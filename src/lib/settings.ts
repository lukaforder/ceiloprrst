import { load } from '@tauri-apps/plugin-store';

interface Settings {
	lastFolder?: string;
}

let storePromise: ReturnType<typeof load> | null = null;

async function getStore() {
	if (!storePromise) {
		storePromise = load('settings.json');
	}
	return storePromise;
}

export async function getLastFolder(): Promise<string | undefined> {
	try {
		const store = await getStore();
		return await store.get<string>('lastFolder');
	} catch {
		return undefined;
	}
}

export async function setLastFolder(folder: string): Promise<void> {
	try {
		const store = await getStore();
		await store.set('lastFolder', folder);
		await store.save();
	} catch {
		// non-critical, ignore
	}
}
