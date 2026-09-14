import { appConfigDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

interface Settings {
	lastFolder?: string;
}

let settingsPathPromise: Promise<string> | null = null;

async function getSettingsPath(): Promise<string> {
	if (!settingsPathPromise) {
		settingsPathPromise = (async () => {
			const dir = await appConfigDir();
			if (!(await exists(dir))) await mkdir(dir, { recursive: true });
			return join(dir, 'settings.json');
		})();
	}
	return settingsPathPromise;
}

export async function getLastFolder(): Promise<string | undefined> {
	try {
		const path = await getSettingsPath();
		if (!(await exists(path))) return undefined;
		const settings: Settings = JSON.parse(await readTextFile(path));
		return settings.lastFolder;
	} catch {
		return undefined;
	}
}

export async function setLastFolder(folder: string): Promise<void> {
	try {
		const path = await getSettingsPath();
		await writeTextFile(path, JSON.stringify({ lastFolder: folder }));
	} catch {
		// non-critical, ignore
	}
}
