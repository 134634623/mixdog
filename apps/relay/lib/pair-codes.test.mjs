import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  GLOBAL_FAIL_LIMIT,
  IP_BACKOFF_BASE_MS,
  IP_FAILS_PER_STRIKE,
  PAIR_CODE_TTL_MS,
  PairCodes,
} from './pair-codes.mjs';
import { startRelay } from '../server.mjs';

const clock = () => {
  const state = { now: 1_000_000 };
  return { state, now: () => state.now };
};

test('a code resolves once, to its device, and is then spent', () => {
  const { now } = clock();
  const codes = new PairCodes({ now });
  const deviceId = randomUUID();
  assert.equal(codes.register(deviceId, '482917', 'Home PC'), 'ok');
  const first = codes.resolve('482917', '1.1.1.1');
  assert.equal(first.status, 'ok');
  assert.equal(first.deviceId, deviceId);
  assert.equal(first.name, 'Home PC');
  assert.match(first.ticket, /^[0-9a-f]{32}$/);
  assert.equal(codes.resolve('482917', '1.1.1.1').status, 'invalid');
});

test('a code expires after five minutes and a new one replaces the old', () => {
  const { state, now } = clock();
  const codes = new PairCodes({ now });
  const deviceId = randomUUID();
  codes.register(deviceId, '111111', '');
  codes.register(deviceId, '222222', '');
  assert.equal(codes.resolve('111111', 'a').status, 'invalid');
  state.now += PAIR_CODE_TTL_MS + 1;
  assert.equal(codes.resolve('222222', 'b').status, 'invalid');
});

test('malformed codes and collisions between devices are refused', () => {
  const codes = new PairCodes();
  const a = randomUUID();
  const b = randomUUID();
  for (const bad of ['12345', '1234567', 'abcdef', '12 345', 123456, null]) assert.equal(codes.register(a, bad, ''), 'invalid');
  assert.equal(codes.register('not-an-id', '123456', ''), 'invalid');
  assert.equal(codes.register(a, '123456', ''), 'ok');
  assert.equal(codes.register(b, '123456', ''), 'taken');
  codes.clear(a);
  assert.equal(codes.register(b, '123456', ''), 'ok');
});

test('a ticket is single use and bound to its device', () => {
  const codes = new PairCodes();
  const deviceId = randomUUID();
  codes.register(deviceId, '654321', '');
  const { ticket } = codes.resolve('654321', 'ip');
  assert.equal(codes.takeTicket(ticket, randomUUID()), false);
  codes.register(deviceId, '654322', '');
  const second = codes.resolve('654322', 'ip');
  assert.equal(codes.takeTicket(second.ticket, deviceId), true);
  assert.equal(codes.takeTicket(second.ticket, deviceId), false);
  assert.equal(codes.takeTicket('nope', deviceId), false);
});

test('wrong guesses lock a source out with a growing backoff, even for a right code', () => {
  const { state, now } = clock();
  const codes = new PairCodes({ now });
  codes.register(randomUUID(), '999999', '');
  for (let i = 0; i < IP_FAILS_PER_STRIKE; i += 1) assert.equal(codes.resolve('000000', 'bad').status, 'invalid');
  const locked = codes.resolve('999999', 'bad');
  assert.equal(locked.status, 'limited');
  assert.equal(locked.retryAfterMs, IP_BACKOFF_BASE_MS);
  // Another source is unaffected.
  state.now += 1;
  state.now -= 1;
  state.now += IP_BACKOFF_BASE_MS;
  for (let i = 0; i < IP_FAILS_PER_STRIKE; i += 1) codes.resolve('000000', 'bad');
  assert.equal(codes.resolve('999999', 'bad').retryAfterMs, IP_BACKOFF_BASE_MS * 2);
  state.now += IP_BACKOFF_BASE_MS * 2;
  assert.equal(codes.resolve('999999', 'bad').status, 'ok');
});

test('the whole code space shares one guess budget across sources', () => {
  const { state, now } = clock();
  const codes = new PairCodes({ now });
  codes.register(randomUUID(), '777777', '');
  for (let i = 0; i < GLOBAL_FAIL_LIMIT; i += 1) assert.equal(codes.resolve('000000', `src-${i}`).status, 'invalid');
  const blocked = codes.resolve('777777', 'fresh-source');
  assert.equal(blocked.status, 'limited');
  state.now += 10 * 60_000 + 1;
  codes.register(randomUUID(), '777777', '');
  assert.equal(codes.resolve('777777', 'fresh-source').status, 'ok');
});

async function withRelay(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-paircode-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  const sockets = [];
  try {
    await run(relay, `http://127.0.0.1:${relay.port}`, sockets);
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function connectDesktop(relay, sockets, { pairV2 = true } = {}) {
  const deviceId = randomUUID();
  relay.store.authenticate(deviceId, '0123456789abcdef');
  const auth = `Basic ${Buffer.from(`${deviceId}:0123456789abcdef`).toString('base64')}`;
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, { headers: { Authorization: auth } });
  sockets.push(socket);
  const frames = [];
  socket.on('message', (raw, binary) => {
    if (!binary) frames.push(JSON.parse(String(raw)));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'desktop-lanes', media: true, e2ee: 1, ...(pairV2 ? { pairV2: 1 } : {}) }));
  return { deviceId, socket, frames };
}

const until = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached');
};

const post = (origin, path, body, headers = {}) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('relay: a registered code redeems into a claim the desktop sees as a code claim', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const desktop = await connectDesktop(relay, sockets);
    desktop.socket.send(JSON.stringify({ type: 'pair-code', code: '482917', name: 'Home PC' }));
    await until(() => desktop.frames.some((frame) => frame.type === 'pair-code-ack'));
    assert.equal(desktop.frames.find((frame) => frame.type === 'pair-code-ack').ok, true);

    const support = await (await fetch(`${origin}/pair-code/support?deviceId=${desktop.deviceId}`)).json();
    assert.deepEqual(support, { online: true, pairV2: true });

    const resolved = await post(origin, '/pair-code/resolve', { code: '482917' });
    assert.equal(resolved.status, 200);
    const body = await resolved.json();
    assert.equal(body.deviceId, desktop.deviceId);
    assert.equal(body.name, 'Home PC');
    await until(() => desktop.frames.some((frame) => frame.type === 'pair-code-used'));

    const spent = await post(origin, '/pair-code/resolve', { code: '482917' });
    assert.equal(spent.status, 404);
    assert.equal((await spent.json()).status, 'invalid-code');

    const publicKey = 'A'.repeat(87);
    const claim = (ticket) =>
      post(
        origin,
        '/claim',
        { deviceId: desktop.deviceId, clientId: randomUUID(), publicKey, name: 'Phone', ...(ticket ? { ticket } : {}) },
        { Origin: origin }
      );
    assert.equal((await claim(body.ticket)).status, 202);
    await until(() => desktop.frames.some((frame) => frame.type === 'client-claim'));
    assert.equal(desktop.frames.find((frame) => frame.type === 'client-claim').method, 'code');
    // The ticket is spent: reusing it, or sending none, is a plain QR claim.
    assert.equal((await claim(body.ticket)).status, 202);
    assert.equal((await claim('0'.repeat(32))).status, 202);
    await until(() => desktop.frames.filter((frame) => frame.type === 'client-claim').length === 3);
    assert.deepEqual(
      desktop.frames.filter((frame) => frame.type === 'client-claim').map((frame) => frame.method),
      ['code', 'qr', 'qr']
    );
  });
});

test('relay: wrong guesses are limited per source and never echo the code', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const desktop = await connectDesktop(relay, sockets);
    desktop.socket.send(JSON.stringify({ type: 'pair-code', code: '135790' }));
    await until(() => desktop.frames.some((frame) => frame.type === 'pair-code-ack'));
    for (let i = 0; i < IP_FAILS_PER_STRIKE; i += 1) {
      assert.equal((await post(origin, '/pair-code/resolve', { code: '000000' })).status, 404);
    }
    const limited = await post(origin, '/pair-code/resolve', { code: '135790' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.doesNotMatch(JSON.stringify(await limited.json()), /135790/);
  });
});

test('relay: oversize and malformed code requests are refused, cross-origin callers too', async () => {
  await withRelay(async (_relay, origin) => {
    assert.equal((await post(origin, '/pair-code/resolve', { code: 'x'.repeat(5000) })).status, 400);
    assert.equal((await post(origin, '/pair-code/resolve', { code: 'abc' })).status, 404);
    assert.equal((await post(origin, '/pair-code/resolve', { code: '123456' }, { Origin: 'https://evil.example' })).status, 403);
    const preflight = await fetch(`${origin}/pair-code/resolve`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
    const page = await fetch(`${origin}/connect`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'none'/);
  });
});

test('relay: an old desktop is reported as not supporting pairing v2, and presence is per route', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const old = await connectDesktop(relay, sockets, { pairV2: false });
    await until(() => old.frames.length > 0);
    const support = await (await fetch(`${origin}/pair-code/support?deviceId=${old.deviceId}`)).json();
    assert.deepEqual(support, { online: true, pairV2: false });
    const stranger = randomUUID();
    const presence = await (await post(origin, '/pair-code/presence', { ids: [old.deviceId, stranger] })).json();
    assert.deepEqual(presence, { online: { [old.deviceId]: true } });
  });
});
