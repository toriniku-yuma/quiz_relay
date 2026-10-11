import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export function connectDatabase(url: string, ca?: string, viaHyperdrive = false) {
  const address = new URL(url);
  const localPlaintext =
    ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) &&
    address.searchParams.get('sslmode') === 'disable';
  const client = postgres(url, {
    prepare: false,
    ssl:
      viaHyperdrive || localPlaintext
        ? false
        : ca
          ? { ca, rejectUnauthorized: true }
          : 'verify-full',
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
  });
  return {
    db: drizzle(client),
    close: () => client.end({ timeout: 5 }),
    tls: viaHyperdrive
      ? 'hyperdrive-managed'
      : localPlaintext
        ? 'local-plaintext'
        : 'verify-full',
  };
}
