export function computeColumns(width: number): number {
	if (width >= 1024) return 5;
	if (width >= 768) return 4;
	if (width >= 640) return 3;
	return 2;
}
