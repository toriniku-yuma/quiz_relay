// Run against a local/private maintenance Worker, never expose that Worker publicly.
import process from 'node:process';

const address = process.env.MAINTENANCE_LOCAL_URL;
if (!address) throw new Error('MAINTENANCE_LOCAL_URL_REQUIRED');
const url = new URL(address);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
  throw new Error('LOCAL_MAINTENANCE_PROXY_REQUIRED');
const action = process.argv[2] ?? 'maintenance';
if (!['maintenance', 'inventory'].includes(action))
  throw new Error('INVALID_MAINTENANCE_ACTION');
url.pathname = `/${action}`;
let more = false;
do {
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) throw new Error('MAINTENANCE_INCOMPLETE');
  const value = (await response.json()) as { ready?: boolean };
  more = action === 'inventory' && value.ready === false;
  if (more) console.log('Inventory page completed; continuing.');
} while (more);
console.log('Maintenance batch completed.');
