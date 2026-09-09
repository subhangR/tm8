// Explicit operator mapping for existing accounts without a live session.
// No email matching, new account, password grant or authenticated session.
import pg from 'pg';
const [mode, accountId, subject] = process.argv.slice(2);
if (!['local', 'control'].includes(mode) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(accountId ?? '') || !/^[0-9]{1,20}$/.test(subject ?? '')) {
  throw new Error('Usage: link-github.mjs local|control ACCOUNT_UUID GITHUB_NUMERIC_ID');
}
const url = process.env.TM8_MIGRATION_DATABASE_URL;
if (!url) throw new Error('TM8_MIGRATION_DATABASE_URL must be a privileged operator connection');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  const table = mode === 'local' ? 'public.accounts' : 'tm8_directory.accounts';
  const account = (await client.query(`select * from ${table} where id=$1 for update`, [accountId])).rows[0];
  if (!account) throw new Error('Existing account not found');
  if (mode === 'local') {
    const linked = (await client.query('select subject from public.local_github_accounts where account_id=$1', [accountId])).rows[0];
    if (linked && linked.subject !== subject) throw new Error('Account already linked to another GitHub identity');
    if (!linked) await client.query('insert into public.local_github_accounts(subject,account_id) values($1,$2)', [subject, accountId]);
  } else {
    if (account.github_subject && account.github_subject !== subject) throw new Error('Account already linked to another GitHub identity');
    await client.query('update tm8_directory.accounts set github_subject=$2 where id=$1', [accountId, subject]);
  }
  await client.query('commit');
  console.log('GitHub identity linked to the existing account. Sign in through GitHub to continue.');
} catch (error) { await client.query('rollback'); throw error; }
finally { await client.end(); }
