<script lang="ts">
	import ThemeSelector from '$lib/components/ThemeSelector.svelte';
	import './theme.css';
	import {
		prepareUnifiedAssignment,
		type UnifiedAssignmentInput,
		prepareClassificationChange,
		canEscalate,
		type ClassificationChangeInput
	} from '$lib/incidents/escalation';
	import ClassificationDialog from '$lib/components/ClassificationDialog.svelte';
	import SettingsView from '$lib/components/settings/SettingsView.svelte';
	import { canAccessSettings } from '$lib/settings/sections';
	import {
		loadReasons,
		changeReason,
		saveReasons,
		REASONS_KEY,
		type ReasonChange
	} from '$lib/reasons/catalog';
	import type { ReassignmentReason } from '$lib/types/reassignment-reason';
	let reasonList = $state<ReassignmentReason[]>([]);
	let reasonsReady = $state(false);
	let reasonError = $state('');
	let reasonSnapshot: string | null = null;
	onMount(() => {
		try {
			reasonSnapshot = localStorage.getItem(REASONS_KEY);
			reasonList = loadReasons(reasonSnapshot);
			reasonsReady = true;
		} catch {
			reasonError =
				'No se pudo cargar el catálogo de motivos. Los datos guardados se han conservado; las asignaciones están bloqueadas.';
		}
	});
	function updateReason(change: ReasonChange): boolean {
		if (!reasonsReady) return false;
		try {
			const next = changeReason(activeUser, reasonList, change);
			reasonSnapshot = saveReasons(localStorage, next, reasonSnapshot);
			reasonList = next;
			reasonError = '';
			return true;
		} catch (error) {
			reasonError = error instanceof Error ? error.message : 'No se pudo guardar el catálogo.';
			return false;
		}
	}

	import {
		queueIncidents,
		filterIncidentQueue,
		type IncidentQueue,
		type QueueStatusFilter
	} from '$lib/incidents/queue';
	import type { IncidentRating } from '$lib/types/incident-rating';
	import { loadIncidentRatings, saveIncidentRatings } from '$lib/storage/ratings';
	import {
		canClientConfirmOrReject,
		canClientReopenIncident,
		canClientRateIncident,
		getRatingForResolution,
		getIncidentResolvedAt,
		getAutoCloseRemainingMinutes,
		getReopenRemainingMinutes
	} from '$lib/incidents/closure';
	import IncidentRatingModal from '$lib/components/IncidentRatingModal.svelte';
	import { isIncidentList } from '$lib/incidents/validation';
	import {
		canManageAssignment,
		canAssignTo,
		incidentOrganizationId,
		getAssigneeLevelIncompatibility,
		isCandidateLevelCompatible
	} from '$lib/incidents/assignment';
	import TechnicianDashboard from '$lib/components/dashboard/TechnicianDashboard.svelte';
	import {
		loadHistory,
		recoverAssignment,
		commitAssignment,
		INCIDENTS_KEY,
		HISTORY_KEY
	} from '$lib/storage/assignment';
	import { demoOrganization } from '$lib/data/organizations';
	import { demoUsers } from '$lib/data/users';
	import type { IncidentHistoryEntry } from '$lib/types/incident-history';
	import type { IncidentMessage } from '$lib/types/incident-message';
	import IncidentMessages from '$lib/components/IncidentMessages.svelte';
	import { completeInternalNoteEffects } from '$lib/storage/internal-note-effects';
	import { loadMessages, MESSAGES_KEY } from '$lib/storage/messages';
	import { recoverFirstResponse, FIRST_RESPONSE_RECOVERY_KEY } from '$lib/storage/first-response';
	import {
		commitTransitionWithMessage,
		recoverTransitionWithMessage
	} from '$lib/storage/transition-message';
	import { syncAndCommitAutoClosures } from '$lib/storage/auto-close';
	import {
		applyCreationSla,
		buildCreatedHistoryEntry,
		recordStatusTransition,
		isIncidentReopened,
		reclassifyIncident,
		applyPriorityOverride,
		removePriorityOverride
	} from '$lib/incidents/lifecycle';
	import { commitIncidentEdit, type IncidentEditChange } from '$lib/storage/incident-edit';
	import { commitIncidentDeletion } from '$lib/storage/incident-deletion';
	import { demoSupportTeams } from '$lib/data/teams';
	import { demoSupportLevels } from '$lib/data/support-levels';
	import type { SupportLevelDefinition, SupportTeam } from '$lib/types/support';
	import {
		SUPPORT_LEVELS_STORAGE_KEY,
		loadSupportLevelsResult,
		saveSupportLevels
	} from '$lib/support/levels-catalog';
	import {
		SUPPORT_TEAMS_STORAGE_KEY,
		loadSupportTeamsResult,
		saveSupportTeams
	} from '$lib/support/teams-catalog';
	import { SITES_STORAGE_KEY, loadSitesResult, saveSites } from '$lib/sites/catalog';
	import { demoSites } from '$lib/data/sites';
	import type { Site } from '$lib/types/site';
	import ChangeSiteDialog from '$lib/components/ChangeSiteDialog.svelte';
	import ReclassifyDialog from '$lib/components/ReclassifyDialog.svelte';
	import OverridePriorityDialog from '$lib/components/OverridePriorityDialog.svelte';
	import { changeIncidentSite, validateIncidentSite } from '$lib/sites/incident-site';
	import { USERS_STORAGE_KEY, loadUsersResult, saveUsers } from '$lib/users/catalog';
	import SlaBadge from '$lib/components/SlaBadge.svelte';
	import IncidentSlaPanel from '$lib/components/IncidentSlaPanel.svelte';
	import {
		SLA_POLICIES_KEY,
		loadSlaPoliciesResult,
		saveSlaPolicies,
		changeSlaPolicy,
		checkIncidentCreationSla,
		type SlaPolicyCatalogState,
		type SlaPolicyChange
	} from '$lib/incidents/sla-catalog';
	import AssignmentDialog from '$lib/components/AssignmentDialog.svelte';
	import NotificationCenter from '$lib/components/NotificationCenter.svelte';
	import type { Notification, NotificationType } from '$lib/types/notification';
	import {
		NOTIFICATIONS_KEY,
		loadNotificationsResult,
		saveNotifications
	} from '$lib/storage/notifications';
	import {
		buildIncidentNotification,
		markNotificationAsRead,
		markAllNotificationsAsRead,
		clearUserNotifications
	} from '$lib/incidents/notifications';
	import { incidents as initialIncidents } from '$lib/data/incidents';
	import type { Incident, IncidentPriority, IncidentStatus } from '$lib/types/incident';
	import { onMount } from 'svelte';
	import { initialCategories } from '$lib/data/categories';
	import {
		loadCategoriesResult,
		resolveCategoryRouting,
		CATEGORY_STORAGE_KEY
	} from '$lib/categories/catalog';
	import type { IncidentCategory } from '$lib/types/category';
	import {
		SUBCATEGORIES_STORAGE_KEY,
		loadSubcategoriesResult,
		initializeSubcategoriesCatalog,
		getAvailableSubcategories
	} from '$lib/classification/subcategories-catalog';
	import {
		PRIORITY_MATRICES_STORAGE_KEY,
		loadPriorityMatricesResult,
		resolveOrganizationMatrix
	} from '$lib/classification/matrix-catalog';
	import { classifyIncident, isImpactLevel, toIncidentPriority } from '$lib/classification/engine';
	import type {
		SubcategoryLoadResult,
		PriorityMatricesCatalogLoadResult,
		ImpactLevel,
		ClassificationResult,
		PriorityMatrixLoadResult
	} from '$lib/types/classification';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { getMe, signOut, AuthApiError } from '$lib/api/auth';
	import {
		listIncidents,
		IncidentApiError,
		type IncidentListItem,
		type IncidentQueue as RealIncidentQueue
	} from '$lib/api/./incidents';
	import { session } from '$lib/stores/session';
	import OrganizationSelector from '$lib/components/OrganizationSelector.svelte';
	import RealIncidentList from '$lib/components/incidents/RealIncidentList.svelte';
	import { defaultDemoUser } from '$lib/auth/demo-session';
	import { generateId } from '$lib/utils/id';
	import { hasPermission, canAccessOrganization } from '$lib/auth/permissions';
	import { canViewIncident, canActOnIncident, canAccessRecord } from '$lib/auth/record-access';
	import type { AppUser } from '$lib/types/user';

	let sessionLoading = $state(!$session.isAuthenticated);

	let realIncidents = $state<IncidentListItem[]>([]);
	let realLoading = $state(false);
	let realError = $state<string | null>(null);

	let incidentRequestId = 0;
	let incidentAbortController: AbortController | null = null;

	const VALID_QUEUES: ReadonlySet<string> = new Set(['mine', 'unassigned', 'all']);

	function normalizeQueue(param: string | null): RealIncidentQueue {
		if (param && VALID_QUEUES.has(param)) {
			return param as RealIncidentQueue;
		}
		return 'all';
	}

	let activeQueue = $derived<RealIncidentQueue>(
		normalizeQueue($page.url.searchParams.get('queue'))
	);

	async function selectQueue(queue: RealIncidentQueue) {
		if (activeQueue === queue) return;
		const url = new URL($page.url);
		url.searchParams.set('queue', queue);
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(url.pathname + url.search, { keepFocus: true, noScroll: true });
	}

	$effect(() => {
		const isAuth = $session.isAuthenticated;
		const currentOrg = $session.activeOrganization;
		const currentUserId = $session.user?.id;
		const currentQueue = activeQueue;

		incidentRequestId += 1;
		const thisRequestId = incidentRequestId;

		if (incidentAbortController) {
			incidentAbortController.abort();
			incidentAbortController = null;
		}

		if (!isAuth || !currentOrg) {
			realIncidents = [];
			realLoading = false;
			realError = null;
			return;
		}

		realIncidents = [];
		realError = null;
		realLoading = true;

		const controller = new AbortController();
		incidentAbortController = controller;
		const targetOrgId = currentOrg.id;
		const targetUserId = currentUserId;
		const targetQueue = currentQueue;

		(async () => {
			try {
				const data = await listIncidents(targetOrgId, {
					queue: targetQueue,
					signal: controller.signal
				});

				if (
					thisRequestId !== incidentRequestId ||
					$session.activeOrganization?.id !== targetOrgId ||
					$session.user?.id !== targetUserId ||
					activeQueue !== targetQueue
				) {
					return;
				}

				realIncidents = data;
				realError = null;
			} catch (err: unknown) {
				if (
					thisRequestId !== incidentRequestId ||
					$session.activeOrganization?.id !== targetOrgId ||
					$session.user?.id !== targetUserId ||
					activeQueue !== targetQueue
				) {
					return;
				}

				if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
					return;
				}

				if (err instanceof IncidentApiError && err.status === 401) {
					session.clearSession();
					realIncidents = [];
					realError = null;
					realLoading = false;
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					await goto('/login?expired=true');
					return;
				}

				if (err instanceof IncidentApiError) {
					if (err.status === 403) {
						realError = 'No tienes permisos para consultar esta cola.';
					} else {
						realError = err.message;
					}
				} else {
					realError = 'No se pudieron cargar las incidencias. Inténtalo de nuevo.';
				}
			} finally {
				if (
					thisRequestId === incidentRequestId &&
					$session.activeOrganization?.id === targetOrgId &&
					$session.user?.id === targetUserId &&
					activeQueue === targetQueue
				) {
					realLoading = false;
				}
			}
		})();

		return () => {
			controller.abort();
		};
	});

	onMount(async () => {
		if (!$session.isAuthenticated) {
			sessionLoading = true;
			try {
				const context = await getMe();
				session.setSession(context);
			} catch (err) {
				if (err instanceof AuthApiError && err.status === 401) {
					session.clearSession();
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					await goto('/login?expired=true');
					return;
				}
				session.setError(
					err instanceof AuthApiError ? err.message : 'Error al conectar con el servidor.'
				);
			} finally {
				sessionLoading = false;
			}
		}
	});

	let signOutError = $state('');
	let isSigningOut = $state(false);

	async function handleSignOut() {
		signOutError = '';
		isSigningOut = true;
		try {
			await signOut();
			session.clearSession();
			realIncidents = [];
			realError = null;
			realLoading = false;
			await goto(resolve('/login'));
		} catch {
			signOutError = 'No se pudo cerrar la sesión. Inténtalo de nuevo.';
		} finally {
			isSigningOut = false;
		}
	}

	let incidentList = $state<Incident[]>([...initialIncidents]);
	let categoryList = $state<IncidentCategory[]>(
		initialCategories.map((category) => ({ ...category }))
	);
	let userList = $state<AppUser[]>([...demoUsers]);
	let usersLoaded = $state(false);
	let userLoadError = $state('');
	let userSaveError = $state('');

	function persistUsers(next: AppUser[]): boolean {
		if (!usersLoaded || userLoadError || !hasPermission(activeUser, 'users:manage')) {
			return false;
		}
		try {
			saveUsers(localStorage, next);
			userList = next;
			userSaveError = '';
			return true;
		} catch (err) {
			userSaveError = err instanceof Error ? err.message : 'No se pudieron guardar los usuarios.';
			return false;
		}
	}

	let levelList = $state<SupportLevelDefinition[]>([...demoSupportLevels]);
	let levelsLoaded = $state(false);
	let levelLoadError = $state('');
	let levelSaveError = $state('');

	function persistLevels(next: SupportLevelDefinition[]): boolean {
		if (!levelsLoaded || levelLoadError || !hasPermission(activeUser, 'organization:manage')) {
			return false;
		}
		try {
			saveSupportLevels(localStorage, next);
			levelList = next;
			levelSaveError = '';
			return true;
		} catch (err) {
			levelSaveError = err instanceof Error ? err.message : 'No se pudieron guardar los niveles.';
			return false;
		}
	}

	let teamList = $state<SupportTeam[]>([...demoSupportTeams]);
	let teamsLoaded = $state(false);
	let teamLoadError = $state('');
	let teamSaveError = $state('');

	function persistTeams(next: SupportTeam[]): boolean {
		if (!teamsLoaded || teamLoadError || !hasPermission(activeUser, 'organization:manage')) {
			return false;
		}
		try {
			saveSupportTeams(localStorage, next);
			teamList = next;
			teamSaveError = '';
			return true;
		} catch (err) {
			teamSaveError = err instanceof Error ? err.message : 'No se pudieron guardar los equipos.';
			return false;
		}
	}

	let siteList = $state<Site[]>([...demoSites]);
	let sitesLoaded = $state(false);
	let siteLoadError = $state('');
	let siteSaveError = $state('');

	function persistSites(next: Site[]): boolean {
		if (!sitesLoaded || siteLoadError || !hasPermission(activeUser, 'organization:manage')) {
			return false;
		}
		try {
			saveSites(localStorage, next);
			siteList = next;
			siteSaveError = '';
			return true;
		} catch (err) {
			siteSaveError = err instanceof Error ? err.message : 'No se pudieron guardar las sedes.';
			return false;
		}
	}

	let activeUser = $state<AppUser>(defaultDemoUser);
	let currentView = $state<'home' | 'incidents' | 'settings'>(
		defaultDemoUser.role === 'technician' ? 'home' : 'incidents'
	);
	let messageList = $state<IncidentMessage[]>([]);

	function refreshMessages() {
		try {
			messageList = loadMessages(localStorage.getItem(MESSAGES_KEY));
		} catch {
			// keep current messageList
		}
	}

	$effect(() => {
		const current = userList.find((u) => u.id === activeUser.id);
		if (
			current &&
			(current.name !== activeUser.name ||
				current.email !== activeUser.email ||
				current.role !== activeUser.role)
		) {
			activeUser = current;
		}
	});

	$effect(() => {
		if (currentView === 'settings' && !canAccessSettings(activeUser)) {
			currentView = activeUser.role === 'technician' ? 'home' : 'incidents';
		}
		if (currentView === 'home' && activeUser.role !== 'technician') {
			currentView = 'incidents';
		}
	});

	const visibleIncidents = $derived(
		incidentList.filter((incident) => canViewIncident(activeUser, incident))
	);
	let selectedQueue = $state<IncidentQueue>('all');
	const queueOptions = [
		{ value: 'all', label: 'Todas' },
		{ value: 'mine', label: 'Mis incidencias' },
		{ value: 'unassigned', label: 'Sin asignar' }
	] satisfies { value: IncidentQueue; label: string }[];
	const currentQueue = $derived(queueIncidents(activeUser, incidentList, selectedQueue));
	const mineCount = $derived(
		activeUser.role === 'technician' ? queueIncidents(activeUser, incidentList, 'mine').length : 0
	);
	const unassignedCount = $derived(
		activeUser.role === 'technician'
			? queueIncidents(activeUser, incidentList, 'unassigned').length
			: 0
	);
	function categoryName(incident: Incident): string {
		if (!incident.categoryId) return 'Sin categoría';
		return (
			categoryList.find(
				(category) =>
					category.id === incident.categoryId &&
					(category.organizationId ?? demoOrganization.id) === incidentOrganizationId(incident)
			)?.name ?? 'Categoría no disponible'
		);
	}
	const canEdit = $derived(hasPermission(activeUser, 'incidents:edit'));
	const canDelete = $derived(hasPermission(activeUser, 'incidents:delete'));
	const canCreate = $derived(hasPermission(activeUser, 'incidents:create'));

	const summary = $derived([
		{
			label: 'Incidencias abiertas',
			value: visibleIncidents.filter((incident) => incident.status === 'open').length,
			color: 'text-cyan-400',
			badge: 'bg-cyan-400'
		},
		{
			label: 'Pendientes',
			value: visibleIncidents.filter((incident) => incident.status === 'pending').length,
			color: 'text-amber-400',
			badge: 'bg-amber-400'
		},
		{
			label: 'Resueltas',
			value: visibleIncidents.filter((incident) => incident.status === 'resolved').length,
			color: 'text-emerald-400',
			badge: 'bg-emerald-400'
		},
		{
			label: 'Cerradas',
			value: visibleIncidents.filter((incident) => incident.status === 'closed').length,
			color: 'text-slate-400',
			badge: 'bg-slate-400'
		}
	]);

	let title = $state('');
	let client = $state('');
	let description = $state('');

	const STORAGE_KEY = INCIDENTS_KEY;

	let selectedStatus = $state<QueueStatusFilter>('active');

	const statusFilters = [
		{ value: 'active', label: 'Activas' },
		{ value: 'open', label: 'Abiertas' },
		{ value: 'pending', label: 'Pendientes' },
		{ value: 'resolved', label: 'Resueltas' },
		{ value: 'closed', label: 'Cerradas' },
		{ value: 'all', label: 'Todas' }
	] satisfies { value: QueueStatusFilter; label: string }[];

	let searchQuery = $state('');
	const filteredIncidents = $derived(
		filterIncidentQueue(activeUser, incidentList, selectedQueue, selectedStatus, searchQuery)
	);

	let incidentLoadError = $state('');
	let history = $state<IncidentHistoryEntry[]>([]);
	let assignmentReady = $state(false);

	let assignmentError = $state('');
	let assignmentIncident = $state<Incident | null>(null);
	let assignmentTarget = $state('');
	let storedIncidentSnapshot = $state<string | null>(null);
	let storedHistorySnapshot: string | null = null;
	function assigneeName(incident: Incident): string {
		if (!incident.assignedToUserId) return 'Sin asignar';
		const user = userList.find(
			(item) =>
				item.id === incident.assignedToUserId &&
				item.organizationId === incidentOrganizationId(incident)
		);
		return user ? user.name + (user.active ? '' : ' (inactivo)') : 'Técnico no disponible';
	}
	function teamName(incident: Incident): string {
		if (!incident.teamId) return 'Sin equipo';
		return (
			teamList.find(
				(team) =>
					team.id === incident.teamId && team.organizationId === incidentOrganizationId(incident)
			)?.name ?? 'Equipo no disponible'
		);
	}
	function siteNameForIncident(incident: Incident): string {
		if (!incident.siteId) return 'Sin sede asignada';
		const site = siteList.find(
			(s) => s.id === incident.siteId && s.organizationId === incidentOrganizationId(incident)
		);
		return site ? `${site.name}${!site.active ? ' (inactiva)' : ''}` : 'Sede no disponible';
	}

	function openAssignment(incident: Incident, self = false) {
		if (
			!assignmentReady ||
			incidentLoadError ||
			!(self
				? canAssignTo(activeUser, incident, activeUser.id, levelList)
				: canManageAssignment(activeUser, incident))
		)
			return;
		assignmentError = '';
		assignmentTarget = self ? activeUser.id : (incident.assignedToUserId ?? '');
		assignmentIncident = incident;
	}

	function handleAssumeIncident(incident: Incident) {
		if (!assignmentReady || incidentLoadError || activeUser.role !== 'technician') return;
		if (!isCandidateLevelCompatible(activeUser, incident, levelList)) {
			window.alert(
				'Tu nivel de soporte no tiene la capacidad técnica requerida para asumir esta incidencia.'
			);
			return;
		}
		try {
			const id = incident.id;
			const original = incidentList.find((i) => i.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			const change = prepareUnifiedAssignment(
				activeUser,
				original,
				userList,
				teamList,
				{ assignedToUserId: activeUser.id },
				levelList
			);
			if (!change) return;
			const next = incidentList.map((item) => (item.id === id ? change.incident : item));
			const nextHistory = [...history, change.event];
			commitAssignment(
				localStorage,
				next,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = next;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(next);
			storedHistorySnapshot = JSON.stringify(nextHistory);

			const notif = buildIncidentNotification({
				type: 'incident_assigned',
				incident: change.incident,
				actor: activeUser,
				newAssigneeId: activeUser.id,
				reason: 'Asumida desde el panel operativo'
			});
			recordNotification(notif);
		} catch (error) {
			window.alert(error instanceof Error ? error.message : 'No se pudo asumir la incidencia.');
		}
	}

	let classificationIncident = $state<Incident | null>(null);
	let classificationError = $state('');

	function openClassification(incident: Incident) {
		if (!assignmentReady || incidentLoadError || !canEscalate(activeUser, incident)) return;
		classificationError = '';
		classificationIncident = incident;
	}

	function confirmClassification(input: ClassificationChangeInput) {
		if (!assignmentReady || incidentLoadError || !classificationIncident) return;
		try {
			const id = classificationIncident.id;
			const original = incidentList.find((item) => item.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			const change = prepareClassificationChange(activeUser, original, input, {
				levels: levelList,
				teams: teamList,
				categories: categoryList
			});
			if (!change) {
				classificationIncident = null;
				classificationError = '';
				return;
			}
			const next = incidentList.map((item) => (item.id === id ? change.incident : item));
			const nextHistory = [...history, change.event];
			commitAssignment(
				localStorage,
				next,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = next;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(next);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			if (editingIncident && editingIncident.id === id) {
				editingIncident = {
					...change.incident,
					description: change.incident.description ?? '',
					solution: change.incident.solution ?? ''
				};
			}
			classificationIncident = null;
			classificationError = '';
			if (change.event.eventType === 'escalated') {
				const notif = buildIncidentNotification({
					type: 'incident_escalated',
					incident: change.incident,
					actor: activeUser,
					newAssigneeId: change.incident.assignedToUserId ?? undefined,
					reason: change.event.reason ?? ''
				});
				recordNotification(notif);
			}
		} catch (error) {
			classificationError =
				error instanceof Error ? error.message : 'No se pudo guardar la clasificación.';
		}
	}

	let siteChangeIncident = $state<Incident | null>(null);
	let siteChangeError = $state('');

	function openChangeSite(incident: Incident) {
		if (
			!assignmentReady ||
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:edit')
		)
			return;
		siteChangeError = '';
		siteChangeIncident = incident;
	}

	function confirmChangeSite(input: {
		targetSiteId: string | null;
		reason?: string;
		comment?: string;
	}) {
		if (!assignmentReady || incidentLoadError || !siteChangeIncident) return;
		try {
			const id = siteChangeIncident.id;
			const original = incidentList.find((item) => item.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			const change = changeIncidentSite(activeUser, original, input, siteList);
			if (!change) {
				siteChangeIncident = null;
				siteChangeError = '';
				return;
			}
			const next = incidentList.map((item) => (item.id === id ? change.incident : item));
			const nextHistory = [...history, change.event];
			commitAssignment(
				localStorage,
				next,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = next;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(next);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			if (editingIncident && editingIncident.id === id) {
				editingIncident = {
					...change.incident,
					description: change.incident.description ?? '',
					solution: change.incident.solution ?? ''
				};
			}
			siteChangeIncident = null;
			siteChangeError = '';
		} catch (error) {
			siteChangeError = error instanceof Error ? error.message : 'No se pudo cambiar la sede.';
		}
	}
	function confirmAssignment(input: UnifiedAssignmentInput) {
		if (!assignmentReady || incidentLoadError || !assignmentIncident) return;
		try {
			const id = assignmentIncident.id;
			const original = incidentList.find((item) => item.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			const change = prepareUnifiedAssignment(
				activeUser,
				original,
				userList,
				teamList,
				input,
				levelList
			);
			if (!change) {
				assignmentIncident = null;
				assignmentError = '';
				return;
			}
			const next = incidentList.map((item) => (item.id === id ? change.incident : item));
			const nextHistory = [...history, change.event];
			commitAssignment(
				localStorage,
				next,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = next;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(next);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			if (editingIncident && editingIncident.id === id) {
				editingIncident = {
					...change.incident,
					description: change.incident.description ?? '',
					solution: change.incident.solution ?? ''
				};
			}
			assignmentIncident = null;
			assignmentError = '';
			const notifType: NotificationType =
				change.event.eventType === 'escalated'
					? 'incident_escalated'
					: change.event.eventType === 'reassigned'
						? 'incident_reassigned'
						: 'incident_assigned';
			const notif = buildIncidentNotification({
				type: notifType,
				incident: change.incident,
				actor: activeUser,
				newAssigneeId: change.incident.assignedToUserId ?? undefined,
				reason: change.event.reason ?? ''
			});
			recordNotification(notif);
		} catch (error) {
			assignmentError =
				error instanceof Error ? error.message : 'No se pudo guardar la asignación.';
		}
	}

	let reclassifyIncidentTarget = $state<Incident | null>(null);
	let reclassifyError = $state('');

	function openReclassify(incident: Incident) {
		if (
			!assignmentReady ||
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:classify') ||
			(incident.status !== 'open' && incident.status !== 'pending')
		) {
			return;
		}
		reclassifyError = '';
		reclassifyIncidentTarget = incident;
	}

	function confirmReclassify(input: {
		newCategoryId: string;
		newSubcategoryId: string;
		newImpact: ImpactLevel;
		reason: string;
	}) {
		if (!assignmentReady || incidentLoadError || !reclassifyIncidentTarget) return;
		const id = reclassifyIncidentTarget.id;
		const original = incidentList.find((i) => i.id === id);
		if (!original) {
			reclassifyError = 'La incidencia ya no existe.';
			return;
		}

		const res = reclassifyIncident({
			incident: original,
			actorUser: activeUser,
			newCategoryId: input.newCategoryId,
			newSubcategoryId: input.newSubcategoryId,
			newImpact: input.newImpact,
			reason: input.reason,
			categoryList,
			subcategories: subcategoriesState.status === 'valid' ? subcategoriesState.subcategories : [],
			priorityMatrices:
				priorityMatricesState.status === 'valid' ? priorityMatricesState.matrices : []
		});

		if (!res.ok) {
			reclassifyError = res.error;
			return;
		}

		const nextList = incidentList.map((item) => (item.id === id ? res.incident : item));
		const nextHistory = [...history, res.historyEntry];

		try {
			commitAssignment(
				localStorage,
				nextList,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = nextList;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(nextList);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			if (editingIncident && editingIncident.id === id) {
				editingIncident = {
					...res.incident,
					description: res.incident.description ?? '',
					solution: res.incident.solution ?? ''
				};
			}
			reclassifyIncidentTarget = null;
			reclassifyError = '';
		} catch (err) {
			reclassifyError =
				err instanceof Error
					? err.message
					: 'Error al persistir la reclasificación. Comprueba si los datos cambiaron en otra pestaña.';
		}
	}

	let overrideIncidentTarget = $state<Incident | null>(null);
	let overrideError = $state('');

	function openOverride(incident: Incident) {
		if (
			!assignmentReady ||
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:override_priority') ||
			(incident.status !== 'open' && incident.status !== 'pending')
		) {
			return;
		}
		overrideError = '';
		overrideIncidentTarget = incident;
	}

	function confirmApplyOverride(input: { targetPriority: IncidentPriority; reason: string }) {
		if (!assignmentReady || incidentLoadError || !overrideIncidentTarget) return;
		const id = overrideIncidentTarget.id;
		const original = incidentList.find((i) => i.id === id);
		if (!original) {
			overrideError = 'La incidencia ya no existe.';
			return;
		}

		const res = applyPriorityOverride({
			incident: original,
			actorUser: activeUser,
			targetPriority: input.targetPriority,
			reason: input.reason
		});

		if (!res.ok) {
			overrideError = res.error;
			return;
		}

		const nextList = incidentList.map((item) => (item.id === id ? res.incident : item));
		const nextHistory = [...history, res.historyEntry];

		try {
			commitAssignment(
				localStorage,
				nextList,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = nextList;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(nextList);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			if (editingIncident && editingIncident.id === id) {
				editingIncident = {
					...res.incident,
					description: res.incident.description ?? '',
					solution: res.incident.solution ?? ''
				};
			}
			overrideIncidentTarget = null;
			overrideError = '';
		} catch (err) {
			overrideError =
				err instanceof Error
					? err.message
					: 'Error al persistir la excepción de prioridad. Comprueba si los datos cambiaron en otra pestaña.';
		}
	}

	function confirmRemoveOverride(input: { reason: string }) {
		if (!assignmentReady || incidentLoadError || !overrideIncidentTarget) return;
		const id = overrideIncidentTarget.id;
		const original = incidentList.find((i) => i.id === id);
		if (!original) {
			overrideError = 'La incidencia ya no existe.';
			return;
		}

		const res = removePriorityOverride({
			incident: original,
			actorUser: activeUser,
			reason: input.reason
		});

		if (!res.ok) {
			overrideError = res.error;
			return;
		}

		const nextList = incidentList.map((item) => (item.id === id ? res.incident : item));
		const nextHistory = [...history, res.historyEntry];

		try {
			commitAssignment(
				localStorage,
				nextList,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = nextList;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(nextList);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			if (editingIncident && editingIncident.id === id) {
				editingIncident = {
					...res.incident,
					description: res.incident.description ?? '',
					solution: res.incident.solution ?? ''
				};
			}
			overrideIncidentTarget = null;
			overrideError = '';
		} catch (err) {
			overrideError =
				err instanceof Error
					? err.message
					: 'Error al retirar la excepción de prioridad. Comprueba si los datos cambiaron en otra pestaña.';
		}
	}

	function getSubcategoryInfo(
		subcatId?: string | null,
		orgId?: string
	): { name: string; baseCriticality?: string } | null {
		if (!subcatId) return null;
		const subcats = subcategoriesState.status === 'valid' ? subcategoriesState.subcategories : [];
		const found = subcats.find((s) => s.id === subcatId && (!orgId || s.organizationId === orgId));
		if (found) {
			return { name: found.name, baseCriticality: found.baseCriticality };
		}
		return { name: subcatId };
	}

	const impactLabels: Record<string, string> = {
		I1: 'I1 — Una persona',
		I2: 'I2 — Varias personas',
		I3: 'I3 — Equipo o departamento',
		I4: 'I4 — Sede u organización completa'
	};

	const criticalityLabels: Record<string, string> = {
		critical: 'Crítica (C1)',
		high: 'Alta (C2)',
		medium: 'Media (C3)',
		low: 'Baja (C4)'
	};

	const priorityBadgeClasses: Record<IncidentPriority, string> = {
		urgent: 'badge-priority-urgent',
		high: 'badge-priority-high',
		medium: 'badge-priority-medium',
		low: 'badge-priority-low'
	};

	let now = $state(new Date());

	let slaCatalogState = $state<SlaPolicyCatalogState>({ status: 'valid', policies: [] });
	let slaPoliciesReady = $state(false);
	let slaPolicyError = $state('');
	let slaPolicySnapshot: string | null = null;

	let subcategoriesState = $state<SubcategoryLoadResult>({ status: 'missing', subcategories: [] });
	let subcategoriesReady = $state(false);
	let subcategoriesError = $state('');
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let subcategoriesSnapshot: string | null = null;

	let priorityMatricesState = $state<PriorityMatricesCatalogLoadResult>({
		status: 'missing',
		matrices: []
	});
	let priorityMatricesReady = $state(false);
	let priorityMatricesError = $state('');
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let priorityMatricesSnapshot: string | null = null;

	function reloadSubcategories(raw: string | null) {
		try {
			subcategoriesSnapshot = raw;
			const res = loadSubcategoriesResult(raw);
			subcategoriesState = res;
			if (res.status === 'corrupt') {
				subcategoriesError = res.error;
				subcategoriesReady = false;
			} else {
				subcategoriesError = '';
				subcategoriesReady = true;
			}
		} catch {
			subcategoriesState = {
				status: 'corrupt',
				error: 'Error inesperado al cargar las subcategorías.'
			};
			subcategoriesError =
				'No se pudo cargar el catálogo de subcategorías. Los datos se han conservado.';
			subcategoriesReady = false;
		}
	}

	function reloadPriorityMatrices(raw: string | null) {
		try {
			priorityMatricesSnapshot = raw;
			const res = loadPriorityMatricesResult(raw);
			priorityMatricesState = res;
			if (res.status === 'corrupt') {
				priorityMatricesError = res.error;
				priorityMatricesReady = false;
			} else {
				priorityMatricesError = '';
				priorityMatricesReady = true;
			}
		} catch {
			priorityMatricesState = {
				status: 'corrupt',
				error: 'Error inesperado al cargar las matrices de prioridad.'
			};
			priorityMatricesError =
				'No se pudo cargar el catálogo de matrices de prioridad. Los datos se han conservado.';
			priorityMatricesReady = false;
		}
	}

	let notificationList = $state<Notification[]>([]);
	let notificationsReady = $state(false);
	let notificationError = $state('');
	let notificationSnapshot: string | null = null;

	function recordNotification(notification: Notification | null) {
		if (!notification || !notificationsReady) return;
		try {
			const next = [...notificationList, notification];
			notificationSnapshot = saveNotifications(localStorage, next, notificationSnapshot);
			notificationList = next;
			notificationError = '';
		} catch (error) {
			notificationError =
				error instanceof Error ? error.message : 'No se pudo guardar la notificación.';
		}
	}

	function handleMarkNotificationRead(id: string) {
		if (!notificationsReady) return;
		try {
			const next = markNotificationAsRead(notificationList, id);
			notificationSnapshot = saveNotifications(localStorage, next, notificationSnapshot);
			notificationList = next;
			notificationError = '';
		} catch (error) {
			notificationError =
				error instanceof Error ? error.message : 'No se pudo actualizar la notificación.';
		}
	}

	function handleMarkAllNotificationsRead() {
		if (!notificationsReady) return;
		try {
			const orgId = activeUser.organizationId;
			const next = markAllNotificationsAsRead(notificationList, activeUser.id, orgId);
			notificationSnapshot = saveNotifications(localStorage, next, notificationSnapshot);
			notificationList = next;
			notificationError = '';
		} catch (error) {
			notificationError =
				error instanceof Error ? error.message : 'No se pudieron actualizar las notificaciones.';
		}
	}

	function handleClearNotifications() {
		if (!notificationsReady) return;
		try {
			const orgId = activeUser.organizationId;
			const next = clearUserNotifications(notificationList, activeUser.id, orgId);
			notificationSnapshot = saveNotifications(localStorage, next, notificationSnapshot);
			notificationList = next;
			notificationError = '';
		} catch (error) {
			notificationError =
				error instanceof Error ? error.message : 'No se pudieron eliminar las notificaciones.';
		}
	}

	function handleMessageSent(incident: Incident | undefined, message: IncidentMessage) {
		if (!incident) return;
		if (!messageList.some((item) => item.id === message.id))
			messageList = [...messageList, message];
		if (message.visibility === 'internal') {
			const result = completeInternalNoteEffects(
				localStorage,
				activeUser,
				incident,
				message,
				userList
			);
			history = result.history;
			storedHistorySnapshot = localStorage.getItem(HISTORY_KEY);
			if (result.notifications) {
				notificationList = result.notifications;
				notificationSnapshot = localStorage.getItem(NOTIFICATIONS_KEY);
			}
			return;
		}
		const notifType: NotificationType = 'incident_comment';
		const notif = buildIncidentNotification({
			type: notifType,
			incident,
			actor: activeUser,
			message
		});
		recordNotification(notif);
	}

	// Rejection modal state
	let rejectModalOpen = $state(false);
	let rejectIncident = $state<Incident | null>(null);
	let rejectComment = $state('');

	// Reopen modal state
	let reopenModalOpen = $state(false);
	let reopenIncident = $state<Incident | null>(null);
	let reopenReason = $state('');

	// Ratings state
	let incidentRatings = $state<IncidentRating[]>([]);
	let ratingModalOpen = $state(false);
	let ratingIncident = $state<Incident | null>(null);

	function openRejectModal(incident: Incident) {
		rejectIncident = incident;
		rejectComment = '';
		rejectModalOpen = true;
	}

	function openReopenModal(incident: Incident) {
		reopenIncident = incident;
		reopenReason = '';
		reopenModalOpen = true;
	}

	function handleConfirmResolution(incident: Incident) {
		if (!canClientConfirmOrReject(incident, activeUser) || incidentLoadError) return;

		const closeTime = new Date().toISOString();
		const updated = recordStatusTransition(incident, 'closed', closeTime, {
			closureType: 'client_confirmed'
		});

		const historyEntry: IncidentHistoryEntry = {
			id: generateId(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: activeUser.id,
			timestamp: closeTime,
			eventType: 'resolution_accepted',
			newValue: {
				status: 'closed',
				closedAt: closeTime,
				closureType: 'client_confirmed'
			}
		};

		const nextList = incidentList.map((i) => (i.id === incident.id ? updated : i));
		const nextHistory = [...history, historyEntry];

		commitAssignment(
			localStorage,
			nextList,
			nextHistory,
			storedIncidentSnapshot,
			storedHistorySnapshot
		);
		incidentList = nextList;
		history = nextHistory;
		storedIncidentSnapshot = JSON.stringify(nextList);
		storedHistorySnapshot = JSON.stringify(nextHistory);

		if (editingIncident && editingIncident.id === incident.id) {
			editingIncident = { ...updated };
		}

		// Notification to technician
		const notif = buildIncidentNotification({
			type: 'incident_closed',
			incident: updated,
			actor: activeUser
		});
		recordNotification(notif);

		// Open rating modal if eligible
		if (canClientRateIncident(updated, activeUser, incidentRatings)) {
			ratingIncident = updated;
			ratingModalOpen = true;
		}
	}

	function handleRejectResolution(e: SubmitEvent) {
		e.preventDefault();
		if (!rejectIncident || !rejectComment.trim() || incidentLoadError) return;

		const incident = rejectIncident;
		const commentText = rejectComment.trim();
		const reopenTime = new Date().toISOString();
		const updated = recordStatusTransition(incident, 'open', reopenTime);

		const historyEntry: IncidentHistoryEntry = {
			id: generateId(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: activeUser.id,
			timestamp: reopenTime,
			eventType: 'resolution_rejected',
			newValue: {
				status: 'open',
				comment: commentText
			}
		};

		// Also add a public comment to messages so the technician can see why it was rejected
		const message: IncidentMessage = {
			id: generateId(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			authorUserId: activeUser.id,
			content: `[Solución rechazada]: ${commentText}`,
			visibility: 'public',
			createdAt: reopenTime
		};

		const rawMessages = localStorage.getItem(MESSAGES_KEY);
		const currentMessages = rawMessages ? loadMessages(rawMessages) : [];
		const nextMessages = [...currentMessages, message];
		const nextList = incidentList.map((i) => (i.id === incident.id ? updated : i));
		const nextHistory = [...history, historyEntry];

		try {
			commitTransitionWithMessage(
				localStorage,
				nextList,
				nextHistory,
				nextMessages,
				storedIncidentSnapshot,
				storedHistorySnapshot,
				rawMessages
			);
		} catch (error) {
			window.alert(
				error instanceof Error
					? error.message
					: 'No se pudo rechazar la solución. Los datos se han conservado.'
			);
			return;
		}

		incidentList = nextList;
		history = nextHistory;
		messageList = nextMessages;
		storedIncidentSnapshot = JSON.stringify(nextList);
		storedHistorySnapshot = JSON.stringify(nextHistory);

		if (editingIncident && editingIncident.id === incident.id) {
			editingIncident = { ...updated };
		}

		// Notifications are secondary: failure here must not undo or misreport a confirmed transition
		try {
			const notif = buildIncidentNotification({
				type: 'incident_reopened',
				incident: updated,
				actor: activeUser,
				reason: commentText
			});
			recordNotification(notif);
		} catch {
			// Secondary notification failure does not corrupt data
		}

		rejectModalOpen = false;
		rejectIncident = null;
		rejectComment = '';
	}

	function handleReopenClosed(e: SubmitEvent) {
		e.preventDefault();
		if (!reopenIncident || !reopenReason.trim() || incidentLoadError) return;

		const incident = reopenIncident;
		if (!canClientReopenIncident(incident, activeUser, now)) {
			window.alert('La ventana de reapertura de 24 horas ha expirado.');
			reopenModalOpen = false;
			return;
		}

		const reasonText = reopenReason.trim();
		const reopenTime = new Date().toISOString();
		const updated = recordStatusTransition(incident, 'open', reopenTime);

		const historyEntry: IncidentHistoryEntry = {
			id: generateId(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: activeUser.id,
			timestamp: reopenTime,
			eventType: 'reopened',
			newValue: {
				status: 'open',
				reason: reasonText
			}
		};

		// Also add a public comment to messages
		const message: IncidentMessage = {
			id: generateId(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			authorUserId: activeUser.id,
			content: `[Incidencia reabierta]: ${reasonText}`,
			visibility: 'public',
			createdAt: reopenTime
		};

		const rawMessages = localStorage.getItem(MESSAGES_KEY);
		const currentMessages = rawMessages ? loadMessages(rawMessages) : [];
		const nextMessages = [...currentMessages, message];
		const nextList = incidentList.map((i) => (i.id === incident.id ? updated : i));
		const nextHistory = [...history, historyEntry];

		try {
			commitTransitionWithMessage(
				localStorage,
				nextList,
				nextHistory,
				nextMessages,
				storedIncidentSnapshot,
				storedHistorySnapshot,
				rawMessages
			);
		} catch (error) {
			window.alert(
				error instanceof Error
					? error.message
					: 'No se pudo reabrir la incidencia. Los datos se han conservado.'
			);
			return;
		}

		incidentList = nextList;
		history = nextHistory;
		messageList = nextMessages;
		storedIncidentSnapshot = JSON.stringify(nextList);
		storedHistorySnapshot = JSON.stringify(nextHistory);

		if (editingIncident && editingIncident.id === incident.id) {
			editingIncident = { ...updated };
		}

		// Notifications are secondary: failure here must not undo or misreport a confirmed transition
		try {
			const notif = buildIncidentNotification({
				type: 'incident_reopened',
				incident: updated,
				actor: activeUser,
				reason: reasonText
			});
			recordNotification(notif);
		} catch {
			// Secondary notification failure does not corrupt data
		}

		reopenModalOpen = false;
		reopenIncident = null;
		reopenReason = '';
	}

	function handleSaveRating(ratingValue: number, ratingComment?: string) {
		if (!ratingIncident) return;
		const resolvedAt = getIncidentResolvedAt(ratingIncident);
		if (!resolvedAt) return;

		const orgId = incidentOrganizationId(ratingIncident);
		const newRating: IncidentRating = {
			id: generateId(),
			organizationId: orgId,
			incidentId: ratingIncident.id,
			resolvedAt,
			technicianUserId: ratingIncident.assignedToUserId || '',
			clientUserId: activeUser.id,
			rating: ratingValue,
			comment: ratingComment,
			createdAt: new Date().toISOString()
		};

		const nextRatings = [...incidentRatings, newRating];
		saveIncidentRatings(nextRatings, localStorage);
		incidentRatings = nextRatings;
		ratingModalOpen = false;
		ratingIncident = null;
	}

	function runAutoClosureSync(currentTime: Date = new Date()): void {
		if (incidentLoadError) return;
		try {
			const result = syncAndCommitAutoClosures(
				localStorage,
				incidentList,
				history,
				storedIncidentSnapshot,
				storedHistorySnapshot,
				currentTime
			);
			if (result.changed) {
				incidentList = result.state.incidents;
				history = result.state.history;
				storedIncidentSnapshot = result.state.incidentsSnapshot;
				storedHistorySnapshot = result.state.historySnapshot;
				if (editingIncident) {
					const closedCurrent = result.state.incidents.find((i) => i.id === editingIncident?.id);
					if (closedCurrent && closedCurrent.status === 'closed') {
						editingIncident = { ...closedCurrent };
					}
				}
			}
		} catch (error) {
			console.error('Error durante la sincronización de cierre automático:', error);
			incidentLoadError =
				error instanceof Error && error.message
					? error.message
					: 'Error durante el cierre automático de incidencias. Se ha bloqueado la edición para conservar los datos guardados.';
			throw error;
		}
	}

	onMount(() => {
		try {
			recoverAssignment(localStorage);
			recoverFirstResponse(localStorage);
			recoverTransitionWithMessage(localStorage);
			const stored = localStorage.getItem(STORAGE_KEY);
			storedIncidentSnapshot = stored;
			storedHistorySnapshot = localStorage.getItem(HISTORY_KEY);
			history = loadHistory(storedHistorySnapshot);
			if (stored !== null) {
				const parsed: unknown = JSON.parse(stored);
				if (!isIncidentList(parsed)) {
					throw new Error('Formato de incidencias no válido');
				}
				incidentList = parsed;
			}
			// Sincronizar auto-cierre determinista para incidencias resueltas >= 24h
			runAutoClosureSync(now);
			assignmentReady = true;
		} catch (error) {
			incidentLoadError =
				error instanceof Error && error.message
					? error.message
					: 'No se pudieron cargar las incidencias o su historial. Se ha bloqueado la edición para conservar los datos guardados.';
			incidentList = [];
		}

		try {
			slaPolicySnapshot = localStorage.getItem(SLA_POLICIES_KEY);
			const slaResult = loadSlaPoliciesResult(slaPolicySnapshot);
			if (slaResult.status === 'missing') {
				const initialRaw = JSON.stringify(slaResult.seededPolicies);
				localStorage.setItem(SLA_POLICIES_KEY, initialRaw);
				slaPolicySnapshot = initialRaw;
				slaCatalogState = { status: 'valid', policies: slaResult.seededPolicies };
				slaPoliciesReady = true;
			} else if (slaResult.status === 'valid') {
				slaCatalogState = { status: 'valid', policies: slaResult.policies };
				slaPoliciesReady = true;
			} else {
				slaCatalogState = {
					status: 'corrupt',
					error: slaResult.error,
					raw: slaPolicySnapshot ?? ''
				};
				slaPolicyError =
					'No se pudo cargar el catálogo de políticas SLA. Los datos guardados están corruptos y se han conservado; la administración y asignación SLA están bloqueadas.';
				slaPoliciesReady = false;
			}
		} catch {
			slaCatalogState = {
				status: 'corrupt',
				error: 'Error inesperado al leer el almacenamiento de SLA.',
				raw: slaPolicySnapshot ?? ''
			};
			slaPolicyError =
				'No se pudo cargar el catálogo de políticas SLA. Los datos guardados se han conservado; la administración y asignación SLA están bloqueadas.';
			slaPoliciesReady = false;
		}

		try {
			notificationSnapshot = localStorage.getItem(NOTIFICATIONS_KEY);
			const notifResult = loadNotificationsResult(notificationSnapshot);
			if (notifResult.status === 'corrupt') {
				notificationError =
					'No se pudieron cargar las notificaciones guardadas porque los datos están corruptos. Los datos se han conservado.';
				notificationsReady = false;
			} else {
				notificationList = notifResult.notifications;
				notificationsReady = true;
			}
		} catch {
			notificationError =
				'Error inesperado al leer las notificaciones guardadas. Los datos se han conservado.';
			notificationsReady = false;
		}

		try {
			const ratingsResult = loadIncidentRatings(localStorage);
			if (ratingsResult.status === 'valid') {
				incidentRatings = ratingsResult.ratings;
			} else {
				incidentRatings = [];
			}
		} catch {
			incidentRatings = [];
		}

		refreshMessages();

		if (localStorage.getItem(SUBCATEGORIES_STORAGE_KEY) === null) {
			initializeSubcategoriesCatalog(localStorage);
		}
		reloadSubcategories(localStorage.getItem(SUBCATEGORIES_STORAGE_KEY));
		reloadPriorityMatrices(localStorage.getItem(PRIORITY_MATRICES_STORAGE_KEY));

		function handleStorage(event: StorageEvent) {
			if (event.key === MESSAGES_KEY || event.key === null) refreshMessages();
			if (event.key === null) {
				reloadSubcategories(localStorage.getItem(SUBCATEGORIES_STORAGE_KEY));
				reloadPriorityMatrices(localStorage.getItem(PRIORITY_MATRICES_STORAGE_KEY));
			} else if (event.key === SUBCATEGORIES_STORAGE_KEY) {
				reloadSubcategories(
					event.newValue !== undefined
						? event.newValue
						: localStorage.getItem(SUBCATEGORIES_STORAGE_KEY)
				);
			} else if (event.key === PRIORITY_MATRICES_STORAGE_KEY) {
				reloadPriorityMatrices(
					event.newValue !== undefined
						? event.newValue
						: localStorage.getItem(PRIORITY_MATRICES_STORAGE_KEY)
				);
			}
		}

		window.addEventListener('storage', handleStorage);

		const intervalId = setInterval(() => {
			now = new Date();
			if (assignmentReady && !incidentLoadError) {
				try {
					runAutoClosureSync(now);
				} catch {
					// El error ya fue capturado y registrado en incidentLoadError
				}
			}
		}, 60_000);

		function handleVisibility() {
			if (document.visibilityState === 'visible') {
				now = new Date();
				if (assignmentReady && !incidentLoadError) {
					try {
						runAutoClosureSync(now);
					} catch {
						// El error ya fue capturado y registrado en incidentLoadError
					}
				}
			}
		}

		document.addEventListener('visibilitychange', handleVisibility);

		return () => {
			clearInterval(intervalId);
			document.removeEventListener('visibilitychange', handleVisibility);
			window.removeEventListener('storage', handleStorage);
		};
	});

	function updateSlaPolicy(change: SlaPolicyChange): boolean {
		if (!slaPoliciesReady || slaCatalogState.status !== 'valid') return false;
		try {
			const next = changeSlaPolicy(activeUser, slaCatalogState.policies, change);
			slaPolicySnapshot = saveSlaPolicies(localStorage, next, slaPolicySnapshot);
			slaCatalogState = { status: 'valid', policies: next };
			slaPolicyError = '';
			return true;
		} catch (error) {
			slaPolicyError =
				error instanceof Error ? error.message : 'No se pudo guardar la política SLA.';
			return false;
		}
	}

	let isFormOpen = $state(false);
	let newCategoryId = $state('');
	let newSubcategoryId = $state('');
	let newImpact = $state<ImpactLevel | ''>('');
	let newSiteId = $state('');

	const activeOrgId = $derived(activeUser.organizationId ?? demoOrganization.id);
	const selectedCategory = $derived(
		newCategoryId
			? categoryList.find(
					(c) => c.id === newCategoryId && c.active && canAccessRecord(activeUser, c)
				)
			: undefined
	);
	const availableSubcategories = $derived(
		subcategoriesReady && subcategoriesState.status === 'valid' && selectedCategory
			? getAvailableSubcategories(
					subcategoriesState.subcategories,
					categoryList,
					activeOrgId,
					selectedCategory.id
				)
			: []
	);
	const selectedSubcategory = $derived(
		newSubcategoryId ? availableSubcategories.find((s) => s.id === newSubcategoryId) : undefined
	);

	const matrixResult = $derived.by<PriorityMatrixLoadResult | null>(() => {
		if (!priorityMatricesReady) return null;
		if (priorityMatricesState.status === 'corrupt') {
			return {
				status: 'corrupt',
				error: priorityMatricesError || 'El catálogo de matrices de prioridad está corrupto.'
			};
		}
		try {
			return resolveOrganizationMatrix(priorityMatricesState.matrices, activeOrgId);
		} catch (err) {
			return {
				status: 'corrupt',
				error: err instanceof Error ? err.message : 'Error al resolver la matriz de prioridad.'
			};
		}
	});

	const classificationPreview = $derived.by<ClassificationResult | null>(() => {
		if (!selectedSubcategory || !newImpact || !isImpactLevel(newImpact)) {
			return null;
		}
		if (!matrixResult || matrixResult.status === 'corrupt') {
			return null;
		}
		try {
			return classifyIncident({
				subcategory: selectedSubcategory,
				impact: newImpact,
				matrix: matrixResult.matrix
			});
		} catch {
			return null;
		}
	});

	const calculatedOperationalPriority = $derived(
		classificationPreview ? toIncidentPriority(classificationPreview.effectivePriority) : null
	);

	const isCreationV2Valid = $derived(
		!!title.trim() &&
			!!(activeUser.role === 'client' ? activeUser.name : client.trim()) &&
			!!description.trim() &&
			!!newCategoryId &&
			!!selectedCategory &&
			!!newSubcategoryId &&
			!!selectedSubcategory &&
			!!newImpact &&
			isImpactLevel(newImpact) &&
			subcategoriesReady &&
			subcategoriesState.status === 'valid' &&
			priorityMatricesReady &&
			priorityMatricesState.status !== 'corrupt' &&
			matrixResult?.status !== 'corrupt' &&
			calculatedOperationalPriority !== null
	);

	$effect(() => {
		if (newSubcategoryId && !availableSubcategories.some((s) => s.id === newSubcategoryId)) {
			newSubcategoryId = '';
		}
	});

	const priorityLabels: Record<IncidentPriority, string> = {
		urgent: 'Urgente',
		high: 'Alta',
		medium: 'Media',
		low: 'Baja'
	};

	const priorityClasses: Record<IncidentPriority, string> = {
		urgent: 'text-priority-urgent',
		high: 'text-priority-high',
		medium: 'text-priority-medium',
		low: 'text-priority-low'
	};

	function persistIncidentEdit(original: Incident, change: IncidentEditChange): boolean {
		let result;
		try {
			result = commitIncidentEdit(
				localStorage,
				activeUser,
				original,
				change,
				incidentList,
				history,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
		} catch (error) {
			window.alert(
				error instanceof Error ? error.message : 'No se pudo guardar. Tu borrador se conserva.'
			);
			return false;
		}
		incidentList = result.incidents;
		history = result.history;
		storedIncidentSnapshot = JSON.stringify(result.incidents);
		storedHistorySnapshot = JSON.stringify(result.history);
		// Notifications are secondary: failure here must not undo or misreport a confirmed save.
		if (result.notificationInput) {
			try {
				const notification = buildIncidentNotification(result.notificationInput);
				if (notification && !notificationsReady) {
					notificationError =
						'La incidencia se ha guardado, pero las notificaciones no están disponibles.';
				} else recordNotification(notification);
			} catch {
				notificationError =
					'La incidencia se ha guardado, pero no se pudo generar la notificación.';
			}
		}
		return true;
	}

	function updateIncidentStatus(id: number, event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const status = select.value as IncidentStatus;
		const incident = incidentList.find((item) => item.id === id);
		if (!incident) return;
		if (
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:edit') ||
			status === 'closed' ||
			status === incident.status ||
			!['open', 'pending', 'resolved'].includes(status)
		) {
			select.value = incident.status;
			return;
		}
		const missingDescription = !incident.description?.trim();
		const missingSolution = status === 'resolved' && !incident.solution?.trim();
		if (missingDescription || missingSolution) {
			select.value = incident.status;
			window.alert(
				missingDescription
					? 'Completa la descripción del problema antes de cambiar el estado.'
					: 'Para resolver esta incidencia, indica la solución aplicada.'
			);
			openEditIncident(id);
			if (editingIncident) editingIncident.status = status;
			return;
		}
		if (!persistIncidentEdit(incident, { kind: 'status', status })) select.value = incident.status;
	}

	function deleteIncident(id: number) {
		const incident = incidentList.find((item) => item.id === id);

		if (
			!incident ||
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:delete')
		)
			return;

		const confirmed = window.confirm(
			`¿Eliminar permanentemente la incidencia #${incident.id}: "${incident.title}"? Esta acción no se puede deshacer.`
		);

		if (!confirmed) return;

		try {
			const result = commitIncidentDeletion(
				localStorage,
				activeUser,
				id,
				incidentList,
				history,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = result.incidents;
			storedIncidentSnapshot = JSON.stringify(result.incidents);
			if (editingIncident?.id === id) {
				editingIncident = null;
			}
		} catch (error) {
			incidentLoadError =
				error instanceof Error
					? error.message
					: 'No se pudieron guardar los cambios o los datos han cambiado en otra pestaña. Recarga antes de continuar.';
			window.alert(incidentLoadError);
		}
	}

	function createIncident(event: SubmitEvent) {
		event.preventDefault();

		if (
			incidentLoadError ||
			!assignmentReady ||
			!hasPermission(activeUser, 'incidents:create') ||
			!activeUser.organizationId ||
			!canAccessOrganization(activeUser, activeUser.organizationId)
		)
			return;
		const cleanTitle = title.trim();
		const cleanClient = activeUser.role === 'client' ? activeUser.name : client.trim();
		const cleanDescription = description.trim();

		const orgId = activeUser.organizationId ?? demoOrganization.id;
		const slaCheck = checkIncidentCreationSla(slaCatalogState, orgId);
		if (!slaCheck.allowed) {
			window.alert(slaCheck.error);
			return;
		}

		if (!cleanTitle || !cleanClient || !cleanDescription) {
			window.alert('Completa el título, el cliente y la descripción del problema.');
			return;
		}

		if (!subcategoriesReady || subcategoriesState.status === 'corrupt') {
			window.alert(
				subcategoriesError ||
					'El catálogo de subcategorías no está disponible o contiene datos corruptos. No se puede crear la incidencia.'
			);
			return;
		}

		if (!priorityMatricesReady || priorityMatricesState.status === 'corrupt') {
			window.alert(
				priorityMatricesError ||
					'El catálogo de matrices de prioridad no está disponible o contiene datos corruptos. No se puede crear la incidencia.'
			);
			return;
		}

		if (!newCategoryId) {
			window.alert('Selecciona una categoría obligatoria.');
			return;
		}
		const matchedCat = categoryList.find(
			(c) => c.id === newCategoryId && c.active && canAccessRecord(activeUser, c)
		);
		if (!matchedCat) {
			window.alert(
				'La categoría seleccionada no es válida, no pertenece a tu organización o está inactiva.'
			);
			return;
		}

		if (!newSubcategoryId) {
			window.alert('Selecciona una subcategoría obligatoria.');
			return;
		}
		const matchedSubcat = subcategoriesState.subcategories.find(
			(s) => s.id === newSubcategoryId && s.organizationId === orgId
		);
		if (!matchedSubcat) {
			window.alert('La subcategoría seleccionada no existe o no pertenece a tu organización.');
			return;
		}
		if (matchedSubcat.categoryId !== matchedCat.id) {
			window.alert('La subcategoría no pertenece a la categoría seleccionada.');
			return;
		}
		if (!matchedSubcat.active) {
			window.alert('La subcategoría seleccionada está inactiva.');
			return;
		}

		if (!newImpact || !isImpactLevel(newImpact)) {
			window.alert('Selecciona un nivel de impacto obligatorio (I1 a I4).');
			return;
		}

		const resolvedMatrix = resolveOrganizationMatrix(priorityMatricesState.matrices, orgId);
		if (resolvedMatrix.status === 'corrupt') {
			window.alert(resolvedMatrix.error);
			return;
		}

		let classificationRes: ClassificationResult;
		try {
			classificationRes = classifyIncident({
				subcategory: matchedSubcat,
				impact: newImpact,
				matrix: resolvedMatrix.matrix
			});
		} catch (err) {
			window.alert(
				err instanceof Error ? err.message : 'Error al calcular la clasificación de la incidencia.'
			);
			return;
		}

		const operationalPriority = toIncidentPriority(classificationRes.effectivePriority);

		// Retained messages must never attach to a new incident that reuses a deleted ID.
		let messageIncidentIds: number[];
		try {
			messageIncidentIds = loadMessages(localStorage.getItem(MESSAGES_KEY)).map(
				(message) => message.incidentId
			);
		} catch {
			window.alert(
				'No se pueden comprobar los identificadores de mensajes guardados. Revisa los datos antes de crear otra incidencia.'
			);
			return;
		}
		const nextId =
			Math.max(
				0,
				...incidentList.map((incident) => incident.id),
				...history.map((entry) => entry.incidentId),
				...messageIncidentIds
			) + 1;

		const categoryRouting = resolveCategoryRouting(matchedCat);

		let validatedSiteId: string | null = null;
		if (newSiteId) {
			if (!sitesLoaded || siteLoadError) {
				window.alert(
					siteLoadError ||
						'El catálogo de sedes no está disponible o contiene datos corruptos. No se puede asignar una sede.'
				);
				return;
			}
			try {
				const validatedSite = validateIncidentSite(newSiteId, orgId, siteList);
				validatedSiteId = validatedSite ? validatedSite.id : null;
			} catch (err) {
				window.alert(err instanceof Error ? err.message : 'Error al validar la sede seleccionada.');
				return;
			}
		}

		const draft: Incident = {
			id: nextId,
			organizationId: activeUser.organizationId,
			createdByUserId: activeUser.id,
			...(activeUser.role === 'client' ? { clientUserId: activeUser.id } : {}),
			title: cleanTitle,
			client: cleanClient,
			description: cleanDescription,
			solution: '',
			status: 'open',
			priority: operationalPriority,
			createdAt: new Date().toISOString(),
			siteId: validatedSiteId,
			categoryId: matchedCat.id,
			subcategoryId: matchedSubcat.id,
			classification: classificationRes.snapshot,
			...categoryRouting
		};

		const incidentWithSla = applyCreationSla(draft, slaCheck.policies);

		if (!isIncidentList([incidentWithSla])) {
			window.alert('Error interno al validar los datos de la incidencia creada.');
			return;
		}

		const nextIncidents = [incidentWithSla, ...incidentList];
		const createdEvent = buildCreatedHistoryEntry(incidentWithSla, activeUser.id);
		const nextHistory = [...history, createdEvent];

		try {
			if (localStorage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null) {
				throw new Error(
					'Hay una primera respuesta pendiente de recuperación. Recarga antes de continuar.'
				);
			}
			commitAssignment(
				localStorage,
				nextIncidents,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
		} catch (error) {
			window.alert(
				error instanceof Error
					? error.message
					: 'No se pudieron guardar la incidencia y su historial.'
			);
			return;
		}

		incidentList = nextIncidents;
		history = nextHistory;
		storedIncidentSnapshot = JSON.stringify(nextIncidents);
		storedHistorySnapshot = JSON.stringify(nextHistory);

		title = '';
		client = '';
		description = '';
		newCategoryId = '';
		newSubcategoryId = '';
		newImpact = '';
		newSiteId = '';
		isFormOpen = false;
	}

	type EditableIncident = Incident;

	let editingIncident = $state<EditableIncident | null>(null);
	let solutionExpanded = $state(false);
	const managedIncident = $derived(incidentList.find((item) => item.id === editingIncident?.id));

	function openEditIncident(id: number) {
		solutionExpanded = false;
		refreshMessages();
		const incident = incidentList.find((item) => item.id === id);

		if (!incident || incidentLoadError || !canViewIncident(activeUser, incident)) return;

		editingIncident = {
			...incident,
			description: incident.description ?? '',
			solution: incident.solution ?? ''
		};
	}

	function showEditDialog(dialog: HTMLDialogElement) {
		dialog.showModal();
	}

	function saveEditedIncident(event: SubmitEvent) {
		event.preventDefault();
		if (!editingIncident || incidentLoadError) return;
		const editingId = editingIncident.id;
		const original = incidentList.find((item) => item.id === editingId);
		if (!original) return;
		if (!persistIncidentEdit(original, { kind: 'edit', draft: editingIncident })) return;
		editingIncident = null;
		refreshMessages();
	}

	let categoryLoaded = $state(false);
	let categoryLoadError = $state('');
	let categorySaveError = $state('');

	function persistCategories(next: IncidentCategory[]): boolean {
		if (!categoryLoaded || categoryLoadError || !hasPermission(activeUser, 'categories:manage'))
			return false;
		try {
			localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(next));
			categoryList = next;
			categorySaveError = '';
			return true;
		} catch {
			categorySaveError =
				'No se pudieron guardar los cambios. El catálogo no se ha modificado. Inténtalo de nuevo.';
			return false;
		}
	}

	onMount(() => {
		try {
			const storedUsers = localStorage.getItem(USERS_STORAGE_KEY);
			const result = loadUsersResult(storedUsers);
			if (result.status === 'missing') {
				userList = result.seededUsers;
			} else if (result.status === 'valid') {
				userList = result.users;
			} else if (result.status === 'corrupt') {
				userLoadError = result.error;
			}
		} catch {
			userLoadError = 'No se pudieron cargar los usuarios guardados.';
		} finally {
			usersLoaded = true;
		}

		try {
			const storedCategories = localStorage.getItem(CATEGORY_STORAGE_KEY);
			const result = loadCategoriesResult(storedCategories);
			if (result.status === 'missing') {
				categoryList = result.seededCategories;
			} else if (result.status === 'valid') {
				categoryList = result.categories;
				// Persist migrated categories so subsequent loads have full modern routing fields
				localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(result.categories));
			} else if (result.status === 'corrupt') {
				categoryLoadError = result.error;
			}
		} catch {
			categoryLoadError =
				'No se pudo cargar el catálogo. No se han modificado los datos guardados.';
		} finally {
			categoryLoaded = true;
		}

		try {
			const storedLevels = localStorage.getItem(SUPPORT_LEVELS_STORAGE_KEY);
			const result = loadSupportLevelsResult(storedLevels);
			if (result.status === 'missing') {
				levelList = result.seededLevels;
			} else if (result.status === 'valid') {
				levelList = result.levels;
			} else if (result.status === 'corrupt') {
				levelLoadError = result.error;
			}
		} catch {
			levelLoadError = 'No se pudieron cargar los niveles de soporte guardados.';
		} finally {
			levelsLoaded = true;
		}

		try {
			const storedTeams = localStorage.getItem(SUPPORT_TEAMS_STORAGE_KEY);
			const result = loadSupportTeamsResult(storedTeams);
			if (result.status === 'missing') {
				teamList = result.seededTeams;
			} else if (result.status === 'valid') {
				teamList = result.teams;
			} else if (result.status === 'corrupt') {
				teamLoadError = result.error;
			}
		} catch {
			teamLoadError = 'No se pudieron cargar los equipos guardados.';
		} finally {
			teamsLoaded = true;
		}

		try {
			const storedSites = localStorage.getItem(SITES_STORAGE_KEY);
			const result = loadSitesResult(storedSites);
			if (result.status === 'missing') {
				siteList = result.seededSites;
			} else if (result.status === 'valid') {
				siteList = result.sites;
			} else if (result.status === 'corrupt') {
				siteLoadError = result.error;
			}
		} catch {
			siteLoadError = 'No se pudieron cargar las sedes guardadas.';
		} finally {
			sitesLoaded = true;
		}
	});
</script>

<svelte:head>
	<title>Panel | SoporteFlow</title>
	<meta name="description" content="Gestor de incidencias de soporte técnico" />
</svelte:head>

<div class="support-app min-h-screen bg-slate-950 text-white">
	<header class="app-header border-b border-slate-800 bg-slate-900">
		<div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
			<div class="flex flex-wrap items-center gap-4 sm:gap-6">
				<div>
					<div class="flex items-center gap-2">
						<p class="text-xl font-bold">Soporte<span class="text-cyan-400">Flow</span></p>
						<span
							class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
						>
							Incidencias en modo demo
						</span>
					</div>
					{#if sessionLoading}
						<p class="text-xs text-slate-400">Cargando sesión...</p>
					{:else if $session.error}
						<p class="text-xs text-red-400" role="alert">{$session.error}</p>
					{:else if $session.user}
						<p class="text-xs text-slate-300">
							<span class="font-medium text-white">{$session.user.name}</span>
							<span class="text-slate-500">·</span>
							{$session.user.email}
						</p>
						<OrganizationSelector
							organizations={$session.organizations}
							activeOrganizationId={$session.activeOrganization?.id ?? null}
							disabled={sessionLoading || isSigningOut}
							onchange={(id) => {
								session.setActiveOrganization(id);
							}}
						/>
					{:else}
						<p class="text-xs text-slate-400">Gestión de soporte técnico</p>
					{/if}
				</div>
				{#if activeUser.role === 'technician'}
					<nav
						class="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1"
						aria-label="Vistas principales"
					>
						<button
							type="button"
							onclick={() => (currentView = 'home')}
							class={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
								currentView === 'home'
									? 'bg-cyan-500 text-slate-950 shadow-xs'
									: 'text-slate-300 hover:bg-slate-800 hover:text-white'
							}`}
							aria-current={currentView === 'home' ? 'page' : undefined}
							data-testid="nav-tab-home"
						>
							Mi trabajo
						</button>
						<button
							type="button"
							onclick={() => (currentView = 'incidents')}
							class={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
								currentView === 'incidents'
									? 'bg-cyan-500 text-slate-950 shadow-xs'
									: 'text-slate-300 hover:bg-slate-800 hover:text-white'
							}`}
							aria-current={currentView === 'incidents' ? 'page' : undefined}
							data-testid="nav-tab-incidents"
						>
							Incidencias
						</button>
					</nav>
				{/if}
			</div>

			<div class="header-actions">
				<NotificationCenter
					user={activeUser}
					incidents={incidentList}
					{now}
					notifications={notificationList}
					{notificationError}
					onopenincident={(id) => openEditIncident(id)}
					onmarkread={handleMarkNotificationRead}
					onmarkallread={handleMarkAllNotificationsRead}
					onclearall={handleClearNotifications}
				/>
				<ThemeSelector />
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={handleSignOut}
						disabled={isSigningOut}
						class="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
						aria-label="Cerrar sesión"
					>
						{#if isSigningOut}
							Cerrando sesión...
						{:else}
							Cerrar sesión
						{/if}
					</button>
					{#if signOutError}
						<span role="alert" aria-live="assertive" class="text-xs font-medium text-red-400">
							{signOutError}
						</span>
					{/if}
				</div>
				{#if canAccessSettings(activeUser)}
					<button
						type="button"
						onclick={() =>
							(currentView =
								currentView === 'settings'
									? activeUser.role === 'technician'
										? 'home'
										: 'incidents'
									: 'settings')}
						class="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-400"
						aria-label={currentView === 'settings' ? 'Volver' : 'Configuración'}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-4 w-4 text-cyan-400"
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
						<span>Configuración</span>
					</button>
				{/if}
				{#if canCreate && !incidentLoadError}
					<button
						type="button"
						onclick={() => (isFormOpen = true)}
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
					>
						Nueva incidencia demo
					</button>
				{/if}
			</div>
		</div>
	</header>

	<main class="app-main mx-auto max-w-7xl px-6 py-10">
		<!-- Bloque independiente: Incidencias reales -->
		<section class="mb-10 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
			<div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
				<div class="flex items-center gap-3">
					<h2 class="text-xl font-bold text-white">Incidencias reales</h2>
					<span
						class="rounded border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-semibold text-cyan-300"
					>
						Datos reales · Solo lectura
					</span>
				</div>
				{#if $session.activeOrganization}
					<div class="flex items-center gap-4">
						<span class="text-sm font-medium text-slate-300">
							Organización: <span class="text-white">{$session.activeOrganization.name}</span>
						</span>
						<a
							href={resolve(`/app/incidents/new?organizationId=${$session.activeOrganization.id}`)}
							class="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
						>
							Nueva incidencia
						</a>
					</div>
				{/if}
			</div>

			<div class="mt-4">
				<div class="mb-4">
					<div
						class="flex w-fit items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1"
						role="tablist"
						aria-label="Colas de incidencias"
					>
						<button
							type="button"
							role="tab"
							aria-selected={activeQueue === 'mine'}
							onclick={() => selectQueue('mine')}
							class={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${
								activeQueue === 'mine'
									? 'bg-cyan-500 text-slate-950 shadow-xs'
									: 'text-slate-300 hover:bg-slate-800 hover:text-white'
							}`}
							data-testid="queue-tab-mine"
						>
							Mis incidencias
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={activeQueue === 'unassigned'}
							onclick={() => selectQueue('unassigned')}
							class={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${
								activeQueue === 'unassigned'
									? 'bg-cyan-500 text-slate-950 shadow-xs'
									: 'text-slate-300 hover:bg-slate-800 hover:text-white'
							}`}
							data-testid="queue-tab-unassigned"
						>
							Sin asignar
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={activeQueue === 'all'}
							onclick={() => selectQueue('all')}
							class={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${
								activeQueue === 'all'
									? 'bg-cyan-500 text-slate-950 shadow-xs'
									: 'text-slate-300 hover:bg-slate-800 hover:text-white'
							}`}
							data-testid="queue-tab-all"
						>
							Todas
						</button>
					</div>
				</div>

				{#if !$session.activeOrganization}
					<div class="rounded-lg border border-slate-800 bg-slate-950/40 p-6 text-center">
						<p class="text-sm text-slate-400">
							Selecciona una organización para consultar sus incidencias.
						</p>
					</div>
				{:else}
					<RealIncidentList
						incidents={realIncidents}
						loading={realLoading}
						error={realError}
						queue={activeQueue}
					/>
				{/if}
			</div>
		</section>

		<!-- Zona demo separada visualmente -->
		<div class="mb-8 border-t border-slate-800 pt-8">
			<div class="flex items-center gap-2">
				<h2 class="text-lg font-semibold text-slate-400">Demostración</h2>
				<span
					class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
				>
					Incidencias en modo demo
				</span>
			</div>
		</div>
		{#if currentView === 'settings' && canAccessSettings(activeUser)}
			{#key activeUser.id}
				<SettingsView
					actor={activeUser}
					users={userList}
					usersReady={usersLoaded}
					userError={userLoadError || userSaveError}
					onUserChange={persistUsers}
					supportLevels={levelList}
					supportLevelsReady={levelsLoaded}
					supportLevelError={levelLoadError || levelSaveError}
					onSupportLevelChange={persistLevels}
					teams={teamList}
					teamsReady={teamsLoaded}
					teamError={teamLoadError || teamSaveError}
					onTeamChange={persistTeams}
					sites={siteList}
					sitesReady={sitesLoaded}
					siteError={siteLoadError || siteSaveError}
					onSiteChange={persistSites}
					availableSupportLevels={levelList}
					availableTeams={teamList}
					availableSites={siteList}
					incidents={incidentList}
					categories={categoryList}
					categoriesReady={categoryLoaded}
					categoryError={categoryLoadError || categorySaveError}
					onCategoryChange={persistCategories}
					reasons={reasonList}
					{reasonsReady}
					{reasonError}
					onReasonChange={updateReason}
					slaPolicies={slaCatalogState.status === 'valid' ? slaCatalogState.policies : []}
					{slaPoliciesReady}
					{slaPolicyError}
					onSlaPolicyChange={updateSlaPolicy}
					onClose={() => (currentView = activeUser.role === 'technician' ? 'home' : 'incidents')}
				/>
			{/key}
		{:else if currentView === 'home' && activeUser.role === 'technician'}
			<TechnicianDashboard
				technician={activeUser}
				incidents={incidentList}
				{history}
				messages={messageList}
				users={userList}
				levels={levelList}
				teams={teamList}
				sites={siteList}
				categories={categoryList}
				{now}
				onopenincident={(id) => openEditIncident(id)}
				onassumeincident={(inc) => handleAssumeIncident(inc)}
				onviewallmine={() => {
					selectedQueue = 'mine';
					currentView = 'incidents';
				}}
			/>
		{:else}
			{#if !reasonsReady && reasonError && activeUser.role !== 'client'}<p
					role="alert"
					class="mb-4 text-sm text-red-300"
				>
					{reasonError}
				</p>{/if}
			{#if incidentLoadError}<p role="alert" class="mb-6 text-red-400">{incidentLoadError}</p>{/if}
			{#if activeUser.role === 'client'}<p class="mb-6 text-sm text-cyan-300">
					Solo se muestran tus incidencias. Las antiguas sin un cliente vinculado no se incluyen.
				</p>{/if}
			<section>
				<p class="text-sm font-medium text-cyan-400">Panel principal</p>
				<h1 class="mt-1 text-3xl font-bold">Resumen de incidencias</h1>
				<p class="mt-2 text-slate-400">Consulta rápidamente el estado del soporte técnico.</p>
			</section>

			<section class="mt-8 grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
				{#each summary as item (item.label)}
					<article
						class="flex min-h-[110px] flex-col justify-between rounded-xl border border-slate-800 bg-slate-900 p-5"
					>
						<div class="flex items-center justify-between gap-2">
							<p class="text-sm font-medium text-slate-400">{item.label}</p>
							<span class={`h-2.5 w-2.5 shrink-0 rounded-full ${item.badge}`}></span>
						</div>
						<p class={`mt-2 text-4xl font-bold ${item.color}`}>{item.value}</p>
					</article>
				{/each}
			</section>

			<section class="mt-8 rounded-xl border border-slate-800 bg-slate-900">
				<div class="border-b border-slate-800 px-6 py-5">
					<h2 class="text-lg font-semibold">
						{activeUser.role === 'technician'
							? queueOptions.find((option) => option.value === selectedQueue)?.label
							: 'Incidencias recientes'}
					</h2>
					{#if activeUser.role === 'technician'}
						<div class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Cola de trabajo">
							{#each queueOptions as option (option.value)}<button
									type="button"
									aria-pressed={selectedQueue === option.value}
									onclick={() => (selectedQueue = option.value)}
									class={`rounded-lg border px-4 py-2 text-sm font-semibold ${selectedQueue === option.value ? 'border-cyan-400 bg-cyan-500 text-slate-950' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
									>{option.label}</button
								>{/each}
						</div>
						<p class="mt-3 text-sm text-slate-300" role="status">
							Asignadas a mí: {mineCount} · Sin asignar: {unassignedCount}
						</p>
						<p class="mt-1 text-xs text-slate-400">
							Totales de tu organización, sin aplicar búsqueda ni estado.
						</p>
						{#if selectedQueue === 'mine'}<p class="mt-2 text-sm text-slate-400">
								Primero abiertas y pendientes, después resueltas. En cada grupo: prioridad alta
								primero y las más antiguas antes.
							</p>{/if}
					{/if}

					<p class="text-sm text-slate-400">Aquí aparecerán los últimos casos registrados.</p>

					<div class="mt-4">
						<label for="incident-search" class="mb-2 block text-sm font-medium text-slate-300">
							Buscar incidencias
						</label>

						<input
							id="incident-search"
							type="search"
							bind:value={searchQuery}
							placeholder="Buscar por ID, título o cliente..."
							class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
						/>

						<p class="mt-2 text-xs text-slate-400" role="status">
							Resultados: {filteredIncidents.length} de {currentQueue.length}
						</p>
					</div>

					<div class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Estado de la incidencia">
						{#each statusFilters as filter (filter.value)}
							<button
								type="button"
								onclick={() => (selectedStatus = filter.value)}
								aria-pressed={selectedStatus === filter.value}
								class={`rounded-lg px-3 py-2 text-sm font-medium transition ${
									selectedStatus === filter.value
										? 'bg-cyan-500 text-slate-950'
										: 'bg-slate-800 text-slate-400 hover:text-white'
								}`}
							>
								{filter.label}
							</button>
						{/each}
					</div>
				</div>

				<div class="overflow-x-auto">
					<table aria-label="Incidencias" class="incident-list w-full text-left">
						<thead class="text-xs text-slate-500 uppercase">
							<tr class="border-b border-slate-800">
								<th scope="col" class="min-w-[200px] px-6 py-4 font-medium">Incidencia</th>
								<th scope="col" class="min-w-[120px] px-6 py-4 font-medium">Cliente</th>
								<th scope="col" class="px-6 py-4 font-medium">Categoría</th>
								<th scope="col" class="px-6 py-4 font-medium">Nivel</th>
								<th scope="col" class="min-w-[120px] px-6 py-4 font-medium whitespace-nowrap"
									>Prioridad</th
								>
								<th scope="col" class="min-w-[130px] px-6 py-4 font-medium whitespace-nowrap"
									>SLA</th
								>
								<th scope="col" class="min-w-[120px] px-6 py-4 font-medium whitespace-nowrap"
									>Estado</th
								>
								<th scope="col" class="px-6 py-4 font-medium whitespace-nowrap">Fecha</th>
							</tr>
						</thead>

						<tbody>
							{#each filteredIncidents as incident (incident.id)}
								<tr
									class="incident-row border-b border-slate-800/70 last:border-0 hover:bg-slate-800/30"
								>
									<td class="incident-title px-6 py-4">
										{#if canViewIncident(activeUser, incident)}
											<button
												type="button"
												onclick={() => openEditIncident(incident.id)}
												aria-label={`${canEdit ? 'Editar' : 'Abrir'} incidencia ${incident.id}: ${incident.title}`}
												class="rounded text-left font-medium text-cyan-400 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400"
											>
												{incident.title}
											</button>
										{:else}<p class="font-medium">{incident.title}</p>
											<p class="mt-2 text-sm text-slate-400">
												{incident.description ?? 'Sin descripción'}
											</p>
											{#if incident.solution}<p class="mt-1 text-sm text-slate-400">
													Solución: {incident.solution}
												</p>{/if}{/if}
										<p class="mt-1 text-xs text-slate-500">#{incident.id}</p>
										<p class="mt-2 text-sm text-slate-300">
											{incident.assignedToUserId ? 'Asignado a: ' : ''}{assigneeName(incident)}
										</p>
										{#if assignmentReady && !incidentLoadError && activeUser.role === 'technician' && !incident.assignedToUserId && canAssignTo(activeUser, incident, activeUser.id, levelList)}
											<button
												type="button"
												onclick={() => openAssignment(incident, true)}
												class="mt-2 rounded border border-slate-700 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
												>Asignarme</button
											>
										{/if}
									</td>

									<td class="px-6 py-4 text-sm text-slate-400">
										<span class="mobile-field-label" aria-hidden="true">Cliente</span
										>{incident.client}
									</td>

									<td class="incident-category px-6 py-4 text-sm text-slate-300">
										<span class="mobile-field-label" aria-hidden="true">Categoría</span>
										{categoryName(incident)}
									</td>

									<td class="incident-level px-6 py-4 text-sm whitespace-nowrap">
										<span class="mobile-field-label" aria-hidden="true">Nivel</span>
										{#if incident.supportLevel}
											<span
												class="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-semibold text-cyan-300"
											>
												{incident.supportLevel}
											</span>
										{:else}
											<span class="text-xs text-slate-500">—</span>
										{/if}
									</td>

									<td
										role="cell"
										class={`px-6 py-4 text-sm font-medium whitespace-nowrap ${priorityClasses[incident.priority]}`}
									>
										<span class="mobile-field-label" aria-hidden="true">Prioridad</span>
										<span class="inline-flex items-center gap-1.5 whitespace-nowrap">
											{priorityLabels[incident.priority]}
											{#if incident.classification?.hasOverride}
												<span
													class="badge-override-table rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase"
													title="Override de prioridad activo"
												>
													Override
												</span>
											{/if}
										</span>
									</td>

									<td class="incident-sla px-6 py-4 text-sm whitespace-nowrap">
										<span class="mobile-field-label" aria-hidden="true">SLA</span>
										<div class="flex items-center gap-1.5 whitespace-nowrap">
											{#if isIncidentReopened(incident, history)}
												<span
													class="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-xs font-bold tracking-wide whitespace-nowrap text-rose-400 uppercase shadow-xs"
													data-testid="reopened-badge"
												>
													<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500"></span>
													Reabierta
												</span>
											{/if}
											<SlaBadge {incident} {now} />
										</div>
									</td>

									<td class="incident-state px-6 py-4 whitespace-nowrap"
										><span class="mobile-field-label" aria-hidden="true">Estado</span>
										{#if incident.status === 'closed'}
											<span
												class="inline-flex items-center rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300"
											>
												Cerrada
											</span>
										{:else if canEdit}
											<select
												value={incident.status}
												onchange={(event) => updateIncidentStatus(incident.id, event)}
												class="rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
												aria-label={`Cambiar estado de ${incident.title}`}
											>
												<option value="open">Abierta</option>
												<option value="pending">Pendiente</option>
												<option value="resolved">Resuelta</option>
											</select>
										{:else}<span class="text-sm text-slate-300"
												>{statusFilters.find((filter) => filter.value === incident.status)
													?.label}</span
											>{/if}
									</td>

									<td class="incident-date px-6 py-4 text-sm whitespace-nowrap text-slate-500"
										><span class="mobile-field-label" aria-hidden="true">Fecha</span>
										{new Date(incident.createdAt).toLocaleDateString('es-ES')}
									</td>
								</tr>
							{:else}
								<tr>
									<td colspan="8" class="px-6 py-10 text-center text-sm text-slate-400">
										No hay incidencias que coincidan con los filtros actuales.
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	</main>
	{#if assignmentIncident && assignmentReady && !incidentLoadError && canActOnIncident(activeUser, assignmentIncident, 'incidents:assign')}
		<AssignmentDialog
			incident={assignmentIncident}
			actor={activeUser}
			users={userList}
			teams={teamList}
			levels={levelList}
			categories={categoryList}
			reasons={reasonList}
			initialTarget={assignmentTarget}
			error={assignmentError}
			onconfirm={confirmAssignment}
			oncancel={() => {
				assignmentIncident = null;
				assignmentError = '';
			}}
		/>
	{/if}
	{#if classificationIncident && assignmentReady && !incidentLoadError && canEscalate(activeUser, classificationIncident)}
		<ClassificationDialog
			incident={classificationIncident}
			categories={categoryList}
			levels={levelList}
			teams={teamList}
			reasons={reasonList}
			error={classificationError}
			onconfirm={confirmClassification}
			oncancel={() => {
				classificationIncident = null;
				classificationError = '';
			}}
		/>
	{/if}
	{#if siteChangeIncident}
		<ChangeSiteDialog
			incident={siteChangeIncident}
			sites={siteList}
			error={siteChangeError}
			onconfirm={confirmChangeSite}
			oncancel={() => {
				siteChangeIncident = null;
				siteChangeError = '';
			}}
		/>
	{/if}
	{#if isFormOpen && canCreate && !incidentLoadError}
		<dialog
			use:showEditDialog
			onclose={() => (isFormOpen = false)}
			aria-labelledby="new-incident-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			<div class="flex items-start justify-between">
				<div>
					<p class="text-sm font-medium text-cyan-400">Soporte técnico</p>
					<h2 id="new-incident-title" class="mt-1 text-2xl font-bold">Nueva incidencia</h2>
				</div>

				<button
					type="button"
					onclick={() => (isFormOpen = false)}
					aria-label="Cerrar formulario"
					class="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800 hover:text-white"
				>
					✕
				</button>
			</div>

			<form class="mt-6 space-y-5" onsubmit={createIncident}>
				<div>
					<label for="title" class="mb-2 block text-sm font-medium text-slate-300">Título</label>
					<input
						id="title"
						bind:value={title}
						required
						placeholder="Ej.: El portátil no se conecta a la red"
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="client" class="mb-2 block text-sm font-medium text-slate-300">
						Cliente
					</label>
					<input
						id="client"
						bind:value={client}
						disabled={activeUser.role === 'client'}
						placeholder={activeUser.role === 'client' ? activeUser.name : 'Nombre del cliente'}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="new-description" class="mb-2 block text-sm font-medium text-slate-300">
						Descripción del problema (obligatoria)
					</label>

					<textarea
						id="new-description"
						bind:value={description}
						required
						rows="3"
						placeholder="¿Qué ocurre, desde cuándo y a quién afecta?"
						class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					></textarea>
				</div>

				<div>
					<label for="new-category" class="mb-2 block text-sm font-medium text-slate-300">
						Categoría <span class="text-rose-400">*</span>
					</label>
					<select
						id="new-category"
						bind:value={newCategoryId}
						onchange={() => {
							newSubcategoryId = '';
						}}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="">Selecciona una categoría</option>
						{#each categoryList.filter((c) => c.active && canAccessRecord(activeUser, c)) as cat (cat.id)}
							<option value={cat.id}>{cat.name}</option>
						{/each}
					</select>
					{#if newCategoryId}
						{@const selectedCat = categoryList.find((c) => c.id === newCategoryId)}
						{#if selectedCat && (selectedCat.defaultSupportLevel || selectedCat.defaultTeamId)}
							{@const selectedTeam = teamList.find((t) => t.id === selectedCat.defaultTeamId)}
							<p class="mt-1.5 text-xs text-slate-400">
								Routing inicial:
								<span class="font-medium text-cyan-300"
									>{selectedCat.defaultSupportLevel ?? '—'}</span
								>
								·
								<span class="font-medium text-slate-300"
									>{selectedTeam ? selectedTeam.name : (selectedCat.defaultTeamId ?? '—')}</span
								>
							</p>
						{/if}
					{/if}
				</div>

				<div>
					<label for="new-subcategory" class="mb-2 block text-sm font-medium text-slate-300">
						Subcategoría <span class="text-rose-400">*</span>
					</label>
					{#if subcategoriesState.status === 'corrupt'}
						<div
							class="rounded-lg border border-rose-500/50 bg-rose-950/30 p-3 text-xs text-rose-300"
						>
							{subcategoriesError ||
								'Catálogo de subcategorías corrupto. Se ha bloqueado la creación.'}
						</div>
					{:else}
						<select
							id="new-subcategory"
							bind:value={newSubcategoryId}
							disabled={!newCategoryId || availableSubcategories.length === 0}
							required
							class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{#if !newCategoryId}
								<option value="">Selecciona primero una categoría</option>
							{:else if availableSubcategories.length === 0}
								<option value="">No hay subcategorías activas disponibles</option>
							{:else}
								<option value="">Selecciona una subcategoría</option>
								{#each availableSubcategories as sub (sub.id)}
									<option value={sub.id}>{sub.name}</option>
								{/each}
							{/if}
						</select>
						{#if newCategoryId && availableSubcategories.length === 0}
							<p class="mt-1.5 text-xs text-amber-400">
								Esta categoría no dispone de subcategorías activas configuradas para tu
								organización.
							</p>
						{/if}
					{/if}
				</div>

				<div>
					<label for="new-impact" class="mb-2 block text-sm font-medium text-slate-300">
						Impacto <span class="text-rose-400">*</span>
					</label>
					<select
						id="new-impact"
						bind:value={newImpact}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="">Selecciona el impacto</option>
						<option value="I1">I1 — Una persona.</option>
						<option value="I2">I2 — Varias personas.</option>
						<option value="I3">I3 — Equipo o departamento.</option>
						<option value="I4">I4 — Sede u organización completa.</option>
					</select>
				</div>

				<div>
					<label for="new-site" class="mb-2 block text-sm font-medium text-slate-300">
						Sede / Ubicación
					</label>
					<select
						id="new-site"
						bind:value={newSiteId}
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="">Sin sede asignada</option>
						{#each siteList.filter((s) => s.active && canAccessRecord(activeUser, s)) as site (site.id)}
							<option value={site.id}>{site.name}</option>
						{/each}
					</select>
				</div>

				<div>
					<span class="mb-2 block text-sm font-medium text-slate-300">
						Prioridad calculada (automática)
					</span>
					{#if priorityMatricesState.status === 'corrupt'}
						<div
							class="rounded-lg border border-rose-500/50 bg-rose-950/30 p-3 text-xs text-rose-300"
						>
							{priorityMatricesError ||
								'Catálogo de matrices de prioridad corrupto. No se puede calcular la prioridad.'}
						</div>
					{:else if calculatedOperationalPriority}
						<div
							class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-3"
						>
							<span class="text-sm font-semibold {priorityClasses[calculatedOperationalPriority]}">
								{priorityLabels[calculatedOperationalPriority]}
							</span>
							{#if classificationPreview?.snapshot?.minPriorityApplied}
								<span class="text-xs text-amber-400">
									Elevada por prioridad mínima de la subcategoría
								</span>
							{/if}
						</div>
					{:else}
						<div
							class="rounded-lg border border-dashed border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-500"
						>
							Pendiente de clasificación (selecciona subcategoría e impacto)
						</div>
					{/if}
				</div>

				<div class="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onclick={() => (isFormOpen = false)}
						class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
					>
						Cancelar
					</button>

					<button
						type="submit"
						disabled={!isCreationV2Valid}
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Crear incidencia
					</button>
				</div>
			</form>
		</dialog>
	{/if}

	{#if editingIncident && managedIncident && canViewIncident(activeUser, managedIncident)}
		<dialog
			use:showEditDialog
			onclose={() => {
				editingIncident = null;
				refreshMessages();
			}}
			aria-labelledby="edit-incident-title"
			class="incident-workspace fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			<div class="flex items-start justify-between gap-4">
				<div>
					<div class="flex items-center gap-2">
						<p class="text-sm font-medium text-cyan-400">
							Incidencia #{editingIncident.id}
						</p>
						{#if managedIncident && isIncidentReopened(managedIncident, history)}
							<span
								class="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-xs font-bold tracking-wide text-rose-400 uppercase shadow-xs"
								data-testid="detail-reopened-badge"
							>
								<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500"></span>
								Reabierta
							</span>
						{/if}
					</div>
					<h2 id="edit-incident-title" class="mt-1 text-2xl font-bold">
						{managedIncident?.title || 'Sin título'}
					</h2>
				</div>

				<button
					type="button"
					onclick={() => {
						editingIncident = null;
						refreshMessages();
					}}
					aria-label="Cerrar incidencia"
					class="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800 hover:text-white"
				>
					✕
				</button>
			</div>

			<div class="incident-workspace-grid">
				{#if canActOnIncident(activeUser, managedIncident, 'incidents:edit')}
					<form class="incident-information space-y-3" onsubmit={saveEditedIncident}>
						<h3 class="text-sm font-semibold text-slate-300">Información</h3>
						<div>
							<label for="edit-title" class="mb-2 block text-sm font-medium text-slate-300">
								Título
							</label>
							<input
								id="edit-title"
								bind:value={editingIncident.title}
								required
								class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
							/>
						</div>

						<div>
							<label for="edit-client" class="mb-2 block text-sm font-medium text-slate-300">
								Cliente
							</label>
							<input
								id="edit-client"
								bind:value={editingIncident.client}
								required
								class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
							/>
						</div>

						<div>
							<label for="edit-description" class="mb-2 block text-sm font-medium text-slate-300">
								Descripción del problema (obligatoria)
							</label>
							<textarea
								id="edit-description"
								bind:value={editingIncident.description}
								required
								rows="3"
								placeholder="¿Qué ocurre, desde cuándo y a quién afecta?"
								class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
							></textarea>
						</div>

						<p class="text-sm text-slate-400">
							Categoría: {categoryName(managedIncident ?? editingIncident)}
						</p>
						<div class="grid grid-cols-2 items-start gap-3">
							<div>
								{#if editingIncident.classification}
									<label
										for="edit-priority-display"
										class="incident-field-label mb-2 block text-sm font-medium text-slate-300"
									>
										Prioridad {editingIncident.classification.hasOverride
											? 'operativa'
											: 'calculada'}
									</label>
									<div
										id="edit-priority-display"
										class="incident-field-control flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-950/60 text-sm text-slate-300"
									>
										<span>{priorityLabels[editingIncident.priority]}</span>
										{#if editingIncident.classification.hasOverride}
											<span
												class="badge-override-active rounded-full px-2 py-0.5 text-xs leading-none font-bold uppercase"
											>
												Override
											</span>
										{/if}
									</div>
								{:else}
									<label
										for="edit-priority"
										class="incident-field-label mb-2 block text-sm font-medium text-slate-300"
									>
										Prioridad
									</label>
									<select
										id="edit-priority"
										bind:value={editingIncident.priority}
										class="incident-field-control flex w-full items-center rounded-lg border border-slate-700 bg-slate-950 text-sm text-white outline-none focus:border-cyan-400"
									>
										<option value="low">Baja</option>
										<option value="medium">Media</option>
										<option value="high">Alta</option>
										<option value="urgent">Urgente</option>
									</select>
								{/if}
							</div>

							<div>
								<label
									for="edit-status"
									class="incident-field-label mb-2 block text-sm font-medium text-slate-300"
								>
									Estado
								</label>
								{#if editingIncident.status === 'closed'}
									<div
										id="edit-status-display"
										class="incident-field-control flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-300"
									>
										<span class="h-2 w-2 shrink-0 rounded-full bg-slate-400"></span>
										<span class="truncate"
											>Cerrada (confirmada por cliente o auto-cierre tras 24 h)</span
										>
									</div>
								{:else}
									<select
										id="edit-status"
										bind:value={editingIncident.status}
										class="incident-field-control flex w-full items-center rounded-lg border border-slate-700 bg-slate-950 text-sm text-white outline-none focus:border-cyan-400"
									>
										<option value="open">Abierta</option>
										<option value="pending">Pendiente</option>
										<option value="resolved">Resuelta</option>
									</select>
								{/if}
							</div>
						</div>

						{#if solutionExpanded || editingIncident.status === 'resolved' || editingIncident.status === 'closed' || editingIncident.solution?.trim()}
							<div>
								<label for="edit-solution" class="mb-2 block text-sm font-medium text-slate-300">
									Solución aplicada
									{editingIncident.status === 'resolved' || editingIncident.status === 'closed'
										? '(obligatoria)'
										: '(opcional)'}
								</label>
								<textarea
									id="edit-solution"
									bind:value={editingIncident.solution}
									required={editingIncident.status === 'resolved' ||
										editingIncident.status === 'closed'}
									aria-describedby="edit-solution-help"
									rows="3"
									placeholder="Describe las acciones realizadas y el resultado."
									class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
								></textarea>
								<p id="edit-solution-help" class="mt-2 text-xs text-slate-400">
									Para marcar la incidencia como resuelta debes documentar la solución. No incluyas
									contraseñas ni credenciales.
								</p>
							</div>
						{:else}
							<button
								type="button"
								class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-cyan-300"
								onclick={() => (solutionExpanded = true)}>Añadir solución</button
							>
						{/if}

						<div class="flex justify-end gap-3 pt-2">
							<button
								type="button"
								onclick={() => (editingIncident = null)}
								class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
							>
								Cancelar
							</button>

							<button
								type="submit"
								class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
							>
								Guardar cambios
							</button>
						</div>
					</form>
				{:else}
					<section class="incident-information space-y-3" aria-label="Información de la incidencia">
						{#if managedIncident.status === 'resolved'}
							<div class="space-y-3 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-4">
								<div class="flex items-center gap-2 text-sm font-semibold text-emerald-300">
									<svg
										class="h-5 w-5 shrink-0"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
										/>
									</svg>
									<span>Solución propuesta · Esperando confirmación del cliente</span>
								</div>
								{#if canClientConfirmOrReject(managedIncident, activeUser)}
									<p class="text-xs text-slate-300">
										El equipo de soporte ha registrado la solución propuesta. Por favor, revisa si
										resuelve tu consulta o problema. Si confirmas, la incidencia quedará cerrada.
										{#if getAutoCloseRemainingMinutes(managedIncident, now) !== null}
											<span class="mt-1 block font-medium text-amber-300">
												(Se cerrará automáticamente si no hay respuesta en {Math.max(
													1,
													Math.round((getAutoCloseRemainingMinutes(managedIncident, now) ?? 0) / 60)
												)} h).
											</span>
										{/if}
									</p>
									<div class="flex flex-wrap items-center gap-3 pt-1">
										<button
											type="button"
											onclick={() => handleConfirmResolution(managedIncident)}
											class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 shadow-sm transition-colors hover:bg-emerald-400"
										>
											✓ Confirmar solución
										</button>
										<button
											type="button"
											onclick={() => openRejectModal(managedIncident)}
											class="btn-reject-solution inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold shadow-xs"
										>
											✕ Rechazar solución
										</button>
									</div>
								{:else}
									<p class="text-xs text-slate-300">
										La incidencia se encuentra resuelta a la espera de que el cliente valide la
										solución propuesta.
										{#if getAutoCloseRemainingMinutes(managedIncident, now) !== null}
											<span class="mt-1 block text-slate-400">
												Cierre automático programado por inactividad tras 24 h (restan aprox. {Math.max(
													1,
													Math.round((getAutoCloseRemainingMinutes(managedIncident, now) ?? 0) / 60)
												)} h si no responde).
											</span>
										{/if}
									</p>
								{/if}
							</div>
						{/if}

						{#if managedIncident.status === 'closed'}
							<div class="space-y-2.5 rounded-xl border border-slate-700/80 bg-slate-950/60 p-4">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-2 text-sm font-semibold text-slate-200">
										<span class="inline-block h-2 w-2 rounded-full bg-slate-400"></span>
										<span>
											{managedIncident.closureType === 'auto_closed'
												? 'Incidencia cerrada automáticamente (por inactividad tras 24 h)'
												: 'Incidencia cerrada · Solución confirmada por el cliente'}
										</span>
									</div>
									{#if managedIncident.closedAt}
										<span class="text-xs text-slate-400">
											{new Date(managedIncident.closedAt).toLocaleString('es-ES')}
										</span>
									{/if}
								</div>
								{#if activeUser.role === 'client' && managedIncident.clientUserId === activeUser.id}
									{#if canClientReopenIncident(managedIncident, activeUser, now)}
										{@const reopenDeadline = new Date(
											Date.parse(
												managedIncident.closedAt ||
													managedIncident.updatedAt ||
													managedIncident.createdAt
											) +
												24 * 60 * 60 * 1000
										)}
										<div class="flex flex-wrap items-center justify-between gap-3 pt-1">
											<p class="text-xs text-slate-400">
												Si el problema persiste, puedes reabrirla hasta el <strong
													class="text-slate-200">{reopenDeadline.toLocaleString('es-ES')}</strong
												>
												(restan aprox. {Math.max(
													1,
													Math.round((getReopenRemainingMinutes(managedIncident, now) ?? 0) / 60)
												)} h).
											</p>
											<button
												type="button"
												onclick={() => openReopenModal(managedIncident)}
												class="shrink-0 cursor-pointer rounded-lg border border-amber-500/50 bg-amber-950/30 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-900/40"
											>
												Reabrir incidencia
											</button>
										</div>
									{:else}
										<p class="text-xs text-slate-500 italic">
											La ventana de reapertura de 24 horas ha expirado. Incidencia cerrada
											definitivamente.
										</p>
									{/if}
								{:else if managedIncident.closedAt}
									{@const remainingMinutes = getReopenRemainingMinutes(managedIncident, now) ?? 0}
									{#if remainingMinutes > 0}
										<p class="text-xs text-slate-400">
											Ventana de reapertura del cliente activa (restan aprox. {Math.max(
												1,
												Math.round(remainingMinutes / 60)
											)} h).
										</p>
									{:else}
										<p class="text-xs text-slate-500 italic">
											Ventana de reapertura finalizada. Caso cerrado de forma definitiva.
										</p>
									{/if}
								{/if}
							</div>
						{/if}

						{#if activeUser.role === 'client' && canClientRateIncident(managedIncident, activeUser, incidentRatings)}
							<div
								class="flex items-center justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-950/20 p-4"
							>
								<div>
									<p class="text-sm font-semibold text-amber-300">Valoración del servicio</p>
									<p class="mt-0.5 text-xs text-slate-400">
										¿Qué te ha parecido la atención recibida en esta resolución?
									</p>
								</div>
								<button
									type="button"
									onclick={() => {
										ratingIncident = managedIncident;
										ratingModalOpen = true;
									}}
									class="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 shadow-sm transition-colors hover:bg-amber-400"
								>
									★ Valorar atención
								</button>
							</div>
						{/if}

						{#if getRatingForResolution(managedIncident, incidentRatings)}
							{@const r = getRatingForResolution(managedIncident, incidentRatings)!}
							<div class="space-y-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-2">
										<span class="text-sm font-semibold text-amber-300"
											>Satisfacción del cliente:</span
										>
										<div class="flex text-amber-400" aria-label="{r.rating} de 5 estrellas">
											{#each [1, 2, 3, 4, 5] as star (star)}
												<span>{star <= r.rating ? '★' : '☆'}</span>
											{/each}
										</div>
										<span class="text-xs font-medium text-amber-200">({r.rating}/5)</span>
									</div>
									<span class="text-xs text-slate-400"
										>{new Date(r.createdAt).toLocaleDateString('es-ES')}</span
									>
								</div>
								{#if r.comment}
									<p
										class="border-l-2 border-amber-400/60 py-0.5 pl-2 text-xs text-slate-300 italic"
									>
										"{r.comment}"
									</p>
								{/if}
								<p class="text-[11px] text-slate-400">
									Técnico evaluado: <strong class="text-slate-200"
										>{userList.find((u) => u.id === r.technicianUserId)?.name || 'Técnico'}</strong
									>
								</p>
							</div>
						{/if}

						<p class="text-sm text-slate-300">Cliente: {managedIncident.client}</p>
						<p class="text-sm text-slate-400">Categoría: {categoryName(managedIncident)}</p>
						<p class="text-sm text-slate-300">
							Prioridad: {priorityLabels[managedIncident.priority]} · Estado: {statusFilters.find(
								(filter) => filter.value === managedIncident.status
							)?.label}
						</p>
						<h3 class="text-sm font-semibold">Descripción</h3>
						<p class="text-sm whitespace-pre-wrap text-slate-300">
							{managedIncident.description || 'Sin descripción'}
						</p>
						{#if managedIncident.solution}<h3 class="text-sm font-semibold">Solución aplicada</h3>
							<p class="text-sm whitespace-pre-wrap text-slate-300">
								{managedIncident.solution}
							</p>{/if}
					</section>
				{/if}

				{#if managedIncident}
					{@const currentAssignee = userList.find((u) => u.id === managedIncident.assignedToUserId)}
					{@const incompatibility = getAssigneeLevelIncompatibility(
						managedIncident,
						currentAssignee,
						levelList
					)}
					<div class="space-y-4">
						<section
							aria-labelledby="incident-management-title"
							class="incident-management rounded-xl border border-slate-700 p-4"
						>
							<h3 id="incident-management-title" class="text-lg font-semibold">
								Gestión de la incidencia
							</h3>
							<dl class="management-values mt-3 grid gap-3 text-sm">
								<div>
									<dt class="text-slate-400">Responsable</dt>
									<dd class="mt-1">{assigneeName(managedIncident)}</dd>
								</div>
								<div>
									<dt class="text-slate-400">Nivel requerido</dt>
									<dd class="mt-1">{managedIncident.supportLevel ?? 'Sin nivel'}</dd>
								</div>
								<div>
									<dt class="text-slate-400">Equipo</dt>
									<dd class="mt-1">{teamName(managedIncident)}</dd>
								</div>
								<div>
									<dt class="text-slate-400">Sede</dt>
									<dd class="mt-1">{siteNameForIncident(managedIncident)}</dd>
								</div>
							</dl>
							{#if incompatibility}
								<div
									role="alert"
									class="incompatibility-warning mt-3 flex items-start gap-2.5 rounded-lg border p-3 text-xs leading-relaxed"
								>
									<svg
										class="warning-icon mt-0.5 h-4 w-4 shrink-0"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
										aria-hidden="true"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
										/>
									</svg>
									<div class="space-y-0.5">
										<p class="warning-title font-semibold">
											Responsable por debajo del nivel requerido
										</p>
										<p class="warning-text">
											{incompatibility.message}
										</p>
									</div>
								</div>
							{/if}
							<div class="mt-4 flex flex-wrap gap-3">
								{#if assignmentReady && !incidentLoadError}
									{#if canManageAssignment(activeUser, managedIncident)}
										<button
											type="button"
											onclick={() => openAssignment(managedIncident)}
											class="rounded border px-3 py-2 text-sm transition-colors {incompatibility
												? 'btn-reassign-emphasis font-medium'
												: 'border-slate-600 text-cyan-300 hover:bg-slate-800'}"
											>{managedIncident.assignedToUserId
												? 'Reasignar incidencia'
												: 'Asignar incidencia'}</button
										>
									{:else if activeUser.role === 'technician' && !managedIncident.assignedToUserId && canAssignTo(activeUser, managedIncident, activeUser.id, levelList)}
										<button
											type="button"
											onclick={() => openAssignment(managedIncident, true)}
											class="rounded border border-slate-600 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
											>Asignarme</button
										>
									{/if}
									{#if !managedIncident.classification && canEscalate(activeUser, managedIncident)}
										<button
											type="button"
											onclick={() => openClassification(managedIncident)}
											class="rounded border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
											>Cambiar clasificación</button
										>
									{/if}
									{#if canActOnIncident(activeUser, managedIncident, 'incidents:edit')}
										<button
											type="button"
											onclick={() => openChangeSite(managedIncident)}
											class="rounded border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
											>Cambiar sede</button
										>
									{/if}
								{/if}
							</div>
						</section>
						{#if managedIncident.classification}
							{@const subcatInfo = getSubcategoryInfo(
								managedIncident.subcategoryId,
								managedIncident.organizationId
							)}
							{@const calculatedPrio = toIncidentPriority(
								managedIncident.classification.calculatedPriority
							)}
							{@const authorizedByUser = managedIncident.classification.overrideAuthorizedBy
								? userList.find(
										(u) => u.id === managedIncident.classification?.overrideAuthorizedBy
									)
								: null}
							<section
								aria-labelledby="incident-v2-classification-title"
								class="incident-v2-classification space-y-3 rounded-xl border border-slate-700 p-4"
							>
								<div class="flex flex-wrap items-center justify-between gap-2">
									<h3
										id="incident-v2-classification-title"
										class="text-base font-semibold text-white"
									>
										Clasificación y Prioridad V2
									</h3>
									{#if managedIncident.classification.hasOverride}
										<span
											class="badge-override-active inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wider uppercase"
										>
											Override activo
										</span>
									{/if}
								</div>

								<dl class="grid gap-3 text-sm sm:grid-cols-2">
									<div>
										<dt class="text-xs text-slate-400">Categoría</dt>
										<dd class="mt-0.5 font-medium text-slate-200">
											{categoryName(managedIncident)}
										</dd>
									</div>
									<div>
										<dt class="text-xs text-slate-400">Subcategoría</dt>
										<dd class="mt-0.5 font-medium text-slate-200">
											{subcatInfo?.name || managedIncident.subcategoryId || 'Sin subcategoría'}
											{#if subcatInfo?.baseCriticality}
												<span class="text-xs text-slate-400">
													({criticalityLabels[subcatInfo.baseCriticality] ??
														subcatInfo.baseCriticality})
												</span>
											{/if}
										</dd>
									</div>
									<div>
										<dt class="text-xs text-slate-400">Impacto</dt>
										<dd class="mt-0.5 font-medium text-slate-200">
											{impactLabels[managedIncident.classification.impactLevel] ??
												managedIncident.classification.impactLevel}
										</dd>
									</div>
									<div>
										<dt class="text-xs text-slate-400">Prioridad calculada base</dt>
										<dd class="mt-0.5">
											<span
												class="inline-flex items-center rounded-lg border px-2 py-0.5 text-xs font-semibold {priorityBadgeClasses[
													calculatedPrio
												]}"
											>
												{priorityLabels[calculatedPrio]}
											</span>
											{#if managedIncident.classification.minPriorityApplied}
												<span class="text-priority-medium ml-1 text-[11px] font-medium"
													>(Mín. aplicada)</span
												>
											{/if}
										</dd>
									</div>
									<div class="sm:col-span-2">
										<dt class="text-xs text-slate-400">Prioridad operativa actual</dt>
										<dd class="mt-0.5 flex items-center gap-2">
											<span
												class="inline-flex items-center rounded-lg border px-2 py-0.5 text-xs font-semibold {priorityBadgeClasses[
													managedIncident.priority
												]}"
											>
												{priorityLabels[managedIncident.priority]}
											</span>
											{#if managedIncident.classification.hasOverride}
												<span class="text-priority-urgent text-xs font-medium">
													(Excepción manual autorizada)
												</span>
											{/if}
										</dd>
									</div>
								</dl>

								{#if managedIncident.classification.hasOverride}
									<div class="box-override-detail rounded-lg p-3 text-xs">
										<div class="flex items-center justify-between">
											<span class="font-semibold text-inherit">Detalle de la excepción:</span>
											{#if managedIncident.classification.overrideAuthorizedBy}
												<span class="text-slate-400">
													Autorizado por: <strong class="text-slate-200"
														>{authorizedByUser?.name ||
															managedIncident.classification.overrideAuthorizedBy}</strong
													>
												</span>
											{/if}
										</div>
										{#if managedIncident.classification.overrideReason}
											<p class="mt-1 text-slate-300 italic">
												"{managedIncident.classification.overrideReason}"
											</p>
										{/if}
									</div>
								{/if}

								{#if managedIncident.status === 'resolved'}
									{#if canActOnIncident(activeUser, managedIncident, 'incidents:classify') || canActOnIncident(activeUser, managedIncident, 'incidents:override_priority')}
										<p
											class="rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5 text-xs text-amber-300"
										>
											Para reclasificar o gestionar excepciones de prioridad, la incidencia debe ser
											reabierta previamente.
										</p>
									{/if}
								{:else if managedIncident.status === 'open' || managedIncident.status === 'pending'}
									<div class="flex flex-wrap gap-2 pt-1">
										{#if canActOnIncident(activeUser, managedIncident, 'incidents:classify')}
											<button
												type="button"
												onclick={() => openReclassify(managedIncident)}
												class="btn-reclassify-action rounded-lg px-3 py-1.5 text-xs font-semibold shadow-xs"
											>
												Reclasificar
											</button>
										{/if}
										{#if canActOnIncident(activeUser, managedIncident, 'incidents:override_priority')}
											<button
												type="button"
												onclick={() => openOverride(managedIncident)}
												class="btn-override-action rounded-lg px-3 py-1.5 text-xs font-medium transition"
											>
												{managedIncident.classification.hasOverride
													? 'Modificar excepción'
													: 'Excepción de prioridad'}
											</button>
										{/if}
									</div>
								{/if}
							</section>
						{/if}
						<IncidentSlaPanel incident={managedIncident} {now} />
					</div>
				{/if}
			</div>
			<div class="incident-activity">
				{#key `${managedIncident.id}:${activeUser.id}`}
					<IncidentMessages
						incident={managedIncident}
						actor={activeUser}
						{history}
						users={userList}
						categories={categoryList}
						teams={teamList}
						sites={siteList}
						incidents={incidentList}
						incidentsSnapshot={storedIncidentSnapshot}
						onincidentupdate={(updated) => {
							incidentList = incidentList.map((i) => (i.id === updated.id ? updated : i));
							storedIncidentSnapshot = JSON.stringify(incidentList);
						}}
						onmessagesent={(sentMsg) => handleMessageSent(managedIncident, sentMsg)}
					/>
				{/key}
			</div>
			{#if managedIncident && canDelete && canActOnIncident(activeUser, managedIncident, 'incidents:delete')}
				<details class="incident-danger mt-4 border-t border-slate-700 pt-2">
					<summary class="text-sm font-semibold text-red-300">Eliminar incidencia</summary>
					<p class="mt-2 text-sm text-slate-400">
						Eliminar la incidencia es permanente y no se puede deshacer.
					</p>
					<button
						type="button"
						disabled={!!incidentLoadError}
						onclick={() => deleteIncident(managedIncident.id)}
						class="mt-3 rounded-lg border border-red-400 px-4 py-2 text-sm font-medium text-red-300"
						>Eliminar incidencia</button
					>
				</details>
			{/if}
		</dialog>
	{/if}

	<!-- Modal de Rechazo de Solución -->
	{#if rejectModalOpen && rejectIncident}
		<dialog
			use:showEditDialog
			class="fixed inset-0 m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
			aria-labelledby="reject-modal-title"
			oncancel={(e) => {
				e.preventDefault();
				rejectModalOpen = false;
				rejectIncident = null;
			}}
		>
			<div class="flex items-center justify-between border-b border-slate-800 pb-3">
				<h2 id="reject-modal-title" class="text-lg font-semibold text-white">
					Rechazar solución propuesta
				</h2>
				<button
					type="button"
					onclick={() => {
						rejectModalOpen = false;
						rejectIncident = null;
					}}
					class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
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
			<p class="mt-2 text-xs text-slate-400">
				Indica qué problema persiste o por qué la solución propuesta no es suficiente. Este
				comentario se añadirá a la incidencia y notificará al responsable.
			</p>
			<form onsubmit={handleRejectResolution} class="mt-4 space-y-4">
				<div>
					<label for="reject-comment" class="mb-1 block text-xs font-medium text-slate-300">
						Motivo del rechazo <span class="text-red-400">*</span>
					</label>
					<textarea
						id="reject-comment"
						bind:value={rejectComment}
						required
						rows="3"
						placeholder="Explica qué sigue fallando o qué falta por resolver..."
						class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-red-400 focus:ring-1 focus:ring-red-400 focus:outline-hidden"
					></textarea>
				</div>
				<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-3">
					<button
						type="button"
						onclick={() => {
							rejectModalOpen = false;
							rejectIncident = null;
						}}
						class="cursor-pointer rounded-xl px-4 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200"
					>
						Cancelar
					</button>
					<button
						type="submit"
						disabled={!rejectComment.trim()}
						class="cursor-pointer rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Rechazar y reabrir
					</button>
				</div>
			</form>
		</dialog>
	{/if}

	<!-- Modal de Reapertura de Incidencia Cerrada -->
	{#if reopenModalOpen && reopenIncident}
		<dialog
			use:showEditDialog
			class="fixed inset-0 m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
			aria-labelledby="reopen-modal-title"
			oncancel={(e) => {
				e.preventDefault();
				reopenModalOpen = false;
				reopenIncident = null;
			}}
		>
			<div class="flex items-center justify-between border-b border-slate-800 pb-3">
				<h2 id="reopen-modal-title" class="text-lg font-semibold text-white">Reabrir incidencia</h2>
				<button
					type="button"
					onclick={() => {
						reopenModalOpen = false;
						reopenIncident = null;
					}}
					class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
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
			<p class="mt-2 text-xs text-slate-400">
				Explica el motivo por el que necesitas reabrir la incidencia. Se reanudará la atención
				técnica y se notificará al técnico.
			</p>
			<form onsubmit={handleReopenClosed} class="mt-4 space-y-4">
				<div>
					<label for="reopen-reason" class="mb-1 block text-xs font-medium text-slate-300">
						Motivo de reapertura <span class="text-amber-400">*</span>
					</label>
					<textarea
						id="reopen-reason"
						bind:value={reopenReason}
						required
						rows="3"
						placeholder="Describe la razón por la que solicitas reabrir..."
						class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-hidden"
					></textarea>
				</div>
				<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-3">
					<button
						type="button"
						onclick={() => {
							reopenModalOpen = false;
							reopenIncident = null;
						}}
						class="cursor-pointer rounded-xl px-4 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200"
					>
						Cancelar
					</button>
					<button
						type="submit"
						disabled={!reopenReason.trim()}
						class="cursor-pointer rounded-xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Reabrir incidencia
					</button>
				</div>
			</form>
		</dialog>
	{/if}

	<!-- Modal de Encuesta de Satisfacción -->
	{#if ratingIncident}
		<IncidentRatingModal
			open={ratingModalOpen}
			incident={ratingIncident}
			technicianName={userList.find((u) => u.id === ratingIncident?.assignedToUserId)?.name}
			onSave={handleSaveRating}
			onClose={() => {
				ratingModalOpen = false;
				ratingIncident = null;
			}}
		/>
	{/if}

	{#if reclassifyIncidentTarget && canActOnIncident(activeUser, reclassifyIncidentTarget, 'incidents:classify')}
		<ReclassifyDialog
			incident={reclassifyIncidentTarget}
			categories={categoryList}
			subcategories={subcategoriesState.status === 'valid' ? subcategoriesState.subcategories : []}
			priorityMatrices={priorityMatricesState.status === 'valid'
				? priorityMatricesState.matrices
				: []}
			error={reclassifyError}
			onconfirm={confirmReclassify}
			oncancel={() => {
				reclassifyIncidentTarget = null;
				reclassifyError = '';
			}}
		/>
	{/if}

	{#if overrideIncidentTarget && canActOnIncident(activeUser, overrideIncidentTarget, 'incidents:override_priority')}
		<OverridePriorityDialog
			incident={overrideIncidentTarget}
			error={overrideError}
			onapply={confirmApplyOverride}
			onremove={confirmRemoveOverride}
			oncancel={() => {
				overrideIncidentTarget = null;
				overrideError = '';
			}}
		/>
	{/if}
</div>
