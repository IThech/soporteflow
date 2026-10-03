/**
 * Keeps keyboard focus inside a modal dialog (WCAG 2.4.3). `aria-modal="true"` tells assistive
 * technology the rest of the page is inert, but browsers do not enforce it: without this, Tab
 * walks out of the dialog into the page behind the backdrop.
 *
 * Usage: <div role="dialog" aria-modal="true" tabindex="-1" use:focusTrap>
 * Tab on the last focusable element wraps to the first one and Shift+Tab on the first wraps to
 * the last; disabled and hidden controls are skipped. Initial focus and focus restoration stay
 * with each dialog (they already handle them).
 */
const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])'
].join(', ');

function focusableIn(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(element) => element.getClientRects().length > 0
	);
}

export function focusTrap(node: HTMLElement) {
	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const items = focusableIn(node);
		if (items.length === 0) {
			event.preventDefault();
			node.focus();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || active === node)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		}
	}
	node.addEventListener('keydown', onKeydown);
	return {
		destroy() {
			node.removeEventListener('keydown', onKeydown);
		}
	};
}
