import { Monitor } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { DesktopRemoteHost } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t, uiFormatLocale } from '../i18n';
import { ActionButton, Group, ResourceRow } from './capability-controls';
import type { CapabilityApi } from './capability-data';

const HOSTS_REFRESH_MS = 3_000;

/** Two-line code input: accepts `482917`, `482 917`, `482·917`. */
function normalizeCodeInput(text: string): string {
  return text.replace(/\D/gu, '').slice(0, 6);
}

/** "Connect to another PC": the 6-digit code shown on the other computer's
 *  Settings → Connection, then the computers saved here. Each opens its own
 *  window; this app stays fully usable beside it. */
export function RemoteHostsPanel({ api }: { api: CapabilityApi }) {
  const [hosts, setHosts] = useState<DesktopRemoteHost[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmForget, setConfirmForget] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void api
      .listRemoteHosts?.()
      .then((next) => setHosts(next ?? []))
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!api.listRemoteHosts) return undefined;
    refresh();
    const timer = window.setInterval(refresh, HOSTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [api, refresh]);

  if (!api.connectRemoteHostByCode) return null;

  const run = (key: string, action: () => Promise<unknown> | undefined): void => {
    setBusy(key);
    setError('');
    void Promise.resolve()
      .then(action)
      .then(refresh)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(''));
  };
  const ready = code.length === 6;
  const connect = (): void => {
    if (!ready || !api.connectRemoteHostByCode) return;
    run('connect', async () => {
      await api.connectRemoteHostByCode?.(code);
      setCode('');
    });
  };

  return (
    <>
      <Group
        title={t('Connect to another PC')}
        description={t('Open Settings → Connection on the other computer and enter its 6-digit code.')}
      >
        <div className="settings-connection-body">
          <form
            className="settings-remote-host-form"
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <span className="settings-code-input">
              <input
                type="text"
                name="code"
                className="settings-connection-input"
                value={code.length > 3 ? `${code.slice(0, 3)}·${code.slice(3)}` : code}
                inputMode="numeric"
                placeholder="000·000"
                aria-label={t('6-digit code')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setCode(normalizeCodeInput(event.currentTarget.value))}
              />
            </span>
            <ActionButton disabled={!ready || busy === 'connect'} onClick={connect}>
              {busy === 'connect' ? t('Connecting…') : t('Connect')}
            </ActionButton>
          </form>
          {error && <ErrorNotice error={error} />}
        </div>
      </Group>
      {hosts.length > 0 && (
        <Group
          title={t('Saved PCs')}
          description={t('Computers you have connected to. Each opens in its own window.')}
        >
          <div className="settings-resource-list">
            {hosts.map((host) => (
              <ResourceRow
                key={host.id}
                leading={<Monitor size={15} />}
                title={host.name}
                meta={
                  host.lastConnectedAt
                    ? t('Last connected {{lastSeen}}', {
                        lastSeen: new Date(host.lastConnectedAt).toLocaleString(uiFormatLocale()),
                      })
                    : t('Not connected yet')
                }
                status={host.online === undefined ? (host.open ? 'Online' : undefined) : host.online ? 'Online' : 'Offline'}
                actions={
                  <>
                    <ActionButton
                      disabled={Boolean(busy)}
                      onClick={() => run(`open:${host.id}`, () => api.openRemoteHost?.(host.id))}
                    >
                      {t('Open')}
                    </ActionButton>
                    <ActionButton
                      danger
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (confirmForget !== host.id) {
                          setConfirmForget(host.id);
                          return;
                        }
                        setConfirmForget('');
                        run(`forget:${host.id}`, () => api.forgetRemoteHost?.(host.id));
                      }}
                    >
                      {confirmForget === host.id ? t('Confirm forget') : t('Forget')}
                    </ActionButton>
                  </>
                }
              />
            ))}
          </div>
        </Group>
      )}
    </>
  );
}