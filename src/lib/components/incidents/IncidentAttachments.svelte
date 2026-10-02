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
	{#if uploaded}<p class="status-msg success" role="status">Adjunto subido correctamente.</p>{/if}
	{#if $controller.loading}
		<p class="status-msg" role="status">Cargando adjuntos…</p>
	{:else if !$controller.error && $controller.items.length === 0}
		<p class="empty-msg">No hay adjuntos en esta incidencia.</p>
	{/if}
	{#if $controller.error}
		<p class="error-msg" role="alert">{$controller.error}</p>
		<button
			type="button"
			class="btn btn-secondary"
			disabled={$controller.busy || $controller.loading}
			onclick={() => controller.load()}>Comprobar listado</button
		>
	{/if}
	{#if $controller.items.length > 0}
		<ul class="file-list">
			{#each $controller.items as item (item.id)}
				<li class="file-item">
					<span class="filename">{item.originalName}</span>
					<span class="file-size"
						>{(item.size / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} KB</span
					>
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={() => download(item)}
						aria-label={`Descargar ${item.originalName}`}>Descargar</button
					>
				</li>
			{/each}
		</ul>
	{/if}
	{#if canUpload}
		<div class="upload-zone">
			<label for="attachment-file" class="upload-label">Seleccionar un archivo</label>
			<input
				bind:this={input}
				id="attachment-file"
				type="file"
				accept={ATTACHMENT_ACCEPT}
				onchange={choose}
				disabled={$controller.busy || $controller.items.length >= 5}
				aria-describedby="attachment-help"
				class="file-input"
			/>
			<p id="attachment-help" class="hint">
				Los adjuntos son visibles para quienes tienen acceso a esta incidencia.
			</p>
			{#if selected}
				<p class="selected-info">
					<span class="filename">{selected.name}</span> · {(selected.size / 1024).toLocaleString(
						'es-ES',
						{
							maximumFractionDigits: 1
						}
					)} KB
				</p>
			{/if}
			{#if validation}
				<p class="error-msg" role="alert">{validation}</p>
			{/if}
			<div class="upload-actions">
				<button
					type="button"
					class="btn btn-primary"
					onclick={upload}
					disabled={!selected ||
						!!validation ||
						$controller.busy ||
						$controller.unknown ||
						$controller.items.length >= 5}
				>
					{$controller.busy ? 'Subiendo…' : 'Subir adjunto'}
				</button>
				{#if $controller.busy}
					<span class="status-msg" role="status">Confirmando la subida…</span>
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.attachments {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		color: var(--text-primary);
	}
	h2 {
		margin: 0;
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.hint {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
		line-height: 1.5;
	}
	.empty-msg {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.status-msg {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}
	.status-msg.success {
		color: var(--success-text, #16a34a);
		font-weight: 500;
	}
	.error-msg {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--danger-text, #dc2626);
	}
	.file-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
	}
	.file-item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) 0;
		border-bottom: 1px solid var(--border);
		font-size: var(--text-sm);
	}
	.file-item:last-child {
		border-bottom: none;
	}
	.filename {
		overflow-wrap: anywhere;
		flex: 1;
		min-width: 0;
		font-weight: 500;
		color: var(--text-primary);
	}
	.file-size {
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.upload-zone {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-2);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border);
	}
	.upload-label {
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-secondary);
	}
	.file-input {
		display: block;
		max-width: 100%;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}
	.file-input::file-selector-button {
		padding: var(--space-1) var(--space-3);
		margin-right: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-elevated, rgba(148, 163, 184, 0.1));
		color: var(--text-primary);
		font-family: inherit;
		font-size: var(--text-xs);
		font-weight: 500;
		cursor: pointer;
		transition: background var(--duration) var(--ease);
	}
	.file-input::file-selector-button:hover {
		background: var(--surface-hover, rgba(148, 163, 184, 0.16));
	}
	.selected-info {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}
	.upload-actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-1);
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-2) var(--space-4);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		font-family: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
		line-height: 1.25;
		cursor: pointer;
		transition: all var(--duration) var(--ease);
		text-decoration: none;
	}
	.btn-sm {
		padding: var(--space-1) var(--space-3);
		font-size: var(--text-xs);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn:focus-visible,
	.file-input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.btn-primary {
		background: var(--accent);
		color: var(--accent-contrast, #ffffff);
	}
	.btn-primary:hover:not(:disabled) {
		background: var(--accent-hover, var(--accent));
		filter: brightness(0.95);
	}
	.btn-secondary {
		background: var(--surface-elevated, rgba(148, 163, 184, 0.1));
		border-color: var(--border);
		color: var(--text-primary);
	}
	.btn-secondary:hover:not(:disabled) {
		background: var(--surface-hover, rgba(148, 163, 184, 0.16));
	}
	@media (max-width: 639px) {
		.attachments {
			padding: var(--space-5) var(--space-4);
		}
	}
</style>
