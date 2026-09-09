import { readFile } from 'node:fs/promises';
if (process.argv[2] === 'get') {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) process.exit(1); }
  const fields = Object.fromEntries(input.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  if (fields.protocol === 'https' && fields.host === 'github.com') {
    try {
      const token = (await readFile('/home/user/.config/tm8/github-token', 'utf8')).trim();
      if (/^[A-Za-z0-9_]{20,256}$/.test(token)) process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
    } catch {}
  }
}
