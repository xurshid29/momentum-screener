import { useEffect, useState } from 'react';

// Shared "are dashboard alerts armed" state (2026-07-31).
//
// The AlertsToggle button used to keep this entirely to itself — it wrote
// localStorage and its own component state, and NOTHING read either.
// useScreenerAlerts ran unconditionally, so "Alerts OFF" changed the button's
// label and colour while every confirmation kept beeping. This module is the
// missing shared reference: the toggle writes through it, the alert hook
// reads it.
//
// Device-local on purpose (localStorage, not user_panel_layout): arming also
// unlocks this browser's AudioContext, which is per-tab state a server-side
// preference cannot express. The custom event keeps components in the same
// tab in sync; the `storage` event covers other tabs.
const STORAGE_KEY = 'alerts.armed';
const CHANGE_EVENT = 'alerts-armed-changed';

export function isAlertsArmed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAlertsArmed(armed: boolean): void {
  try {
    if (armed) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode / storage disabled — the in-tab event still propagates
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAlertsArmed(): boolean {
  const [armed, setArmed] = useState<boolean>(isAlertsArmed);
  useEffect(() => {
    const sync = () => setArmed(isAlertsArmed());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync); // other tabs
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return armed;
}
