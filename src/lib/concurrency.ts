export function createPool(limit: number) {
	let active = 0;
	const queue: (() => void)[] = [];

	function next() {
		if (active >= limit || queue.length === 0) return;
		active++;
		const task = queue.shift()!;
		task();
	}

	return function run<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			queue.push(() => {
				fn()
					.then(resolve, reject)
					.finally(() => {
						active--;
						next();
					});
			});
			next();
		});
	};
}
