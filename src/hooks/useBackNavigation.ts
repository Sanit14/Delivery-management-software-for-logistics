import { useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useCallback } from 'react';

/**
 * useBackNavigation — one reusable hook for the whole app's back behaviour.
 *
 * Two ideas, kept deliberately simple so it never becomes unpredictable:
 *
 * 1. HIERARCHY (default): every page has a fixed logical parent. The back button
 *    on a DR detail ALWAYS goes to the DR list, no matter how you arrived. This
 *    is predictable, which matters for fast keyboard users who build muscle memory.
 *    Parents are derived from the route in parentOf().
 *
 * 2. RETURN-TO-CALLER (detours): some pages are opened as a deliberate side-trip
 *    from another (e.g. "add new agent" launched from Wasuli). For those, the
 *    caller passes a `from` location in navigation state, and back returns there
 *    instead of to the hierarchy parent. So new-agent → back → Wasuli when opened
 *    from Wasuli, but → Master Data when opened from Master Data.
 *
 * Esc key triggers the same back action — but ONLY if nothing else (a modal/popup)
 * is open. A page with an open popup passes `blocked: true` so Esc closes the popup
 * first (handled by the page) instead of navigating away.
 */

// Fixed logical parent for each route pattern. Returns the parent path, or '/'
// (dashboard) for top-level pages.
function parentOf(pathname: string): string {
  // Detail/sub pages whose parent is a list:
  if (pathname.startsWith('/challan/')) return '/challan';
  if (pathname.startsWith('/firm-accounts/')) return '/firm-accounts';
  // Top-level pages go back to the dashboard.
  return '/';
}

interface BackOptions {
  /** When true, Esc is suppressed (a modal/popup is open and owns Esc). */
  blocked?: boolean;
  /** Explicit fallback parent, overriding parentOf() for unusual cases. */
  fallback?: string;
}

export function useBackNavigation(options: BackOptions = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { blocked = false, fallback } = options;

  // Where "back" should go: a caller-provided `from` wins (return-to-caller),
  // otherwise the hierarchy parent (or an explicit fallback).
  const goBack = useCallback(() => {
    const state = location.state as { from?: string } | null;
    if (state && state.from) {
      navigate(state.from);
    } else {
      navigate(fallback || parentOf(location.pathname));
    }
  }, [navigate, location, fallback]);

  // Esc triggers back, unless a popup is open (blocked) — then the page's own
  // Esc handler closes the popup and this stays out of the way.
  useEffect(() => {
    if (blocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't hijack Esc while the user is in a text field clearing it, unless
        // the field is empty (common pattern: Esc clears, second Esc goes back).
        const el = document.activeElement as HTMLElement | null;
        const inEditable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (inEditable && (el as HTMLInputElement).value) return;
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blocked, goBack]);

  return { goBack };
}
