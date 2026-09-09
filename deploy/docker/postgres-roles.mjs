import { execFileSync } from 'node:child_process';
const roles = [
  ['tm8_runtime', 'tm8_app', 'TM8_RUNTIME_DB_PASSWORD'],
  ['tm8_delivery_runtime', 'tm8_delivery_worker', 'TM8_DELIVERY_DB_PASSWORD'],
  ['tm8_node_runtime', 'tm8_node_enrollment', 'TM8_ENROLLMENT_DB_PASSWORD'],
];
let sql = 'begin;\n';
for (const [login, role, key] of roles) {
  const password = process.env[key];
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password ?? '')) throw new Error(`Run deploy/docker/configure.mjs to configure ${key}`);
  // Only generated base64url secrets enter these SQL literals. No shell runs.
  sql += `do $$ begin if not exists(select 1 from pg_roles where rolname='${login}') then create role ${login} login; end if; end $$;\n`;
  sql += `alter role ${login} nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password '${password}';\n`;
  sql += `grant ${role} to ${login};\n`;
}
sql += 'commit;\n';
try { execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-U', 'tm8', '-h', '127.0.0.1', '-p', '5442', '-d', 'tm8_dev'], { input: sql, stdio: ['pipe', 'ignore', 'pipe'] }); }
catch { throw new Error('Could not configure restricted runtime database roles'); }
