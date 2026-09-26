/**
 * The boot banner per node mode (doc 15 §2, "one banner per mode"). The claim
 * state and token mint are faked at the pg-auth seam; the lines are the real
 * `announceNodeClaim` output.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const node = vi.hoisted(() => ({ claimed: false, minted: 0 }));

vi.mock('../../src/identity/pg-auth.js', () => ({
  nodeIsClaimed: async () => node.claimed,
  claimTokenIsLive: async () => false,
  issueNodeClaimToken: async () => `tok_${++node.minted}`,
}));

import { announceNodeClaim, type ClaimAnnouncementOptions } from '../../src/identity/node-claim-boot.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-banner-'));
  Object.assign(node, { claimed: false, minted: 0 });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function banner(opts: Partial<ClaimAnnouncementOptions>): Promise<string> {
  const lines: string[] = [];
  await announceNodeClaim({
    db: {} as ClaimAnnouncementOptions['db'],
    dataDir,
    url: 'https://tm8.example.org',
    localUrl: 'http://127.0.0.1:17777',
    nodeMode: 'personal',
    nodeModeSource: 'default',
    nodeModeSet: false,
    ensureOwner: async () => undefined,
    log: (line) => lines.push(line),
    ...opts,
  });
  return lines.join('\n');
}

const tokenFile = () => join(dataDir, 'setup-token');

describe('boot banner', () => {
  it('first run (no mode, unclaimed): claim first, then the chooser — and prints the claim box', async () => {
    const out = await banner({});
    expect(out).toContain('node: personal (default, no mode chosen yet) · first run · unclaimed');
    expect(out).toContain('First run. Claim this node below first; after the claim, open http://127.0.0.1:17777 and choose Personal, Peer or Server.');
    expect(out).toContain('THIS NODE IS UNCLAIMED');
    // The claim link travels (public origin); the chooser does not.
    expect(out).toContain('https://tm8.example.org/#claim=tok_1');
  });

  it('first run with the launch cookie: claim once with the setup token, then tm8 open — never the bare origin', async () => {
    const out = await banner({ launchCookie: true });
    expect(out).toContain('First run. Claim this node below first; after the claim, run tm8 open and choose Personal, Peer or Server.');
    expect(out).toContain('│  Claim once with the setup token, then run: tm8 open');
    // The only URL printed is the claim link: the bare origin answers anonymous.
    expect(out.match(/https?:\/\/\S+/g)).toEqual(['https://tm8.example.org/#claim=tok_1']);
  });

  it('returns the claim URL it advertised (the desktop shell has no terminal), and nothing on a claimed node', async () => {
    const lines: string[] = [];
    const base = {
      db: {} as ClaimAnnouncementOptions['db'], dataDir, url: 'https://tm8.example.org', nodeMode: 'personal' as const,
      nodeModeSource: 'default' as const, nodeModeSet: false, ensureOwner: async () => undefined, log: (l: string) => lines.push(l),
    };
    expect(await announceNodeClaim(base)).toBe('https://tm8.example.org/#claim=tok_1');
    node.claimed = true;
    expect(await announceNodeClaim(base)).toBeUndefined();
  });

  it('an upgraded node (no mode, claimed) says it runs as personal, and nothing else', async () => {
    node.claimed = true;
    const out = await banner({});
    expect(out).toBe('  node: personal (default, no mode chosen yet) · runs as personal: the owner on this machine, nobody else · claimed');
  });

  it('personal, recorded, unclaimed: the claim box too — decision 34, every mode claims once', async () => {
    const out = await banner({ nodeModeSource: 'file', nodeModeSet: true });
    expect(out).toContain(`node: personal (from ${join(dataDir, 'mode')}) · the owner on this machine, nobody else · unclaimed`);
    expect(out).toContain('THIS NODE IS UNCLAIMED');
    expect(out).toContain('https://tm8.example.org/#claim=tok_1');
    expect(out).not.toContain('First run');
    expect(await readFile(tokenFile(), 'utf8')).toContain('tok_1');
  });

  it('personal, chosen, claimed: offers the switch for letting others in', async () => {
    node.claimed = true;
    const out = await banner({ nodeModeSource: 'file', nodeModeSet: true });
    expect(out).toContain('  open http://127.0.0.1:17777');
    expect(out).toContain('to let other people in, switch mode in Settings or run: tm8 node mode set peer|server');
  });

  it('personal, chosen, claimed, launch cookie: run tm8 open — no URL, no password', async () => {
    node.claimed = true;
    const out = await banner({ nodeModeSource: 'file', nodeModeSet: true, launchCookie: true });
    expect(out).toContain('  to open tm8 as the owner, run: tm8 open');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('password');
  });

  it('peer, claimed: one mode line', async () => {
    node.claimed = true;
    const out = await banner({ nodeMode: 'peer', nodeModeSource: 'file', nodeModeSet: true });
    expect(out).toBe(`  node: peer (from ${join(dataDir, 'mode')}) · owner on this machine, password for everyone else · claimed`);
  });

  it('server pinned by env, unclaimed: names the variable, never an env file path, and prints the claim box', async () => {
    const out = await banner({ nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true });
    expect(out).toContain('node: server (from TM8_NODE_MODE) · everyone signs in, everywhere · unclaimed');
    expect(out).not.toContain('First run');
    expect(out).toContain('THIS NODE IS UNCLAIMED');
    expect((await stat(tokenFile())).mode & 0o777).toBe(0o600);
  });

  it('env and file disagree: the env wins and the banner names both', async () => {
    node.claimed = true;
    await writeFile(join(dataDir, 'mode'), 'personal\n');
    const out = await banner({ nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true });
    expect(out).toContain(`${join(dataDir, 'mode')} says personal; TM8_NODE_MODE wins`);
    // Agreeing, or unreadable: no line.
    await writeFile(join(dataDir, 'mode'), 'server\n');
    expect(await banner({ nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true })).not.toContain('wins');
    await writeFile(join(dataDir, 'mode'), 'garbage');
    expect(await banner({ nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true })).not.toContain('wins');
  });

  it('a deprecated alias on an UNCLAIMED node adds one line naming its replacement', async () => {
    expect(await banner({ nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true, deprecatedAlias: true }))
      .toContain('TM8_NODE_MODE=multi is deprecated, use server');
    expect(await banner({ nodeMode: 'personal', nodeModeSource: 'file', nodeModeSet: true, deprecatedAlias: true }))
      .toContain(`"single" in ${join(dataDir, 'mode')} is deprecated, use personal`);
  });

  it('PROD CLASS: a CLAIMED node spelled single or multi prints exactly main\u2019s one line, nothing else', async () => {
    // Prod runs TM8_NODE_MODE=single + TM8_DISABLE_AUTO_OWNER=1, claimed. Main
    // printed `  node: claimed · mode single` for it; a deploy must not change that.
    node.claimed = true;
    expect(await banner({ nodeMode: 'personal', nodeModeSource: 'env', nodeModeSet: true, deprecatedAlias: true }))
      .toBe('  node: claimed · mode single');
    expect(await banner({ nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true, deprecatedAlias: true }))
      .toBe('  node: claimed · mode multi');
    expect(node.minted).toBe(0);
  });

  it('an unknown claim state still prints the mode line, with the error', async () => {
    const lines: string[] = [];
    const { announceNodeClaim: announce } = await import('../../src/identity/node-claim-boot.js');
    const pg = await import('../../src/identity/pg-auth.js');
    vi.spyOn(pg, 'nodeIsClaimed').mockRejectedValueOnce(new Error('db down'));
    await announce({
      db: {} as ClaimAnnouncementOptions['db'], dataDir, url: 'http://x', nodeMode: 'peer', nodeModeSource: 'file',
      nodeModeSet: true, ensureOwner: async () => undefined, log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe(`  node: peer (from ${join(dataDir, 'mode')}) · owner on this machine, password for everyone else`);
    expect(lines[1]).toContain('db down');
  });
});
