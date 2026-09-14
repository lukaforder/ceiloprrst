export function visible(node: HTMLElement, callback: () => void) {
	let timer: ReturnType<typeof setTimeout> | null = null;

	const observer = new IntersectionObserver(
		(entries) => {
			const entry = entries[0];
			if (entry.isIntersecting) {
				timer = setTimeout(() => {
					callback();
					observer.disconnect();
				}, 150);
			} else if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
		{ rootMargin: '200px' }
	);
	observer.observe(node);

	return {
		destroy() {
			if (timer) clearTimeout(timer);
			observer.disconnect();
		}
	};
}
