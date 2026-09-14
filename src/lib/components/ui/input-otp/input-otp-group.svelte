<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="input-otp-group"
	class={cn("has-aria-invalid:border-b-destructive dark:has-aria-invalid:border-b-destructive/50 rounded-none gap-1 flex items-center", className)}
	{...restProps}
>
	{@render children?.()}
</div>
