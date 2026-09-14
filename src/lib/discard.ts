import { dirname, join } from '@tauri-apps/api/path';
import { mkdir, rename } from '@tauri-apps/plugin-fs';

export async function moveFileToFolder(filePath: string, folderName: string): Promise<string> {
	const currentDir = await dirname(filePath);
	const destinationDir = await join(currentDir, folderName);

	await mkdir(destinationDir, { recursive: true });

	const fileName = filePath.split(/[\\/]/).pop();

	if (!fileName) {
		throw new Error(`Could not determine filename from path: ${filePath}`);
	}

	const destinationPath = await join(destinationDir, fileName);

	await rename(filePath, destinationPath);

	return destinationPath;
}
