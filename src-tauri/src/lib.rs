#[cfg_attr(mobile, tauri::mobile_entry_point)]

mod video_stream;

use video_stream::VideoStreamServer;

#[derive(serde::Serialize)]
struct VideoStreamHandle {
    url: String,
    token: String,
}

#[tauri::command]
fn register_video_stream(
    state: tauri::State<VideoStreamServer>,
    path: String,
) -> Result<VideoStreamHandle, String> {
    let token = state
        .register(std::path::PathBuf::from(path))
        .map_err(|e| e.to_string())?;

    Ok(VideoStreamHandle {
        url: format!("http://127.0.0.1:{}/stream/{}", state.port(), token),
        token,
    })
}

#[tauri::command]
fn move_file_to_folder(
    file_path: String,
    folder_name: String,
) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;

    let file_path = PathBuf::from(&file_path);

    let parent = file_path
        .parent()
        .ok_or_else(|| "File has no parent directory".to_string())?;

    let destination_dir = parent.join(&folder_name);

    fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("Failed to create destination folder: {e}"))?;

    let file_name = file_path
        .file_name()
        .ok_or_else(|| "File has no filename".to_string())?;

    let destination = destination_dir.join(file_name);

    fs::rename(&file_path, &destination)
        .map_err(|e| format!("Failed to move file: {e}"))?;

    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn undo_move_file(file_path: String) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;

    let file_path = PathBuf::from(&file_path);

    // The file should currently be inside a folder such as:
    // /videos/discard/file.mp4
    let discard_dir = file_path
        .parent()
        .ok_or_else(|| "File has no parent directory".to_string())?;

    // Move it back to the directory containing the discard folder:
    // /videos/discard/file.mp4 -> /videos/file.mp4
    let original_dir = discard_dir
        .parent()
        .ok_or_else(|| "Discard folder has no parent directory".to_string())?;

    let file_name = file_path
        .file_name()
        .ok_or_else(|| "File has no filename".to_string())?;

    let destination = original_dir.join(file_name);

    fs::rename(&file_path, &destination)
        .map_err(|e| format!("Failed to restore file: {e}"))?;

    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn unregister_video_stream(
    state: tauri::State<VideoStreamServer>,
    token: String,
) {
    state.unregister(&token);
}

pub fn run() {
    let stream_server =
        VideoStreamServer::start().expect("failed to start video stream server");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage(stream_server)
        .invoke_handler(tauri::generate_handler![
            register_video_stream,
            unregister_video_stream,
            move_file_to_folder,
            undo_move_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
