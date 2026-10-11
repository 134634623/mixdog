import { Globe, Monitor, Smartphone } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type {
  DesktopRemoteAccessInfo,
  DesktopRemotePairCode,
  DesktopRemotePairCodeUnsupported,
} from '../../shared/contract';
import { nativeAppInfo } from '../../shared/native-app';
import { remoteClientKind, type RemoteClientKind } from '../../shared/remote-trust';
import { t, uiFormatLocale } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { RemoteHostsPanel } from './remote-hosts-panel';
import {
  subscribeConnectionTabRequests,
  takeConnectionTabRequest,
  type ConnectionTabId,
} from './connection-intent';
import { formatPairCode, remainingFraction, remainingLabel } from './pair-code-format';
import { ActionButton, Group, ResourceRow } from './capability-controls';
import type { CapabilityApi } from './capability-data';
import {
  connectionInfoReady,
  getCachedConnectionInfo,
  preloadConnectionInfo,
  setCachedConnectionInfo,
} from './connection-info';

const CONNECTION_RETRY_MS = 2_000;
const CONNECTION_STALLED_ATTEMPTS = 5;
const RELAY_CONNECTING_MESSAGE =
  'Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.';

function unpairLabel(busy: boolean, confirming: boolean): string {
  if (busy) return t('Unpairing…');
  return confirming ? t('Confirm unpair') : t('Unpair');
}

/** Keeps the pairing card current: a ready card polls for device changes, and
 *  a card still waiting on the relay retries until one arrives. */
function useConnectionInfoUpdates({
  api,
  ready,
  applyInfo,
  setInfo,
  setStalledAttempts,
}: {
  api: CapabilityApi;
  ready: boolean;
  applyInfo(next: DesktopRemoteAccessInfo | null): void;
  setInfo(next: DesktopRemoteAccessInfo | null): void;
  setStalledAttempts(update: (count: number) => number): void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyInfo is a per-render callback; the poll restarts only when ready or api change.
  useEffect(() => {
    if (!ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    const refresh = () => {
      void api
        .getRemoteAccessInfo?.()
        .then((value) => {
          if (!live) return;
          applyInfo(value ?? null);
        })
        .catch(() => {
          /* retain the current card */
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    const unsubscribe = subscribeSetupChanges(refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [ready, api]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setInfo/setStalledAttempts are per-render callbacks; the retry loop restarts only when api or ready change.
  useEffect(() => {
    if (ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    let timer = 0;
    const attempt = () => {
      const startedAt = Date.now();
      void preloadConnectionInfo(api, CONNECTION_RETRY_MS).then((value) => {
        if (!live) return;
        setInfo(value);
        if (connectionInfoReady(value)) return;
        setStalledAttempts((count) => count + 1);
        timer = window.setTimeout(attempt, Math.max(0, CONNECTION_RETRY_MS - (Date.now() - startedAt)));
      });
    };
    attempt();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, ready]);
}

// Both unpair flows answer with the refreshed card; a failed call keeps the
// card the user is looking at.
function applyConnectionResult(
  pending: Promise<DesktopRemoteAccessInfo | null | undefined>,
  applyInfo: (next: DesktopRemoteAccessInfo | null) => void,
  done: () => void
): void {
  void pending
    .then((value) => applyInfo(value ?? null))
    .catch(() => {
      /* retain the current card */
    })
    .finally(done);
}

type ConnectionTab = ConnectionTabId;

function ConnectionTabs({ tab, onSelect }: { tab: ConnectionTab; onSelect(next: ConnectionTab): void }) {
  const tabs: Array<[ConnectionTab, string]> = [
    ['this', t('Connect to this PC')],
    ['other', t('Connect to another PC')],
  ];
  return (
    <div className="settings-connection-tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onSelect(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const CODE_POLL_MS = 8_000;

/** The 6-digit code exists only while this card is on screen: it is requested
 *  on mount, kept fresh on a heartbeat, and withdrawn on unmount. */
function usePairCode(api: CapabilityApi): {
  code: DesktopRemotePairCode | null;
  unsupported: boolean;
  now: number;
  renew(): void;
} {
  const [code, setCode] = useState<DesktopRemotePairCode | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const request = api.getRemotePairCode;
  // A relay without codes answers { unsupported: true }; a missing answer from
  // an older host means the same.
  // null is a request still pending (a loading state), not "unsupported".
  const accept = (next: DesktopRemotePairCode | DesktopRemotePairCodeUnsupported | null | undefined): void => {
    const none = next === undefined || (next !== null && 'unsupported' in next);
    setUnsupported(none);
    setCode(none || next === null ? null : next);
  };
  const renew = (): void => {
    void request?.('renew')
      .then(accept)
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!request) return undefined;
    let live = true;
    const ensure = () => {
      void request('ensure')
        .then((next) => live && accept(next))
        .catch(() => undefined);
    };
    ensure();
    const poll = window.setInterval(ensure, CODE_POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
      void request('release').catch(() => undefined);
    };
  }, [request]);
  return { code, unsupported, now, renew };
}

/** Connect a device: the QR for cameras, the 6-digit code for everything else.
 *  The pairing URL lives only inside the QR; there is no link to copy. */
function PairingCard({ info, api }: { info: DesktopRemoteAccessInfo; api: CapabilityApi }) {
  const { code, unsupported, now, renew } = usePairCode(api);
  return (
    <Group
      title={t('Connect a device')}
      description={t('An approved device gets the same access as this PC.')}
    >
      <div className="settings-connection-body">
        <div className="settings-connection-pair">
          <figure className="settings-connection-card">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: QR SVG generated by the app's own relay info, not user content. */}
            <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: info.relayBrowserQrSvg || '' }} />
          </figure>
          <div className="settings-connection-field-group">
            <b>{t('Phones and tablets: scan the QR code')}</b>
            <span className="settings-connection-hint">
              {t('Scan with the Mixdog app (Android · iPhone/iPad) or the camera.')}
            </span>
            {unsupported ? (
              <span className="settings-connection-hint" role="note">
                {t("This relay doesn't support codes yet — use the QR code")}
              </span>
            ) : code && api.getRemotePairCode ? (
              <>
                <span className="settings-connection-hint">{t('PCs and browsers: enter the code')}</span>
                <div className="settings-pair-code" role="group" aria-label={t('6-digit code')}>
                  <b>{formatPairCode(code.code)}</b>
                </div>
                <div className="settings-pair-timer">
                  <div className="settings-pair-bar" aria-hidden="true">
                    <i style={{ width: `${Math.round(remainingFraction(code.expiresAt, now) * 100)}%` }} />
                  </div>
                  <span>{t('{{time}} left', { time: remainingLabel(code.expiresAt, now) })}</span>
                  <ActionButton onClick={renew}>{t('New code')}</ActionButton>
                </div>
                {info.relayConnectUrl && (
                  <span className="settings-connection-hint">
                    {t('In a browser, open {{url}} and enter the code.', {
                      url: info.relayConnectUrl.replace(/^https?:\/\//u, ''),
                    })}
                  </span>
                )}
              </>
            ) : api.getRemotePairCode ? (
              <span className="settings-connection-hint" role="status">
                {t('Getting a code…')}
              </span>
            ) : null}
            {unsupported ? null : (
              <span className="settings-connection-hint">
                {t('The code works once, for 5 minutes. This PC must approve every request.')}
              </span>
            )}
          </div>
        </div>
      </div>
    </Group>
  );
}

const KIND_ICON = { app: Smartphone, pc: Monitor, browser: Globe } as const;

function kindLabel(kind: RemoteClientKind): string {
  if (kind === 'app') return t('Mixdog app');
  if (kind === 'pc') return t('Mixdog PC');
  return t('Browser');
}
function renderConnectionNote(message: string) {
  return (
    <Group title={t('Web app')}>
      <p className="settings-connection-note">{message}</p>
    </Group>
  );
}

function renderPairingPlaceholder() {
  return (
    <Group title={t('Web app')} description={t('Works on any network. Open the secure link in a browser.')}>
      <div className="settings-connection-body">
        <figure
          className="settings-connection-card settings-connection-card--loading"
          aria-label={t('Preparing pairing code')}
          aria-busy="true"
        >
          <div className="settings-connection-qr-placeholder" aria-hidden="true" />
          <figcaption>
            <b>{t('Preparing pairing code…')}</b>
            <small>{t('Starting the secure relay')}</small>
          </figcaption>
        </figure>
      </div>
    </Group>
  );
}

// Each device row and the unpair-everything row confirm in place: the first
// click arms the button, the second one performs the revocation.
function renderLinkedDevices({
  info,
  api,
  rotating,
  confirmRotate,
  revokingClient,
  confirmClient,
  setRotating,
  setConfirmRotate,
  setRevokingClient,
  setConfirmClient,
  applyInfo,
}: {
  info: DesktopRemoteAccessInfo;
  api: CapabilityApi;
  rotating: boolean;
  confirmRotate: boolean;
  revokingClient: string;
  confirmClient: string;
  setRotating(value: boolean): void;
  setConfirmRotate(value: boolean): void;
  setRevokingClient(value: string): void;
  setConfirmClient(value: string): void;
  applyInfo(next: DesktopRemoteAccessInfo | null): void;
}) {
  return (
    <Group
      title={t('Connected devices')}
      description={t('Devices stay connected until you unpair them here.')}
    >
      <div className="settings-resource-list">
        {info.clients.map((client) => {
          const lastSeen = client.lastSeenAt
            ? new Date(client.lastSeenAt).toLocaleString(uiFormatLocale())
            : t('Never');
          const kind = remoteClientKind(client.browser);
          const Icon = KIND_ICON[kind];
          return (
            <ResourceRow
              key={client.id}
              leading={<Icon size={15} aria-label={kindLabel(kind)} />}
              title={client.name || `${client.platform || t('Device')} · ${client.browser || t('Browser')}`}
              meta={
                t('Added {{created}} · Last used {{lastSeen}}', {
                  created: new Date(client.createdAt).toLocaleDateString(uiFormatLocale()),
                  lastSeen,
                })
              }
              status={client.online ? 'Online' : 'Offline'}
              actions={
                <ActionButton
                  danger
                  disabled={Boolean(revokingClient)}
                  onClick={() => {
                    if (confirmClient !== client.id) {
                      setConfirmClient(client.id);
                      return;
                    }
                    if (!api.revokeRemoteAccessClient) return;
                    setConfirmClient('');
                    setRevokingClient(client.id);
                    applyConnectionResult(api.revokeRemoteAccessClient(client.id), applyInfo, () =>
                      setRevokingClient('')
                    );
                  }}
                >
                  {unpairLabel(revokingClient === client.id, confirmClient === client.id)}
                </ActionButton>
              }
            />
          );
        })}
      </div>
      <ResourceRow
        title={t('Unpair every device')}
        description={t('Every device approved so far loses access and must be approved again.')}
        actions={
          <ActionButton
            disabled={rotating}
            onClick={() => {
              if (!confirmRotate) {
                setConfirmRotate(true);
                return;
              }
              if (!api.rotateRemoteAccess) return;
              setConfirmRotate(false);
              setRotating(true);
              applyConnectionResult(api.rotateRemoteAccess(), applyInfo, () => setRotating(false));
            }}
          >
            {unpairLabel(rotating, confirmRotate)}
          </ActionButton>
        }
      />
    </Group>
  );
}

export function ConnectionPanel({ api }: { api: CapabilityApi }) {
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(() => getCachedConnectionInfo(api));
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [revokingClient, setRevokingClient] = useState('');
  const [confirmClient, setConfirmClient] = useState('');
  const [stalledAttempts, setStalledAttempts] = useState(0);
  const [tab, setTab] = useState<ConnectionTab>(() => takeConnectionTabRequest() ?? 'this');
  useEffect(
    () =>
      subscribeConnectionTabRequests(() => {
        const requested = takeConnectionTabRequest();
        if (requested) setTab(requested);
      }),
    []
  );
  const ready = connectionInfoReady(info);
  const applyInfo = (next: DesktopRemoteAccessInfo | null): void => {
    setCachedConnectionInfo(api, next);
    setInfo(next);
  };

  useConnectionInfoUpdates({ api, ready, applyInfo, setInfo, setStalledAttempts });

  if (!api.getRemoteAccessInfo) {
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    const note = renderConnectionNote(
      remoteServer
        ? t(
            'This web app is paired and connected through {{server}}. Pairing QR codes for other browsers live in the desktop app under Settings → Connection.',
            { server: remoteServer }
          )
        : t(RELAY_CONNECTING_MESSAGE)
    );
    const native = nativeAppInfo();
    if (!native?.call) return note;
    // The phone app keeps a list of paired PCs on its own pairing screen.
    return (
      <>
        {note}
        <Group title={t('Switch PC')}>
          <ResourceRow
            title={t('Switch PC / pair another PC')}
            description={t('Go back to the Mixdog app’s start screen to pick another paired PC or scan a new QR code.')}
            actions={<ActionButton onClick={() => void native.call?.('openHostPicker').catch(() => undefined)}>{t('Switch PC')}</ActionButton>}
          />
        </Group>
      </>
    );
  }

  // Connecting OUT to another PC does not depend on this PC's own relay, so
  // its tab works while this PC's pairing card is still waiting on the relay.
  const withTabs = (thisPc: ReactNode) =>
    api.connectRemoteHostByCode ? (
      <>
        <ConnectionTabs tab={tab} onSelect={setTab} />
        <div role="tabpanel" className="settings-connection-panel">
          {tab === 'other' ? <RemoteHostsPanel api={api} /> : thisPc}
        </div>
      </>
    ) : (
      thisPc
    );
  if (!ready) {
    return withTabs(
      stalledAttempts >= CONNECTION_STALLED_ATTEMPTS
        ? renderConnectionNote(t(RELAY_CONNECTING_MESSAGE))
        : renderPairingPlaceholder()
    );
  }

  return withTabs(
    <>
      <PairingCard info={info} api={api} />
      {info.clients.length > 0 &&
        renderLinkedDevices({
          info,
          api,
          rotating,
          confirmRotate,
          revokingClient,
          confirmClient,
          setRotating,
          setConfirmRotate,
          setRevokingClient,
          setConfirmClient,
          applyInfo,
        })}
    </>
  );
}
