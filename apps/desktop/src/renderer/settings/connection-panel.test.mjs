import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { getCachedConnectionInfo, setCachedConnectionInfo } from './connection-info.ts';
import { ConnectionPanel } from './connection-panel.tsx';

const readyInfo = (id) => ({
  relayBrowserUrl: `https://relay.example/d/${id}/`,
  relayBrowserQrSvg: `<svg data-device="${id}"></svg>`,
  relayConnectUrl: 'https://relay.example/connect',
  clients: [],
});

test('a displayed QR and its cache clear on disconnect and return after the automatic retry', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const old = readyInfo('aaaaaaaa');
  const fresh = readyInfo('bbbbbbbb');
  const disconnected = Promise.withResolvers();
  const reconnected = Promise.withResolvers();
  let calls = 0;
  const api = {
    getRemoteAccessInfo() {
      calls += 1;
      if (calls === 1) return disconnected.promise;
      if (calls === 2) return reconnected.promise;
      return Promise.resolve(fresh);
    },
  };
  setCachedConnectionInfo(api, old);

  await act(async () => root.render(React.createElement(ConnectionPanel, { api })));
  assert.ok(document.querySelector('svg[data-device="aaaaaaaa"]'));

  await act(async () => disconnected.resolve(null));
  assert.equal(document.querySelector('.settings-connection-card svg'), null);
  assert.ok(document.querySelector('.settings-connection-card[aria-busy="true"]'));
  assert.equal(getCachedConnectionInfo(api), null);
  assert.equal(calls, 2);

  await act(async () => reconnected.resolve(fresh));
  assert.equal(document.querySelector('svg[data-device="aaaaaaaa"]'), null);
  assert.ok(document.querySelector('svg[data-device="bbbbbbbb"]'));
  assert.deepEqual(getCachedConnectionInfo(api), fresh);
});

test('the pairing card shows the QR and a 6-digit code with no link field; the other-PC tab takes a code', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const connected = [];
  const released = [];
  const api = {
    getRemoteAccessInfo: () => Promise.resolve(readyInfo('cccccccc')),
    getRemotePairCode: (action) => {
      if (action === 'release') released.push(action);
      return Promise.resolve(
        action === 'release' ? null : { code: action === 'renew' ? '111222' : '482917', expiresAt: Date.now() + 200_000 }
      );
    },
    listRemoteHosts: () =>
      Promise.resolve([{ id: 'h1', name: 'Home PC', open: false, online: true, lastConnectedAt: 0 }]),
    connectRemoteHostByCode: (code) => {
      connected.push(code);
      return Promise.resolve();
    },
  };
  setCachedConnectionInfo(api, readyInfo('cccccccc'));
  await act(async () => root.render(React.createElement(ConnectionPanel, { api })));

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('.settings-connection-card svg[data-device="cccccccc"]'));
  assert.equal(document.querySelector('.settings-pair-code b').textContent, '482·917');
  assert.equal(document.querySelector('input[readonly]'), null, 'no pairing link field');
  assert.equal(document.querySelector('.settings-connection-link'), null);
  assert.ok(!document.body.textContent.includes('relay.example/d/'), 'the pairing URL is never shown');

  const renew = [...document.querySelectorAll('button')].find((button) => button.textContent === 'New code');
  await act(async () => renew.click());
  assert.equal(document.querySelector('.settings-pair-code b').textContent, '111·222');

  await act(async () => tabs[1].click());
  assert.deepEqual(released, ['release'], 'the code is withdrawn when the screen leaves the tab');
  assert.ok(document.body.textContent.includes('Home PC'));
  const input = document.querySelector('input[name="code"]');
  assert.ok(input);
  assert.equal(document.querySelector('input[name="link"]'), null);
  const nativeSet = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
  await act(async () => {
    nativeSet.call(input, '482917');
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  });
  const connect = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Connect');
  await act(async () => connect.click());
  assert.deepEqual(connected, ['482917']);
});

test('connected devices show a kind icon, an online pill, dates and unpair', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const info = {
    ...readyInfo('dddddddd'),
    clients: [
      { id: 'c1', name: 'Fold · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: 1, lastSeenAt: 2, online: true },
      { id: 'c2', name: 'Office', platform: 'Windows', browser: 'Mixdog Desktop', createdAt: 1, lastSeenAt: 0, online: false },
      { id: 'c3', name: 'Laptop · Chrome', platform: 'Windows', browser: 'Chrome', createdAt: 1, lastSeenAt: 2, online: false },
    ],
  };
  const api = {
    getRemoteAccessInfo: () => Promise.resolve(info),
    getRemotePairCode: () => Promise.resolve({ code: '123456', expiresAt: Date.now() + 100_000 }),
    rotateRemoteAccess: () => Promise.resolve(info),
  };
  setCachedConnectionInfo(api, info);
  await act(async () => root.render(React.createElement(ConnectionPanel, { api })));
  const rows = [...document.querySelectorAll('.settings-resource')];
  assert.equal(rows.length, 4, 'three devices plus unpair-all');
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.querySelector('.settings-resource-icon svg')?.getAttribute('aria-label')),
    ['Mixdog app', 'Mixdog PC', 'Browser']
  );
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.querySelector('.settings-status').textContent),
    ['Online', 'Offline', 'Offline']
  );
  assert.ok(rows[0].querySelector('.settings-resource-meta').textContent.includes('Added'));
  assert.ok(rows.slice(0, 3).every((row) => [...row.querySelectorAll('button')].some((b) => b.textContent === 'Unpair')));
});