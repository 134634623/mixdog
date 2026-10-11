import { useCallback, useEffect, useState } from 'react';
import type { DesktopUpdaterState } from '../shared/contract';

type Invoke = (action: () => unknown) => Promise<void>;

export function useDesktopUpdater(invoke: Invoke) {
  const [state, setState] = useState<DesktopUpdaterState>({ status: 'disabled' });
  const [ready, setReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (state.status !== 'ready') setDialogOpen(false);
  }, [state.status]);

  useEffect(() => {
    const host = window.mixdogDesktop;
    let live = true;
    const getState = host?.getUpdaterState;
    const read = () => {
      void getState!()
        .then((next) => {
          if (live) setState(next);
        })
        .catch(() => {})
        .finally(() => {
          if (live) setReady(true);
        });
    };
    if (typeof getState !== 'function') {
      setReady(true);
    } else {
      read();
    }
    const unsubscribe = host?.subscribeUpdaterState?.((next) => {
      if (live) setState(next);
    });
    // Remote clients: a read made while the connection was down fails and
    // would leave the update state stale until a reload. Same value as
    // REMOTE_CONNECTION_READY_EVENT (remote-shim-state).
    const reconnected = typeof getState === 'function' ? read : null;
    if (reconnected) window.addEventListener('mixdog:remote-connection-ready', reconnected);
    return () => {
      live = false;
      unsubscribe?.();
      if (reconnected) window.removeEventListener('mixdog:remote-connection-ready', reconnected);
    };
  }, []);

  const openDialog = useCallback(() => {
    if (state.status === 'ready') setDialogOpen(true);
  }, [state.status]);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const install = useCallback(() => {
    setDialogOpen(false);
    void invoke(async () => {
      const next = await window.mixdogDesktop.showDesktopUpdate();
      setState(next);
    });
  }, [invoke]);

  return {
    state,
    ready,
    dialogOpen,
    openDialog,
    closeDialog,
    install,
  };
}
