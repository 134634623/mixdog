// The main PC's 6-digit pairing code (pairing v2). It exists only while
// Settings → Connection is open: the renderer asks for it (`ensure`) on a
// short heartbeat and releases it when the screen closes. The relay holds the
// code → device-route mapping; it is valid for five minutes and single use, so
// a code the renderer stops asking for dies on its own. A code is a secret of
// a few minutes' life and is never logged here or sent anywhere but the relay.
import { randomInt } from 'node:crypto';

export const PAIR_CODE_TTL_MS = 300_000;
const MAX_COLLISION_RETRIES = 5;

export interface PairCodeState {
  /** Six digits, no separator. */
  code: string;
  expiresAt: number;
}

export interface PairCodeManager {
  /** The live code, minting one when none is live (or `renew`). */
  ensure(renew?: boolean): PairCodeState;
  /** The screen closed: withdraw the code from the relay. */
  release(): void;
  /** The relay answered a `pair-code` frame. */
  onAck(ok: boolean): void;
  /** The relay redeemed the code for someone; the next ensure mints a new one. */
  onUsed(): void;
  /** A relay leg opened: it knows nothing of the code yet. */
  resend(): void;
}

export function createPairCodeManager(deps: {
  sendEnvelope(payload: unknown): void;
  hostName: string;
  now?: () => number;
  randomCode?: () => string;
}): PairCodeManager {
  const now = deps.now ?? Date.now;
  const randomCode = deps.randomCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
  let current: PairCodeState | null = null;
  let active = false;
  let collisions = 0;

  const live = (): PairCodeState | null => (current && current.expiresAt > now() ? current : null);
  const publish = (): void => {
    if (current) deps.sendEnvelope({ type: 'pair-code', code: current.code, name: deps.hostName });
  };
  const mint = (): PairCodeState => {
    current = { code: randomCode(), expiresAt: now() + PAIR_CODE_TTL_MS };
    publish();
    return current;
  };

  return {
    ensure(renew = false) {
      active = true;
      const existing = live();
      return existing && !renew ? existing : mint();
    },
    release() {
      active = false;
      collisions = 0;
      if (!current) return;
      current = null;
      deps.sendEnvelope({ type: 'pair-code-clear' });
    },
    onAck(ok) {
      if (ok) {
        collisions = 0;
        return;
      }
      // Another desktop holds this exact code right now: draw again.
      current = null;
      if (active && collisions < MAX_COLLISION_RETRIES) {
        collisions += 1;
        mint();
      }
    },
    onUsed() {
      current = null;
    },
    resend() {
      if (live()) publish();
    },
  };
}
