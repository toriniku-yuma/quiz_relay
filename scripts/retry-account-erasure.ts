import { authDeletion, retryAuthentication } from '../src/erasure/jobs.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';

// Dedicated erasure-role credentials only; never fall back to a normal app or migration URL.
const {
  ERASURE_DATABASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SECRET_KEY,
  DATABASE_CA_CERT,
} = process.env;
const key = SUPABASE_SECRET_KEY ?? SUPABASE_SERVICE_ROLE_KEY;
if (!ERASURE_DATABASE_URL || !SUPABASE_URL || !key)
  throw new Error('ERASURE_CONFIGURATION_REQUIRED');
const { db, close } = connectDatabase(ERASURE_DATABASE_URL, DATABASE_CA_CERT, false);
try {
  await retryAuthentication(db, authDeletion(SUPABASE_URL, key));
} finally {
  await close();
}
