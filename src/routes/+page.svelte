<script lang="ts">
	import { resolve } from '$app/paths';
	import ProductPreview from '$lib/components/landing/ProductPreview.svelte';
	import ProductSections from '$lib/components/landing/ProductSections.svelte';
	import './public-home.css';
</script>

<svelte:head>
	<title>SoporteFlow — Tu soporte técnico, sin perder el hilo.</title>
	<meta
		name="description"
		content="Centraliza incidencias, organiza el trabajo técnico y mantén a cada cliente al tanto desde un único lugar. Prueba SoporteFlow."
	/>
</svelte:head>

<div class="public-home">
	<a class="skip-link" href="#contenido">Saltar al contenido</a>
	<header class="public-header">
		<div class="landing-container header-inner">
			<a href={resolve('/')} class="wordmark" aria-label="SoporteFlow, inicio"
				><span class="brand-symbol" aria-hidden="true">s<span>f</span></span>Soporte<span
					class="wordmark-flow">Flow</span
				></a
			>
			<nav aria-label="Navegación principal">
				<a href="#producto">Producto</a><a href="#equipos">Para tu equipo</a><a
					href={resolve('/app')}
					class="portal-link">Acceder al portal <span aria-hidden="true">↗</span></a
				>
			</nav>
		</div>
	</header>
	<main id="contenido" tabindex="-1">
		<section class="hero landing-container" aria-labelledby="hero-title">
			<div class="hero-copy">
				<p class="eyebrow">
					<span class="small-square" aria-hidden="true"></span> SOPORTE TÉCNICO, BIEN ORGANIZADO
				</p>
				<h1 id="hero-title">Tu soporte técnico,<br /><span>sin perder el hilo.</span></h1>
				<p class="hero-description">
					Centraliza incidencias, organiza el trabajo técnico y mantén a cada cliente al tanto desde
					un único lugar.
				</p>
				<div class="hero-actions">
					<a href={resolve('/app')} class="primary-link"
						>Probar SoporteFlow <span aria-hidden="true">↗</span></a
					><a href="#producto" class="text-link"
						>Conocer SoporteFlow <span aria-hidden="true">↓</span></a
					>
				</div>
				<p class="demo-note">Versión de demostración · Sin registro</p>
			</div>
			<ProductPreview />
		</section>
		<div class="workflow-strip" aria-label="Flujo previsto del producto">
			<div class="landing-container">
				<p class="workflow-caption">
					DEL AVISO A LA SOLUCIÓN <span>Visión del producto · Asignación prevista</span>
				</p>
				<ol>
					<li>Incidencia <span aria-hidden="true">→</span></li>
					<li>Clasificación <span aria-hidden="true">→</span></li>
					<li>Asignación <span aria-hidden="true">→</span></li>
					<li>Trabajo <span aria-hidden="true">→</span></li>
					<li>Solución</li>
				</ol>
			</div>
		</div>
		<ProductSections />
	</main>
	<footer class="landing-container public-footer">
		<a href={resolve('/')} class="wordmark">Soporte<span class="wordmark-flow">Flow</span></a>
		<p>Claridad para cada incidencia.</p>
		<a href={resolve('/app')}>Abrir demo <span aria-hidden="true">↗</span></a>
	</footer>
</div>
