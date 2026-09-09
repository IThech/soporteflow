<script lang="ts">
	import { onMount } from 'svelte';
	import { readTheme, saveTheme, resolveTheme, type ThemePreference } from '$lib/theme';
	let preference = $state<ThemePreference>('system');
	let ready = $state(false);
	let error = $state('');
	let open = $state(false);
	let panel: HTMLDetailsElement;
	let trigger: HTMLElement;
	const choices = [
		{ value: 'light', label: 'Claro' },
		{ value: 'dark', label: 'Oscuro' },
		{ value: 'system', label: 'Sistema' }
	] as const;
	const selectedLabel = $derived(choices.find((choice) => choice.value === preference)?.label);
	let apply = () => {};
	onMount(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		try {
			preference = readTheme(window.localStorage);
		} catch {
			preference = 'system';
		}
		apply = () => {
			document.documentElement.dataset.appTheme = resolveTheme(preference, media.matches);
		};
		apply();
		ready = true;
		media.addEventListener('change', apply);
		return () => {
			media.removeEventListener('change', apply);
			delete document.documentElement.dataset.appTheme;
		};
	});
	function change(value: ThemePreference) {
		preference = value;
		open = false;
		trigger?.focus();
		apply();
		try {
			error = saveTheme(window.localStorage, preference) ? '' : 'No se pudo guardar la apariencia.';
		} catch {
			error = 'No se pudo guardar la apariencia.';
		}
		if (error) open = true;
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && open) {
			open = false;
			trigger?.focus();
		}
	}}
	onclick={(event) => {
		if (open && event.target instanceof Node && !panel?.contains(event.target)) open = false;
	}}
/>
<details class="appearance-control" bind:this={panel} bind:open>
	<summary
		bind:this={trigger}
		aria-label={`Apariencia: ${selectedLabel}`}
		title={`Apariencia: ${selectedLabel}`}
	>
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			aria-hidden="true"
			><circle cx="12" cy="12" r="4" /><path
				d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"
			/></svg
		>
	</summary>
	<div class="appearance-menu" role="group" aria-label="Apariencia">
		<p class="mb-2 text-xs font-semibold text-slate-400">Apariencia</p>
		{#each choices as choice (choice.value)}
			<button
				type="button"
				disabled={!ready}
				aria-pressed={preference === choice.value}
				onclick={() => change(choice.value)}
			>
				<span>{choice.label}</span><span aria-hidden="true"
					>{preference === choice.value ? '✓' : ''}</span
				>
			</button>
		{/each}
		{#if error}<p role="status" class="mt-2 text-xs text-red-300">{error}</p>{/if}
	</div>
</details>
