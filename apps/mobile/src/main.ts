// First-run / host-picker screen of the Mixdog phone app. This page is the only
// UI bundled into the app: scan the desktop's QR or enter its 6-digit code,
// remember the host, then navigate the WebView to the relay's
// `/d/<deviceId>/` page. Everything after that is the relay web app.
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  DEFAULT_RELAY_ORIGIN,
  emptyHostBook,
  extractPairingLink,
  forgetHost,
  parseCodeInput,
  redeemCode,
  readHostBook,
  rememberHost,
  type HostBook,
} from './hosts.ts';
import { originsOfBook } from './origins.ts';
import { checkForUpdate, type AvailableUpdate } from './update.ts';
import { nativeAppInfo } from '../../desktop/src/shared/native-app.ts';

/** Code redemption goes through the native HTTP stack: the bundled page is a
 *  different origin from the relay, and a relay without the endpoint answers
 *  without CORS headers, which the WebView would report as a network failure
 *  instead of "update the main PC". */
const relayFetch: typeof fetch = async (input, init) => {
  if (!Capacitor.isNativePlatform()) return fetch(input, init);
  const response = await CapacitorHttp.request({
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers as Record<string, string> | undefined) ?? {},
    data: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    responseType: 'text',
  });
  const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
  return new Response(text, { status: response.status });
};

const HOSTS_KEY = 'mixdog.hosts';
const DISMISSED_UPDATE_KEY = 'mixdog.update.dismissed';

const STRINGS = {
  en: {
    heading: 'Connect Mixdog',
    note: 'On the main PC, open Settings → Connection.',
    step1: 'Open Settings → Connection on the main PC',
    step2: 'Scan the QR code or enter the code',
    step3: 'Approve this phone on the main PC',
    scan: 'Scan QR code',
    or: 'or',
    enterCode: 'Enter 6-digit code',
    codeHeading: 'Enter code',
    codeNote: 'Enter the 6-digit code shown on the main PC under Settings → Connection.',
    codeLabel: '6-digit code',
    back: 'Back',
    waiting: 'Waiting for approval on the main PC…',
    codeInvalid: 'That code is wrong or has expired. Check the new code on the main PC.',
    codeLimited: 'Too many attempts. Try again in {s} seconds.',
    codeOutdated: 'Update Mixdog on the main PC to connect with a code. The QR code still works.',
    codeNetwork: 'Could not reach the relay. Check this phone’s connection.',
    connect: 'Connect',
    paired: 'Paired PCs',
    forget: 'Forget',
    updateGet: 'Download update',
    updateLater: 'Later',
    updateAvailable: 'Mixdog {v} is available.',
    opening: 'Opening…',
    notLink: 'That is not a Mixdog QR code.',
    scanUnavailable: 'QR scanning is not available here. Enter the 6-digit code instead.',
    cameraOff: 'Camera permission is off. Allow it in Settings or enter the 6-digit code.',
    preparing: 'Preparing the QR scanner… try again in a moment.',
    scanFailed: 'Could not scan. Enter the 6-digit code instead.',
  },
  ko: {
    heading: 'Mixdog 연결',
    note: '메인 PC에서 설정 → 연결을 여세요.',
    step1: '메인 PC에서 설정 → 연결 열기',
    step2: 'QR 코드를 스캔하거나 코드 입력',
    step3: '메인 PC에서 이 휴대폰 승인',
    scan: 'QR 코드 스캔',
    or: '또는',
    enterCode: '6자리 코드 입력',
    codeHeading: '코드 입력',
    codeNote: '메인 PC의 설정 → 연결에 보이는 6자리 코드를 입력하세요.',
    codeLabel: '6자리 코드',
    back: '뒤로',
    waiting: '메인 PC에서 승인을 기다리는 중…',
    codeInvalid: '코드가 맞지 않거나 만료되었습니다. 메인 PC의 새 코드를 확인하세요.',
    codeLimited: '시도가 너무 많습니다. {s}초 뒤에 다시 시도하세요.',
    codeOutdated: '코드로 연결하려면 메인 PC의 Mixdog을 업데이트하세요. QR 코드는 그대로 사용할 수 있습니다.',
    codeNetwork: '릴레이에 연결할 수 없습니다. 휴대폰의 연결을 확인하세요.',
    connect: '연결',
    paired: '연결된 PC',
    forget: '삭제',
    updateGet: '업데이트 다운로드',
    updateLater: '나중에',
    updateAvailable: 'Mixdog {v} 버전을 사용할 수 있습니다.',
    opening: '여는 중…',
    notLink: 'Mixdog QR 코드가 아닙니다.',
    scanUnavailable: '여기서는 QR 스캔을 사용할 수 없습니다. 6자리 코드를 입력하세요.',
    cameraOff: '카메라 권한이 꺼져 있습니다. 설정에서 허용하거나 6자리 코드를 입력하세요.',
    preparing: 'QR 스캐너를 준비하는 중… 잠시 후 다시 시도하세요.',
    scanFailed: '스캔하지 못했습니다. 6자리 코드를 입력하세요.',
  },
};
type StringKey = keyof typeof STRINGS.en;
const strings = navigator.language.toLowerCase().startsWith('ko') ? STRINGS.ko : STRINGS.en;
const t = (key: StringKey): string => strings[key];

function applyStrings(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) {
    el.textContent = t(el.dataset.t as StringKey);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-t-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.tAria as StringKey));
  }
  document.documentElement.lang = strings === STRINGS.ko ? 'ko' : 'en';
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (text: string, failed = false): void => {
  const line = $('status');
  line.textContent = text;
  line.dataset.failed = failed ? '1' : '';
};

let book: HostBook = emptyHostBook();

async function loadBook(): Promise<void> {
  book = readHostBook((await Preferences.get({ key: HOSTS_KEY })).value);
}

async function saveBook(): Promise<void> {
  await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(book) });
}

/** Tell the native side which relay origins may load (it persists them and
 *  refuses navigation to anything else). Must finish before navigating. */
async function syncOrigins(): Promise<void> {
  try {
    await nativeAppInfo()?.call?.('setAllowedOrigins', { origins: originsOfBook(book) });
  } catch {
    // Without the bridge the native side keeps its last list.
  }
}

async function openHost(url: string, redeemed?: { name: string; ticket: string }): Promise<void> {
  const link = extractPairingLink(url);
  if (!link) return;
  book = rememberHost(book, link, Date.now(), redeemed?.name);
  await saveBook();
  await syncOrigins();
  status(redeemed ? t('waiting') : t('opening'));
  // The one-time ticket rides the fragment (never sent to the relay with the
  // page request); the relay web app uses it for its first claim.
  window.location.href = redeemed ? `${link.url}#pair=${redeemed.ticket}` : link.url;
}

/** Code entry: redeem at the relay, then open the host, which asks the main
 *  PC for approval. */
async function connectWithCode(): Promise<void> {
  const code = parseCodeInput(($('code') as HTMLInputElement).value);
  if (!code) return;
  ($('connect') as HTMLButtonElement).disabled = true;
  status('');
  const result = await redeemCode(DEFAULT_RELAY_ORIGIN, code, relayFetch);
  if (result.ok) {
    await openHost(result.link.url, { name: result.name, ticket: result.ticket });
    return;
  }
  const messages = {
    invalid: t('codeInvalid'),
    'rate-limited': t('codeLimited').replace('{s}', String(result.retryAfter ?? 60)),
    outdated: t('codeOutdated'),
    network: t('codeNetwork'),
  };
  status(messages[result.reason], true);
  ($('connect') as HTMLButtonElement).disabled = !parseCodeInput(($('code') as HTMLInputElement).value);
}

function showCodeEntry(show: boolean): void {
  $('start').hidden = show;
  $('code-entry').hidden = !show;
  status('');
  if (show) ($('code') as HTMLInputElement).focus();
}

async function connectFrom(text: string): Promise<void> {
  const link = extractPairingLink(text);
  if (!link) {
    status(t('notLink'), true);
    return;
  }
  await openHost(link.url);
}

async function scan(): Promise<void> {
  try {
    if (!(await BarcodeScanner.isSupported()).supported) {
      status(t('scanUnavailable'), true);
      return;
    }
    if ((await BarcodeScanner.requestPermissions()).camera !== 'granted') {
      status(t('cameraOff'), true);
      return;
    }
    // Android scans through a Play services module that may not be on the
    // phone yet; fetch it first instead of opening a scanner that is missing.
    if (
      Capacitor.getPlatform() === 'android' &&
      !(await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available
    ) {
      status(t('preparing'));
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return;
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const value = barcodes[0]?.rawValue ?? '';
    if (value) await connectFrom(value);
  } catch (error) {
    // Closing the scanner is not a failure.
    if (!/cancel/iu.test(String((error as Error)?.message ?? error))) {
      status(t('scanFailed'), true);
    }
  }
}

function renderHosts(): void {
  const list = $('hosts');
  list.textContent = '';
  $('hosts-section').hidden = book.hosts.length === 0;
  for (const host of book.hosts) {
    const row = document.createElement('div');
    row.className = 'host';
    const open = document.createElement('button');
    open.className = 'host-open';
    open.textContent = host.name;
    open.addEventListener('click', () => void openHost(host.url));
    const forget = document.createElement('button');
    forget.className = 'host-forget secondary';
    forget.textContent = t('forget');
    forget.addEventListener('click', () => {
      book = forgetHost(book, host.url);
      void saveBook().then(syncOrigins).then(renderHosts);
    });
    row.append(open, forget);
    list.append(row);
  }
}

async function offerUpdate(update: AvailableUpdate): Promise<void> {
  const dismissed = (await Preferences.get({ key: DISMISSED_UPDATE_KEY })).value;
  if (dismissed === update.version) return;
  $('update-text').textContent = t('updateAvailable').replace('{v}', update.version);
  $('update').hidden = false;
  $('update-get').addEventListener('click', () => void Browser.open({ url: update.apkUrl }));
  $('update-later').addEventListener('click', () => {
    $('update').hidden = true;
    void Preferences.set({ key: DISMISSED_UPDATE_KEY, value: update.version });
  });
}

/** `mixdog://pair?link=<pairing link>` (and plain https pairing links). */
function linkFromAppUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('link') ?? url;
  } catch {
    return url;
  }
}

const LAUNCH_UPDATE_BUDGET_MS = 600;

async function boot(): Promise<void> {
  applyStrings();
  await loadBook();
  renderHosts();
  await syncOrigins();
  const manage = new URLSearchParams(window.location.search).has('manage');
  $('scan').addEventListener('click', () => void scan());
  const codeInput = $('code') as HTMLInputElement;
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/gu, '').slice(0, 6);
    codeInput.value = digits.length > 3 ? `${digits.slice(0, 3)}·${digits.slice(3)}` : digits;
    ($('connect') as HTMLButtonElement).disabled = digits.length !== 6;
  });
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connectWithCode();
  });
  $('enter-code').addEventListener('click', () => showCodeEntry(true));
  $('code-back').addEventListener('click', () => showCodeEntry(false));
  $('connect').addEventListener('click', () => void connectWithCode());
  void App.addListener('appUrlOpen', ({ url }) => void connectFrom(linkFromAppUrl(url)));

  // Only Android sideloads: iOS updates arrive through TestFlight.
  let update: AvailableUpdate | null = null;
  if (Capacitor.getPlatform() === 'android') {
    const info = await App.getInfo();
    // A launch that goes straight to the saved host (a notification Allow /
    // Deny lands here too) must not sit behind a slow release lookup: it gets a
    // short budget, and only the picker screen, which stays up anyway, waits
    // the full timeout.
    update = await checkForUpdate(
      info.version,
      undefined,
      !manage && book.last ? LAUNCH_UPDATE_BUDGET_MS : undefined
    );
    if (update) await offerUpdate(update);
  }
  const prompting = update !== null && !$('update').hidden;
  if (!manage && !prompting && book.last) await openHost(book.last);
  else if (!manage && prompting) {
    // Launch continues to the last host once the prompt is answered.
    for (const id of ['update-get', 'update-later']) {
      $(id).addEventListener('click', () => {
        if (book.last) void openHost(book.last);
      });
    }
  }
}

void boot();
