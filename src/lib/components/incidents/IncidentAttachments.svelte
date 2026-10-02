<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { TenantIdentity } from '$lib/app/tenant-identity';
	import { tenantKey } from '$lib/app/tenant-identity';
	import { createAttachmentController } from '$lib/app/incident-attachments';
	import {
		ATTACHMENT_ACCEPT,
		attachmentFileError,
		type IncidentAttachment
	} from '$lib/attachments';
	let {
		identity,
		incidentId,
		capabilities,
		closed = false,
		onSessionExpiry
	}: {
		identity: TenantIdentity | null;
		incidentId: string;
		capabilities: readonly string[];
		closed?: boolean;
		onSessionExpiry: () => void;
	} = $props();
	const controller = createAttachmentController(undefined, () => onSessionExpiry());
	let selected = $state<File | null>(null);
	let validation = $state<string | null>(null);
	let uploaded = $state(false);
	let input = $state<HTMLInputElement>();
	const canUpload = $derived(capabilities.includes('incidents:add_comment') && !closed);
	$effect(() => {
		const key = tenantKey(identity) + incidentId;
		void key;
		selected = null;
		validation = null;
		uploaded = false;
		controller.setTarget(identity, incidentId);
	});
	onDestroy(() => controller.dispose());
	function choose(event: Event) {
		selected = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		validation = selected ? attachmentFileError(selected) : null;
	}
	async function upload() {
		if (!selected || validation) return;
		uploaded = false;
		if (await controller.upload(selected)) {
			uploaded = true;
			selected = null;
			if (input) input.value = '';
		}
	}
	async function download(item: IncidentAttachment) {
		const blob = await controller.download(item.id);
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = item.originalName;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<section class="attachments" aria-labelledby="attachments-heading">
	<h2 id="attachments-heading">Adjuntos</h2>
	<p class="hint">
		PDF, JPG/JPEG, PNG o WebP · Máximo 5 MB por archivo y 5 archivos por incidencia.
	</p>
	{#if uploaded}<p role="status">Adjunto subido correctamente.</p>{/if}
	{#if $controller.loading}<p role="status">
			Cargando adjuntos…
		</p>{:else if !$controller.error && $controller.items.length === 0}<p>
			No hay adjuntos en esta incidencia.
		</p>{/if}
	{#if $controller.error}<p role="alert">{$controller.error}</p>
		<button
			type="button"
			disabled={$controller.busy || $controller.loading}
			onclick={() => controller.load()}>Comprobar listado</button
		>{/if}
	<ul>
		{#each $controller.items as item (item.id)}<li>
				<span class="filename">{item.originalName}</span><span
					>{(item.size / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} KB</span
				><button
					type="button"
					onclick={() => download(item)}
					aria-label={`Descargar ${item.originalName}`}>Descargar</button
				>
			</li>{/each}
	</ul>
	{#if canUpload}
		<label for="attachment-file">Seleccionar un archivo</label>
		<input
			bind:this={input}
			id="attachment-file"
			type="file"
			accept={ATTACHMENT_ACCEPT}
			onchange={choose}
			disabled={$controller.busy || $controller.items.length >= 5}
			aria-describedby="attachment-help"
		/>
		<p id="attachment-help" class="hint">
			Los adjuntos son visibles para quienes tienen acceso a esta incidencia.
		</p>
		{#if selected}<p class="filename">
				{selected.name} · {(selected.size / 1024).toLocaleString('es-ES', {
					maximumFractionDigits: 1
				})} KB
			</p>{/if}
		{#if validation}<p role="alert">{validation}</p>{/if}
		<button
			type="button"
			onclick={upload}
			disabled={!selected ||
				!!validation ||
				$controller.busy ||
				$controller.unknown ||
				$controller.items.length >= 5}>{$controller.busy ? 'Subiendo…' : 'Subir adjunto'}</button
		>
		{#if $controller.busy}<p role="status">Confirmando la subida…</p>{/if}
	{/if}
</section>

<style>
	.attachments {
		min-width: 0;
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		color: var(--text-primary);
	}
	h2 {
		font-size: 1rem;
		font-weight: 600;
	}
	.hint {
		font-size: 0.875rem;
		opacity: 0.75;
		margin-block: 0.5rem;
	}
	ul {
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding-block: 0.75rem;
		border-bottom: 1px solid var(--border);
	}
	.filename {
		overflow-wrap: anywhere;
		flex: 1;
		min-width: 0;
	}
	input {
		display: block;
		max-width: 100%;
		margin-block: 0.5rem;
	}
	button {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}
	button:disabled {
		opacity: 0.5;
	}
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}
</style>
