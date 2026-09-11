import assert from 'node:assert/strict';
import { API_PATHS } from '../src/shared/api-paths.ts';

const target = process.env.PROBE_ORIGIN;
assert.equal(target, 'https://quiz-relay-probe.quiz-relay.workers.dev');

const url = `${target}${API_PATHS.egress}`;
const headers = { Authorization: `Bearer ${process.env.PROBE_TOKEN}` };

assert.equal((await fetch(url, { method: 'POST' })).status, 401);
assert.equal(
  (
    await fetch(url, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://unapproved.example' },
    })
  ).status,
  403,
);

const response = await fetch(url, { method: 'POST', headers });
const result = await response.json();

assert.equal(response.status, 200, JSON.stringify(result));
assert.deepEqual(result, {
  reached: true,
  profile: 'approved-workers-dev',
  inboxImplemented: false,
});

console.log(
  JSON.stringify({
    fixedPublicEgress: 'PASS',
    unauthorized: 'PASS',
    foreignOrigin: 'PASS',
    dnsRebinding: 'NOT_TESTED',
    ...result,
  }),
);
