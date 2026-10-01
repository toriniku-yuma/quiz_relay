import { readFileSync, writeFileSync } from 'node:fs';
import { exportPrivacyJournal, restorePrivacyJournal } from '../src/erasure/recovery.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';

const [command, path, approval] = process.argv.slice(2);
if (
  !path ||
  !['export', 'restore'].includes(command) ||
  (command === 'restore' && approval !== '--apply')
)
  throw new Error('Usage: privacy-journal.ts export FILE | restore FILE --apply');
const address = process.env.PRIVACY_RECOVERY_DATABASE_URL;
if (!address) throw new Error('PRIVACY_RECOVERY_DATABASE_URL_REQUIRED');
const { db, close } = connectDatabase(address, process.env.DATABASE_CA_CERT);
try {
  if (command === 'export')
    writeFileSync(path, JSON.stringify(await exportPrivacyJournal(db)), {
      flag: 'wx',
      mode: 0o600,
    });
  else await restorePrivacyJournal(db, JSON.parse(readFileSync(path, 'utf8')));
  console.log(
    command === 'export'
      ? 'Privacy journal exported. Store it independently of application backups.'
      : 'Privacy receipts restored. Keep traffic stopped until room inventory and erasure jobs complete.',
  );
} finally {
  await close();
}
