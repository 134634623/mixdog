import assert from 'node:assert/strict';
import test from 'node:test';

import { createPairCodeManager, PAIR_CODE_TTL_MS } from './remote-pair-code.ts';
import {
  fetchHostPresence,
  parsePairCodeInput,
  redeemPairCode,
  relayHttpOrigin,
  remoteHostId,
} from './remote-hosts.ts';

const setup = (codes = ['111111', '222222', '333333']) => {
  const sent = [];
  const clock = { now: 1_000 };
  const queue = [...codes];
  const manager = createPairCodeManager({
    sendEnvelope: (frame) => sent.push(frame),
    hostName: 'Home PC',
    now: () => clock.now,
    randomCode: () => queue.shift() ?? '999999',
  });
  return { manager, sent, clock };
};

test('a code is minted on first ask, published once, and reused until it expires', () => {
  const { manager, sent, clock } = setup();
  const first = manager.ensure();
  assert.equal(first.code, '111111');
  assert.equal(first.expiresAt, 1_000 + PAIR_CODE_TTL_MS);
  assert.deepEqual(sent, [{ type: 'pair-code', code: '111111', name: 'Home PC' }]);
  assert.equal(manager.ensure().code, '111111');
  assert.equal(sent.length, 1);
  clock.now += PAIR_CODE_TTL_MS + 1;
  assert.equal(manager.ensure().code, '222222');
});

test('renew replaces the code; release withdraws it; used makes the next ask mint', () => {
  const { manager, sent } = setup();
  manager.ensure();
  assert.equal(manager.ensure(true).code, '222222');
  manager.onUsed();
  assert.equal(manager.ensure().code, '333333');
  manager.release();
  assert.deepEqual(sent.at(-1), { type: 'pair-code-clear' });
  const count = sent.length;
  manager.release();
  assert.equal(sent.length, count, 'releasing nothing sends nothing');
});

test('a collision answer draws a fresh code while the screen is open, and a new relay leg republishes', () => {
  const { manager, sent } = setup();
  manager.ensure();
  manager.onAck(false);
  assert.equal(sent.at(-1).code, '222222');
  manager.onAck(true);
  manager.resend();
  assert.equal(sent.at(-1).code, '222222');
  manager.release();
  manager.onAck(false);
  assert.equal(sent.at(-1).type, 'pair-code-clear', 'a closed screen does not redraw');
});

test('codes are typed in any grouping and never contain anything but six digits', () => {
  assert.equal(parsePairCodeInput('482·917'), '482917');
  assert.equal(parsePairCodeInput('482 917'), '482917');
  assert.equal(parsePairCodeInput('48291'), null);
  assert.equal(parsePairCodeInput('12345a'), null);
  assert.equal(relayHttpOrigin('wss://relay.example.com/'), 'https://relay.example.com');
  assert.equal(relayHttpOrigin('ws://127.0.0.1:9800'), 'http://127.0.0.1:9800');
});

const reply = (status, body) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('redeeming a code maps every relay answer to a message that says what to do', async () => {
  const device = '0123456789abcdef0123456789abcdef';
  const ok = await redeemPairCode('https://r', '482917', reply(200, { deviceId: device, name: 'Home PC', ticket: 'a'.repeat(32) }));
  assert.deepEqual(ok, { deviceId: device, name: 'Home PC', ticket: 'a'.repeat(32) });
  await assert.rejects(redeemPairCode('https://r', '000000', reply(404, { status: 'invalid-code' })), /wrong or has expired/);
  await assert.rejects(redeemPairCode('https://r', '000000', reply(429, { status: 'rate-limited', retryAfter: 42 })), /42 seconds/);
  // A relay that predates codes answers 404 without the JSON status.
  await assert.rejects(redeemPairCode('https://r', '000000', reply(404, 'Not found')), /Update Mixdog on the main PC/);
});

test('saved PC presence is asked per relay and unknown relays stay unknown', async () => {
  const device = '0123456789abcdef0123456789abcdef';
  const url = `https://r.example/d/${device}/`;
  const calls = [];
  const online = await fetchHostPresence([{ id: remoteHostId(url), url }], async (target, init) => {
    calls.push([target, JSON.parse(init.body)]);
    return new Response(JSON.stringify({ online: { [device]: true } }));
  });
  assert.equal(online.get(remoteHostId(url)), true);
  assert.deepEqual(calls, [['https://r.example/pair-code/presence', { ids: [device] }]]);
  const down = await fetchHostPresence([{ id: 'x', url }], async () => {
    throw new Error('offline');
  });
  assert.equal(down.has('x'), false);
});
