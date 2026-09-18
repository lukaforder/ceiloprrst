export interface ThumbnailResult {
	dataUrl: string;
	blurhash: string;
}

export function generateThumbnail(
	path: string,
	convertFileSrc: (path: string) => string,
	encodeBlurhashFromCanvas: (canvas: HTMLCanvasElement) => string,
	thumbWidth = 320
): Promise<ThumbnailResult | null> {
	return new Promise((resolve) => {
		const video = document.createElement('video');

		video.src = convertFileSrc(path);
		video.muted = true;
		video.crossOrigin = 'anonymous';
		video.preload = 'metadata';

		const cleanup = (result: ThumbnailResult | null) => {
			video.remove();
			resolve(result);
		};

		video.addEventListener('loadedmetadata', () => {
			video.currentTime = Math.min(1, video.duration / 2);
		});

		video.addEventListener('seeked', () => {
			const canvas = document.createElement('canvas');
			const scale = thumbWidth / video.videoWidth;

			canvas.width = thumbWidth;
			canvas.height = video.videoHeight * scale;

			const ctx = canvas.getContext('2d');

			if (!ctx) return cleanup(null);

			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

			cleanup({
				dataUrl: canvas.toDataURL('image/jpeg', 0.6),
				blurhash: encodeBlurhashFromCanvas(canvas)
			});
		});

		video.addEventListener('error', () => cleanup(null));
	});
}
