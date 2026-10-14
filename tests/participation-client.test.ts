import { expect, it } from 'vitest';
import { participationTarget } from '../src/shared/participation';

it('外部参加URLは承認対象のHTTPS originと一意のUUIDだけを受け付ける', () => {
  const url = new URL('https://host.quiz-relay.workers.dev/participate/');
  url.search = new URLSearchParams({
    home: 'https://source.quiz-relay.workers.dev',
    source: crypto.randomUUID(),
    instance: crypto.randomUUID(),
    mode: 'room',
  }).toString();
  expect(participationTarget(url)?.mode).toBe('room');
  for (const home of [
    'http://source.quiz-relay.workers.dev',
    'https://source.quiz-relay.workers.dev:444',
    'https://source.quiz-relay.workers.dev/path',
    'https://source.quiz-relay.workers.dev.attacker.example',
    'https://user@source.quiz-relay.workers.dev',
  ]) {
    const modified = new URL(url);
    modified.searchParams.set('home', home);
    expect(participationTarget(modified)).toBeNull();
  }
  url.searchParams.append('mode', 'ranked');
  expect(participationTarget(url)).toBeNull();
});
it('本人確認URLはログインか参加の流れを必ず指定する', () => {
  const url = new URL('https://source.quiz-relay.workers.dev/authorize/');
  url.search = new URLSearchParams({
    host: 'https://host.quiz-relay.workers.dev',
    source: crypto.randomUUID(),
    instance: crypto.randomUUID(),
    mode: 'ranked',
    state: crypto.randomUUID(),
    operation: crypto.randomUUID(),
    flow: 'participation',
  }).toString();
  expect(participationTarget(url, true)?.mode).toBe('ranked');
  url.searchParams.set('flow', 'popup');
  expect(participationTarget(url, true)).toBeNull();
  url.searchParams.delete('flow');
  expect(participationTarget(url, true)).toBeNull();
});
