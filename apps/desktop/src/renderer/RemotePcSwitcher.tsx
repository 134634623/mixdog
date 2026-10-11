import { ChevronDown, Check, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { nativeAppInfo } from '../shared/native-app';
import { remoteWindowInfo, remoteWindowSwitcher } from '../shared/remote-window';
import { t, uiFormatLocale } from './i18n';
import { isRemoteBrowserRenderer } from './remote-ui-projection';
import { loadWebSwitcherPcs, type SwitcherPc } from './remote-saved-pcs';

/** Top-bar PC switcher for a remote UI (phone, other-PC window, browser): the
 *  PC being driven, a "Remote" badge, and — with more than one saved PC — a
 *  menu to switch. Settings shown here belong to the connected PC. */
export function RemotePcSwitcher() {
  const windowInfo = remoteWindowInfo();
  const bridge = remoteWindowSwitcher();
  const remote = Boolean(windowInfo) || isRemoteBrowserRenderer();
  const [pcs, setPcs] = useState<SwitcherPc[]>([]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the list reloads when the menu opens, not on bridge identity.
  useEffect(() => {
    if (!remote) return undefined;
    let live = true;
    const load = () => {
      const pending = bridge ? bridge.listHosts() : loadWebSwitcherPcs();
      void Promise.resolve(pending)
        .then((next) => live && setPcs(next))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [remote, open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (!remote) return null;
  const current = pcs.find((pc) => pc.current);
  const name = windowInfo?.hostName || current?.name || t('This PC');
  const others = pcs.filter((pc) => !pc.current);

  const connectAnother = (): void => {
    setOpen(false);
    if (bridge) void bridge.manageConnections();
    else if (nativeAppInfo()?.call) void nativeAppInfo()?.call?.('openHostPicker').catch(() => undefined);
    else location.assign('/connect');
  };
  const switchTo = (pc: SwitcherPc): void => {
    setOpen(false);
    if (bridge) void bridge.openHost(pc.id);
    else location.assign(`/d/${pc.id}/`);
  };

  return (
    <div className="remote-pc-switcher" ref={root}>
      {others.length === 0 ? (
        <span className="remote-pc-name" role="status">
          <i className={`remote-pc-dot${current?.online === false ? ' off' : ''}`} aria-hidden="true" />
          {name}
        </span>
      ) : (
        <button
          type="button"
          className="remote-pc-name remote-pc-button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <i className={`remote-pc-dot${current?.online === false ? ' off' : ''}`} aria-hidden="true" />
          {name}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
      <span className="remote-pc-badge">{t('Remote')}</span>
      <span className="remote-pc-note">{t('Settings are those of the connected PC')}</span>
      {open && (
        <div className="remote-pc-menu" role="menu">
          {pcs.map((pc) => (
            <button
              key={pc.id}
              type="button"
              role="menuitem"
              className={`remote-pc-item${pc.current ? ' on' : ''}`}
              disabled={pc.current}
              onClick={() => switchTo(pc)}
            >
              <i className={`remote-pc-dot${pc.online === true ? '' : ' off'}`} aria-hidden="true" />
              <span>
                {pc.name || t('This PC')}
                <small>
                  {pc.online === true ? t('Online') : t('Offline')}
                  {pc.current
                    ? ` · ${t('In use')}`
                    : pc.lastConnectedAt
                      ? ` · ${new Date(pc.lastConnectedAt).toLocaleDateString(uiFormatLocale())}`
                      : ''}
                </small>
              </span>
              {pc.current && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
          <div className="remote-pc-sep" />
          <button type="button" role="menuitem" className="remote-pc-item" onClick={connectAnother}>
            <Plus size={14} aria-hidden="true" />
            <span>{t('Connect another PC (code)')}</span>
          </button>
          <button type="button" role="menuitem" className="remote-pc-item" onClick={connectAnother}>
            <span>{t('Manage connections')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
