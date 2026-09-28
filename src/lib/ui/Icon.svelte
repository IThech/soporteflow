<script lang="ts" module>
	/**
	 * Own line icon set (UI-1C): 24×24 grid, 1.75 stroke, round caps, currentColor. Only icons
	 * with a real use today; no icon library.
	 */
	const PATHS = {
		inbox:
			'M3 13h4.5l1.5 3h6l1.5-3H21M5.2 5.6 3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-2.2-7.4A2 2 0 0 0 16.9 4H7.1a2 2 0 0 0-1.9 1.6Z',
		plus: 'M12 5v14M5 12h14',
		'plus-square':
			'M12 8.5v7M8.5 12h7M6 3.5h12A2.5 2.5 0 0 1 20.5 6v12a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5Z',
		building:
			'M4 20.5h16M6 20.5V5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 18 5v15.5M9.5 7.5h1m3 0h1m-5 4h1m3 0h1m-5 4h1m3 0h1',
		'chevron-down': 'm6.5 9.5 5.5 5.5 5.5-5.5',
		'chevron-left': 'm14.5 6-6 6 6 6',
		'chevron-right': 'm9.5 6 6 6-6 6',
		menu: 'M4 7h16M4 12h16M4 17h16',
		'log-out': 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16.5 14.5 12 10 7.5M14.5 12H4',
		'filter-x': 'M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z'
	} as const;
	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	let {
		name,
		size = 18,
		strokeWidth = 1.75
	}: { name: IconName; size?: number; strokeWidth?: number } = $props();
</script>

<svg
	class="sf-icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"><path d={PATHS[name]} /></svg
>

<style>
	.sf-icon {
		flex: none;
		display: block;
	}
</style>
