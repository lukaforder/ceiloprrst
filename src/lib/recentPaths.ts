import { load } from '@tauri-apps/plugin-store';

const MAX_RECENT = 5;
const KEY = 'recentPaths';

export function createRecentPaths(storeName = 'userData.json') {
	const store = load(storeName, { autoSave: true });

	async function get(): Promise<string[]> {
		const s = await store;
		const stored = await s.get(KEY);

		return Array.isArray(stored) ? (stored as string[]) : [];
	}

	async function write(paths: string[]): Promise<string[]> {
		const s = await store;

		await s.set(KEY, paths);
		await s.save();

		return paths;
	}

	async function add(path: string): Promise<string[]> {
		const current = await get();

		return write([path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT));
	}

	async function remove(path: string): Promise<string[]> {
		const current = await get();

		if (!current.includes(path)) return current;

		return write(current.filter((p) => p !== path));
	}

	async function clear(): Promise<string[]> {
		return write([]);
	}

	return { get, add, remove, clear };
}
