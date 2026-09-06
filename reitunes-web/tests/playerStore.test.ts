import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { usePlayerStore } from '../src/stores/playerStore.ts';
import type { PlaybackTarget } from '../src/types/index.ts';

const state = usePlayerStore.getState;
const track = (id: string): PlaybackTarget => ({ libraryItemId: id, startPosition: 0 });
const bookmark = (id: string, seconds: number): PlaybackTarget => ({ libraryItemId: id, bookmarkId: `b${seconds}`, startPosition: seconds });
const current = () => state().currentEntry?.libraryItemId;
beforeEach(() => usePlayerStore.setState(usePlayerStore.getInitialState(), true));

test('a bookmark jump preserves the track context and manual queue without sequencing bookmarks', () => {
  state().playFrom([track('set'), track('following-track')], 0, 'Library');
  state().addToQueue(track('queued-track'));
  const context = state().contextOrder;
  state().play(bookmark('set', 45));
  assert.equal(state().contextOrder, context);
  assert.equal(state().currentEntry?.startPosition, 45);
  state().next();
  assert.equal(current(), 'queued-track');
  state().next();
  assert.equal(current(), 'following-track');
  assert.equal(state().currentEntry?.startPosition, 0);
});

test('a standalone random bookmark does not create a bookmark playlist and can be replayed', () => {
  state().play(bookmark('set', 45));
  assert.deepEqual(state().contextOrder, []);
  const request = state().playRequest;
  state().next();
  assert.equal(state().playRequest, request);
  state().play(bookmark('set', 45));
  assert.equal(state().playRequest, request + 1);
});

test('bookmark playback establishes a context and Next preserves the next bookmark position', () => {
  state().playFrom([bookmark('mix', 20), bookmark('mix', 45), bookmark('other', 80)], 0, 'Library');
  state().next();
  assert.equal(current(), 'mix');
  assert.equal(state().currentEntry?.startPosition, 45);
  state().next();
  assert.equal(current(), 'other');
  assert.equal(state().currentEntry?.startPosition, 80);
});

test('choosing another context preserves manual additions and resumes the new context afterwards', () => {
  state().playFrom([track('old')], 0, 'Library');
  state().addToQueue(bookmark('queued', 123));
  state().playFrom([track('new'), track('following')], 0, 'New playlist');
  state().next();
  assert.equal(current(), 'queued');
  assert.equal(state().currentEntry?.startPosition, 123);
  state().next();
  assert.equal(current(), 'following');
});

test('Previous and Next retrace actual history, including manual entries and bookmark offsets', () => {
  state().playFrom([track('a'), track('d'), track('e')], 0, 'Library');
  state().addToQueue(bookmark('b', 90));
  state().addToQueue(track('c'));
  state().next(); state().next(); state().next();
  for (const expected of ['c', 'b', 'a']) { state().previous(); assert.equal(current(), expected); }
  for (const expected of ['b', 'c', 'd', 'e']) { state().next(); assert.equal(current(), expected); }
  assert.deepEqual(state().manualQueue, []);
});

test('repeat one repeats the actual manual bookmark, while an explicit Next skips it', () => {
  state().playFrom([track('context'), track('following')], 0, 'Library');
  state().addToQueue(bookmark('manual', 34));
  state().next();
  state().cycleRepeatMode(); state().cycleRepeatMode();
  const request = state().playRequest;
  state().next('ended');
  assert.equal(current(), 'manual');
  assert.equal(state().currentEntry?.startPosition, 34);
  assert.equal(state().playRequest, request + 1);
  state().next();
  assert.equal(current(), 'following');
});

test('shuffle plays every entry once, exposes its order, and stops with repeat off', () => {
  state().playFrom(Array.from({ length: 25 }, (_, i) => track(String(i))), 7, 'Library', true);
  const order = state().contextOrder.map(entry => entry.libraryItemId);
  const played = [current()];
  for (let i = 1; i < 25; i++) { state().next('ended'); played.push(current()); }
  assert.deepEqual(played, order);
  assert.equal(new Set(played).size, 25);
  const request = state().playRequest;
  state().next('ended');
  assert.equal(state().playRequest, request);
});

test('repeat all starts a new shuffled cycle without repeating the boundary entry', () => {
  state().playFrom([track('a'), track('b')], 0, 'Library', true);
  state().cycleRepeatMode();
  state().next();
  const last = current();
  state().next('ended');
  assert.notEqual(current(), last);
  assert.equal(state().contextIndex, 0);
});

test('toggling shuffle does not reintroduce consumed entries', () => {
  state().playFrom([track('a'), track('b'), track('c'), track('d')], 0, 'Library');
  state().next();
  state().toggleShuffle();
  state().toggleShuffle();
  assert.deepEqual(state().contextOrder.slice(state().contextIndex + 1).map(entry => entry.libraryItemId), ['c', 'd']);
});

test('queue occurrences can be reordered and removed independently even for the same track', () => {
  state().addToQueue(bookmark('mix', 20)); state().addToQueue(bookmark('mix', 45));
  const [first, second] = state().manualQueue;
  assert.notEqual(first.id, second.id);
  state().moveQueueEntry(second.id, first.id);
  assert.deepEqual(state().manualQueue.map(entry => entry.startPosition), [45, 20]);
  state().removeFromQueue(first.id);
  state().next();
  assert.equal(state().currentEntry?.startPosition, 45);
});

test('Play next precedes append-only queue entries', () => {
  state().addToQueue(track('later'));
  state().addNext(track('first'));
  state().next(); assert.equal(current(), 'first');
  state().next(); assert.equal(current(), 'later');
});

test('Play next after Previous takes priority without losing the interrupted entry', () => {
  state().playFrom([track('a'), track('following')], 0, 'Library');
  state().addToQueue(bookmark('interrupted', 90));
  state().addToQueue(track('later'));
  state().next();
  state().previous();
  state().addNext(track('requested'));
  for (const expected of ['requested', 'interrupted', 'later', 'following']) {
    state().next();
    assert.equal(current(), expected);
  }
});

test('replaying a selection requests playback again, including at zero', () => {
  state().playFrom([bookmark('mix', 0)], 0, 'Library');
  const request = state().playRequest;
  state().playFrom([bookmark('mix', 0)], 0, 'Library');
  assert.equal(state().playRequest, request + 1);
  assert.equal(state().currentEntry?.startPosition, 0);
});

test('invalid or empty contexts do not disturb current playback or the queue', () => {
  state().playFrom([track('a')], 0, 'Library');
  const before = state();
  state().playFrom([], 0, 'Empty');
  state().playFrom([track('b')], 3, 'Invalid');
  assert.equal(state(), before);
});

test('Previous without history restarts the current bookmark at its saved position', () => {
  state().playFrom([bookmark('mix', 45)], 0, 'Library');
  const request = state().playRequest;
  state().previous();
  assert.equal(state().currentEntry?.startPosition, 45);
  assert.equal(state().playRequest, request + 1);
});
