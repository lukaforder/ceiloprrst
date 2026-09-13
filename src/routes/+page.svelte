<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';

	import { toggleMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { open } from '@tauri-apps/plugin-dialog';
	import { readDir, readFile } from '@tauri-apps/plugin-fs';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let entries: any[] = $state([]);

	async function pickAndLoad() {
		const dir = await open({
			directory: true,
			multiple: false
		});

		if (!dir || Array.isArray(dir)) return;

		entries = await readDir(dir);

		// files = await Promise.all(
		// 	entries
		// 		.filter((e) => !e.isFile) // only files
		// 		.map(async (file) => {
		// 			const content = await readFile(file.name);
		// 			return {
		// 				name: file.name,
		// 				content
		// 			};
		// 		})
		// );
	}
</script>

<Button onclick={toggleMode} variant="outline" size="icon">
	<SunIcon
		class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all! dark:scale-0 dark:-rotate-90"
	/>
	<MoonIcon
		class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all! dark:scale-100 dark:rotate-0"
	/>
	<span class="sr-only">Toggle theme</span>
</Button>

<!-- <AlertDialog.Root>
	<AlertDialog.Trigger class={buttonVariants({ variant: 'outline' })}>
		Show Dialog
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Add a videos directory</AlertDialog.Title>
			<AlertDialog.Description
				>this needs to be done by you so that the app has permission to read your files</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Later</AlertDialog.Cancel>
			<AlertDialog.Action onclick={addDirectory()}>Continue</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root> -->

<button onclick={pickAndLoad}> Select Folder </button>

<ul>
	{#each entries as file, i (file.name)}
		<li>
			<strong>{file.name}</strong>
			<pre>{file.content}</pre>
		</li>
	{/each}
</ul>
