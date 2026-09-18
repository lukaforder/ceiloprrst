import { invoke } from '@tauri-apps/api/core';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];
export const SKIP_SMALL = 5;
export const SKIP_LARGE = 10;
export const FAST_FORWARD_MAX = 4;
export const FAST_FORWARD_INTERVAL_MS = 120;
export const SCRUB_SEEK_THROTTLE_MS = 80;
export const RELEASE_GRACE_MS = 80;
export const REVERSE_STEP = 0.5;
export const REVERSE_HOLD_DELAY = 250;
export const REVERSE_INTERVAL_MS = 100;

export function formatTime(t: number): string {
	if (!Number.isFinite(t)) return '0:00';
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = Math.floor(t % 60);
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
	const ss = String(s).padStart(2, '0');
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function nextRampSpeed(current: number, max = FAST_FORWARD_MAX): number {
	const idx = SPEEDS.indexOf(current);
	const startIdx = idx === -1 ? SPEEDS.findIndex((s) => s > current) : idx + 1;
	if (startIdx === -1 || startIdx >= SPEEDS.length) return max;
	return Math.min(max, SPEEDS[startIdx]);
}

export async function moveFileToFolder(filePath: string, folderName: string): Promise<string> {
	return invoke<string>('move_file_to_folder', { filePath, folderName });
}

export async function undoMoveFile(filePath: string): Promise<string> {
	return invoke<string>('undo_move_file', { filePath });
}

export async function registerVideoStream(path: string) {
	return invoke<{ url: string; token: string }>('register_video_stream', { path });
}

export async function unregisterVideoStream(token: string) {
	return invoke('unregister_video_stream', { token });
}

export type HoldKey = 'ArrowRight' | 'ArrowLeft';

/** Tracks physical key holds with a small release grace period so quick re-presses don't flicker. */
export function createHoldTracker(releaseGraceMs = RELEASE_GRACE_MS) {
	const active: Partial<Record<HoldKey, { releaseTimer: ReturnType<typeof setTimeout> | null }>> =
		{};

	function begin(key: HoldKey, onStart: () => void) {
		const existing = active[key];
		if (existing) {
			if (existing.releaseTimer) {
				clearTimeout(existing.releaseTimer);
				existing.releaseTimer = null;
			}
			return;
		}
		active[key] = { releaseTimer: null };
		onStart();
	}

	function end(key: HoldKey, onEnd: () => void) {
		const existing = active[key];
		if (!existing) return;
		existing.releaseTimer = setTimeout(() => {
			delete active[key];
			onEnd();
		}, releaseGraceMs);
	}

	function clearAll() {
		for (const key of Object.keys(active) as HoldKey[]) {
			const entry = active[key];
			if (entry?.releaseTimer) clearTimeout(entry.releaseTimer);
			delete active[key];
		}
	}

	return { begin, end, clearAll };
}

/** Simple hold-to-repeat runner used for reverse scrubbing: fires once immediately, then repeats after a delay. */
export function createHoldRepeater(step: () => void, delayMs: number, intervalMs: number) {
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let interval: ReturnType<typeof setInterval> | null = null;

	function start() {
		step();
		holdTimer = setTimeout(() => {
			interval = setInterval(step, intervalMs);
		}, delayMs);
	}

	function stop() {
		if (holdTimer !== null) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
		if (interval !== null) {
			clearInterval(interval);
			interval = null;
		}
	}

	return { start, stop };
}
