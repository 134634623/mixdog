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
import { subscribeConnectionTabRequests, takeConnectionTabRequest, type ConnectionTabId } from './connection-intent';
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

function ConnectionTabs({
  tab,
  withOther,
  onSelect,
}: {
  tab: ConnectionTab;
  withOther: boolean;
  onSelect(next: ConnectionTab): void;
}) {
  const tabs: Array<[ConnectionTab, string]> = [
    ['app', t('Mobile')],
    ['web', t('Web')],
  ];
  if (withOther) tabs.push(['other', t('Other PC')]);
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

type PairCodeState = {
  code: DesktopRemotePairCode | null;
  unsupported: boolean;
  now: number;
  renew(): void;
};

/** The 6-digit code exists only while a tab that shows it is on screen: it is
 *  requested when shown, kept fresh on a heartbeat, and withdrawn when hidden.
 *  The Web and Other PC tabs share one code. */
function usePairCode(api: CapabilityApi, enabled: boolean): PairCodeState {
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
    if (!request || !enabled) return undefined;
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
      setCode(null);
      void request('release').catch(() => undefined);
    };
  }, [request, enabled]);
  return { code, unsupported, now, renew };
}

/** Phone app tab: the QR only. The pairing URL lives inside the QR; there is
 *  no link to copy. */
function AppPairingCard({ info }: { info: DesktopRemoteAccessInfo }) {
  return (
    <Group title={t('Mobile')} description={t('An approved device gets the same access as this PC.')}>
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
            <span className="settings-connection-hint">{t('No camera? Enter the code from the Web tab instead.')}</span>
          </div>
        </div>
      </div>
    </Group>
  );
}

/** The 6-digit code with its countdown, shared by the Web and Other PC tabs. */
function PairCodeBlock({ pair, available }: { pair: PairCodeState; available: boolean }) {
  const { code, unsupported, now, renew } = pair;
  if (!available) return null;
  if (unsupported) {
    return (
      <span className="settings-connection-hint" role="note">
        {t("This relay doesn't support codes yet — use the QR code")}
      </span>
    );
  }
  if (!code) {
    return (
      <span className="settings-connection-hint" role="status">
        {t('Getting a code…')}
      </span>
    );
  }
  return (
    <>
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
      <span className="settings-connection-hint">
        {t('The code works once, for 5 minutes. This PC must approve every request.')}
      </span>
    </>
  );
}

/** Web tab: no QR (a browser on a PC cannot scan one), just the address and
 *  the code. */
function WebPairingCard({ info, pair, api }: { info: DesktopRemoteAccessInfo; pair: PairCodeState; api: CapabilityApi }) {
  return (
    <Group title={t('Web')} description={t('An approved device gets the same access as this PC.')}>
      <div className="settings-connection-body">
        <div className="settings-connection-field-group settings-connection-code-card">
          {info.relayConnectUrl && (
            <b>
              {t('In a browser, open {{url}} and enter the code.', {
                url: info.relayConnectUrl.replace(/^https?:\/\//u, ''),
              })}
            </b>
          )}
          <PairCodeBlock pair={pair} available={Boolean(api.getRemotePairCode)} />
        </div>
      </div>
    </Group>
  );
}

/** Other PC tab, top half: this PC's code, for another PC's Mixdog to enter. */
function ThisPcCodeCard({ pair, api }: { pair: PairCodeState; api: CapabilityApi }) {
  if (!api.getRemotePairCode) return null;
  return (
    <Group
      title={t('This PC’s code')}
      description={t('On the other PC, open Settings → Connection → Other PC and enter this code.')}
    >
      <div className="settings-connection-body">
        <div className="settings-connection-field-group settings-connection-code-card">
          <PairCodeBlock pair={pair} available />
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
    <Group title={t('Connect a device')}>
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
  kind: tabKind,
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
  kind: RemoteClientKind;
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
  // Each tab lists only the devices that connected its way, with
  // unpair-everything under any non-empty list.
  const clients = info.clients.filter((client) => remoteClientKind(client.browser) === tabKind);
  if (clients.length === 0) return null;
  return (
    <Group title={t('Connected devices')} description={t('Devices stay connected until you unpair them here.')}>
      <div className="settings-resource-list">
        {clients.map((client) => {
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
              meta={t('Added {{created}} · Last used {{lastSeen}}', {
                created: new Date(client.createdAt).toLocaleDateString(uiFormatLocale()),
                lastSeen,
              })}
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
  const [tab, setTab] = useState<ConnectionTab>(() => takeConnectionTabRequest() ?? 'app');
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
  const withOther = Boolean(api.connectRemoteHostByCode);
  const shown: ConnectionTab = tab === 'other' && !withOther ? 'app' : tab;
  const pair = usePairCode(api, ready && shown !== 'app');

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
            actions={
              <ActionButton onClick={() => void native.call?.('openHostPicker').catch(() => undefined)}>
                {t('Switch PC')}
              </ActionButton>
            }
          />
        </Group>
      </>
    );
  }

  const withTabs = (content: ReactNode) => (
    <>
      <ConnectionTabs tab={shown} withOther={withOther} onSelect={setTab} />
      <div role="tabpanel" className="settings-connection-panel">
        {content}
      </div>
    </>
  );
  const waiting =
    stalledAttempts >= CONNECTION_STALLED_ATTEMPTS
      ? renderConnectionNote(t(RELAY_CONNECTING_MESSAGE))
      : renderPairingPlaceholder();
  if (!ready) {
    // Connecting OUT to another PC does not depend on this PC's own relay, so
    // that half of its tab works while this PC is still waiting on the relay.
    return withTabs(shown === 'other' ? <RemoteHostsPanel api={api} /> : waiting);
  }

  const devices = renderLinkedDevices({
    info,
    kind: shown === 'web' ? 'browser' : shown === 'other' ? 'pc' : 'app',
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
  });
  if (shown === 'web') {
    return withTabs(
      <>
        <WebPairingCard info={info} pair={pair} api={api} />
        {devices}
      </>
    );
  }
  if (shown === 'other') {
    return withTabs(
      <>
        <ThisPcCodeCard pair={pair} api={api} />
        <RemoteHostsPanel api={api} />
        {devices}
      </>
    );
  }
  return withTabs(
    <>
      <AppPairingCard info={info} />
      {devices}
    </>
  );
}
