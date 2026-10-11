import { expect, it } from 'vitest';
import { externalInstanceUrl } from '../src/shared/external-instance';

it('インスタンスを指定した開催先URLだけを受け付け、秘密・重複指定・ローカル宛先を拒否する', () => {
  const id = 'd7c997cf-26e3-4051-a99b-1d0401e48d4f';
  expect(
    externalInstanceUrl(`https://host.example.workers.dev/game/?instance=${id}`),
  ).toEqual({ peerOrigin: 'https://host.example.workers.dev', instanceId: id });
  for (const url of [
    `http://host.example.workers.dev/game/?instance=${id}`,
    `https://127.0.0.1/game/?instance=${id}`,
    `https://secret@host.example.workers.dev/game/?instance=${id}`,
    `https://host.example.workers.dev/game/?instance=${id}&token=secret`,
    `https://host.example.workers.dev/game/?instance=${id}&instance=${id}`,
    `https://host.example.workers.dev/api/?instance=${id}`,
  ])
    expect(() => externalInstanceUrl(url)).toThrow();
});
