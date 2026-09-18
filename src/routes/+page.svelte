<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import { readDir, type DirEntry } from '@tauri-apps/plugin-fs';
	import { convertFileSrc } from '@tauri-apps/api/core';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { get } from 'svelte/store';
	import { fade } from 'svelte/transition';
	import { onMount } from 'svelte';

	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { VideoItem } from '$lib/types';
	import { createPool } from '$lib/concurrency';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	import {
		getCachedThumbnail,
		saveCachedThumbnail,
		loadFolderManifest,
		recordBlurhash
	} from '$lib/thumbnailCache';

	import { encodeBlurhashFromCanvas, blurhashToDataUrl } from '$lib/blurhash';
	import { getLastFolder, setLastFolder } from '$lib/settings';

	import { generateThumbnail } from '$lib/thumbnailGenerator';
	import { createLazyVisibility } from '$lib/lazyVisibility';
	import { createSessionPlayback } from '$lib/sessionPlayback';
	import { computeColumns } from '$lib/layout';
	import { createRecentPaths } from '$lib/recentPaths';

	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { MorphingText } from '$lib/components/magic/morphing-text';

	const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi'];
	const MAX_CONCURRENT_THUMBNAILS = 4;
	const ROW_HEIGHT = 220;
	const THUMB_WIDTH = 320;
	const SCROLL_IDLE_DELAY = 120;

	const pool = createPool(MAX_CONCURRENT_THUMBNAILS);
	const loadingPaths = new Set<string>();
	const recentPathsStore = createRecentPaths();

	let playingVideo = $state<VideoItem | null>(null);
	let playingVideoIndex = $state<number | null>(null);
	let videos = $state<VideoItem[]>([]);
	let scanning = $state(false);
	let scrollEl = $state<HTMLDivElement | undefined>(undefined);
	let columns = $state(computeColumns(window.innerWidth));
	let currentFolder = $state<string | null>(null);
	let recentPaths = $state<string[]>([]);

	let isScrolling = false;
	let scrollIdleTimer: number | undefined;

	const session = createSessionPlayback(() => videos);
	const lazy = createLazyVisibility<VideoItem>({
		getKey: (v) => v.path,
		onVisible: loadThumb,
		// svelte-ignore state_referenced_locally
		root: scrollEl ?? null
	});

	onMount(async () => {
		recentPaths = await recentPathsStore.get();
	});

	const totalVideoCount = $derived(videos.length);
	const rowCount = $derived(Math.ceil(videos.length / columns));

	const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => scrollEl ?? null,
		estimateSize: () => ROW_HEIGHT,
		overscan: 3
	});

	$effect(() => {
		const onResize = () => (columns = computeColumns(window.innerWidth));
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	$effect(() => {
		if (!scrollEl) return;
		get(rowVirtualizer).setOptions({ getScrollElement: () => scrollEl ?? null });
	});

	$effect(() => {
		if (!scrollEl) return;
		const el = scrollEl;

		const handleScroll = () => {
			isScrolling = true;
			lazy.setScrolling(true);

			if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer);

			scrollIdleTimer = window.setTimeout(() => {
				isScrolling = false;
				lazy.setScrolling(false);
				scrollIdleTimer = undefined;
				lazy.flushPending();
			}, SCROLL_IDLE_DELAY);
		};

		el.addEventListener('scroll', handleScroll, { passive: true });

		return () => {
			el.removeEventListener('scroll', handleScroll);
			if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer);
		};
	});

	$effect(() => {
		get(rowVirtualizer).setOptions({ count: rowCount });
	});

	async function pickFolder(path?: string) {
		const defaultPath = await getLastFolder();
		const folder = path ?? (await open({ directory: true, multiple: false, defaultPath }));

		if (!folder || typeof folder !== 'string') return;

		await setLastFolder(folder);
		recentPaths = await recentPathsStore.add(folder);

		scanning = true;
		videos = [];
		session.reset();
		playingVideo = null;
		playingVideoIndex = null;
		currentFolder = folder;

		const entries: DirEntry[] = await readDir(folder);

		videos = entries
			.filter(
				(e) => !e.isDirectory && VIDEO_EXT.includes(e.name.split('.').pop()?.toLowerCase() ?? '')
			)
			.map((e) => ({
				name: e.name,
				path: `${folder}/${e.name}`,
				thumb: null,
				blurhash: null,
				blurhashUrl: null
			}));

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

	async function loadThumb(item: VideoItem) {
		if (item.thumb || loadingPaths.has(item.path)) return;

		loadingPaths.add(item.path);

		await pool(async () => {
			try {
				const cached = await getCachedThumbnail(item.path);

				if (cached) {
					item.thumb = cached;
					return;
				}

				const result = await generateThumbnail(
					item.path,
					convertFileSrc,
					encodeBlurhashFromCanvas,
					THUMB_WIDTH
				);

				if (!result) return;

				item.thumb = result.dataUrl;
				item.blurhash = result.blurhash;
				item.blurhashUrl = blurhashToDataUrl(result.blurhash);

				void saveCachedThumbnail(item.path, result.dataUrl);
				if (currentFolder) recordBlurhash(currentFolder, item.name, result.blurhash);
			} finally {
				loadingPaths.delete(item.path);
			}
		});
	}

	async function startSorting() {
		if (!videos.length) return;

		const next = session.requestNext();
		if (!next) return;

		playingVideo = next.item;
		playingVideoIndex = next.index;
	}

	function selectFromGrid(target: HTMLElement) {
		const index = Number(target.dataset.videoIndex);
		const item = videos[index];

		if (!item) return;

		session.markSeen(index);
		playingVideo = item;
		playingVideoIndex = index;
	}

	function handleGridClick(event: MouseEvent) {
		const target = (event.target as HTMLElement).closest<HTMLElement>('[data-video-index]');
		if (target) selectFromGrid(target);
	}

	function handleGridKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;

		const target = (event.target as HTMLElement).closest<HTMLElement>('[data-video-index]');
		if (!target) return;

		event.preventDefault();
		selectFromGrid(target);
	}

	function handleVideoRestored(index: number, video: VideoItem, restoredPath: string) {
		const existing = videos[index] === video ? video : videos[index];
		if (existing) videos[index] = { ...existing, path: restoredPath };
	}
</script>

<div class="flex h-full min-h-0 flex-col {playingVideo ? 'pointer-events-none opacity-0' : ''}">
	<header class="sticky top-0 z-10 shrink-0 bg-background/80 backdrop-blur">
		<div class="flex items-center gap-3 bg-sidebar p-2">
			<Button onclick={() => pickFolder()} disabled={scanning}>
				{#if scanning}
					Scanning...
				{:else if currentFolder}
					Change folder
				{:else}
					Select folder
				{/if}
			</Button>

			<Button onclick={() => pickFolder()} disabled={scanning}>
				{scanning ? 'Scanning...' : 'Change discard folder'}
			</Button>

			<Button
				onclick={startSorting}
				disabled={scanning || !currentFolder || !videos.length}
				class="ml-auto"
			>
				Start
			</Button>

			<Dialog.Root>
				<Dialog.Trigger>Settings</Dialog.Trigger>
				<Dialog.Content>
					<Dialog.Header>
						<Dialog.Title>Settings</Dialog.Title>
						<Dialog.Description>
							<ol>
								<li>Volume on fast forward</li>
								<li>Fast forward speed</li>
								<li>Delete stored thumbnails (count & size)</li>
								<li>Theme</li>
								<li>Generate blurhash for thumbnails</li>
								<li>Generate thumbnails for videos</li>
								<li>Store generated thumbnails</li>
							</ol>
						</Dialog.Description>
					</Dialog.Header>
				</Dialog.Content>
			</Dialog.Root>
		</div>
	</header>

	{#if videos.length === 0 && !scanning && !currentFolder}
		<Card.Root class="m-auto w-full max-w-lg pt-4">
			<ol class="absolute left-10">
				<li class="text-lg text-foreground/50">Recent locations</li>
				{#each recentPaths as path (path)}
					<li class="group w-fit justify-center">
						<button
							class="absolute -left-4 items-center text-destructive/50 opacity-0 transition-all group-hover:opacity-100"
							onclick={async () => {
								recentPaths = await recentPathsStore.remove(path);
							}}>X</button
						>
						<button
							onclick={() => pickFolder(path)}
							class="relative items-center p-0 text-foreground/50 underline underline-offset-4 hover:text-foreground"
							>{path}</button
						>
					</li>
				{:else}
					<li class="text-foreground/30">none</li>
				{/each}
			</ol>
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
			<Card.Footer class="group flex flex-col">
				<p class="mb-4 w-full text-sm font-extralight text-muted-foreground/40">
					i choose to pronounce it as "see-lee-oh-prist"
				</p>
				<p
					class="mb-4 w-full text-sm font-extralight text-muted-foreground/20 opacity-0 transition-opacity group-hover:opacity-100"
				>
					"ceiloprrst" is "clipsorter" alphabetically sorted
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
									<div class="relative aspect-video overflow-hidden bg-muted" use:lazy.action={v}>
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
												transition:fade={{ duration: 250 }}
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
		onRequestNext={async () => {
			const next = session.requestNext();
			return next ? { index: next.index, video: next.item } : null;
		}}
		onVideoRestored={handleVideoRestored}
		onClose={() => {
			playingVideo = null;
			playingVideoIndex = null;
		}}
	/>
{/if}
