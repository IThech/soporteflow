<script lang="ts">
	import '$lib/styles/tokens.css';
	import { onDestroy } from 'svelte';
	import { provideOrganizationContext } from '$lib/app/context';

	/**
	 * /app tree (UI-1A): provides the organization context (native Svelte context, one instance per
	 * layout mount; nothing is fetched during SSR — pages load it from client effects). It renders
	 * no chrome: the new AppShell is composed by the migrated pages, while the isolated demo
	 * (/app/demo) and the not-yet-migrated incident detail/new pages keep their own layout.
	 */
	let { children } = $props();
	const context = provideOrganizationContext();
	onDestroy(() => context.dispose());
</script>

{@render children()}
