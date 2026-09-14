import { encode, decode } from 'blurhash';

// Encode from the small thumbnail canvas we already produced — no extra video decode.
export function encodeBlurhashFromCanvas(canvas: HTMLCanvasElement): string {
	const w = 32;
	const h = Math.max(1, Math.round((w * canvas.height) / canvas.width));

	const tiny = document.createElement('canvas');
	tiny.width = w;
	tiny.height = h;
	const ctx = tiny.getContext('2d');
	if (!ctx) return '';
	ctx.drawImage(canvas, 0, 0, w, h);

	const { data } = ctx.getImageData(0, 0, w, h);
	return encode(data, w, h, 4, 3);
}

// Decode a blurhash string into a small blurred data URL, cheap and synchronous-ish.
export function blurhashToDataUrl(hash: string, width = 32, height = 20): string {
	const pixels = decode(hash, width, height);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) return '';
	const imageData = ctx.createImageData(width, height);
	imageData.data.set(pixels);
	ctx.putImageData(imageData, 0, 0);
	return canvas.toDataURL('image/png');
}
