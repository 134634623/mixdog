// A request from outside Settings → Connection (a remote window's PC switcher)
// to land on its "Connect to another PC" tab. The panel may not be mounted yet,
// so the request waits here until it is.
export type ConnectionTabId = 'this' | 'other';

const EVENT = 'mixdog:connection-tab-request';
let pending: ConnectionTabId | null = null;

export function requestConnectionTab(tab: ConnectionTabId): void {
  pending = tab;
  window.dispatchEvent(new Event(EVENT));
}

/** The waiting request, once. */
export function takeConnectionTabRequest(): ConnectionTabId | null {
  const tab = pending;
  pending = null;
  return tab;
}

export function subscribeConnectionTabRequests(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
