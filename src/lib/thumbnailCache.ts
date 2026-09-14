import { appCacheDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, readFile, writeFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

let cacheDirPromise: Promise<string> | null = null;

async function getCacheDir(): Promise<string> {
	if (!cacheDirPromise) {
		cacheDirPromise = (async () => {
			const base = await appCacheDir();
			const dir = await join(base, 'video-thumbs');
			if (!(await exists(dir))) await mkdir(dir, { recursive: true });
			return dir;
		})();
	}
	return cacheDirPromise;
}

function hashPath(path: string): string {
	let h = 0;
	for (let i = 0; i < path.length; i++) {
		h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16);
}

// --- Per-file thumbnail JPEG cache (unchanged) ---

export async function getCachedThumbnail(path: string): Promise<string | null> {
	const dir = await getCacheDir();
	const file = await join(dir, `${hashPath(path)}.jpg`);
	if (!(await exists(file))) return null;
	const bytes = await readFile(file);
	const blob = new Blob([bytes], { type: 'image/jpeg' });
	return URL.createObjectURL(blob);
}

export async function saveCachedThumbnail(path: string, dataUrl: string): Promise<void> {
	const dir = await getCacheDir();
	const file = await join(dir, `${hashPath(path)}.jpg`);
	const base64 = dataUrl.split(',')[1];
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	await writeFile(file, bytes);
}

// --- Per-folder blurhash manifest (batched writes, instant bulk reads) ---

const manifestCache = new Map<string, Record<string, string>>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function manifestPath(folderPath: string): Promise<string> {
	const dir = await getCacheDir();
	return join(dir, `manifest-${hashPath(folderPath)}.json`);
}

export async function loadFolderManifest(folderPath: string): Promise<Record<string, string>> {
	const cached = manifestCache.get(folderPath);
	if (cached) return cached;

	const file = await manifestPath(folderPath);
	let manifest: Record<string, string> = {};
	if (await exists(file)) {
		try {
			manifest = JSON.parse(await readTextFile(file));
		} catch {
			manifest = {};
		}
	}
	manifestCache.set(folderPath, manifest);
	return manifest;
}

// Called every time a fresh blurhash is generated. Debounced to disk so we're
// not doing a read-modify-write for every single one of 3000 files.
export function recordBlurhash(folderPath: string, fileName: string, hash: string): void {
	const manifest = manifestCache.get(folderPath) ?? {};
	manifest[fileName] = hash;
	manifestCache.set(folderPath, manifest);

	clearTimeout(flushTimers.get(folderPath));
	flushTimers.set(
		folderPath,
		setTimeout(async () => {
			const file = await manifestPath(folderPath);
			await writeTextFile(file, JSON.stringify(manifest));
		}, 800)
	);
}
