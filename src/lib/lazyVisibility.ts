export interface LazyVisibilityOptions<T> {
	getKey: (item: T) => string;
	onVisible: (item: T) => void;
	visibleDelay?: number;
	root?: Element | null;
	threshold?: number;
}

export function createLazyVisibility<T>(options: LazyVisibilityOptions<T>) {
	const { getKey, onVisible, visibleDelay = 150, threshold = 0.01 } = options;

	const intersecting = new Set<string>();
	const timers = new Map<string, number>();
	const pending = new Map<string, T>();
	const items = new WeakMap<Element, T>();

	let scrolling = false;
	let observer: IntersectionObserver | null = null;

	function getObserver(): IntersectionObserver {
		if (observer) return observer;

		observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const item = items.get(entry.target);
					if (!item) continue;

					const key = getKey(item);

					if (entry.isIntersecting) {
						intersecting.add(key);

						const timer = window.setTimeout(() => {
							timers.delete(key);
							if (!intersecting.has(key)) return;

							if (scrolling) {
								pending.set(key, item);
							} else {
								onVisible(item);
							}
						}, visibleDelay);

						timers.set(key, timer);
					} else {
						intersecting.delete(key);
						pending.delete(key);

						const existing = timers.get(key);

						if (existing !== undefined) {
							clearTimeout(existing);
							timers.delete(key);
						}
					}
				}
			},
			{ root: options.root ?? null, threshold }
		);

		return observer;
	}

	function setScrolling(value: boolean) {
		scrolling = value;
	}

	function flushPending() {
		for (const item of pending.values()) {
			if (intersecting.has(getKey(item))) onVisible(item);
		}

		pending.clear();
	}

	function action(node: Element, item: T) {
		items.set(node, item);
		getObserver().observe(node);

		return {
			destroy() {
				const key = getKey(item);

				intersecting.delete(key);
				pending.delete(key);

				const existing = timers.get(key);

				if (existing !== undefined) {
					clearTimeout(existing);
					timers.delete(key);
				}

				observer?.unobserve(node);
				items.delete(node);
			}
		};
	}

	return { action, setScrolling, flushPending };
}
