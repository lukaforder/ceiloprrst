<script lang="ts">
	import type { VideoItem } from '$lib/types';
	import ArrowDown from '$lib/icons/arrow-down.svelte';
	import ArrowUp from '$lib/icons/arrow-up.svelte';
	import { toast } from 'svelte-sonner';
	import {
		SPEEDS,
		SKIP_SMALL,
		SKIP_LARGE,
		FAST_FORWARD_MAX,
		FAST_FORWARD_INTERVAL_MS,
		SCRUB_SEEK_THROTTLE_MS,
		REVERSE_STEP,
		REVERSE_HOLD_DELAY,
		REVERSE_INTERVAL_MS,
		formatTime,
		nextRampSpeed,
		moveFileToFolder,
		undoMoveFile,
		registerVideoStream,
		unregisterVideoStream,
		createHoldTracker,
		createHoldRepeater
	} from '$lib/videoPlayer';

	let {
		video,
		videoIndex,
		onClose,
		onRequestNext,
		onVideoRestored
	}: {
		video: VideoItem;
		videoIndex: number;
		onClose: () => void;
		onRequestNext?: () => Promise<{ index: number; video: VideoItem } | null>;
		onVideoRestored?: (index: number, video: VideoItem, restoredPath: string) => void;
	} = $props();

	let videoEl: HTMLVideoElement | undefined = $state();
	let videoContainer: HTMLDivElement | undefined = $state();

	let streamUrl: string | undefined = $state();
	let streamToken: string | undefined;
	let streamLoading = $state(false);
	let streamError = $state(false);
	let streamRequestId = 0;

	async function loadStream(path: string) {
		const requestId = ++streamRequestId;
		const previousToken = streamToken;

		holdTracker.clearAll();
		stopFastForward();
		stopReverse();

		streamUrl = undefined;
		streamLoading = true;
		streamError = false;

		try {
			const handle = await registerVideoStream(path);
			if (requestId !== streamRequestId) {
				unregisterVideoStream(handle.token).catch(() => {});
				return;
			}
			streamUrl = handle.url;
			streamToken = handle.token;
		} catch (err) {
			if (requestId === streamRequestId) {
				console.error('failed to start video stream', err);
				streamError = true;
			}
		} finally {
			if (requestId === streamRequestId) streamLoading = false;
		}

		if (previousToken) unregisterVideoStream(previousToken).catch(() => {});
	}

	let currentTime = $state(0);
	let duration = $state(0);
	let paused = $state(true);
	let volume = $state(1);
	let muted = $state(false);
	let playbackRate = $state(1);
	let bufferedEnd = $state(0);

	let audioTracksList: { id: string; label: string; language: string }[] = $state([]);
	let selectedAudioTrackId = $state<string | null>(null);

	let controlsVisible = $state(true);
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	let speedMenuOpen = $state(false);
	let speedMenuRef: HTMLDivElement | undefined = $state();

	let fastForwardActive = false;
	let rampInterval: ReturnType<typeof setInterval> | null = null;
	let rateBeforeHold: number | null = null;
	let lastVol = $state(0);

	let reverseActive = false;
	const reverseRepeater = createHoldRepeater(
		() => {
			if (!videoEl) return;
			videoEl.currentTime = Math.max(0, videoEl.currentTime - REVERSE_STEP);
			if (videoEl.currentTime <= 0) stopReverse();
		},
		REVERSE_HOLD_DELAY,
		REVERSE_INTERVAL_MS
	);

	let scrubbing = $state(false);
	let resumeAfterScrub = false;
	let lastScrubSeek = 0;

	const holdTracker = createHoldTracker();

	let videoSwipeState = $state<'up' | 'down' | 'normal'>('normal');

	function resetHideTimer() {
		controlsVisible = true;
		if (hideTimer) clearTimeout(hideTimer);
		if (!paused) hideTimer = setTimeout(() => (controlsVisible = false), 2500);
	}

	function togglePlay() {
		if (!videoEl) return;
		videoEl.paused ? videoEl.play() : videoEl.pause();
	}

	function skip(seconds: number) {
		if (!videoEl) return;
		videoEl.currentTime = Math.min(
			Math.max(videoEl.currentTime + seconds, 0),
			duration || Infinity
		);
	}

	function setSpeed(speed: number) {
		playbackRate = speed;
	}

	function toggleSpeedMenu() {
		speedMenuOpen = !speedMenuOpen;
	}

	function chooseSpeed(speed: number) {
		setSpeed(speed);
		speedMenuOpen = false;
	}

	function handleWindowPointerDown(e: PointerEvent) {
		if (speedMenuOpen && speedMenuRef && !speedMenuRef.contains(e.target as Node)) {
			speedMenuOpen = false;
		}
	}

	function startFastForward() {
		if (!videoEl || fastForwardActive) return;

		lastVol = volume;
		volume = 0.2;
		fastForwardActive = true;
		rateBeforeHold = playbackRate;

		if (videoEl.paused) videoEl.play();

		let rate = playbackRate;
		clearRampInterval();

		rampInterval = setInterval(() => {
			if (!videoEl) return;
			rate = nextRampSpeed(rate, FAST_FORWARD_MAX);
			videoEl.playbackRate = rate;
			playbackRate = rate;
			if (rate >= FAST_FORWARD_MAX) clearRampInterval();
		}, FAST_FORWARD_INTERVAL_MS);
	}

	function stopFastForward() {
		if (!fastForwardActive || !videoEl) return;

		fastForwardActive = false;
		clearRampInterval();

		if (rateBeforeHold !== null) {
			videoEl.playbackRate = rateBeforeHold;
			playbackRate = rateBeforeHold;
			rateBeforeHold = null;
		}

		volume = lastVol;
	}

	function clearRampInterval() {
		if (rampInterval !== null) {
			clearInterval(rampInterval);
			rampInterval = null;
		}
	}

	function startReverse() {
		if (!videoEl || reverseActive) return;
		reverseActive = true;
		videoEl.pause();
		reverseRepeater.start();
	}

	function stopReverse() {
		reverseActive = false;
		reverseRepeater.stop();
		videoEl?.play();
	}

	function handleArrowUp() {
		if (!videoEl || !videoContainer) return;

		if (videoSwipeState === 'normal') {
			videoEl.pause();
			videoContainer.style.width = '640px';
			videoContainer.style.height = '360px';
			videoContainer.style.transform = 'translate(0%, -10%)';
			videoSwipeState = 'up';
		} else if (videoSwipeState === 'down') {
			videoEl.pause();
			resetVideoSize();
			videoSwipeState = 'normal';
		}
	}

	function resetVideoSize() {
		if (!videoEl || !videoContainer) return;
		videoContainer.style.width = '100%';
		videoContainer.style.height = '100%';
		videoContainer.style.transform = 'unset';
	}

	function handleArrowDown() {
		if (!videoEl || !videoContainer) return;

		if (videoSwipeState === 'normal') {
			videoEl.pause();
			videoContainer.style.width = '640px';
			videoContainer.style.height = '360px';
			videoContainer.style.transform = 'translate(0%, 10%)';
			videoSwipeState = 'down';
		} else if (videoSwipeState === 'down') {
			markForDiscard();
			videoContainer.style.transform = 'translate(0%, 100%)';
			void nextVideo(); // don't await: request next video immediately
			resetVideoSize();
			videoSwipeState = 'normal';
		} else if (videoSwipeState === 'up') {
			videoEl.pause();
			resetVideoSize();
			videoSwipeState = 'normal';
		}
	}

	function onAudioTrackChange(id: string) {
		if (!videoEl?.audioTracks) return;
		for (let i = 0; i < videoEl.audioTracks.length; i++) {
			videoEl.audioTracks[i].enabled = videoEl.audioTracks[i].id === id;
		}
		selectedAudioTrackId = id;
	}

	function refreshAudioTracks() {
		if (!videoEl?.audioTracks) return;

		const list = [];
		for (let i = 0; i < videoEl.audioTracks.length; i++) {
			const track = videoEl.audioTracks[i];
			list.push({ id: track.id, label: track.label || `Track ${i + 1}`, language: track.language });
			if (track.enabled) selectedAudioTrackId = track.id;
		}
		audioTracksList = list;
	}

	function updateBuffered() {
		if (!videoEl || videoEl.buffered.length === 0) return;
		bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
	}

	function markForDiscard() {
		// Capture now: the player may already show another video by the time Undo is pressed.
		const discardedVideo = video;
		const discardedIndex = videoIndex;

		moveFileToFolder(discardedVideo.path, 'discard')
			.then((discardedPath) => {
				toast.success('Video moved to discard folder.', {
					action: {
						label: 'Undo',
						onClick: async () => {
							try {
								const restoredPath = await undoMoveFile(discardedPath);
								onVideoRestored?.(discardedIndex, discardedVideo, restoredPath);
								toast.success('Video restored.');
							} catch (error) {
								console.error('Failed to restore video:', error);
								toast.error(`Failed to restore video: ${error}`);
							}
						}
					}
				});
			})
			.catch((error) => {
				console.error('Failed to move video to discard folder:', error);
				toast.error(`Failed to move video to discard folder: ${error}`);
			});
	}

	async function nextVideo() {
		if (typeof onRequestNext === 'function') {
			try {
				const next = await onRequestNext();
				if (next) {
					video = next.video;
					videoIndex = next.index;
					await loadStream(next.video.path);
					return;
				}
			} catch (err) {
				console.error('onRequestNext failed', err);
			}
		}
		onClose();
	}

	function startScrub() {
		if (!videoEl) return;
		scrubbing = true;
		resumeAfterScrub = !videoEl.paused;
		videoEl.pause();
		lastScrubSeek = 0;
	}

	function handleSeekInput(e: Event) {
		const value = Number((e.target as HTMLInputElement).value);
		currentTime = value;
		if (!videoEl) return;

		const now = performance.now();
		if (now - lastScrubSeek >= SCRUB_SEEK_THROTTLE_MS) {
			videoEl.currentTime = value;
			lastScrubSeek = now;
		}
	}

	function endScrub(e: Event) {
		const value = Number((e.target as HTMLInputElement).value);
		if (videoEl) videoEl.currentTime = value;

		scrubbing = false;
		if (resumeAfterScrub && videoEl) videoEl.play();
	}

	function handleKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case ' ':
			case 'k':
				e.preventDefault();
				togglePlay();
				break;

			case 'ArrowRight':
				e.preventDefault();
				if (videoSwipeState !== 'normal') break;
				holdTracker.begin('ArrowRight', () => (e.shiftKey ? skip(SKIP_SMALL) : startFastForward()));
				break;

			case 'ArrowLeft':
				e.preventDefault();
				if (videoSwipeState !== 'normal') break;
				holdTracker.begin('ArrowLeft', () => (e.shiftKey ? skip(-SKIP_SMALL) : startReverse()));
				break;

			case 'l':
				skip(SKIP_LARGE);
				break;

			case 'j':
				skip(-SKIP_LARGE);
				break;

			case 'ArrowUp':
				e.preventDefault();
				if (!e.repeat) handleArrowUp();
				break;

			case 'ArrowDown':
				e.preventDefault();
				if (!e.repeat) handleArrowDown();
				break;

			case 'm':
				muted = !muted;
				break;

			case 'Escape':
				speedMenuOpen ? (speedMenuOpen = false) : onClose();
				break;

			case '>':
			case '.': {
				const index = SPEEDS.indexOf(playbackRate);
				setSpeed(SPEEDS[Math.min(index + 1, SPEEDS.length - 1)]);
				break;
			}

			case '<':
			case ',': {
				const index = SPEEDS.indexOf(playbackRate);
				setSpeed(SPEEDS[Math.max(index - 1, 0)]);
				break;
			}
		}

		resetHideTimer();
	}

	function handleKeyup(e: KeyboardEvent) {
		if (e.key === 'ArrowRight') holdTracker.end('ArrowRight', stopFastForward);
		else if (e.key === 'ArrowLeft') holdTracker.end('ArrowLeft', stopReverse);
	}

	function handleBlur() {
		holdTracker.clearAll();
		stopFastForward();
		stopReverse();
	}

	$effect(() => {
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('keyup', handleKeyup);
		window.addEventListener('blur', handleBlur);
		window.addEventListener('pointerdown', handleWindowPointerDown);

		return () => {
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('keyup', handleKeyup);
			window.removeEventListener('blur', handleBlur);
			window.removeEventListener('pointerdown', handleWindowPointerDown);

			holdTracker.clearAll();
			stopFastForward();
			stopReverse();

			if (streamToken) unregisterVideoStream(streamToken).catch(() => {});
		};
	});

	$effect(() => {
		if (video) loadStream(video.path);
	});

	$effect(() => {
		if (videoEl && streamUrl) {
			videoEl.currentTime = 0;
			videoEl.play();
		}
	});
</script>

{#if videoSwipeState !== 'normal'}
	<div class="fixed flex h-full w-full items-center justify-center text-white">
		{#if videoSwipeState === 'up'}
			<div class="fixed top-10 flex flex-col items-center gap-2">
				<ArrowUp class="h-12 w-12" />
				<p class="text-lg">Next</p>
			</div>
			<div class="fixed bottom-10 flex flex-col items-center gap-2">
				<ArrowUp class="h-12 w-12 rotate-180" />
				<p class="text-lg">Back</p>
			</div>
			<div class="fixed top-1/2 left-10 flex flex-col items-center gap-2">
				<ArrowDown class="h-12 w-12 rotate-90" />
				<p class="text-lg">Rename</p>
			</div>
			<div class="fixed top-1/2 right-10 flex flex-col items-center gap-2">
				<ArrowDown class="h-12 w-12 -rotate-90" />
				<p class="text-lg">Send to Editor</p>
			</div>
		{:else if videoSwipeState === 'down'}
			<div class="fixed bottom-10 flex flex-col items-center gap-2 text-destructive">
				<ArrowDown class="h-12 w-12" />
				<p class="text-lg">Press down again to move to discard folder.</p>
			</div>
			<div class="fixed top-10 flex flex-col items-center gap-2">
				<ArrowDown class="h-12 w-12 rotate-180" />
				<p class="text-lg">Back</p>
			</div>
		{/if}
	</div>
{/if}

<div
	class="fixed top-1/2 left-1/2 flex h-full w-full -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-all *:focus-within:outline-none"
	role="dialog"
	aria-modal="true"
	aria-label="Video player"
	onmousemove={resetHideTimer}
	onclick={(e) => e.target === e.currentTarget && onClose()}
	onkeydown={(e) => e.key === 'Escape' && onClose()}
	tabindex="-1"
	bind:this={videoContainer}
>
	<div class="flex items-center justify-center gap-2" tabindex="-1">
		<div class="flex flex-col gap-2">
			<video
				bind:this={videoEl}
				src={streamUrl}
				class="max-h-full max-w-full {videoSwipeState !== 'normal' ? 'pointer-events-none' : ''}"
				bind:currentTime
				bind:duration
				bind:paused
				bind:volume
				bind:muted
				bind:playbackRate
				onprogress={updateBuffered}
				onloadedmetadata={refreshAudioTracks}
				onclick={togglePlay}
				autoplay
				preload="auto"
			>
				<track kind="captions" srclang="en" label="English" default />
			</video>

			{#if videoSwipeState !== 'normal'}
				{#if videoSwipeState === 'up'}
					<input
						type="text"
						placeholder="Enter new name..."
						class="ack rounded bg-white/10 px-2 py-1"
						bind:value={video.name}
						onkeydown={(e) => e.stopPropagation()}
					/>
				{:else}
					<p>{video.name}</p>
				{/if}

				<p class="text-xs text-white/70">{video.path}</p>
			{/if}
		</div>
	</div>

	{#if streamLoading}
		<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
			<div
				class="h-10 w-10 animate-spin rounded-full border-2 border-white/25 border-t-white"
			></div>
		</div>
	{:else if streamError}
		<div class="absolute inset-0 flex items-center justify-center text-sm text-white/80">
			Couldn't load this video.
		</div>
	{/if}

	<div
		class="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-linear-to-t from-black/80 to-transparent p-4 transition-opacity {videoSwipeState !==
		'normal'
			? 'pointer-events-none! opacity-0!'
			: ''}"
		class:opacity-0={!controlsVisible}
		class:pointer-events-none={!controlsVisible}
	>
		<div class="relative h-3 w-full rounded bg-white/20">
			<div
				class="absolute h-full rounded bg-white"
				style="width: {(currentTime / (duration || 1)) * 100}%"
			></div>

			<input
				type="range"
				min="0"
				max={duration || 0}
				step="0.01"
				value={currentTime}
				onpointerdown={startScrub}
				oninput={handleSeekInput}
				onchange={endScrub}
				class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
			/>
		</div>

		<div class="flex items-center gap-3 text-sm text-white">
			<button onclick={togglePlay} class="w-6">{paused ? '▶' : '⏸'}</button>
			<button onclick={() => skip(-SKIP_LARGE)}>«{SKIP_LARGE}</button>
			<button onclick={() => skip(SKIP_LARGE)}>{SKIP_LARGE}»</button>

			<span class="tabular-nums">{formatTime(currentTime)} / {formatTime(duration)}</span>

			<div class="flex-1"></div>

			<div class="relative" bind:this={speedMenuRef}>
				<button
					type="button"
					onclick={toggleSpeedMenu}
					aria-haspopup="listbox"
					aria-expanded={speedMenuOpen}
					class="min-w-13 rounded bg-white/10 px-2 py-1 text-left"
				>
					{playbackRate}x
				</button>

				{#if speedMenuOpen}
					<div
						role="listbox"
						class="absolute right-0 bottom-full mb-1 max-h-56 w-16 overflow-y-auto rounded bg-neutral-900 py-1 shadow-lg"
					>
						{#each SPEEDS as speed (speed)}
							<button
								type="button"
								role="option"
								aria-selected={speed === playbackRate}
								onclick={() => chooseSpeed(speed)}
								class="block w-full px-2 py-1 text-left hover:bg-white/15"
								class:bg-white={speed === playbackRate}
							>
								{speed}x
							</button>
						{/each}
					</div>
				{/if}
			</div>

			{#if audioTracksList.length > 1}
				<select
					value={selectedAudioTrackId}
					onchange={(e) => onAudioTrackChange((e.target as HTMLSelectElement).value)}
					class="rounded bg-white/10 px-2 py-1"
				>
					{#each audioTracksList as track (track.id)}
						<option value={track.id}
							>{track.label}{track.language ? ` (${track.language})` : ''}</option
						>
					{/each}
				</select>
			{/if}

			<button onclick={() => (muted = !muted)}>{muted || volume === 0 ? '🔇' : '🔊'}</button>

			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				bind:value={volume}
				class="w-20 accent-white"
			/>

			<button onclick={() => videoEl?.requestFullscreen()}>⛶</button>
			<button onclick={onClose}>✕</button>
		</div>
	</div>
</div>
