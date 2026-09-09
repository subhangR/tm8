#!/usr/local/bin/node
// Controlled provider for disposable browser/Docker acceptance only. Never
// installed in the real workspace image and never contacts a model provider.
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
if (process.argv.includes('status')) {
  if (process.argv.includes('auth')) console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' }));
  else console.error('Logged in using ChatGPT');
  process.exit(0);
}
const args = process.argv.slice(2), prompt = args.at(-1);
if (!prompt?.includes('Assignment:')) throw new Error('The task prompt was not supplied');
const model = args[args.indexOf('--model') + 1];
const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
await fs.writeFile('tm8-task-result.txt', JSON.stringify({ cwd: process.cwd(), model, uid: process.getuid(), childPid: child.pid, prompt }));
console.log(`TM8_TASK_EXECUTED model=${model} uid=${process.getuid()} cwd=${process.cwd()}`);
process.stdin.on('data', data => {
  if (data.toString().includes('PING')) console.log('TM8_TASK_PONG');
  if (data.toString().includes('EXIT')) { child.kill(); process.exit(0); }
});
