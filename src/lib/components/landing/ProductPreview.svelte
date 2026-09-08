<script lang="ts">
	const tickets = [
		{
			id: '104',
			title: 'Sin conexión en recepción',
			client: 'Clínica Norte',
			priority: 'Alta',
			state: 'Abierta',
			tone: 'cyan'
		},
		{
			id: '103',
			title: 'Configurar acceso remoto',
			client: 'Madera Viva',
			priority: 'Media',
			state: 'Pendiente',
			tone: 'amber'
		},
		{
			id: '102',
			title: 'Actualizar certificado web',
			client: 'Estudio Delta',
			priority: 'Baja',
			state: 'Resuelta',
			tone: 'green'
		}
	];
</script>

<figure class="product-preview" aria-labelledby="preview-caption">
	<div class="preview-top">
		<span class="preview-brand">Soporte<span>Flow</span></span><span class="preview-org"
			>Nodhouses <span aria-hidden="true">⌄</span></span
		>
	</div>
	<div class="preview-content">
		<div class="preview-heading">
			<div>
				<p class="preview-eyebrow">TU ESPACIO DE SOPORTE</p>
				<h2>Todo en su sitio.</h2>
			</div>
			<span class="preview-label">Vista de ejemplo</span>
		</div>
		<div class="preview-stats">
			<div>
				<span class="stat-cyan">01</span>
				<p>Abierta</p>
			</div>
			<div>
				<span class="stat-amber">01</span>
				<p>Pendiente</p>
			</div>
			<div>
				<span class="stat-green">01</span>
				<p>Resuelta</p>
			</div>
		</div>
		<div class="preview-list">
			<div class="preview-list-heading">
				<span>Incidencias recientes</span><span>03 casos</span>
			</div>
			{#each tickets as ticket (ticket.id)}
				<div class="preview-ticket">
					<span class="ticket-number">#{ticket.id}</span>
					<div class="ticket-subject">
						<h3>{ticket.title}</h3>
						<p>
							{ticket.client} <span aria-hidden="true">·</span> Prioridad {ticket.priority.toLowerCase()}
						</p>
					</div>
					<span class={`ticket-state ${ticket.tone}`}>{ticket.state}</span>
				</div>
			{/each}
		</div>
		<div class="preview-resolution">
			<span class="resolution-check" aria-hidden="true">✓</span>
			<div>
				<strong>El trabajo queda documentado.</strong>
				<p>Certificado renovado y acceso web comprobado.</p>
			</div>
		</div>
	</div>
	<figcaption id="preview-caption">Representación del producto con datos ficticios.</figcaption>
</figure>
