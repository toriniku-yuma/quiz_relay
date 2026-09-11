// Generates a public verification fixture, never writes the private key.
import { mkdir, writeFile } from 'node:fs/promises';
import { exportJWK, generateKeyPair } from 'jose';
import {
  bodyHash,
  INBOX_PATH,
  signDelivery,
} from '../src/worker/federation/signatures.ts';

const keys = await generateKeyPair('EdDSA', { extractable: true });
const body = { source: 'Node.js', value: 'カタカナ', numbers: [0, 1.5, 1e20] };
const delivery = {
  protocolVersion: 1,
  messageType: 'probe',
  issuer: 'https://node.example',
  audience: 'https://workers.example',
  issuedAt: 1000,
  expiresAt: 1060,
  nonce: crypto.randomUUID(),
  method: 'POST',
  path: INBOX_PATH,
  bodyHash: await bodyHash(body),
  body,
};

await mkdir('tests/fixtures', { recursive: true });
await writeFile(
  'tests/fixtures/node-signature.json',
  `${JSON.stringify(
    {
      nodeVersion: process.version,
      publicKey: await exportJWK(keys.publicKey),
      message: await signDelivery(delivery, keys.privateKey, 'node-fixture'),
    },
    null,
    2,
  )}\n`,
);

console.log('Public Node signature fixture generated. Private key discarded.');
