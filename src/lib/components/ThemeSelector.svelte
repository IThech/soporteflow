<script lang="ts">
	import { onMount } from 'svelte';
	import { parseTheme, readTheme, saveTheme, resolveTheme, type ThemePreference } from '$lib/theme';
	let preference = $state<ThemePreference>('system');
	let ready = $state(false);
	let error = $state('');
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
	function change(event: Event) {
		preference = parseTheme((event.currentTarget as HTMLSelectElement).value);
		apply();
		try {
			error = saveTheme(window.localStorage, preference) ? '' : 'No se pudo guardar la apariencia.';
		} catch {
			error = 'No se pudo guardar la apariencia.';
		}
	}
</script>

<div class="text-sm">
	<label for="app-theme" class="mr-2 text-slate-300">Apariencia</label>
	<select
		id="app-theme"
		value={preference}
		disabled={!ready}
		onchange={change}
		class="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-white"
	>
		<option value="light">Claro</option><option value="dark">Oscuro</option><option value="system"
			>Sistema</option
		>
	</select>
	{#if error}<p role="status" class="mt-1 text-xs text-red-300">{error}</p>{/if}
</div>
