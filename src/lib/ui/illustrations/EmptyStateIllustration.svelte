<script lang="ts">
	/**
	 * Decorative empty-state illustration (UI-1C): a floating ticket card, abstract lines, soft
	 * circles and a "+" badge. Pure SVG, token-driven colors (via classes, so both themes work),
	 * no domain logic, hidden from assistive technology. The float animation is disabled by the
	 * global prefers-reduced-motion rule.
	 */
	let { size = 200 }: { size?: number } = $props();
	const uid = $props.id();
</script>

<svg
	class="sf-illustration"
	width={size}
	height={Math.round((size * 150) / 220)}
	viewBox="0 0 220 150"
	fill="none"
	aria-hidden="true"
	focusable="false"
>
	<defs>
		<radialGradient id="{uid}-halo" cx="0.5" cy="0.5" r="0.5">
			<stop offset="0" class="stop-halo" />
			<stop offset="1" class="stop-transparent" />
		</radialGradient>
		<linearGradient id="{uid}-badge" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" class="stop-cyan-400" />
			<stop offset="1" class="stop-cyan-600" />
		</linearGradient>
	</defs>

	<!-- soft background -->
	<circle cx="110" cy="76" r="70" fill="url(#{uid}-halo)" />
	<circle class="ring" cx="110" cy="76" r="56" stroke-dasharray="2 6" />
	<circle class="dot-soft" cx="36" cy="40" r="5" />
	<circle class="dot-soft" cx="190" cy="112" r="7" />
	<circle class="dot-accent" cx="182" cy="34" r="2.5" />
	<circle class="dot-accent" cx="28" cy="108" r="2" />

	<!-- back card -->
	<rect class="card-back" x="62" y="44" width="104" height="72" rx="10" />

	<g class="float">
		<!-- ticket card -->
		<rect class="card-shadow" x="52" y="40" width="112" height="76" rx="11" />
		<rect class="card" x="50" y="34" width="112" height="76" rx="11" />
		<circle class="status" cx="66" cy="51" r="4" />
		<rect class="line-strong" x="76" y="48" width="44" height="6" rx="3" />
		<rect class="pill" x="128" y="46" width="22" height="10" rx="5" />
		<rect class="line" x="62" y="66" width="86" height="5" rx="2.5" />
		<rect class="line" x="62" y="77" width="66" height="5" rx="2.5" />
		<rect class="divider" x="62" y="91" width="88" height="1" />
		<circle class="avatar" cx="68" cy="100" r="4" />
		<rect class="line" x="76" y="98" width="30" height="4" rx="2" />
	</g>

	<!-- plus badge -->
	<circle class="badge-glow" cx="164" cy="36" r="17" />
	<circle cx="164" cy="36" r="12" fill="url(#{uid}-badge)" />
	<path class="badge-plus" d="M164 30.5v11M158.5 36h11" />
</svg>

<style>
	.sf-illustration {
		display: block;
		max-width: 100%;
		height: auto;
	}
	.stop-halo {
		stop-color: var(--sf-cyan-500);
		stop-opacity: 0.14;
	}
	.stop-transparent {
		stop-color: var(--sf-cyan-500);
		stop-opacity: 0;
	}
	.stop-cyan-400 {
		stop-color: var(--sf-cyan-400);
	}
	.stop-cyan-600 {
		stop-color: var(--sf-cyan-600);
	}
	.ring {
		stroke: var(--sf-cyan-border);
		stroke-width: 1;
	}
	.dot-soft {
		fill: var(--surface-subtle);
		stroke: var(--border);
	}
	.dot-accent {
		fill: var(--sf-cyan-400);
		opacity: 0.7;
	}
	.card-back {
		fill: var(--surface-subtle);
		stroke: var(--border);
	}
	.card-shadow {
		fill: var(--text-primary);
		opacity: 0.05;
	}
	.card {
		fill: var(--surface-card);
		stroke: var(--border-strong);
	}
	.status {
		fill: var(--sf-cyan-500);
	}
	.line-strong {
		fill: var(--text-subtle);
		opacity: 0.8;
	}
	.pill {
		fill: var(--sf-cyan-glow);
		stroke: var(--sf-cyan-border);
	}
	.line {
		fill: var(--border-strong);
		opacity: 0.8;
	}
	.divider {
		fill: var(--border);
	}
	.avatar {
		fill: var(--sf-navy-700);
		opacity: 0.35;
	}
	.badge-glow {
		fill: var(--sf-cyan-glow);
	}
	.badge-plus {
		stroke: var(--sf-navy-text-active);
		stroke-width: 2.2;
		stroke-linecap: round;
	}
	.float {
		animation: sf-float 6s var(--ease) infinite alternate;
	}
	@keyframes sf-float {
		from {
			transform: translateY(0);
		}
		to {
			transform: translateY(-3px);
		}
	}
</style>
