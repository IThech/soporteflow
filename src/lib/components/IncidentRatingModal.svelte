<script lang="ts">
	import type { Incident } from '$lib/types/incident';

	interface Props {
		open: boolean;
		incident: Incident;
		technicianName?: string;
		onSave: (rating: number, comment?: string) => void;
		onClose: () => void;
	}

	let { open, incident, technicianName, onSave, onClose }: Props = $props();

	let selectedRating = $state(0);
	let hoverRating = $state(0);
	let comment = $state('');
	let submitting = $state(false);

	$effect(() => {
		if (open) {
			selectedRating = 0;
			hoverRating = 0;
			comment = '';
			submitting = false;
		}
	});

	const activeRating = $derived(hoverRating > 0 ? hoverRating : selectedRating);

	const ratingLabels: Record<number, string> = {
		1: 'Muy insatisfecho',
		2: 'Insatisfecho',
		3: 'Aceptable',
		4: 'Satisfecho',
		5: 'Muy satisfecho'
	};

	function show(dialog: HTMLDialogElement) {
		dialog.showModal();
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (selectedRating < 1 || selectedRating > 5) return;
		submitting = true;
		onSave(selectedRating, comment.trim() || undefined);
	}
</script>

{#if open}
	<dialog
		use:show
		class="fixed inset-0 m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
		aria-labelledby="rating-modal-title"
		oncancel={(e) => {
			e.preventDefault();
			onClose();
		}}
	>
		<div class="flex items-center justify-between border-b border-slate-800 pb-4">
			<h2 id="rating-modal-title" class="text-lg font-semibold text-white">
				Valorar resolución del soporte
			</h2>
			<button
				type="button"
				onclick={onClose}
				class="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
				aria-label="Cerrar modal"
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		<form onsubmit={handleSubmit} class="mt-4 space-y-4">
			<div class="text-sm text-slate-300">
				<p class="font-medium text-white">#{incident.id} · {incident.title}</p>
				{#if technicianName}
					<p class="mt-1 text-xs text-slate-400">
						Atendido por: <strong class="text-slate-200">{technicianName}</strong>
					</p>
				{/if}
				<p class="mt-2 text-xs text-slate-400">
					Tu opinión nos ayuda a mejorar la calidad del servicio de soporte técnico.
				</p>
			</div>

			<!-- Selector de Estrellas -->
			<div
				class="flex flex-col items-center justify-center rounded-xl border border-slate-800/80 bg-slate-950/60 py-3"
			>
				<div
					class="flex items-center gap-1.5"
					role="group"
					aria-label="Calificación de 1 a 5 estrellas"
				>
					{#each [1, 2, 3, 4, 5] as star (star)}
						<button
							type="button"
							onclick={() => (selectedRating = star)}
							onmouseenter={() => (hoverRating = star)}
							onmouseleave={() => (hoverRating = 0)}
							class="rounded-md p-1 transition-transform hover:scale-115 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-400"
							aria-label="{star} {star === 1 ? 'estrella' : 'estrellas'}"
							aria-pressed={selectedRating === star}
						>
							<svg
								class="h-8 w-8 {star <= activeRating
									? 'fill-amber-400 text-amber-400'
									: 'fill-none text-slate-600'} transition-colors"
								viewBox="0 0 24 24"
								stroke="currentColor"
								stroke-width="1.5"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
								/>
							</svg>
						</button>
					{/each}
				</div>
				<div class="mt-2 h-5 text-center">
					{#if activeRating > 0}
						<span class="animate-in fade-in text-xs font-medium text-amber-300">
							{ratingLabels[activeRating]}
						</span>
					{:else}
						<span class="text-xs text-slate-500">Selecciona una puntuación</span>
					{/if}
				</div>
			</div>

			<!-- Comentario opcional -->
			<div>
				<label for="rating-comment" class="mb-1 block text-xs font-medium text-slate-300">
					Comentario adicional <span class="font-normal text-slate-500">(opcional)</span>
				</label>
				<textarea
					id="rating-comment"
					bind:value={comment}
					rows="3"
					maxlength="500"
					placeholder="Cuéntanos brevemente qué te pareció la resolución o el trato recibido..."
					class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:outline-hidden"
				></textarea>
			</div>

			<!-- Botones -->
			<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-3">
				<button
					type="button"
					onclick={onClose}
					class="cursor-pointer rounded-xl px-4 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
				>
					Ahora no
				</button>
				<button
					type="submit"
					disabled={selectedRating === 0 || submitting}
					class="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-amber-500 px-5 py-2 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-amber-400 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span>Enviar valoración</span>
				</button>
			</div>
		</form>
	</dialog>
{/if}
