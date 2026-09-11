<script lang="ts">
	import type { AppUser } from '$lib/types/user';
	import type { Incident } from '$lib/types/incident';
	import type { IncidentCategory } from '$lib/types/category';
	import type { ReassignmentReason } from '$lib/types/reassignment-reason';
	import type { ReasonChange } from '$lib/reasons/catalog';
	import type { SlaPolicy } from '$lib/types/sla';
	import type { SlaPolicyChange } from '$lib/incidents/sla-catalog';
	import {
		SETTINGS_GROUPS,
		canManageSettingsSection,
		type SettingsSectionId
	} from '$lib/settings/sections';
	import type { SupportLevelDefinition, SupportTeam } from '$lib/types/support';
	import UserManagement from './UserManagement.svelte';
	import SupportLevelManagement from './SupportLevelManagement.svelte';
	import TeamManagement from './TeamManagement.svelte';
	import CategoryManagement from './CategoryManagement.svelte';
	import ReassignmentReasons from '$lib/components/ReassignmentReasons.svelte';
	import SlaPolicyManagement from '$lib/components/SlaPolicyManagement.svelte';
	import SettingsPlaceholder from './SettingsPlaceholder.svelte';

	let {
		actor,
		users,
		usersReady,
		userError = '',
		onUserChange,
		supportLevels = [],
		supportLevelsReady = true,
		supportLevelError = '',
		onSupportLevelChange,
		teams = [],
		teamsReady = true,
		teamError = '',
		onTeamChange,
		availableSupportLevels,
		availableTeams,
		incidents = [],
		categories,
		categoriesReady,
		categoryError = '',
		onCategoryChange,
		reasons,
		reasonsReady,
		reasonError = '',
		onReasonChange,
		slaPolicies,
		slaPoliciesReady,
		slaPolicyError = '',
		onSlaPolicyChange,
		onClose
	}: {
		actor: AppUser;
		users: AppUser[];
		usersReady: boolean;
		userError?: string;
		onUserChange: (next: AppUser[]) => boolean;
		supportLevels?: SupportLevelDefinition[];
		supportLevelsReady?: boolean;
		supportLevelError?: string;
		onSupportLevelChange?: (next: SupportLevelDefinition[]) => boolean;
		teams?: SupportTeam[];
		teamsReady?: boolean;
		teamError?: string;
		onTeamChange?: (next: SupportTeam[]) => boolean;
		availableSupportLevels?: readonly (string | SupportLevelDefinition)[];
		availableTeams?: readonly SupportTeam[];
		incidents?: Incident[];
		categories: IncidentCategory[];
		categoriesReady: boolean;
		categoryError?: string;
		onCategoryChange: (next: IncidentCategory[]) => boolean;
		reasons: ReassignmentReason[];
		reasonsReady: boolean;
		reasonError?: string;
		onReasonChange: (change: ReasonChange) => boolean;
		slaPolicies: SlaPolicy[];
		slaPoliciesReady: boolean;
		slaPolicyError?: string;
		onSlaPolicyChange: (change: SlaPolicyChange) => boolean;
		onClose: () => void;
	} = $props();

	// All section definitions flattened
	const allSections = SETTINGS_GROUPS.flatMap((g) => g.sections);

	// Determine initial section based on user permissions
	function getInitialSection(): SettingsSectionId {
		const activePermitted = allSections.find(
			(s) => s.status === 'active' && canManageSettingsSection(actor, s.id)
		);
		if (activePermitted) return activePermitted.id;

		const anyPermitted = allSections.find((s) => canManageSettingsSection(actor, s.id));
		return anyPermitted?.id ?? 'categories';
	}

	let selectedSection = $state<SettingsSectionId>(getInitialSection());

	const currentSection = $derived(
		allSections.find((s) => s.id === selectedSection) ?? allSections[0]
	);

	const isCurrentSectionPermitted = $derived(canManageSettingsSection(actor, selectedSection));

	const effectiveLevels = $derived<SupportLevelDefinition[]>(
		supportLevels.length > 0
			? [...supportLevels]
			: [...((availableSupportLevels ?? []) as unknown as SupportLevelDefinition[])]
	);

	const effectiveTeams = $derived<SupportTeam[]>(
		teams.length > 0 ? [...teams] : [...(availableTeams ?? [])]
	);
</script>

<div class="settings-view space-y-6">
	<!-- Settings Header -->
	<div
		class="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-5 backdrop-blur-xs"
	>
		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-cyan-400"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
					/>
				</svg>
			</div>
			<div>
				<h1 class="text-xl font-bold text-white">Configuración</h1>
				<p class="text-xs text-slate-400">Administración y parámetros del sistema de soporte</p>
			</div>
		</div>

		<button
			type="button"
			onclick={onClose}
			class="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-400"
			aria-label="Volver a incidencias"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				class="h-4 w-4"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
				aria-hidden="true"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
			</svg>
			<span>Volver a incidencias</span>
		</button>
	</div>

	<!-- Main Settings Layout -->
	<div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
		<!-- Sidebar Navigation -->
		<nav
			class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-3 xl:col-span-3"
			aria-label="Menú de configuración"
		>
			{#each SETTINGS_GROUPS as group, groupIndex (group.id)}
				{@const permittedSections = group.sections.filter((section) =>
					canManageSettingsSection(actor, section.id)
				)}
				{#if permittedSections.length > 0}
					<div
						class="settings-group {groupIndex > 0 ? 'mt-6 border-t border-slate-800/70 pt-5' : ''}"
					>
						<h2
							class="settings-nav-header px-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase select-none"
						>
							{group.label}
						</h2>
						<div class="mt-2.5 space-y-1">
							{#each group.sections as section (section.id)}
								{@const isPermitted = canManageSettingsSection(actor, section.id)}
								{#if isPermitted}
									{@const isSelected = selectedSection === section.id}
									{@const isComingSoon = section.status === 'coming_soon'}
									<button
										type="button"
										onclick={() => (selectedSection = section.id)}
										class="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition {isSelected
											? 'bg-cyan-500/15 font-semibold text-cyan-300 ring-1 ring-cyan-500/40'
											: 'text-slate-300 hover:bg-slate-800/60 hover:text-white'}"
										aria-current={isSelected ? 'true' : undefined}
									>
										<span class="truncate">{section.label}</span>
										{#if isComingSoon}
											<span
												class="inline-flex shrink-0 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400"
											>
												Próxima fase
											</span>
										{/if}
									</button>
								{/if}
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		</nav>

		<!-- Content Panel -->
		<section class="settings-content min-w-0 lg:col-span-9 xl:col-span-9" aria-live="polite">
			{#if !isCurrentSectionPermitted}
				<div
					role="alert"
					class="rounded-xl border border-red-500/30 bg-red-950/20 p-6 text-center text-sm text-red-300"
				>
					No tienes permisos para administrar esta sección.
				</div>
			{:else if currentSection.status === 'coming_soon'}
				<SettingsPlaceholder section={currentSection} />
			{:else if selectedSection === 'users'}
				<UserManagement
					{actor}
					{users}
					ready={usersReady}
					error={userError}
					availableSupportLevels={effectiveLevels}
					availableTeams={effectiveTeams}
					onchange={onUserChange}
				/>
			{:else if selectedSection === 'support_levels'}
				{#key actor.id}
					<SupportLevelManagement
						{actor}
						levels={effectiveLevels}
						{users}
						{incidents}
						ready={supportLevelsReady}
						error={supportLevelError}
						onchange={onSupportLevelChange ?? (() => false)}
					/>
				{/key}
			{:else if selectedSection === 'teams'}
				{#key actor.id}
					<TeamManagement
						{actor}
						teams={effectiveTeams}
						{users}
						{incidents}
						ready={teamsReady}
						error={teamError}
						onchange={onTeamChange ?? (() => false)}
					/>
				{/key}
			{:else if selectedSection === 'categories'}
				<CategoryManagement
					{actor}
					{categories}
					levels={effectiveLevels}
					teams={effectiveTeams}
					ready={categoriesReady}
					error={categoryError}
					onchange={onCategoryChange}
				/>
			{:else if selectedSection === 'reassignment_reasons'}
				{#key actor.id}
					<ReassignmentReasons
						{actor}
						{reasons}
						ready={reasonsReady}
						error={reasonError}
						onchange={onReasonChange}
					/>
				{/key}
			{:else if selectedSection === 'sla_policies'}
				{#key actor.id}
					<SlaPolicyManagement
						{actor}
						policies={slaPolicies}
						{categories}
						ready={slaPoliciesReady}
						error={slaPolicyError}
						onchange={onSlaPolicyChange}
					/>
				{/key}
			{/if}
		</section>
	</div>
</div>
