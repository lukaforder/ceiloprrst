<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import { readDir, type DirEntry } from '@tauri-apps/plugin-fs';
	import { convertFileSrc } from '@tauri-apps/api/core';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { get } from 'svelte/store';
	import { fade } from 'svelte/transition';

	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { VideoItem } from '$lib/types';
	import { createPool } from '$lib/concurrency';

	import {
		getCachedThumbnail,
		saveCachedThumbnail,
		loadFolderManifest,
		recordBlurhash
	} from '$lib/thumbnailCache';

	import { encodeBlurhashFromCanvas, blurhashToDataUrl } from '$lib/blurhash';

	import { getLastFolder, setLastFolder } from '$lib/settings';

	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { MorphingText } from '$lib/components/magic/morphing-text';

	let playingVideo = $state<VideoItem | null>(null);
	let playingVideoIndex = $state<number | null>(null);

	const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi'];

	const MAX_CONCURRENT_THUMBNAILS = 4;
	const THUMBNAIL_VISIBLE_DELAY = 150;
	const SCROLL_IDLE_DELAY = 120;

	const ROW_HEIGHT = 220;
	const THUMB_WIDTH = 320;

	const pool = createPool(MAX_CONCURRENT_THUMBNAILS);

	const loadingPaths = new Set<string>();
	const intersectingPaths = new Set<string>();
	const visibilityTimers = new Map<string, number>();
	const pendingLoads = new Map<string, VideoItem>();
	const observerCallbacks = new WeakMap<Element, VideoItem>();

	let sharedObserver: IntersectionObserver | null = null;

	let isScrolling = false;
	let scrollIdleTimer: number | undefined;

	let videos = $state<VideoItem[]>([]);
	let scanning = $state(false);

	let scrollEl = $state<HTMLDivElement | undefined>(undefined);

	let columns = $state(5);
	let currentFolder = $state<string | null>(null);

	// -------------------------------------------------------------------------
	// Session playback state
	// -------------------------------------------------------------------------

	/*
	 * `videos` is the actual indexed catalogue used by the grid.
	 *
	 * We deliberately DO NOT remove items from this array when they are
	 * discarded. Removing an item would shift every index after it and make
	 * `seenIndexes` invalid.
	 *
	 * The Set is tiny compared with the VideoItem objects themselves and only
	 * contains indexes encountered during this session.
	 */
	const seenIndexes = new Set<number>();

	let totalVideoCount = $derived(videos.length);

	function markIndexSeen(index: number) {
		seenIndexes.add(index);
	}

	function getRandomUnseenIndex(): number | null {
		if (totalVideoCount === 0) {
			return null;
		}

		if (seenIndexes.size >= totalVideoCount) {
			return null;
		}

		let index: number;

		do {
			index = Math.floor(Math.random() * totalVideoCount);
		} while (seenIndexes.has(index));

		seenIndexes.add(index);

		return index;
	}

	function getVideoAtIndex(index: number): VideoItem | null {
		return videos[index] ?? null;
	}

	async function requestNextVideo(): Promise<{
		index: number;
		video: VideoItem;
	} | null> {
		const index = getRandomUnseenIndex();

		if (index === null) {
			return null;
		}

		const video = getVideoAtIndex(index);

		/*
		 * This should only fail if the indexed catalogue changes underneath
		 * us. Since we keep videos stable for the session, it normally cannot
		 * happen.
		 */
		if (!video) {
			return requestNextVideo();
		}

		return {
			index,
			video
		};
	}

	// -------------------------------------------------------------------------
	// Layout
	// -------------------------------------------------------------------------

	function computeColumns(): number {
		const w = window.innerWidth;

		if (w >= 1024) return 5;
		if (w >= 768) return 4;
		if (w >= 640) return 3;

		return 2;
	}

	$effect(() => {
		columns = computeColumns();

		const onResize = () => {
			columns = computeColumns();
		};

		window.addEventListener('resize', onResize);

		return () => {
			window.removeEventListener('resize', onResize);
		};
	});

	const rowCount = $derived(Math.ceil(videos.length / columns));

	const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,

		getScrollElement: () => scrollEl ?? null,

		estimateSize: () => ROW_HEIGHT,

		overscan: 3
	});

	$effect(() => {
		if (!scrollEl) return;

		get(rowVirtualizer).setOptions({
			getScrollElement: () => scrollEl ?? null
		});
	});

	$effect(() => {
		if (!scrollEl) return;

		const el = scrollEl;

		const handleScroll = () => {
			isScrolling = true;

			if (scrollIdleTimer !== undefined) {
				clearTimeout(scrollIdleTimer);
			}

			scrollIdleTimer = window.setTimeout(() => {
				isScrolling = false;
				scrollIdleTimer = undefined;

				flushPendingLoads();
			}, SCROLL_IDLE_DELAY);
		};

		el.addEventListener('scroll', handleScroll, {
			passive: true
		});

		return () => {
			el.removeEventListener('scroll', handleScroll);

			if (scrollIdleTimer !== undefined) {
				clearTimeout(scrollIdleTimer);
			}
		};
	});

	$effect(() => {
		const count = rowCount;

		get(rowVirtualizer).setOptions({
			count
		});
	});

	// -------------------------------------------------------------------------
	// Folder scanning
	// -------------------------------------------------------------------------

	async function pickFolder() {
		const defaultPath = await getLastFolder();

		const folder = await open({
			directory: true,
			multiple: false,
			defaultPath
		});

		if (!folder || typeof folder !== 'string') {
			return;
		}

		void setLastFolder(folder);

		scanning = true;

		// Reset the current session.
		videos = [];
		seenIndexes.clear();

		playingVideo = null;
		playingVideoIndex = null;

		currentFolder = folder;

		const entries: DirEntry[] = await readDir(folder);

		const list: VideoItem[] = entries
			.filter((entry) => {
				if (entry.isDirectory) return false;

				const ext = entry.name.split('.').pop()?.toLowerCase();

				return ext ? VIDEO_EXT.includes(ext) : false;
			})
			.map((entry) => ({
				name: entry.name,
				path: `${folder}/${entry.name}`,
				thumb: null,
				blurhash: null,
				blurhashUrl: null
			}));

		videos = list;
		scanning = false;

		const manifest = await loadFolderManifest(folder);

		for (const item of videos) {
			const hash = manifest[item.name];

			if (hash) {
				item.blurhash = hash;
				item.blurhashUrl = blurhashToDataUrl(hash);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Thumbnails
	// -------------------------------------------------------------------------

	function flushPendingLoads() {
		for (const item of pendingLoads.values()) {
			if (intersectingPaths.has(item.path)) {
				loadThumb(item);
			}
		}

		pendingLoads.clear();
	}

	function getSharedObserver(): IntersectionObserver {
		if (sharedObserver) return sharedObserver;

		sharedObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const item = observerCallbacks.get(entry.target);

					if (!item) continue;

					if (entry.isIntersecting) {
						intersectingPaths.add(item.path);

						const timer = window.setTimeout(() => {
							visibilityTimers.delete(item.path);

							if (!intersectingPaths.has(item.path)) {
								return;
							}

							if (isScrolling) {
								pendingLoads.set(item.path, item);
							} else {
								loadThumb(item);
							}
						}, THUMBNAIL_VISIBLE_DELAY);

						visibilityTimers.set(item.path, timer);
					} else {
						intersectingPaths.delete(item.path);
						pendingLoads.delete(item.path);

						const existing = visibilityTimers.get(item.path);

						if (existing !== undefined) {
							clearTimeout(existing);
							visibilityTimers.delete(item.path);
						}
					}
				}
			},
			{
				root: scrollEl ?? null,
				threshold: 0.01
			}
		);

		return sharedObserver;
	}

	function lazyThumb(node: HTMLElement, item: VideoItem) {
		observerCallbacks.set(node, item);
		getSharedObserver().observe(node);

		return {
			destroy() {
				intersectingPaths.delete(item.path);
				pendingLoads.delete(item.path);

				const existing = visibilityTimers.get(item.path);

				if (existing !== undefined) {
					clearTimeout(existing);
					visibilityTimers.delete(item.path);
				}

				sharedObserver?.unobserve(node);
				observerCallbacks.delete(node);
			}
		};
	}

	async function loadThumb(item: VideoItem) {
		if (item.thumb || loadingPaths.has(item.path)) {
			return;
		}

		loadingPaths.add(item.path);

		await pool(async () => {
			try {
				if (isScrolling) {
					pendingLoads.set(item.path, item);
					return;
				}

				const cached = await getCachedThumbnail(item.path);

				if (cached) {
					item.thumb = cached;
					return;
				}

				const result = await generateThumbnail(item.path);

				if (!result) return;

				const { dataUrl, blurhash } = result;

				item.thumb = dataUrl;
				item.blurhash = blurhash;
				item.blurhashUrl = blurhashToDataUrl(blurhash);

				void saveCachedThumbnail(item.path, dataUrl);

				if (currentFolder) {
					recordBlurhash(currentFolder, item.name, blurhash);
				}
			} finally {
				loadingPaths.delete(item.path);
			}
		});
	}

	// -------------------------------------------------------------------------
	// Start / navigation
	// -------------------------------------------------------------------------

	async function startSorting() {
		if (!videos.length) return;

		/*
		 * Start with a random unseen video, exactly the same way that
		 * "next" chooses one.
		 */
		const next = await requestNextVideo();

		if (!next) {
			return;
		}

		playingVideo = next.video;
		playingVideoIndex = next.index;
	}

	function handleGridClick(event: MouseEvent) {
		const target = (event.target as HTMLElement).closest<HTMLElement>('[data-video-index]');

		if (!target) return;

		const index = Number(target.dataset.videoIndex);
		const item = videos[index];

		if (!item) return;

		/*
		 * Manually opening a video counts as seeing it too.
		 * This prevents "Next" from returning the same video.
		 */
		markIndexSeen(index);

		playingVideo = item;
		playingVideoIndex = index;
	}

	function handleGridKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}

		const target = (event.target as HTMLElement).closest<HTMLElement>('[data-video-index]');

		if (!target) return;

		event.preventDefault();

		const index = Number(target.dataset.videoIndex);
		const item = videos[index];

		if (!item) return;

		markIndexSeen(index);

		playingVideo = item;
		playingVideoIndex = index;
	}

	// -------------------------------------------------------------------------
	// Undo
	// -------------------------------------------------------------------------

	function handleVideoRestored(index: number, video: VideoItem, restoredPath: string) {
		/*
		 * The video was never removed from `videos`, so its original index
		 * remains valid.
		 *
		 * We replace the object rather than mutating the old object. This
		 * keeps the parent as the source of truth.
		 */
		if (videos[index] === video) {
			videos[index] = {
				...video,
				path: restoredPath
			};
		} else {
			/*
			 * Fallback in case the object reference changed for some reason.
			 * The index is still the primary identity for this session.
			 */
			const existing = videos[index];

			if (existing) {
				videos[index] = {
					...existing,
					path: restoredPath
				};
			}
		}

		/*
		 * Do NOT remove the index from seenIndexes.
		 *
		 * Undo means "restore the file", not "pretend this video was never
		 * reviewed". It should therefore remain excluded from automatic Next.
		 */
	}

	// -------------------------------------------------------------------------
	// Thumbnail generation
	// -------------------------------------------------------------------------

	function generateThumbnail(path: string): Promise<{
		dataUrl: string;
		blurhash: string;
	} | null> {
		return new Promise((resolve) => {
			const url = convertFileSrc(path);

			const video = document.createElement('video');

			video.src = url;
			video.muted = true;
			video.crossOrigin = 'anonymous';
			video.preload = 'metadata';

			const cleanup = (
				result: {
					dataUrl: string;
					blurhash: string;
				} | null
			) => {
				video.remove();
				resolve(result);
			};

			video.addEventListener('loadedmetadata', () => {
				video.currentTime = Math.min(1, video.duration / 2);
			});

			video.addEventListener('seeked', () => {
				const canvas = document.createElement('canvas');

				const scale = THUMB_WIDTH / video.videoWidth;

				canvas.width = THUMB_WIDTH;
				canvas.height = video.videoHeight * scale;

				const ctx = canvas.getContext('2d');

				if (!ctx) {
					cleanup(null);
					return;
				}

				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

				const dataUrl = canvas.toDataURL('image/jpeg', 0.6);

				const blurhash = encodeBlurhashFromCanvas(canvas);

				cleanup({
					dataUrl,
					blurhash
				});
			});

			video.addEventListener('error', () => {
				cleanup(null);
			});
		});
	}
</script>

<div class="flex h-full min-h-0 flex-col {playingVideo ? 'pointer-events-none opacity-0' : ''}">
	<header class="sticky top-0 z-10 shrink-0 bg-background/80 backdrop-blur">
		<div class="flex items-center gap-3 bg-sidebar p-2">
			<Button onclick={pickFolder} disabled={scanning}>
				{#if scanning}
					Scanning...
				{:else if currentFolder}
					Change folder
				{:else}
					Select folder
				{/if}
			</Button>

			<Button onclick={pickFolder} disabled={scanning}>
				{scanning ? 'Scanning...' : 'Change discard folder'}
			</Button>

			<Button
				onclick={startSorting}
				disabled={scanning || !currentFolder || !videos.length}
				class="ml-auto"
			>
				Start
			</Button>
		</div>
	</header>

	{#if videos.length === 0 && !scanning && !currentFolder}
		<Card.Root class="m-auto w-full max-w-lg pt-4">
			<Card.Header>
				<MorphingText texts={['ceiloprrst', 'clipsorter']} class="mb-2" />

				<Card.Description>
					is a video clip sorter application designed to help users rapidly sort through large
					amounts of video clips and footage!
				</Card.Description>
			</Card.Header>

			<Card.Content class="mt-4 flex flex-col gap-2 text-muted-foreground *:text-sm">
				<p>how to use:</p>

				<ul class="list-decimal pl-5">
					<li>
						press "Select folder" to choose a directory containing all your clips and videos you
						wish to sort
					</li>

					<li>optionally set a custom discard folder location</li>

					<li>press start</li>
				</ul>
			</Card.Content>

			<Card.Footer>
				<p class="mb-4 w-full text-sm font-extralight text-muted-foreground/40">
					i choose to pronounce it as "see-lee-oh-prist"
				</p>
			</Card.Footer>
		</Card.Root>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={scrollEl}
			class="min-h-0 flex-1 overflow-y-auto p-6"
			onclick={handleGridClick}
			onkeydown={handleGridKeydown}
		>
			{#if scanning}
				<p class="text-center text-muted-foreground">Scanning for videos...</p>
			{/if}

			{#if videos.length > 0}
				<p class="p-2 text-sm text-muted-foreground">
					{totalVideoCount} videos found in {currentFolder}
				</p>
			{/if}

			<div
				style="
					position: relative;
					width: 100%;
					height: {$rowVirtualizer.getTotalSize()}px;
				"
			>
				{#each $rowVirtualizer.getVirtualItems() as row (row.key)}
					<div
						style="
							position: absolute;
							top: 0;
							left: 0;
							width: 100%;
							height: {row.size}px;
							transform: translateY({row.start}px);
							display: grid;
							grid-template-columns: repeat({columns}, minmax(0, 1fr));
							padding: 0 0.25rem;
						"
					>
						{#each Array.from({ length: columns }) as _, colIndex (colIndex)}
							{@const itemIndex = row.index * columns + colIndex}

							{#if videos[itemIndex]}
								{@const v = videos[itemIndex]}

								<div
									class="flex h-full cursor-pointer flex-col gap-2 overflow-hidden rounded-xl border bg-card py-0 text-card-foreground shadow-sm"
									data-video-index={itemIndex}
									role="button"
									tabindex={0}
								>
									<div class="relative aspect-video overflow-hidden bg-muted" use:lazyThumb={v}>
										{#if v.blurhashUrl}
											<img
												src={v.blurhashUrl}
												alt=""
												class="absolute inset-0 h-full w-full scale-110 object-cover blur-md"
											/>
										{:else}
											<div class="absolute inset-0 animate-pulse bg-muted-foreground/10"></div>
										{/if}

										{#if v.thumb}
											<img
												src={v.thumb}
												alt={v.name}
												class="absolute inset-0 h-full w-full object-cover"
												transition:fade={{
													duration: 250
												}}
											/>
										{/if}
									</div>

									<div class="flex items-center px-3 py-2">
										<p
											class="line-clamp-2 h-full w-full truncate text-xs whitespace-normal text-foreground/70"
											title={v.name}
										>
											{v.name}
										</p>
									</div>
								</div>
							{/if}
						{/each}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

{#if playingVideo && playingVideoIndex !== null}
	<VideoPlayer
		video={playingVideo}
		videoIndex={playingVideoIndex}
		onRequestNext={requestNextVideo}
		onVideoRestored={handleVideoRestored}
		onClose={() => {
			playingVideo = null;
			playingVideoIndex = null;
		}}
	/>
{/if}
