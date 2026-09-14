<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { cn } from '$lib/utils';

	interface MorphingTextProps {
		texts: string[];
		class?: string;
	}

	let { texts, class: className }: MorphingTextProps = $props();

	const morphTime = 1.5;
	const returnDelay = 0.5;

	// The text that is currently displayed when we're idle.
	let currentIndex = $state(0);

	let morph = $state(0);
	let time = $state(new Date());

	let isAnimating = $state(false);
	let returning = $state(false);
	let delayUntil = $state(0);

	// These stay fixed for the entire animation.
	let fromText = $state('');
	let toText = $state('');

	let text1Ref: HTMLSpanElement | null = $state(null);
	let text2Ref: HTMLSpanElement | null = $state(null);

	let animationFrameId: number | null = null;

	const setStyles = (fraction: number) => {
		if (!text1Ref || !text2Ref) return;

		const clamped = Math.max(0, Math.min(1, fraction));

		const text1Fraction = 1 - clamped;

		// Text we're morphing TO.
		if (clamped <= 0) {
			text2Ref.style.filter = 'blur(100px)';
			text2Ref.style.opacity = '0%';
		} else {
			text2Ref.style.filter = `blur(${Math.min(8 / clamped - 8, 100)}px)`;
			text2Ref.style.opacity = `${Math.pow(clamped, 0.4) * 100}%`;
		}

		// Text we're morphing FROM.
		if (text1Fraction <= 0) {
			text1Ref.style.filter = 'blur(100px)';
			text1Ref.style.opacity = '0%';
		} else {
			text1Ref.style.filter = `blur(${Math.min(8 / text1Fraction - 8, 100)}px)`;
			text1Ref.style.opacity = `${Math.pow(text1Fraction, 0.4) * 100}%`;
		}
	};

	const startMorph = () => {
		if (isAnimating || texts.length < 2) return;

		// Capture the two texts for THIS animation.
		fromText = texts[currentIndex];
		toText = texts[(currentIndex + 1) % texts.length];

		if (text1Ref && text2Ref) {
			text1Ref.textContent = fromText;
			text2Ref.textContent = toText;

			// Start with the current text fully visible.
			text1Ref.style.filter = 'none';
			text1Ref.style.opacity = '100%';

			text2Ref.style.filter = 'blur(100px)';
			text2Ref.style.opacity = '0%';
		}

		morph = 0;
		returning = false;
		isAnimating = true;
	};

	const animateForward = (dt: number) => {
		morph += dt;

		const fraction = Math.min(morph / morphTime, 1);

		setStyles(fraction);

		if (fraction >= 1) {
			// We are now fully on the second text.
			returning = true;
			morph = 0;

			delayUntil = performance.now() + returnDelay * 1000;
		}
	};

	const animateReturn = (dt: number) => {
		// Small pause while the second text is visible.
		if (performance.now() < delayUntil) return;

		morph += dt;

		const fraction = Math.min(morph / morphTime, 1);

		// Reverse the morph.
		setStyles(1 - fraction);

		if (fraction >= 1) {
			// Completely back on the original text.
			isAnimating = false;
			returning = false;
			morph = 0;

			// IMPORTANT:
			// Do NOT change currentIndex here.
			// The current text remains the current text.

			if (text1Ref && text2Ref) {
				text1Ref.textContent = fromText;
				text2Ref.textContent = toText;

				text1Ref.style.filter = 'none';
				text1Ref.style.opacity = '100%';

				text2Ref.style.filter = 'blur(100px)';
				text2Ref.style.opacity = '0%';
			}
		}
	};

	const animate = () => {
		animationFrameId = requestAnimationFrame(animate);

		const newTime = new Date();
		const dt = (newTime.getTime() - time.getTime()) / 1000;

		time = newTime;

		if (!isAnimating) return;

		if (returning) {
			animateReturn(dt);
		} else {
			animateForward(dt);
		}
	};

	onMount(() => {
		fromText = texts[0];
		toText = texts[1 % texts.length];

		if (text1Ref) {
			text1Ref.textContent = fromText;
			text1Ref.style.opacity = '100%';
			text1Ref.style.filter = 'none';
		}

		if (text2Ref) {
			text2Ref.textContent = toText;
			text2Ref.style.opacity = '0%';
			text2Ref.style.filter = 'blur(100px)';
		}

		animate();
	});

	onDestroy(() => {
		if (animationFrameId !== null) {
			cancelAnimationFrame(animationFrameId);
		}
	});
</script>

<div
	class={cn(
		'relative mx-auto h-16 w-full max-w-3xl cursor-default text-center font-sans text-[40pt] leading-none font-bold filter-[url(#threshold)_blur(0.6px)] md:h-24 lg:text-[6rem]',
		className
	)}
	onclick={startMorph}
	role="button"
	tabindex="0"
	onkeydown={(event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			startMorph();
		}
	}}
>
	<span bind:this={text1Ref} class="absolute inset-x-0 top-0 m-auto inline-block w-full"></span>

	<span bind:this={text2Ref} class="absolute inset-x-0 top-0 m-auto inline-block w-full"></span>

	<svg id="filters" class="fixed h-0 w-0" preserveAspectRatio="xMidYMid slice">
		<defs>
			<filter id="threshold">
				<feColorMatrix
					in="SourceGraphic"
					type="matrix"
					values="1 0 0 0 0
						0 1 0 0 0
						0 0 1 0 0
						0 0 0 255 -140"
				/>
			</filter>
		</defs>
	</svg>
</div>
