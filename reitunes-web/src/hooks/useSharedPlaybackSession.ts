import { useEffect } from 'react';
import type { LibraryItem } from '../types';
import { useQueueStore, queueOccurrenceIds, reconcileShuffleOrder } from './useQueue';
import { recordPlaybackEvent } from '../utils/playbackDiagnostics';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { getPlaybackClientId, ownsBrowserPlayback, useSharedSessionStore,
  type SharedPlaybackSnapshot, type SharedPlaybackState } from '../stores/sharedSessionStore';

export const PLAYBACK_SESSION_EVENT = 'reitunes:playback-session';
export const REALTIME_RECONNECTED_EVENT = 'reitunes:reconnected';

let library: LibraryItem[] = [];
let accepted: SharedPlaybackSnapshot = { revision: 0, state: null };
let received: SharedPlaybackSnapshot | null = null;
let applying = false;
let dirty = false;
let playbackChanged = false;
let localVersion = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<boolean> | null = null;
let refreshing: Promise<void> | null = null;
let generation = 0;
let lastProgressSave = 0;

export function getSharedPlaybackSnapshot() { return accepted; }

function takeReceivedSnapshot(): SharedPlaybackSnapshot | null {
  const snapshot = received;
  received = null;
  return snapshot;
}

export function sharedUpcomingItemIds(state: SharedPlaybackState): string[] {
  const queue = state.queue;
  const current = queue.contextItemIds[queue.contextIndex];
  const context = queue.shuffleEnabled
    ? [...new Set([...queue.shuffledIds, ...queue.contextItemIds])].filter(id => queue.contextItemIds.includes(id))
    : queue.contextItemIds;
  const index = context.indexOf(current);
  const remaining = context.slice(index + 1);
  if (queue.repeatMode === 'all' && index >= 0) remaining.push(...context.slice(0, index));
  return [...queue.manualQueue.map(entry => entry.itemId), ...remaining];
}

function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

function applyQueueSyncStatus(snapshot: SharedPlaybackSnapshot) {
  if (snapshot.revision < accepted.revision) return;
  useSharedSessionStore.setState({ queueSyncPending: snapshot.queueSyncPending ?? false,
    queueSyncError: snapshot.queueSyncError ?? null });
  if (snapshot.revision === accepted.revision) accepted = { ...accepted,
    queueSyncPending: snapshot.queueSyncPending ?? false, queueSyncError: snapshot.queueSyncError ?? null };
}

export async function retrySharedQueueSync(): Promise<void> {
  try {
    const response = await fetch('/api/playback-session/queue-sync', {
      method: 'POST', credentials: 'include', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Could not retry the Sonos queue update.');
    useSharedSessionStore.setState({ queueSyncPending: true, queueSyncError: null });
    await refreshSharedSession();
  } catch (error) {
    useSharedSessionStore.setState({ queueSyncError: error instanceof Error ? error.message : 'Could not update the Sonos queue.' });
  }
}

function localQueue(): SharedPlaybackState['queue'] {
  const queue = useQueueStore.getState();
  const ids = queueOccurrenceIds(queue);
  if (!same(ids, queue.manualQueueIds)) {
    const wasApplying = applying;
    applying = true;
    useQueueStore.setState({ manualQueueIds: ids });
    applying = wasApplying;
  }
  return {
    manualQueue: queue.manualQueue.map((item, index) => ({ id: ids[index], itemId: item.id })),
    contextItemIds: queue.contextItems.map(item => item.id),
    contextIndex: queue.contextIndex, contextName: queue.contextName,
    ...(queue.contextId !== null ? { contextId: queue.contextId } : {}),
    shuffleEnabled: queue.shuffleEnabled, shuffledIds: queue.shuffledIds, repeatMode: queue.repeatMode,
  };
}

function localPlayback(): Omit<SharedPlaybackState, 'queue'> {
  const player = usePlayerStore.getState();
  const target = usePlaybackTargetStore.getState().target;
  return { target: target.kind === 'browser' ? { ...target, ownerId: target.ownerId ?? null } : target,
    currentItemId: player.currentItemId, position: player.resumePosition, playbackRange: player.playbackRange };
}

function capture(): SharedPlaybackState {
  // Sonos owns its observed playhead. A queue edit must never write a browser's
  // older position/current song over a newer speaker observation.
  const playback = playbackChanged || !accepted.state ? localPlayback() : accepted.state;
  return { target: playback.target, currentItemId: playback.currentItemId, position: playback.position,
    playbackRange: playback.playbackRange, queue: localQueue() };
}

export function applySharedPlaybackSnapshot(snapshot: SharedPlaybackSnapshot) {
  if (snapshot.revision < accepted.revision || !snapshot.state) return;
  applyQueueSyncStatus(snapshot);
  accepted = snapshot;
  const state = snapshot.state;
  const byId = new Map(library.map(item => [item.id, item]));
  const queue = state.queue;
  const currentContextId = queue.contextItemIds[queue.contextIndex];
  const contextItems = queue.contextItemIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const entries = queue.manualQueue.filter(entry => byId.has(entry.itemId));
  const previous = useQueueStore.getState();
  const incomingContext = {
    contextItems, contextIndex: currentContextId ? contextItems.findIndex(item => item.id === currentContextId) : -1,
    contextName: queue.contextName, contextId: queue.contextId ?? null,
    shuffleEnabled: queue.shuffleEnabled, shuffledIds: reconcileShuffleOrder(queue.shuffledIds, contextItems),
  };
  // An acknowledgement or a manual-only edit from another screen is safe for
  // inverse Undo. A changed automatic plan must not be overwritten by old Undo.
  const sameContext = previous.contextId === incomingContext.contextId;
  const sameAutomaticPlan = sameContext && previous.contextIndex === incomingContext.contextIndex
    && previous.contextName === incomingContext.contextName && previous.shuffleEnabled === incomingContext.shuffleEnabled
    && same(previous.contextItems.map(item => item.id), contextItems.map(item => item.id))
    && same(previous.shuffledIds, incomingContext.shuffledIds);
  const undo = previous.queueUndo;
  const keepUndo = undo?.kind === 'manual'
    ? sameContext && !entries.some(entry => entry.id === undo.occurrenceId)
    : sameAutomaticPlan;
  applying = true;
  try {
    useQueueStore.setState({ manualQueue: entries.map(entry => byId.get(entry.itemId)!),
      manualQueueIds: entries.map(entry => entry.id), ...incomingContext,
      queueUndo: keepUndo ? undo : null, repeatMode: queue.repeatMode });
    const output = usePlaybackTargetStore.getState();
    if (!same(output.target, state.target)) {
      usePlaybackTargetStore.setState({ target: state.target, takeoverRequired: false,
        isSending: false, isTransportPending: false, error: null });
    }
    const player = usePlayerStore.getState();
    const item = state.currentItemId ? byId.get(state.currentItemId) ?? null : null;
    const owner = state.target.kind === 'browser' && state.target.ownerId === getPlaybackClientId();
    const sameOwnedItem = owner && player.currentItem?.id === state.currentItemId;
    usePlayerStore.setState({ currentItem: item, currentItemId: item?.id ?? null,
      playbackRange: same(player.playbackRange, state.playbackRange) ? player.playbackRange : state.playbackRange,
      resumePosition: sameOwnedItem ? player.resumePosition : state.position,
      isPlaying: sameOwnedItem ? player.isPlaying : false,
      pendingSeek: sameOwnedItem ? player.pendingSeek : owner && item ? state.position : null });
    useSharedSessionStore.setState({ revision: snapshot.revision });
  } finally { applying = false; }
}

async function fetchSnapshot(): Promise<SharedPlaybackSnapshot> {
  const response = await fetch('/api/playback-session', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Could not load the shared playback session.');
  const snapshot = await response.json() as SharedPlaybackSnapshot;
  if (!Number.isInteger(snapshot.revision) || !('state' in snapshot)) throw new Error('The playback session response was invalid.');
  return snapshot;
}

function setError(message: string) {
  useSharedSessionStore.setState({ error: message });
}

function markDirty(includePlayback = false, delay = 0) {
  const session = useSharedSessionStore.getState();
  if (applying || !session.enabled || !session.ready) return;
  const unavailable = session.refreshing || !session.connected;
  if (unavailable && !ownsBrowserPlayback(usePlaybackTargetStore.getState().target)) return;
  dirty = true;
  playbackChanged ||= includePlayback;
  localVersion += 1;
  if (timer) clearTimeout(timer);
  // Already-owned audio can advance without a control-server connection. Keep
  // that intent for the next verified refresh; never retry an old queue blind.
  if (unavailable) return;
  timer = setTimeout(() => { timer = undefined; void flushSharedSession(); }, delay);
}

/** Call after an explicit song/output selection; speaker observations don't call this. */
export function stageSharedPlayback() { markDirty(true); }

export async function flushSharedSession(): Promise<boolean> {
  if (!useSharedSessionStore.getState().enabled) return true;
  const session = useSharedSessionStore.getState();
  if (!session.ready || !session.connected || session.refreshing) return false;
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (writing) {
    const success = await writing;
    return success && (!dirty || await flushSharedSession());
  }
  if (!dirty) return true;
  const version = localVersion;
  const next = capture();
  const changedQueue = !same(next.queue, accepted.state?.queue);
  const expectedRevision = accepted.revision;
  const operationId = crypto.randomUUID();
  dirty = false;
  playbackChanged = false;
  const requestGeneration = generation;
  let httpStatus: number | undefined;
  writing = (async () => {
    try {
      const response = await fetch('/api/playback-session', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, expectedRevision, state: next }), signal: AbortSignal.timeout(20_000),
      });
      httpStatus = response.status;
      if (requestGeneration !== generation) return false;
      if (response.status === 409) {
        const canonical = await response.json() as SharedPlaybackSnapshot;
        dirty = false;
        playbackChanged = false;
        applySharedPlaybackSnapshot(canonical);
        setError('Playback changed on another screen. Your last change was not applied; the current session is shown. Please try again.');
        return false;
      }
      if (!response.ok) {
        // Only read the API's JSON error field, never a proxy's HTML error page.
        const body = await response.json().catch(() => null);
        const detail = typeof body?.error === 'string' ? body.error
          .replace(/\b(?:https?|blob|data|file):[^\s"'<>]+/gi, '[redacted URL]')
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) : '';
        throw new Error(`Could not save the shared playback session (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
      }
      const result = await response.json() as SharedPlaybackSnapshot;
      if (result.revision < accepted.revision) return false;
      accepted = result;
      applyQueueSyncStatus(result);
      useSharedSessionStore.setState(state => ({ revision: result.revision, error: null,
        queueSyncVersion: state.queueSyncVersion + (changedQueue ? 1 : 0) }));
      // New local actions can accumulate while this request is in flight. Keep
      // their optimistic state; the next CAS saves them against this revision.
      // An acknowledgement of exactly our state is not a remote change. Keep
      // store references stable so a later failed Sonos command can roll back
      // its own optimistic queue selection without disturbing newer edits.
      if (localVersion === version && !same(result.state, next)) applySharedPlaybackSnapshot(result);
      return true;
    } catch (error) {
      if (requestGeneration !== generation) return false;
      const contextIds = new Set(next.queue.contextItemIds);
      recordPlaybackEvent('session-save-failed', {
        operationId, expectedRevision, httpStatus, target: next.target.kind,
        errorName: error instanceof Error ? error.name : 'Error',
        errorMessage: error instanceof Error ? error.message : 'Could not save playback.',
        contextCount: next.queue.contextItemIds.length, manualQueueCount: next.queue.manualQueue.length,
        shuffleEnabled: next.queue.shuffleEnabled, shuffledCount: next.queue.shuffledIds.length,
        staleShuffleCount: next.queue.shuffledIds.filter(id => !contextIds.has(id)).length,
        duplicateShuffleCount: next.queue.shuffledIds.length - new Set(next.queue.shuffledIds).size,
      });
      // A reply can be lost after the write committed. Read back rather than
      // blindly replaying a whole old queue or assigning ownership twice.
      let canContinueOwnedAudio = ownsBrowserPlayback(usePlaybackTargetStore.getState().target);
      try {
        const canonical = await fetchSnapshot();
        const sameOwner = canonical.state?.target.kind === 'browser' && canonical.state.target.ownerId === getPlaybackClientId();
        if (!canContinueOwnedAudio || !sameOwner) {
          applySharedPlaybackSnapshot(canonical);
          canContinueOwnedAudio = false;
        } else {
          accepted = canonical;
          applyQueueSyncStatus(canonical);
          useSharedSessionStore.setState({ revision: canonical.revision });
        }
      } catch { /* Preserve an already owned audio element until ownership can be checked. */ }
      dirty = canContinueOwnedAudio;
      playbackChanged = canContinueOwnedAudio;
      useSharedSessionStore.setState({ ready: canContinueOwnedAudio, connected: false });
      setError(`${error instanceof Error ? error.message : 'Could not save playback.'} Refresh the session before trying again.`);
      return false;
    }
  })();
  const success = await writing;
  writing = null;
  if (received && received.revision > accepted.revision) {
    const remote = received;
    received = null;
    if (dirty) {
      dirty = false;
      playbackChanged = false;
      setError('Playback changed on another screen. Your pending change was not applied; please try again.');
    }
    applySharedPlaybackSnapshot(remote);
  } else {
    if (received?.revision === accepted.revision) applyQueueSyncStatus(received);
    received = null;
  }
  return success && (!dirty || await flushSharedSession());
}

export async function refreshSharedSession(): Promise<void> {
  if (refreshing) return refreshing;
  const requestGeneration = generation;
  const pendingWrite = dirty && useSharedSessionStore.getState().ready ? flushSharedSession() : writing;
  // Suspend queue edits before the request. A waking phone may have missed
  // hours of queue advancement while Safari suspended its websocket.
  useSharedSessionStore.setState({ refreshing: true });
  const refreshPromise = (async () => {
    try {
      if (pendingWrite) await pendingWrite;
      let snapshot = await fetchSnapshot();
      if (requestGeneration !== generation) return;
      if (received && received.revision > snapshot.revision) snapshot = received;
      received = null;
      if (!snapshot.state) {
        // The first upgraded browser migrates once. CAS prevents two startup
        // snapshots from replacing each other. Loading never starts playback.
        playbackChanged = true;
        const state = capture();
        playbackChanged = false;
        if (state.target.kind === 'browser') state.target = { kind: 'browser', ownerId: getPlaybackClientId() };
        const response = await fetch('/api/playback-session', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: snapshot.revision, state }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok && response.status !== 409) throw new Error('Could not initialize the shared playback session.');
        snapshot = await response.json() as SharedPlaybackSnapshot;
      }
      if (requestGeneration !== generation) return;
      const latestReceived = takeReceivedSnapshot();
      if (latestReceived && latestReceived.revision >= snapshot.revision) snapshot = latestReceived;
      const stillOwned = snapshot.state?.target.kind === 'browser' && snapshot.state.target.ownerId === getPlaybackClientId();
      const resumeIntent = dirty && stillOwned && ownsBrowserPlayback(usePlaybackTargetStore.getState().target)
        ? { player: usePlayerStore.getState(), queue: localQueue(), baseQueue: accepted.state?.queue } : null;
      dirty = false;
      playbackChanged = false;
      applySharedPlaybackSnapshot(snapshot);
      if (resumeIntent && snapshot.state) {
        // Rebase only stable queue occurrences consumed during playback, keeping
        // additions from another controller. A different owner always wins.
        const base = resumeIntent.baseQueue;
        const localIds = new Set(resumeIntent.queue.manualQueue.map(entry => entry.id));
        const baseIds = new Set(base?.manualQueue.map(entry => entry.id));
        const consumed = new Set([...baseIds].filter(id => !localIds.has(id)));
        const remoteEntries = snapshot.state.queue.manualQueue.filter(entry => !consumed.has(entry.id));
        const remoteIds = new Set(remoteEntries.map(entry => entry.id));
        const entries = [...remoteEntries, ...resumeIntent.queue.manualQueue.filter(entry => !baseIds.has(entry.id) && !remoteIds.has(entry.id))];
        const byId = new Map(library.map(item => [item.id, item]));
        const validEntries = entries.filter(entry => byId.has(entry.itemId));
        const player = resumeIntent.player;
        applying = true;
        useQueueStore.setState({ manualQueue: validEntries.map(entry => byId.get(entry.itemId)!),
          manualQueueIds: validEntries.map(entry => entry.id),
          ...(base?.contextId === snapshot.state.queue.contextId && same(base?.contextItemIds, snapshot.state.queue.contextItemIds)
            ? { contextIndex: resumeIntent.queue.contextIndex } : {}) });
        usePlayerStore.setState({ currentItem: player.currentItem, currentItemId: player.currentItemId,
          resumePosition: player.resumePosition, playbackRange: player.playbackRange,
          pendingSeek: player.pendingSeek, isPlaying: player.isPlaying });
        applying = false;
      }
      useSharedSessionStore.setState({ ready: true, connected: true, refreshing: false, error: null });
      if (resumeIntent) markDirty(true);
    } catch (error) {
      if (requestGeneration !== generation) return;
      useSharedSessionStore.setState({ ready: ownsBrowserPlayback(usePlaybackTargetStore.getState().target), connected: false, refreshing: false,
        error: `${error instanceof Error ? error.message : 'Could not load playback.'} Reconnect and refresh to control playback.` });
    }
  })();
  refreshing = refreshPromise;
  await refreshPromise;
  if (refreshing === refreshPromise) refreshing = null;
}

export function useSharedPlaybackSession(items: LibraryItem[], isLibraryLoading: boolean) {
  useEffect(() => { library = items; }, [items]);
  useEffect(() => {
    if (isLibraryLoading) return;
    generation += 1;
    useSharedSessionStore.setState({ enabled: true, ready: false, connected: false });
    let previousQueue = JSON.stringify(localQueue());
    const unsubscribeQueue = useQueueStore.subscribe(() => {
      const next = JSON.stringify(localQueue());
      if (next !== previousQueue) {
        previousQueue = next;
        markDirty();
      }
    });
    const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
      if (!ownsBrowserPlayback(usePlaybackTargetStore.getState().target)) return;
      const selectionChanged = state.currentItemId !== previous.currentItemId || !same(state.playbackRange, previous.playbackRange);
      const progressChanged = state.resumePosition !== previous.resumePosition;
      if (selectionChanged || (progressChanged && Date.now() - lastProgressSave >= 5_000)) {
        lastProgressSave = Date.now();
        markDirty(true, selectionChanged ? 0 : 100);
      }
    });
    const onSnapshot = (event: Event) => {
      const snapshot = (event as CustomEvent<SharedPlaybackSnapshot>).detail;
      applyQueueSyncStatus(snapshot);
      if (snapshot.revision <= accepted.revision) return;
      const currentTarget = usePlaybackTargetStore.getState().target;
      const nextTarget = snapshot.state?.target;
      if (ownsBrowserPlayback(currentTarget) && nextTarget &&
        (nextTarget.kind !== 'browser' || nextTarget.ownerId !== getPlaybackClientId())) {
        // Even if a progress write failed, an explicit transfer received over
        // the websocket relinquishes browser audio immediately.
        dirty = false;
        playbackChanged = false;
        applySharedPlaybackSnapshot(snapshot);
        return;
      }
      if (writing || dirty || refreshing) { received = snapshot; return; }
      applySharedPlaybackSnapshot(snapshot);
    };
    const onWake = () => {
      if (document.visibilityState !== 'hidden') void refreshSharedSession();
    };
    window.addEventListener(PLAYBACK_SESSION_EVENT, onSnapshot);
    window.addEventListener(REALTIME_RECONNECTED_EVENT, onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
    void refreshSharedSession();
    return () => {
      generation += 1;
      unsubscribeQueue(); unsubscribePlayer();
      window.removeEventListener(PLAYBACK_SESSION_EVENT, onSnapshot);
      window.removeEventListener(REALTIME_RECONNECTED_EVENT, onWake);
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onWake);
      if (timer) clearTimeout(timer);
      // A StrictMode remount starts a new request rather than inheriting the
      // previous effect's pending refresh, whose result is now obsolete.
      refreshing = null;
    };
  }, [isLibraryLoading]);
  const state = useSharedSessionStore();
  return { ready: state.ready, connected: state.connected, refreshing: state.refreshing, error: state.error, refresh: refreshSharedSession,
    queueSyncPending: state.queueSyncPending, queueSyncError: state.queueSyncError, retryQueueSync: retrySharedQueueSync };
}
