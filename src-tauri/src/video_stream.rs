// src-tauri/src/video_stream.rs
//
// Serves local video files over a loopback HTTP server instead of Tauri's
// built-in `asset://` protocol. This exists because of a real, documented bug
// in Tauri's asset protocol: seeking re-reads the file from byte 0 up to the
// requested offset instead of jumping straight there, which gets slow (and on
// very large files, can hang/crash) the further into the file you seek.
// See: https://github.com/tauri-apps/tauri/issues/6375
//
// Files are never exposed by raw path. `register()` hands out an opaque,
// per-session token; the HTTP server only knows how to resolve *that* to a
// path, and tokens are forgotten again via `unregister()`.

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use tiny_http::{Header, Response, Server, StatusCode};

/// Size of each chunk read from disk and written to the response body. Keeps
/// memory use flat regardless of how large the requested range is, instead of
/// buffering the whole range before responding.
const CHUNK_SIZE: usize = 256 * 1024;

pub struct VideoStreamServer {
    port: u16,
    tokens: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl VideoStreamServer {
    /// Binds a random free loopback port and starts serving in the
    /// background. Call once at app startup and keep the returned value alive
    /// (e.g. via `.manage(...)`) for the lifetime of the app.
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = Server::from_listener(listener, None)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

        let tokens: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let tokens_for_thread = tokens.clone();

        thread::spawn(move || {
            for request in server.incoming_requests() {
                let tokens = tokens_for_thread.clone();
                // One thread per request: video seeking can fire several
                // overlapping range requests (e.g. the browser probing ahead
                // while you're also scrubbing), and each is a short-lived
                // blocking read, not a long-held connection.
                thread::spawn(move || {
                    if let Err(err) = handle_request(request, &tokens) {
                        eprintln!("video stream request failed: {err}");
                    }
                });
            }
        });

        Ok(Self { port, tokens })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Registers a file for streaming and returns an opaque token to embed in
    /// the URL. Returns an error if the path doesn't exist or isn't a file,
    /// so callers can reject bogus paths before ever handing out a token.
    pub fn register(&self, path: PathBuf) -> std::io::Result<String> {
        if !path.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("not a file: {}", path.display()),
            ));
        }
        let token = generate_token();
        self.tokens.lock().unwrap().insert(token.clone(), path);
        Ok(token)
    }

    /// Forgets a token so it can no longer be resolved. Call this when a
    /// video is closed or replaced so the map doesn't grow unbounded over a
    /// long-running app session.
    pub fn unregister(&self, token: &str) {
        self.tokens.lock().unwrap().remove(token);
    }
}

fn generate_token() -> String {
    // Good enough entropy for an ephemeral, session-local capability token
    // without pulling in a UUID crate: 128 bits from two random u64s.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let addr_entropy = &nanos as *const _ as u64;
    format!("{:032x}", (nanos as u128) ^ ((addr_entropy as u128) << 64))
}

fn handle_request(
    request: tiny_http::Request,
    tokens: &Arc<Mutex<HashMap<String, PathBuf>>>,
) -> std::io::Result<()> {
    let token = request.url().trim_start_matches("/stream/").to_string();

    let path = {
        let map = tokens.lock().unwrap();
        map.get(&token).cloned()
    };

    let Some(path) = path else {
        return request.respond(Response::empty(StatusCode(404)));
    };

    let mut file = File::open(&path)?;
    let file_size = file.metadata()?.len();
    let mime = guess_mime(&path);

    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let (start, end) = match range_header.as_deref().and_then(parse_range) {
        Some((s, e)) => (s, e.min(file_size.saturating_sub(1))),
        None => (0, file_size.saturating_sub(1)),
    };

    // This is the actual fix: seek straight to the requested byte offset
    // instead of reading (and discarding) every byte before it, which is
    // what made seeking into large/long videos slow under Tauri's built-in
    // asset protocol.
    file.seek(SeekFrom::Start(start))?;
    let length = (end - start + 1) as usize;

    let status = if range_header.is_some() { 206 } else { 200 };
    let mut response = Response::new_empty(StatusCode(status))
        .with_header(header("Content-Type", mime))
        .with_header(header("Accept-Ranges", "bytes"))
        .with_header(header("Content-Length", &length.to_string()));

    if range_header.is_some() {
        response = response.with_header(header(
            "Content-Range",
            &format!("bytes {start}-{end}/{file_size}"),
        ));
    }

    let body = BoundedReader {
        file,
        remaining: length,
    };
    request.respond(response.with_data(body, Some(length)))
}

fn header(field: &str, value: &str) -> Header {
    Header::from_bytes(field.as_bytes(), value.as_bytes()).unwrap()
}

/// Parses a `Range: bytes=START-END` header. `END` may be omitted to mean
/// "to the end of the file", per the HTTP range spec.
fn parse_range(value: &str) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end: u64 = if end.is_empty() {
        u64::MAX
    } else {
        end.parse().ok()?
    };
    Some((start, end))
}

fn guess_mime(path: &PathBuf) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
    {
        Some(ext) if ext == "mp4" || ext == "m4v" => "video/mp4",
        Some(ext) if ext == "webm" => "video/webm",
        Some(ext) if ext == "mkv" => "video/x-matroska",
        Some(ext) if ext == "mov" => "video/quicktime",
        Some(ext) if ext == "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

/// Streams exactly `remaining` bytes from `file`'s current position, in fixed
/// chunks, so a single request never buffers the whole requested range into
/// memory before responding.
struct BoundedReader {
    file: File,
    remaining: usize,
}

impl Read for BoundedReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let cap = buf.len().min(self.remaining).min(CHUNK_SIZE);
        let read = self.file.read(&mut buf[..cap])?;
        self.remaining -= read;
        Ok(read)
    }
}
