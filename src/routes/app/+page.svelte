<script lang="ts">
	import ThemeSelector from '$lib/components/ThemeSelector.svelte';
	import './theme.css';
	import EscalationDialog from '$lib/components/EscalationDialog.svelte';
	import { canEscalate, prepareEscalation, type EscalationInput } from '$lib/incidents/escalation';
	import ReassignmentReasons from '$lib/components/ReassignmentReasons.svelte';
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
		normalizeSearchText,
		validQueue,
		type IncidentQueue
	} from '$lib/incidents/queue';
	import { isIncidentList } from '$lib/incidents/validation';
	import {
		assignmentCandidates,
		canManageAssignment,
		canAssignTo,
		prepareCatalogAssignment,
		incidentOrganizationId
	} from '$lib/incidents/assignment';
	import {
		loadHistory,
		recoverAssignment,
		commitAssignment,
		INCIDENTS_KEY,
		HISTORY_KEY,
		RECOVERY_KEY
	} from '$lib/storage/assignment';
	import { demoOrganization } from '$lib/data/organizations';
	import { demoUsers } from '$lib/data/users';
	import type { IncidentHistoryEntry } from '$lib/types/incident-history';
	import type { IncidentMessage } from '$lib/types/incident-message';
	import IncidentMessages from '$lib/components/IncidentMessages.svelte';
	import { loadMessages, MESSAGES_KEY } from '$lib/storage/messages';
	import { recoverFirstResponse, FIRST_RESPONSE_RECOVERY_KEY } from '$lib/storage/first-response';
	import { applyCreationSla, recordStatusTransition } from '$lib/incidents/lifecycle';
	import { demoSupportTeams } from '$lib/data/teams';
	import SlaBadge from '$lib/components/SlaBadge.svelte';
	import IncidentSlaPanel from '$lib/components/IncidentSlaPanel.svelte';
	import SlaPolicyManagement from '$lib/components/SlaPolicyManagement.svelte';
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
		markAllNotificationsAsRead
	} from '$lib/incidents/notifications';
	import { incidents as initialIncidents } from '$lib/data/incidents';
	import type { Incident, IncidentPriority, IncidentStatus } from '$lib/types/incident';
	import { onMount } from 'svelte';
	import { initialCategories } from '$lib/data/categories';
	import type { IncidentCategory } from '$lib/types/category';
	import { SvelteSet } from 'svelte/reactivity';

	import DemoSessionSelector from '$lib/components/DemoSessionSelector.svelte';
	import { defaultDemoUser, demoSessionUsers } from '$lib/auth/demo-session';
	import { hasPermission, canAccessOrganization } from '$lib/auth/permissions';
	import { canViewIncident, canActOnIncident, canAccessRecord } from '$lib/auth/record-access';
	import type { AppUser } from '$lib/types/user';

	let incidentList = $state<Incident[]>([...initialIncidents]);
	let categoryList = $state<IncidentCategory[]>(
		initialCategories.map((category) => ({ ...category }))
	);
	let activeUser = $state<AppUser>(defaultDemoUser);
	const visibleIncidents = $derived(
		incidentList.filter((incident) => canViewIncident(activeUser, incident))
	);
	const visibleCategories = $derived(
		categoryList.filter((category) => canAccessRecord(activeUser, category))
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
	const canManageCategories = $derived(hasPermission(activeUser, 'categories:manage'));

	function changeDemoUser(user: AppUser) {
		if (!demoSessionUsers.includes(user)) return;
		editingIncident = null;
		assignmentIncident = null;
		escalationIncident = null;
		escalationError = '';
		assignmentError = '';
		categoryDraft = null;
		categorySaveError = '';
		isFormOpen = false;
		title = '';
		client = '';
		description = '';
		priority = 'medium';
		searchQuery = '';
		selectedStatus = 'all';
		selectedQueue = validQueue(user, 'all');
		activeUser = user;
	}

	const summary = $derived([
		{
			label: 'Incidencias abiertas',
			value: visibleIncidents.filter((incident) => incident.status === 'open').length,
			color: 'text-cyan-400'
		},
		{
			label: 'Pendientes',
			value: visibleIncidents.filter((incident) => incident.status === 'pending').length,
			color: 'text-amber-400'
		},
		{
			label: 'Resueltas',
			value: visibleIncidents.filter((incident) => incident.status === 'resolved').length,
			color: 'text-emerald-400'
		}
	]);

	let title = $state('');
	let client = $state('');
	let description = $state('');
	let priority = $state<IncidentPriority>('medium');

	const STORAGE_KEY = INCIDENTS_KEY;

	let selectedStatus = $state<'all' | IncidentStatus>('all');

	const statusFilters = [
		{ value: 'all', label: 'Todas' },
		{ value: 'open', label: 'Abiertas' },
		{ value: 'pending', label: 'Pendientes' },
		{ value: 'resolved', label: 'Resueltas' }
	] satisfies { value: 'all' | IncidentStatus; label: string }[];

	let searchQuery = $state('');
	const filteredIncidents = $derived(
		filterIncidentQueue(activeUser, incidentList, selectedQueue, selectedStatus, searchQuery)
	);

	let incidentLoadError = $state('');
	let history = $state<IncidentHistoryEntry[]>([]);
	let assignmentReady = $state(false);
	let escalationIncident = $state<Incident | null>(null);
	let escalationError = $state('');
	function openEscalation(incident: Incident) {
		if (!assignmentReady || incidentLoadError || !canEscalate(activeUser, incident)) return;
		escalationError = '';
		escalationIncident = incident;
	}
	function confirmEscalation(input: EscalationInput) {
		if (!assignmentReady || incidentLoadError || !escalationIncident) return;
		try {
			const id = escalationIncident.id;
			const original = incidentList.find((item) => item.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			const change = prepareEscalation(activeUser, original, demoUsers, demoSupportTeams, input);
			if (!change) {
				escalationIncident = null;
				return;
			}
			// Responsible-only changes belong in the existing assignment dialog/catalog.
			if (change.event.eventType !== 'escalated')
				throw new Error('Utiliza Asignar/Reasignar para cambiar únicamente el responsable.');
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
			escalationIncident = null;
			const notif = buildIncidentNotification({
				type: 'incident_escalated',
				incident: change.incident,
				actor: activeUser,
				newAssigneeId: input.assignedToUserId,
				reason: input.reason
			});
			recordNotification(notif);
		} catch (error) {
			escalationError = error instanceof Error ? error.message : 'No se pudo guardar el escalado.';
		}
	}

	let assignmentError = $state('');
	let assignmentIncident = $state<Incident | null>(null);
	let assignmentTarget = $state('');
	let storedIncidentSnapshot = $state<string | null>(null);
	let storedHistorySnapshot: string | null = null;
	function assigneeName(incident: Incident): string {
		if (!incident.assignedToUserId) return 'Sin asignar';
		const user = demoUsers.find(
			(item) =>
				item.id === incident.assignedToUserId &&
				item.organizationId === incidentOrganizationId(incident)
		);
		return user ? user.name + (user.active ? '' : ' (inactivo)') : 'Técnico no disponible';
	}
	function teamName(incident: Incident): string {
		if (!incident.teamId) return 'Sin equipo';
		return (
			demoSupportTeams.find(
				(team) =>
					team.id === incident.teamId && team.organizationId === incidentOrganizationId(incident)
			)?.name ?? 'Equipo no disponible'
		);
	}

	function openAssignment(incident: Incident, self = false) {
		if (
			!assignmentReady ||
			!reasonsReady ||
			incidentLoadError ||
			!(self
				? canAssignTo(activeUser, incident, activeUser.id)
				: canManageAssignment(activeUser, incident))
		)
			return;
		assignmentError = '';
		assignmentTarget = self ? activeUser.id : (incident.assignedToUserId ?? '');
		assignmentIncident = incident;
	}
	function confirmAssignment(targetId: string, selection: string, manual: string, comment: string) {
		if (!assignmentReady || !reasonsReady || incidentLoadError || !assignmentIncident) return;
		try {
			const id = assignmentIncident.id;
			const original = incidentList.find((item) => item.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			if (localStorage.getItem(REASONS_KEY) !== reasonSnapshot)
				throw new Error('El catálogo ha cambiado. Recarga antes de asignar.');
			const change = prepareCatalogAssignment(
				activeUser,
				original,
				demoUsers,
				targetId,
				reasonList,
				selection,
				manual,
				comment
			);
			if (!change) {
				assignmentIncident = null;
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
			assignmentIncident = null;
			const notifType: NotificationType = original.assignedToUserId
				? 'incident_reassigned'
				: 'incident_assigned';
			const reasonText =
				selection === '__other__'
					? manual
					: (reasonList.find((r) => r.id === selection)?.name ?? manual);
			const notif = buildIncidentNotification({
				type: notifType,
				incident: change.incident,
				actor: activeUser,
				newAssigneeId: targetId,
				reason: reasonText
			});
			recordNotification(notif);
		} catch (error) {
			assignmentError =
				error instanceof Error ? error.message : 'No se pudo guardar la asignación.';
		}
	}

	let now = $state(new Date());

	let slaCatalogState = $state<SlaPolicyCatalogState>({ status: 'valid', policies: [] });
	let slaPoliciesReady = $state(false);
	let slaPolicyError = $state('');
	let slaPolicySnapshot: string | null = null;

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

	function handleMessageSent(incident: Incident | undefined, message: IncidentMessage) {
		if (!incident) return;
		const notifType: NotificationType =
			message.visibility === 'internal' ? 'incident_internal_note' : 'incident_comment';
		const notif = buildIncidentNotification({
			type: notifType,
			incident,
			actor: activeUser,
			message
		});
		recordNotification(notif);
	}

	onMount(() => {
		try {
			recoverAssignment(localStorage);
			recoverFirstResponse(localStorage);
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
			assignmentReady = true;
		} catch {
			incidentLoadError =
				'No se pudieron cargar las incidencias o su historial. Se ha bloqueado la edición para conservar los datos guardados.';
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

		const intervalId = setInterval(() => {
			now = new Date();
		}, 60_000);

		function handleVisibility() {
			if (document.visibilityState === 'visible') {
				now = new Date();
			}
		}

		document.addEventListener('visibilitychange', handleVisibility);

		return () => {
			clearInterval(intervalId);
			document.removeEventListener('visibilitychange', handleVisibility);
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

	function saveIncidents() {
		if (incidentLoadError) return;
		try {
			if (
				localStorage.getItem(STORAGE_KEY) !== storedIncidentSnapshot ||
				localStorage.getItem(HISTORY_KEY) !== storedHistorySnapshot ||
				localStorage.getItem(RECOVERY_KEY) !== null ||
				localStorage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null
			)
				throw new Error('Los datos han cambiado en otra pestaña. Recarga antes de continuar.');
			localStorage.setItem(STORAGE_KEY, JSON.stringify(incidentList));
			storedIncidentSnapshot = JSON.stringify(incidentList);
		} catch {
			incidentLoadError =
				'No se pudieron guardar los cambios o los datos han cambiado en otra pestaña. Recarga antes de continuar.';
			window.alert(incidentLoadError);
		}
	}

	let isFormOpen = $state(false);

	const priorityLabels = {
		low: 'Baja',
		medium: 'Media',
		high: 'Alta'
	};

	const priorityClasses = {
		low: 'text-slate-400',
		medium: 'text-amber-400',
		high: 'text-rose-400'
	};

	function updateIncidentStatus(id: number, event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const status = select.value as IncidentStatus;
		const incident = incidentList.find((item) => item.id === id);

		if (!incident || incidentLoadError || !canActOnIncident(activeUser, incident, 'incidents:edit'))
			return;

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

			if (editingIncident) {
				editingIncident.status = status;
			}

			return;
		}

		const oldStatus = incident.status;
		let updatedItem: Incident | undefined;

		incidentList = incidentList.map((item) => {
			if (item.id === id) {
				updatedItem = recordStatusTransition(item, status);
				return updatedItem;
			}
			return item;
		});

		saveIncidents();

		if (oldStatus !== status && updatedItem) {
			let notifType: NotificationType = 'incident_status_changed';
			if (status === 'resolved') {
				notifType = 'incident_resolved';
			} else if (oldStatus === 'resolved') {
				notifType = 'incident_reopened';
			}
			const notif = buildIncidentNotification({
				type: notifType,
				incident: updatedItem,
				actor: activeUser,
				previousStatus: oldStatus,
				nextStatus: status
			});
			recordNotification(notif);
		}
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

		incidentList = incidentList.filter((item) => item.id !== id);
		saveIncidents();
		if (!incidentLoadError) editingIncident = null;
	}

	function createIncident(event: SubmitEvent) {
		event.preventDefault();

		if (
			incidentLoadError ||
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
			priority,
			createdAt: new Date().toISOString()
		};

		incidentList.unshift(applyCreationSla(draft, slaCheck.policies));

		saveIncidents();

		title = '';
		client = '';
		description = '';
		priority = 'medium';
		isFormOpen = false;
	}

	type EditableIncident = Incident;

	let editingIncident = $state<EditableIncident | null>(null);
	let solutionExpanded = $state(false);
	const managedIncident = $derived(incidentList.find((item) => item.id === editingIncident?.id));

	function openEditIncident(id: number) {
		solutionExpanded = false;
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
		if (!original || !canActOnIncident(activeUser, original, 'incidents:edit')) return;

		let updatedIncident: Incident = {
			...original,
			priority: editingIncident.priority,
			status: editingIncident.status,
			title: editingIncident.title.trim(),
			client: editingIncident.client.trim(),
			description: (editingIncident.description ?? '').trim(),
			solution: (editingIncident.solution ?? '').trim()
		};

		if (!updatedIncident.title || !updatedIncident.client) {
			window.alert('Completa el título y el cliente.');
			return;
		}

		if (!updatedIncident.description) {
			window.alert('Describe el problema antes de guardar la incidencia.');
			return;
		}

		if (updatedIncident.status === 'resolved' && !updatedIncident.solution) {
			window.alert('Para resolver esta incidencia, indica qué hiciste y cuál fue el resultado.');
			return;
		}

		const statusChanged = original.status !== editingIncident.status;
		const previousStatus = original.status;

		if (statusChanged) {
			const transitioned = recordStatusTransition(original, editingIncident.status);
			updatedIncident = {
				...transitioned,
				priority: editingIncident.priority,
				title: editingIncident.title.trim(),
				client: editingIncident.client.trim(),
				description: (editingIncident.description ?? '').trim(),
				solution: (editingIncident.solution ?? '').trim()
			};
		}

		incidentList = incidentList.map((incident) =>
			incident.id === updatedIncident.id ? updatedIncident : incident
		);

		saveIncidents();

		if (statusChanged) {
			let notifType: NotificationType = 'incident_status_changed';
			if (editingIncident.status === 'resolved') {
				notifType = 'incident_resolved';
			} else if (previousStatus === 'resolved') {
				notifType = 'incident_reopened';
			}
			const notif = buildIncidentNotification({
				type: notifType,
				incident: updatedIncident,
				actor: activeUser,
				previousStatus,
				nextStatus: editingIncident.status
			});
			recordNotification(notif);
		}

		editingIncident = null;
	}

	const CATEGORY_STORAGE_KEY = 'soporteflow-categories';

	let categoryLoaded = $state(false);
	let categoryLoadError = $state('');
	let categorySaveError = $state('');
	let categoryDraft = $state<{ id?: string; name: string; description: string } | null>(null);

	function mayManageCategory(category?: IncidentCategory): boolean {
		return (
			categoryLoaded &&
			!categoryLoadError &&
			hasPermission(activeUser, 'categories:manage') &&
			(category
				? canAccessRecord(activeUser, category)
				: !!activeUser.organizationId &&
					canAccessOrganization(activeUser, activeUser.organizationId))
		);
	}

	function openCategoryForm(id?: string) {
		const category = id === undefined ? undefined : categoryList.find((item) => item.id === id);
		if ((id !== undefined && !category) || !mayManageCategory(category)) return;
		categorySaveError = '';
		categoryDraft = category
			? { id: category.id, name: category.name, description: category.description }
			: { name: '', description: '' };
	}

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

	function saveCategory(event: SubmitEvent) {
		event.preventDefault();
		if (!categoryDraft) return;
		const draft = categoryDraft;
		const original =
			draft.id === undefined ? undefined : categoryList.find((item) => item.id === draft.id);
		if ((draft.id !== undefined && !original) || !mayManageCategory(original)) return;
		const name = draft.name.trim();
		const description = draft.description.trim();
		if (!name) {
			categorySaveError = 'Escribe un nombre para la categoría.';
			return;
		}
		// Compare only within the target organization, including legacy Nodhouses data.
		if (
			categoryList.some(
				(item) =>
					item.id !== original?.id &&
					canAccessRecord(activeUser, item) &&
					normalizeSearchText(item.name) === normalizeSearchText(name)
			)
		) {
			categorySaveError = 'Ya existe una categoría con ese nombre, activa o inactiva.';
			return;
		}
		const category: IncidentCategory = original
			? { ...original, name, description }
			: {
					id: crypto.randomUUID(),
					organizationId: activeUser.organizationId,
					name,
					description,
					active: true
				};
		const next = original
			? categoryList.map((item) => (item.id === original.id ? category : item))
			: [...categoryList, category];
		if (persistCategories(next)) categoryDraft = null;
	}

	function toggleCategory(id: string) {
		const category = categoryList.find((item) => item.id === id);
		if (!category || !mayManageCategory(category)) return;
		persistCategories(
			categoryList.map((item) => (item.id === id ? { ...item, active: !item.active } : item))
		);
	}

	function isCategoryList(value: unknown): value is IncidentCategory[] {
		if (!Array.isArray(value)) return false;

		const ids = new SvelteSet<string>();

		return value.every((item: unknown) => {
			if (typeof item !== 'object' || item === null) return false;

			const category = item as Record<string, unknown>;

			if (
				typeof category.id !== 'string' ||
				!category.id.trim() ||
				typeof category.name !== 'string' ||
				!category.name.trim() ||
				typeof category.description !== 'string' ||
				typeof category.active !== 'boolean' ||
				(category.organizationId !== undefined && typeof category.organizationId !== 'string')
			) {
				return false;
			}

			if (ids.has(category.id)) return false;

			ids.add(category.id);
			return true;
		});
	}

	onMount(() => {
		try {
			const storedCategories = localStorage.getItem(CATEGORY_STORAGE_KEY);

			if (storedCategories !== null) {
				const parsedCategories: unknown = JSON.parse(storedCategories);

				if (!isCategoryList(parsedCategories)) {
					throw new Error('El catálogo guardado no tiene un formato válido.');
				}

				categoryList = parsedCategories;
			}
		} catch {
			categoryLoadError =
				'No se pudo cargar el catálogo. No se han modificado los datos guardados.';
		} finally {
			categoryLoaded = true;
		}
	});
</script>

<svelte:head>
	<title>Panel | SoporteFlow</title>
	<meta name="description" content="Gestor de incidencias de soporte técnico" />
</svelte:head>

<div class="support-app min-h-screen bg-slate-950 text-white">
	<DemoSessionSelector user={activeUser} onchange={changeDemoUser} />
	<header class="app-header border-b border-slate-800 bg-slate-900">
		<div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
			<div>
				<p class="text-xl font-bold">Soporte<span class="text-cyan-400">Flow</span></p>
				<p class="text-xs text-slate-400">Gestión de soporte técnico</p>
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
				/>
				<ThemeSelector />
				{#if canCreate && !incidentLoadError}
					<button
						type="button"
						onclick={() => (isFormOpen = true)}
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
					>
						Nueva incidencia
					</button>
				{/if}
			</div>
		</div>
	</header>

	<main class="app-main mx-auto max-w-7xl px-6 py-10">
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

		<section class="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
			{#each summary as item (item.label)}
				<article class="rounded-xl border border-slate-800 bg-slate-900 p-6">
					<p class="text-sm text-slate-400">{item.label}</p>
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
							<th scope="col" class="px-6 py-4 font-medium">Incidencia</th>
							<th scope="col" class="px-6 py-4 font-medium">Cliente</th>
							<th scope="col" class="px-6 py-4 font-medium">Prioridad</th>
							<th scope="col" class="px-6 py-4 font-medium">SLA</th>
							<th scope="col" class="px-6 py-4 font-medium">Estado</th>
							<th scope="col" class="px-6 py-4 font-medium">Fecha</th>
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

									<p class="mt-2 text-sm text-slate-400">Categoría: {categoryName(incident)}</p>
									<p class="mt-2 text-sm text-slate-300">
										{incident.assignedToUserId ? 'Asignado a: ' : ''}{assigneeName(incident)}
									</p>
									{#if assignmentReady && reasonsReady && !incidentLoadError && activeUser.role === 'technician' && !incident.assignedToUserId && canAssignTo(activeUser, incident, activeUser.id)}
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

								<td
									role="cell"
									class={`px-6 py-4 text-sm font-medium ${priorityClasses[incident.priority]}`}
								>
									<span class="mobile-field-label" aria-hidden="true">Prioridad</span
									>{priorityLabels[incident.priority]}
								</td>

								<td class="incident-sla px-6 py-4 text-sm">
									<span class="mobile-field-label" aria-hidden="true">SLA</span>
									<SlaBadge {incident} {now} />
								</td>

								<td class="incident-state px-6 py-4"
									><span class="mobile-field-label" aria-hidden="true">Estado</span>
									{#if canEdit}
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

								<td class="incident-date px-6 py-4 text-sm text-slate-500"
									><span class="mobile-field-label" aria-hidden="true">Fecha</span>
									{new Date(incident.createdAt).toLocaleDateString('es-ES')}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="px-6 py-10 text-center text-sm text-slate-400">
									No hay incidencias que coincidan con los filtros actuales.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		{#if canManageCategories}
			<section
				aria-labelledby="categories-title"
				class="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-6"
			>
				<h2 id="categories-title" class="text-lg font-semibold">Categorías de incidencias</h2>

				<p class="mt-1 text-sm text-slate-400">
					Catálogo de categorías para clasificar los casos de soporte.
				</p>

				{#if categoryLoaded && !categoryLoadError}
					<button
						type="button"
						onclick={() => openCategoryForm()}
						class="mt-4 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
						>Nueva categoría</button
					>
				{/if}
				{#if categorySaveError}<p role="alert" class="mt-4 text-sm text-red-400">
						{categorySaveError}
					</p>{/if}
				{#if categoryDraft && categoryLoaded && !categoryLoadError}
					<form
						onsubmit={saveCategory}
						class="mt-4 space-y-4 rounded-lg border border-slate-700 bg-slate-950 p-4"
						aria-labelledby="category-form-title"
					>
						<h3 id="category-form-title" class="font-semibold">
							{categoryDraft.id ? 'Editar categoría' : 'Nueva categoría'}
						</h3>
						<div>
							<label for="category-name" class="mb-2 block text-sm text-slate-300"
								>Nombre (obligatorio)</label
							>
							<input
								id="category-name"
								bind:value={categoryDraft.name}
								required
								class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
							/>
						</div>
						<div>
							<label for="category-description" class="mb-2 block text-sm text-slate-300"
								>Descripción (opcional)</label
							>
							<textarea
								id="category-description"
								bind:value={categoryDraft.description}
								rows="3"
								class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
							></textarea>
						</div>
						<div class="flex gap-3">
							<button
								type="submit"
								class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
								>Guardar categoría</button
							>
							<button
								type="button"
								onclick={() => {
									categoryDraft = null;
									categorySaveError = '';
								}}
								class="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
								>Cancelar</button
							>
						</div>
					</form>
				{/if}
				{#if categoryLoadError}
					<p role="alert" class="mt-4 text-sm text-red-400">
						{categoryLoadError}
					</p>
				{:else}
					<ul class="mt-5 grid gap-3 sm:grid-cols-2">
						{#each visibleCategories as category (category.id)}
							<li class="rounded-lg border border-slate-700 bg-slate-950 p-4">
								<div class="flex items-center justify-between gap-3">
									<h3 class="font-medium text-slate-200">{category.name}</h3>

									<span
										class={`text-xs ${category.active ? 'text-emerald-400' : 'text-slate-500'}`}
									>
										{category.active ? 'Activa' : 'Inactiva'}
									</span>
								</div>

								<p class="mt-2 text-sm text-slate-400">
									{category.description}
								</p>
								{#if categoryLoaded}
									<div class="mt-4 flex flex-wrap gap-3">
										<button
											type="button"
											onclick={() => openCategoryForm(category.id)}
											aria-label={`Editar categoría ${category.name}`}
											class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-cyan-400 hover:bg-slate-800"
											>Editar</button
										>
										<button
											type="button"
											onclick={() => toggleCategory(category.id)}
											aria-label={`${category.active ? 'Desactivar' : 'Reactivar'} categoría ${category.name}`}
											class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
											>{category.active ? 'Desactivar' : 'Reactivar'}</button
										>
									</div>
								{/if}
							</li>
						{:else}
							<li class="text-sm text-slate-400">Todavía no hay categorías configuradas.</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
		{#key activeUser.id}<ReassignmentReasons
				actor={activeUser}
				reasons={reasonList}
				ready={reasonsReady}
				error={reasonError}
				onchange={updateReason}
			/>{/key}
		{#key activeUser.id}<SlaPolicyManagement
				actor={activeUser}
				policies={slaCatalogState.status === 'valid' ? slaCatalogState.policies : []}
				categories={categoryList}
				ready={slaPoliciesReady}
				error={slaPolicyError}
				onchange={updateSlaPolicy}
			/>{/key}
	</main>
	{#if escalationIncident && assignmentReady && !incidentLoadError && canEscalate(activeUser, escalationIncident)}
		<EscalationDialog
			incident={escalationIncident}
			teams={demoSupportTeams}
			users={demoUsers}
			currentAssignee={assigneeName(escalationIncident)}
			error={escalationError}
			onconfirm={confirmEscalation}
			oncancel={() => {
				escalationIncident = null;
				escalationError = '';
			}}
		/>
	{/if}

	{#if assignmentIncident && assignmentReady && !incidentLoadError && canActOnIncident(activeUser, assignmentIncident, 'incidents:assign')}
		<AssignmentDialog
			reasons={reasonList}
			actor={activeUser}
			incident={assignmentIncident}
			candidates={assignmentCandidates(assignmentIncident, demoUsers).filter(
				(user) =>
					assignmentIncident !== null && canAssignTo(activeUser, assignmentIncident, user.id)
			)}
			currentName={assigneeName(assignmentIncident)}
			initialTarget={assignmentTarget}
			error={assignmentError}
			onconfirm={confirmAssignment}
			oncancel={() => {
				assignmentIncident = null;
				assignmentError = '';
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
					<label for="priority" class="mb-2 block text-sm font-medium text-slate-300">
						Prioridad
					</label>
					<select
						id="priority"
						bind:value={priority}
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="low">Baja</option>
						<option value="medium">Media</option>
						<option value="high">Alta</option>
					</select>
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
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
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
			onclose={() => (editingIncident = null)}
			aria-labelledby="edit-incident-title"
			class="incident-workspace fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-sm font-medium text-cyan-400">
						Incidencia #{editingIncident.id}
					</p>
					<h2 id="edit-incident-title" class="mt-1 text-2xl font-bold">
						{managedIncident?.title || 'Sin título'}
					</h2>
				</div>

				<button
					type="button"
					onclick={() => (editingIncident = null)}
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
						<div class="grid grid-cols-2 gap-3">
							<div>
								<label for="edit-priority" class="mb-2 block text-sm font-medium text-slate-300">
									Prioridad
								</label>
								<select
									id="edit-priority"
									bind:value={editingIncident.priority}
									class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
								>
									<option value="low">Baja</option>
									<option value="medium">Media</option>
									<option value="high">Alta</option>
								</select>
							</div>

							<div>
								<label for="edit-status" class="mb-2 block text-sm font-medium text-slate-300">
									Estado
								</label>
								<select
									id="edit-status"
									bind:value={editingIncident.status}
									class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
								>
									<option value="open">Abierta</option>
									<option value="pending">Pendiente</option>
									<option value="resolved">Resuelta</option>
								</select>
							</div>
						</div>

						{#if solutionExpanded || editingIncident.status === 'resolved' || editingIncident.solution?.trim()}
							<div>
								<label for="edit-solution" class="mb-2 block text-sm font-medium text-slate-300">
									Solución aplicada
									{editingIncident.status === 'resolved' ? '(obligatoria)' : '(opcional)'}
								</label>
								<textarea
									id="edit-solution"
									bind:value={editingIncident.solution}
									required={editingIncident.status === 'resolved'}
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
									<dt class="text-slate-400">Nivel</dt>
									<dd class="mt-1">{managedIncident.supportLevel ?? 'Sin nivel'}</dd>
								</div>
								<div>
									<dt class="text-slate-400">Equipo</dt>
									<dd class="mt-1">{teamName(managedIncident)}</dd>
								</div>
							</dl>
							<div class="mt-4 flex flex-wrap gap-3">
								{#if assignmentReady && reasonsReady && !incidentLoadError}
									{#if canManageAssignment(activeUser, managedIncident)}
										<button
											type="button"
											onclick={() => openAssignment(managedIncident)}
											class="rounded border border-slate-600 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
											>{managedIncident.assignedToUserId ? 'Reasignar' : 'Asignar técnico'}</button
										>
									{:else if activeUser.role === 'technician' && !managedIncident.assignedToUserId && canAssignTo(activeUser, managedIncident, activeUser.id)}
										<button
											type="button"
											onclick={() => openAssignment(managedIncident, true)}
											class="rounded border border-slate-600 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
											>Asignarme</button
										>
									{/if}
								{/if}
								{#if assignmentReady && !incidentLoadError && canEscalate(activeUser, managedIncident)}
									<button
										type="button"
										onclick={() => openEscalation(managedIncident)}
										class="rounded border border-slate-600 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
										>Escalar incidencia</button
									>
								{/if}
							</div>
						</section>
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
						users={demoUsers}
						categories={categoryList}
						teams={demoSupportTeams}
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
</div>
