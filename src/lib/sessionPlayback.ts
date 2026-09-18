export function createSessionPlayback<T>(getItems: () => T[]) {
	const seenIndexes = new Set<number>();

	function markSeen(index: number) {
		seenIndexes.add(index);
	}

	function getRandomUnseenIndex(): number | null {
		const total = getItems().length;

		if (total === 0 || seenIndexes.size >= total) return null;

		let index: number;

		do {
			index = Math.floor(Math.random() * total);
		} while (seenIndexes.has(index));

		seenIndexes.add(index);

		return index;
	}

	function requestNext(): { index: number; item: T } | null {
		const index = getRandomUnseenIndex();

		if (index === null) return null;

		const item = getItems()[index];

		return item ? { index, item } : requestNext();
	}

	function reset() {
		seenIndexes.clear();
	}

	return { markSeen, getRandomUnseenIndex, requestNext, reset };
}
