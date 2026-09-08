<script lang="ts">
	import { resolve } from '$app/paths';
	const features = [
		{
			number: '01',
			title: 'Cada incidencia, con contexto.',
			text: 'Título, cliente, prioridad y descripción del problema. La información que necesitas para empezar a trabajar.'
		},
		{
			number: '02',
			title: 'Encuentra. Filtra. Continúa.',
			text: 'Busca por identificador, título o cliente. Filtra por estado y recupera el caso que necesitas sin recorrer toda la lista.'
		},
		{
			number: '03',
			title: 'Resolver también es explicar.',
			text: 'Registra la solución aplicada antes de cerrar una incidencia. El resultado queda junto al problema que lo originó.'
		}
	];
</script>

<section id="producto" class="landing-container product-section" aria-labelledby="product-title">
	<div class="section-intro">
		<p class="eyebrow">EL TRABAJO, A LA VISTA</p>
		<h2 id="product-title">Menos vueltas.<br />Más contexto.</h2>
		<p>Consulta qué sigue abierto, qué está pendiente y qué ya tiene solución.</p>
	</div>
	<div class="feature-grid">
		{#each features as feature (feature.number)}
			<article class="feature">
				<span class="feature-number">{feature.number} /</span>
				<h3>{feature.title}</h3>
				<p>{feature.text}</p>
			</article>
		{/each}
	</div>
</section>

<section class="landing-container difference-section" aria-labelledby="difference-title">
	<div>
		<p class="eyebrow">POR QUÉ SOPORTEFLOW</p>
		<h2 id="difference-title">
			Menos clics.<br />Más contexto.<br /><span>Mejor seguimiento.</span>
		</h2>
	</div>
	<div class="difference-points">
		<article>
			<h3>Rapidez para el técnico</h3>
			<p>Busca una incidencia, consulta el problema y actualiza su estado desde el panel.</p>
		</article>
		<article>
			<h3>El contexto, junto al caso</h3>
			<p>
				Problema, prioridad, estado y solución permanecen en la misma incidencia. El historial y las
				comunicaciones están previstos para ampliar ese contexto.
			</p>
		</article>
		<article>
			<h3>Seguimiento compartido</h3>
			<p>
				Empresa y técnico consultan los casos de su organización; el cliente, los suyos. Un mismo
				estado como referencia para seguir el trabajo.
			</p>
		</article>
	</div>
</section>

<section id="equipos" class="team-section" aria-labelledby="team-title">
	<div class="landing-container team-grid">
		<div class="team-copy">
			<p class="eyebrow">PARA QUIEN RESUELVE</p>
			<h2 id="team-title">Tus incidencias,<br /><span>sin ruido.</span></h2>
			<p>
				Retoma el trabajo con la descripción del problema a mano. Actualiza el estado y deja
				constancia de la solución aplicada.
			</p>
			<a href={resolve('/app')} class="text-link"
				>Probar la vista de técnico <span aria-hidden="true">↗</span></a
			>
			<p class="team-demo-note">En la demo, selecciona «Técnico de prueba».</p>
		</div>
		<div class="technician-note">
			<div class="note-heading">
				<span>UNA INCIDENCIA BIEN DOCUMENTADA</span><span aria-hidden="true">↙</span>
			</div>
			<div class="note-row">
				<span class="note-label">Problema</span>
				<p>El equipo de recepción no tiene acceso a la red.</p>
			</div>
			<div class="note-row">
				<span class="note-label">Prioridad</span>
				<p><span class="priority-indicator" aria-hidden="true"></span> Alta</p>
			</div>
			<div class="note-row">
				<span class="note-label">Solución</span>
				<p>Cable sustituido. Conexión y acceso a los recursos comprobados.</p>
			</div>
			<p class="note-foot">Ejemplo de una solución documentada.</p>
		</div>
	</div>
</section>

<section class="landing-container organization-section" aria-labelledby="organization-title">
	<div class="section-intro">
		<p class="eyebrow">PARA QUIEN COORDINA</p>
		<h2 id="organization-title">Una visión común.<br />Un papel para cada persona.</h2>
		<p>
			Cada organización tiene su espacio y cada rol, sus permisos. Prueba las tres vistas en la
			demo.
		</p>
	</div>
	<div class="role-grid">
		<article>
			<span class="role-tag">EMPRESA</span>
			<h3>Orden para coordinar.</h3>
			<p>
				Consulta el resumen de estados y mantén el catálogo de categorías. Organiza el soporte con
				criterios compartidos.
			</p>
			<span class="role-detail">Vista de administrador</span>
		</article>
		<article>
			<span class="role-tag">TÉCNICO</span>
			<h3>Espacio para resolver.</h3>
			<p>
				Trabaja con las incidencias de tu organización, actualiza su estado y documenta la solución.
			</p>
			<span class="role-detail">Permisos según el rol</span>
		</article>
		<article>
			<span class="role-tag">CLIENTE</span>
			<h3>Claridad para seguir.</h3>
			<p>
				Registra una incidencia y consulta tus propios casos, su estado y la solución, sin controles
				administrativos.
			</p>
			<span class="role-detail">Vista de cliente en la demo</span>
		</article>
	</div>
	<aside class="development-note" aria-labelledby="development-title">
		<p id="development-title">El siguiente paso: conectar todo el recorrido.</p>
		<p>
			Próximas capacidades: acceso con autenticación, asignación de técnicos e historial de
			actividad. La demo actual permite probar la gestión de incidencias con roles simulados.
		</p>
	</aside>
</section>

<section class="landing-container final-cta" aria-labelledby="cta-title">
	<div>
		<p class="eyebrow">DA EL SIGUIENTE PASO</p>
		<h2 id="cta-title">Centraliza tu soporte.<br />Empieza por verlo claro.</h2>
		<p>Explora SoporteFlow desde el papel de administrador, técnico o cliente.</p>
	</div>
	<div class="final-action">
		<a href={resolve('/app')} class="primary-link"
			>Acceder al portal <span aria-hidden="true">↗</span></a
		>
		<p>Demo temporal · Sin autenticación real</p>
	</div>
</section>
