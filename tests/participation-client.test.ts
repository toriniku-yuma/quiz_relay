import { expect, it } from 'vitest';
import {
  participationTarget,
  validParticipationMessage,
} from '../src/shared/participation';

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
it('本人確認メッセージは現在のstateと指定した3項目だけを受け付ける', () => {
  const state = crypto.randomUUID(),
    message = { type: 'quiz-relay-participation', state, ticket: 'signed-ticket' };
  expect(validParticipationMessage(message, state)).toBe(true);
  expect(validParticipationMessage(message, crypto.randomUUID())).toBe(false);
  expect(
    validParticipationMessage({ ...message, ticket: 'x'.repeat(16385) }, state),
  ).toBe(false);
  expect(
    validParticipationMessage(
      { ...message, redirect: 'https://attacker.example' },
      state,
    ),
  ).toBe(false);
});
