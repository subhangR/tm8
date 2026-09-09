import pg from 'pg';
import { Directory } from './directory.mjs';
import { SupabaseAuth, origin } from './auth.mjs';
import { createControlServer } from './server.mjs';

if (process.env.TM8_DISTRIBUTED_SYSTEM_FLAG !== 'true' || process.env.TM8_SERVICE_ROLE !== 'control') {
  throw new Error('Control service requires TM8_DISTRIBUTED_SYSTEM_FLAG=true and TM8_SERVICE_ROLE=control');
}
for (const key of ['TM8_CONTROL_DATABASE_URL', 'TM8_SUPABASE_URL', 'TM8_SUPABASE_PUBLISHABLE_KEY', 'TM8_CONTROL_ORIGIN']) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}
const publicOrigin = origin(process.env.TM8_CONTROL_ORIGIN, process.env.TM8_ENV !== 'prod');
const pool = new pg.Pool({ connectionString: process.env.TM8_CONTROL_DATABASE_URL, max: 20 });
const directory = new Directory(pool);
const auth = new SupabaseAuth({ url: process.env.TM8_SUPABASE_URL, key: process.env.TM8_SUPABASE_PUBLISHABLE_KEY, publicOrigin, pool });
const server = createControlServer({ directory, auth, publicOrigin });
await pool.query('select 1 from tm8_directory.accounts limit 1');
server.listen(Number(process.env.TM8_CONTROL_PORT ?? 4620), process.env.TM8_CONTROL_BIND ?? '127.0.0.1', () => {
  process.stdout.write(`[control] Listening at ${publicOrigin}\n`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => { void pool.end(); });
  server.closeIdleConnections();
});
