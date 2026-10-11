import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { RemotePcSwitcher } from './RemotePcSwitcher.tsx';

function installBridge(window, hosts, calls) {
  window.mixdogRemoteWindow = { hostId: 'a', hostName: 'Home PC' };
  window.mixdogRemoteWindowSwitcher = {
    listHosts: () => Promise.resolve(hosts),
    openHost: (id) => {
      calls.push(['open', id]);
      return Promise.resolve(true);
    },
    manageConnections: () => {
      calls.push(['manage']);
      return Promise.resolve(true);
    },
  };
}

test('with one PC the switcher shows the name, the Remote badge and the settings note — no menu', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  installBridge(window, [{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }], []);
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  assert.equal(document.querySelector('.remote-pc-name').textContent, 'Home PC');
  assert.equal(document.querySelector('button.remote-pc-button'), null);
  assert.ok(document.querySelector('.remote-pc-badge'));
  assert.match(document.querySelector('.remote-pc-note').textContent, /connected PC/);
});

test('with several PCs the menu lists them with state, switches, and offers code connect + manage', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  installBridge(
    window,
    [
      { id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true },
      { id: 'b', name: 'Studio PC', online: false, lastConnectedAt: 2, current: false },
    ],
    calls
  );
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await act(async () => document.querySelector('button.remote-pc-button').click());
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 4);
  assert.match(items[0].textContent, /Home PC.*Online/);
  assert.match(items[1].textContent, /Studio PC.*Offline/);
  assert.equal(items[0].disabled, true);
  assert.match(items[2].textContent, /Connect another PC \(code\)/);
  assert.match(items[3].textContent, /Manage connections/);
  await act(async () => items[1].click());
  assert.deepEqual(calls, [['open', 'b']]);
  await act(async () => document.querySelector('button.remote-pc-button').click());
  await act(async () => [...document.querySelectorAll('[role="menuitem"]')][2].click());
  assert.deepEqual(calls.at(-1), ['manage']);
});
