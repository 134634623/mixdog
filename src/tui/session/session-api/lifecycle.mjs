/**
 * lifecycle.mjs — the session object's session-boundary surface: tool
 * approval resolution, the session catalog reads and the runtime passthroughs,
 * composed with the transition groups under ./lifecycle/ (resets, inheritance,
 * resume, dispose).
 */
import { createSessionResetActions } from './lifecycle/session-reset.mjs';
import { createInheritanceActions } from './lifecycle/inheritance.mjs';
import { createResumeAction } from './lifecycle/resume.mjs';
import { createDisposeAction } from './lifecycle/dispose.mjs';

export function createSessionLifecycleApi(bag, { restoreTranscriptItems, oauthFlows }) {
  const { runtime, pushNotice, removeNotice, setProgressHint, finishToolApproval } = bag;

  // Canonical close = execution fence at the local-session boundary. The fence
  // is raised synchronously BEFORE the runtime/manager close (which cancels the
  // session's shells and so triggers completion notifications), so no queue
  // drain, completion wake, pending-resume kick or new submission can start
  // work for a conversation that is being closed. A durable close that fails
  // restores admission with every accepted input intact; one that succeeds
  // leaves the session terminal and settles queued submissions explicitly.
  function closeCanonical(reason) {
    const flags = bag.flags || {};
    const previous = flags.admission || 'open';
    if (previous === 'terminal') return runtime.closeCanonicalSession?.(reason) === true;
    flags.admission = 'closing';
    let closed = false;
    try {
      closed = runtime.closeCanonicalSession?.(reason) === true;
    } catch (error) {
      flags.admission = previous;
      restoreAdmission();
      throw error;
    }
    if (!closed) {
      flags.admission = previous;
      restoreAdmission();
      return false;
    }
    flags.admission = 'terminal';
    flags.admissionGeneration = (Number(flags.admissionGeneration) || 0) + 1;
    bag.settleClosedQueue?.();
    return true;
  }

  function restoreAdmission() {
    void bag.drain?.();
    bag.flushDeferredExecutionPendingResumeKick?.();
  }

  return {
    resolveToolApproval: (id, decision = {}) => {
      const approved = decision === true || decision?.approved === true;
      return finishToolApproval(
        id,
        approved,
        decision?.reason || (approved ? 'approved by user' : 'denied by user'),
        typeof decision?.device === 'string' ? decision.device : ''
      );
    },
    pushNotice,
    removeNotice,
    setProgressHint,
    ...createSessionResetActions(bag),
    listSessions: (options) => {
      return runtime.listSessions(options);
    },
    renameSessionTitle: (id, title) => {
      return runtime.renameSessionTitle?.(id, title) ?? false;
    },
    // Desktop sidebar watcher hook: the daemon watches this directory so
    // heartbeat sidecar create/delete pushes instant working/dot updates.
    // Without it the watcher silently no-ops and the sidebar falls back to
    // the 60s safety poll (user: spinner kept spinning after the turn ended).
    sessionStoreDir: () => {
      try {
        return runtime.sessionStoreDir?.() || null;
      } catch {
        return null;
      }
    },
    ...createInheritanceActions(bag, { restoreTranscriptItems }),
    ...createResumeAction(bag, { restoreTranscriptItems }),

    deliverToolCompletion: (sessionId, text, meta = {}) =>
      runtime.deliverToolCompletion?.(sessionId, text, meta) === true,

    closeCanonicalSession: (reason = 'canonical-session-close') => closeCanonical(reason),

    bindSessionAddress: (sessionId) => runtime.bindSessionAddress?.(sessionId) === true,

    ...createDisposeAction(bag, { oauthFlows }),
  };
}
