import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playAudio } from '../src/utils/audioPlayback.ts';

class FakeAudio extends EventTarget {
  src = '/mix.mp3';
  readyState = 4;
  duration = 3600;
  currentTime = 200;
  paused = true;
  error: object | null = null;
  playCalls = 0;
  loadCalls = 0;
  playResult: Promise<void> = Promise.resolve();
  getAttribute() { return this.src; }
  play() { this.playCalls++; this.paused = false; return this.playResult; }
  pause() { this.paused = true; }
  load() { this.loadCalls++; this.error = null; this.readyState = 0; }
  element() { return this as unknown as HTMLAudioElement; }
}

test('selecting a paused bookmark in the same file seeks and resumes', () => {
  const audio = new FakeAudio();
  playAudio(audio.element(), '/mix.mp3', 45, assert.fail);
  assert.equal(audio.currentTime, 45);
  assert.equal(audio.paused, false);
  assert.equal(audio.playCalls, 1);
});

test('zero is a real seek and repeated requests replay the same entry', () => {
  const audio = new FakeAudio();
  const cancel = playAudio(audio.element(), '/mix.mp3', 0, assert.fail);
  assert.equal(audio.currentTime, 0);
  cancel();
  audio.currentTime = 100;
  playAudio(audio.element(), '/mix.mp3', 0, assert.fail);
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.playCalls, 2);
});

test('waits for metadata before seeking a newly loaded file', () => {
  const audio = new FakeAudio(); audio.readyState = 0;
  playAudio(audio.element(), '/new.mp3', 600, assert.fail);
  assert.equal(audio.src, '/new.mp3');
  assert.equal(audio.currentTime, 200);
  audio.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(audio.currentTime, 600);
});

test('rapid selection cancels the old seek and ignores its rejected play promise', async () => {
  const audio = new FakeAudio(); audio.readyState = 0;
  let reject: (error: Error) => void = () => {};
  audio.playResult = new Promise((_, fail) => { reject = fail; });
  const errors: string[] = [];
  const cancel = playAudio(audio.element(), '/mix.mp3', 500, message => errors.push(message));
  cancel();
  audio.playResult = Promise.resolve();
  playAudio(audio.element(), '/mix.mp3', 10, message => errors.push(message));
  reject(new Error('Old request failed'));
  audio.dispatchEvent(new Event('loadedmetadata'));
  await Promise.resolve();
  assert.equal(audio.currentTime, 10);
  assert.deepEqual(errors, []);
});

test('a failed source is reloaded on retry', () => {
  const audio = new FakeAudio(); audio.error = {};
  playAudio(audio.element(), '/mix.mp3', 20, assert.fail);
  assert.equal(audio.loadCalls, 1);
  audio.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(audio.currentTime, 20);
});

test('play rejection produces a useful error', async () => {
  const audio = new FakeAudio(); audio.playResult = Promise.reject(new Error('Denied'));
  const errors: string[] = [];
  playAudio(audio.element(), '/mix.mp3', 20, message => errors.push(message));
  await Promise.resolve();
  assert.match(errors[0], /Press Play/);
});

test('out-of-range bookmarks stop rather than entering a repeat loop', () => {
  const audio = new FakeAudio();
  const errors: string[] = [];
  playAudio(audio.element(), '/mix.mp3', 4000, message => errors.push(message));
  assert.equal(audio.paused, true);
  assert.equal(audio.playCalls, 0);
  assert.match(errors[0], /beyond the end/);
});
