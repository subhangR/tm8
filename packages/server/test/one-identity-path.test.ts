/**
 * One identity path, enforced structurally.
 *
 * This guard exists because the same bug happened TWICE in one day, in two
 * different blocks, written by two people who were each being careful:
 *
 *  1. The frame's default resolver reported `auto-owner` with no identityId
 *     while the facade grew its own owner resolver over `Db`. Fine while the
 *     facade was the only consumer; the moment the execution handlers read
 *     `ctx.identity` they got undefined and every spawn died with
 *     `28000 no identity bound to this transaction`.
 *  2. The execution handlers then grew their OWN local `claimsFor`, which
 *     differed from the shared one in two ways that both present as
 *     authorization failures rather than claims failures — most dangerously it
 *     bound `actorId` GLOBALLY. A member row belongs to ONE space, and
 *     `internal.resolve_actor` coalesces to it, so a globally-bound actor from
 *     space A on a request touching space B raises 42501 — for the space's own
 *     owner. It had not bitten only because the smoke path uses one space.
 *
 * Neither was findable from inside the block that wrote it: both look correct
 * locally and only fail when a second consumer exists. A test that reads the
 * source is the cheapest thing that can see across blocks.
 *
 * If you are here because this test failed: do not add an exemption. Import
 * `claimsFor` from facade/context.ts. If it genuinely cannot serve your case,
 * change it there so every caller gets the fix.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { autoOwnerResolver } from '../src/http/security.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** The one file allowed to define it. */
const OWNER = join(SRC, 'facade', 'context.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('one identity path (R2 / claims contract)', () => {
  describe('the guarded auto-owner arm', () => {
    const cookieOk = () => true;
    const noCookie = () => false;
    // What the tm8 CLI's transport sends (Node v22 global fetch, measured
    // 2026-09-26): a loopback Host, `sec-fetch-mode: cors`, nothing else.
    const cli = { host: '127.0.0.1:17777', 'sec-fetch-mode': 'cors' } as const;
    // A browser at the node's own UI: same Host, plus the fetch metadata.
    const browser = { ...cli, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' } as const;
    const peer = (autoOwnerCookie: 'off' | (() => boolean), method = 'GET') => ({
      remoteAddress: '127.0.0.1', disableAutoOwner: false, autoOwnerCookie, method,
    });

    it('keeps the bare loopback single-machine path when the cookie is off (pre-W2 rule)', async () => {
      expect(await autoOwnerResolver(browser, peer('off'))).toEqual({ kind: 'auto-owner', autoOwnerVia: 'browser' });
    });

    it('T12 (W2): a loopback BROWSER without the launch cookie is anonymous', async () => {
      expect(await autoOwnerResolver(browser, peer(noCookie))).toEqual({ kind: 'anonymous' });
    });

    it('T12 positive (W2): the same browser WITH a valid launch cookie is the auto-owner, via browser', async () => {
      expect(await autoOwnerResolver(browser, peer(cookieOk))).toEqual({ kind: 'auto-owner', autoOwnerVia: 'browser' });
    });

    it('L1: a token-less CLI request (Node fetch, sec-fetch-mode: cors) is the owner with no cookie, via local', async () => {
      expect(await autoOwnerResolver(cli, peer(noCookie))).toEqual({ kind: 'auto-owner', autoOwnerVia: 'local' });
      // Bun sends no sec-fetch-* at all: the same.
      expect(await autoOwnerResolver({ host: 'localhost:17777' }, peer(noCookie)))
        .toEqual({ kind: 'auto-owner', autoOwnerVia: 'local' });
      expect(await autoOwnerResolver({ host: '[::1]:17777' }, peer(noCookie)))
        .toEqual({ kind: 'auto-owner', autoOwnerVia: 'local' });
    });

    it('L1: ANY one browser marker makes the same CLI request need the cookie (fail closed)', async () => {
      for (const marker of [
        { 'sec-fetch-mode': 'navigate' },
        { 'sec-fetch-mode': ' NAVIGATE ' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-dest': 'document' },
        { origin: 'http://127.0.0.1:17777' },
        { origin: 'null' },
        { cookie: 'unrelated=1' },
      ]) {
        const headers = { ...cli, ...marker };
        expect(await autoOwnerResolver(headers, peer(noCookie)), JSON.stringify(marker)).toEqual({ kind: 'anonymous' });
        // Pair: the marker routes to the browser arm, which the cookie opens.
        expect(await autoOwnerResolver(headers, peer(cookieOk)), JSON.stringify(marker))
          .toEqual({ kind: 'auto-owner', autoOwnerVia: 'browser' });
      }
    });

    it('L1: a Sec-Fetch-Mode that is not navigate is not a marker', async () => {
      for (const mode of ['cors', 'no-cors', 'same-origin', 'websocket']) {
        expect(await autoOwnerResolver({ ...cli, 'sec-fetch-mode': mode }, peer(noCookie)), mode)
          .toEqual({ kind: 'auto-owner', autoOwnerVia: 'local' });
      }
    });

    it('L1: the local arm needs a loopback Host LITERAL (DNS rebinding); absent Host is refused too', async () => {
      for (const host of ['evil.example:17777', 'evil.example', 'tm8.internal', '127.0.0.2:17777', undefined]) {
        const headers = host === undefined ? { 'sec-fetch-mode': 'cors' } : { ...cli, host };
        expect(await autoOwnerResolver(headers, peer(noCookie)), String(host)).toEqual({ kind: 'anonymous' });
      }
      // Pair: each loopback literal, any port or none.
      for (const host of ['127.0.0.1', 'LOCALHOST:1', '[::1]']) {
        expect(await autoOwnerResolver({ ...cli, host }, peer(noCookie)), host)
          .toEqual({ kind: 'auto-owner', autoOwnerVia: 'local' });
      }
    });

    it('L1 CSRF: a markerless POST shaped like a cross-site simple write is refused; the CLI shapes are the owner', async () => {
      for (const type of ['text/plain', 'Text/Plain; charset=utf-8', 'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=x', '']) {
        expect(await autoOwnerResolver({ ...cli, 'content-type': type, 'content-length': '2' }, peer(noCookie, 'POST')), type)
          .toEqual({ kind: 'anonymous' });
      }
      // A body with no content type at all (a Blob body) is simple too.
      expect(await autoOwnerResolver({ ...cli, 'content-length': '2' }, peer(noCookie, 'POST'))).toEqual({ kind: 'anonymous' });
      expect(await autoOwnerResolver({ ...cli, 'transfer-encoding': 'chunked' }, peer(noCookie, 'POST'))).toEqual({ kind: 'anonymous' });
      // An unknown method fails closed as a POST.
      expect(await autoOwnerResolver({ ...cli, 'content-type': 'text/plain' }, { ...peer(noCookie), method: undefined }))
        .toEqual({ kind: 'anonymous' });
      // Pairs: the JSON POST, the bodyless POST, and the octet-stream upload PUT the CLI sends.
      const local = { kind: 'auto-owner', autoOwnerVia: 'local' };
      expect(await autoOwnerResolver({ ...cli, 'content-type': 'application/json', 'content-length': '2' }, peer(noCookie, 'POST'))).toEqual(local);
      expect(await autoOwnerResolver({ ...cli, 'content-length': '0' }, peer(noCookie, 'POST'))).toEqual(local);
      expect(await autoOwnerResolver(cli, peer(noCookie, 'POST'))).toEqual(local);
      expect(await autoOwnerResolver({ ...cli, 'content-type': 'application/octet-stream', 'content-length': '2' }, peer(noCookie, 'PUT'))).toEqual(local);
      // PUT is never CORS-simple, so its content type is not the rule's business.
      expect(await autoOwnerResolver({ ...cli, 'content-type': 'text/plain', 'content-length': '2' }, peer(noCookie, 'PUT'))).toEqual(local);
    });

    it('fails closed: a context with no cookie rule at all is anonymous', async () => {
      expect(await autoOwnerResolver(browser, {
        remoteAddress: '127.0.0.1',
        disableAutoOwner: false,
      } as unknown as Parameters<typeof autoOwnerResolver>[1])).toEqual({ kind: 'anonymous' });
    });

    it('treats a loopback proxy hop as anonymous when any forwarding evidence exists — cookie or not, browser or CLI (T13)', async () => {
      for (const header of ['x-forwarded-for', 'X-Forwarded-Host', 'x-real-ip', 'Forwarded']) {
        for (const autoOwnerCookie of ['off', cookieOk] as const) {
          for (const base of [browser, cli]) {
            expect(await autoOwnerResolver({ ...base, [header]: '' }, {
              remoteAddress: '::ffff:127.0.0.1',
              disableAutoOwner: false,
              autoOwnerCookie,
            })).toEqual({ kind: 'anonymous' });
          }
        }
      }
    });

    it('the kill switch disables auto-owner even for a loopback peer holding the cookie, or a CLI', async () => {
      for (const base of [browser, cli]) {
        expect(await autoOwnerResolver(base, {
          remoteAddress: '::1',
          disableAutoOwner: true,
          autoOwnerCookie: cookieOk,
        })).toEqual({ kind: 'anonymous' });
      }
    });

    it('unknown and non-loopback peers never auto-own, cookie or not, browser or CLI', async () => {
      for (const remoteAddress of [undefined, '10.0.0.8']) {
        for (const base of [browser, cli]) {
          expect(await autoOwnerResolver(base, {
            remoteAddress,
            disableAutoOwner: false,
            autoOwnerCookie: cookieOk,
          })).toEqual({ kind: 'anonymous' });
        }
      }
    });
  });

  it('claimsFor is DEFINED in exactly one file', () => {
    // Matches a definition — `function claimsFor`, `const claimsFor =` — but
    // deliberately NOT a call or an import, which every handler may do.
    const definition = /(?:function\s+claimsFor\b|(?:const|let|var)\s+claimsFor\s*[:=])/;

    const definers = sourceFiles(SRC).filter((file) => definition.test(readFileSync(file, 'utf8')));

    expect(definers, `claimsFor must be defined only in ${OWNER}`).toEqual([OWNER]);
  });

  // ---------------------------------------------------------------------------
  // THE CALLER-IDENTITY CLAIMS, BY NAME.
  //
  // WHY BY NAME AND NOT BY PATTERN. The previous form of this guard matched
  // "code contains set_config AND contains tm8." — a TEXTUAL PROXY for "binds
  // caller identity". The proxy drifted from the property the day a delivery
  // service began binding tm8.principal_type and four tm8.delivery_* claims, and
  // the guard reported a violation of a rule nobody had broken. MATCHING A PREFIX
  // IS WHAT PRODUCED THAT FALSE RED, so the sharpened form enumerates.
  //
  // THE SHARPENING KEEPS THE PROPERTY THAT CREATED THE GUARD. Both founding
  // defects in the header above are still caught: the second one bound `actorId`
  // GLOBALLY from a second file, and actor_id is a NAMED claim below, so a second
  // file binding it is still red. Removing a proxy is not the same as removing
  // rigour.
  //
  // acting_as and client_mutation_id are bound today only from SQL
  // (internal.bind_actor, internal.bind_cmid) and by nothing in src. They are
  // named anyway: the cost of naming a claim that is not yet bound in TypeScript
  // is zero, and it is the difference between this guard noticing a future
  // binding and being surprised by it.
  //
  // `auth_kind` (082, architect ruling R11) is NAMED here rather than added to
  // the allowlist below, and that is the STRONGER of the two options.
  // Allowlisting would say "this file may also bind it"; naming it says
  // "exactly one file may bind it, and that file must be db/client.ts" — the
  // same rule every other caller-identity claim lives under. It carries the
  // auth session's SERVER-RESOLVED kind (browser / cli / agent / agent_runtime), which
  // `internal.require_human_auth_kind()` reads to keep an agent holding its
  // owner's full identity out of `credentials.*`. A second file binding it
  // would be exactly the founding defect this guard exists to catch.
  // ---------------------------------------------------------------------------
  const CALLER_IDENTITY_CLAIMS = [
    'identity_id',
    'actor_id',
    'node_admin',
    'request_id',
    'acting_as',
    'client_mutation_id',
    'auth_kind',
    // 227 (plan W0a): the space an agent session is pinned to. Caller
    // identity, not a side channel — it narrows what identity_id may reach.
    'session_space_id',
    // 256 (W7p): the space link the auth session descends from. Caller
    // identity, not a side channel — it only narrows (credential reads refuse
    // it), and like session_space_id only db/client.ts may bind it.
    'via_link',
  ] as const;

  const CLAIMS_BINDER = join(SRC, 'db', 'client.ts');

  /**
   * Namespaces OTHER than the caller-identity claims may be bound elsewhere only
   * from this list. EACH ENTRY IS A RECORDED DECISION WITH ITS REASON, not a
   * suppression: adding one should cost a decision, not a keystroke.
   */
  const ALLOWED_NON_CALLER_BINDERS = [
    {
      file: join(SRC, 'facade', 'services', 'w2', 'execution.ts'),
      claims: [
        'principal_type',
        'delivery_id',
        'delivery_message_id',
        'delivery_target_work_session_id',
        'delivery_expires_at',
      ],
      reason:
        'The system delivery adapter. Permitted on four facts, each checkable: ' +
        '(1) the namespaces are DISJOINT from the caller-identity claims — this file ' +
        'binds none of identity_id/actor_id/node_admin/request_id, and db/client.ts ' +
        'binds none of the delivery claims; (2) they are ACTIVELY EXCLUSIVE, because ' +
        'internal.require_delivery_principal (135) raises 42501 unless the ' +
        'role is the delivery worker AND principal_type is system_delivery_adapter, so ' +
        'a delivery transaction carrying caller claims is refused BY THE DATABASE; ' +
        '(3) assuming the delivery role fails LOUDLY from tm8_app rather than falling ' +
        'back silently; (4) no request-controlled value is bound — the delivery tuple ' +
        'comes from the stored message, never from whoever is connected.',
    },
  ] as const;

  /**
   * Strip comments first. Files that DOCUMENT the binding — claims.ts explains
   * the SET LOCAL contract in prose, db/types.ts in doc comments — are not
   * binders, and flagging them would train people to ignore this test, which is
   * worse than not having it. Kept deliberately from the original guard.
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  interface Binding {
    readonly file: string;
    readonly claim: string;
    readonly localScope: string;
  }

  /** Every set_config('tm8.X', …) call in src, with its third argument. */
  function bindings(): Binding[] {
    const found: Binding[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(/set_config\(([^)]*)\)/g)) {
        const args = match[1]!.split(',').map((a) => a.trim());
        // A set_config whose arguments cannot be read as exactly three is not
        // silently skipped — it is surfaced, because a mis-parse here would make
        // the local-scope assertion below vacuous for that call.
        expect(
          args.length,
          `${file}: could not read set_config(${match[1]}) as three arguments; ` +
            `the local-scope check cannot be applied to it`,
        ).toBe(3);
        const claim = /^['"`]tm8\.([a-z_]+)['"`]$/.exec(args[0]!)?.[1];
        if (claim) found.push({ file, claim, localScope: args[2]! });
      }
    }
    return found;
  }

  it('each named caller-identity claim is bound in exactly one file', () => {
    const all = bindings();
    for (const claim of CALLER_IDENTITY_CLAIMS) {
      const files = [...new Set(all.filter((b) => b.claim === claim).map((b) => b.file))].sort();
      // A claim bound nowhere in src is fine (SQL may bind it); a claim bound in
      // a second file is the defect this guard was built for.
      expect(
        files.length <= 1,
        `tm8.${claim} is bound in ${files.length} files: ${files.join(', ')} — ` +
          `only ${CLAIMS_BINDER} may bind caller-identity claims. Import claimsFor ` +
          `from facade/context.ts rather than binding it a second time.`,
      ).toBe(true);
      if (files.length === 1) {
        expect(
          files[0],
          `tm8.${claim} is bound in ${files[0]} — only ${CLAIMS_BINDER} may bind it`,
        ).toBe(CLAIMS_BINDER);
      }
    }
  });

  it('any other claim namespace is bound only from the allowlist', () => {
    const named = new Set<string>(CALLER_IDENTITY_CLAIMS);
    const offenders: string[] = [];
    for (const binding of bindings()) {
      if (named.has(binding.claim)) continue;
      const entry = ALLOWED_NON_CALLER_BINDERS.find((e) => e.file === binding.file);
      if (!entry) {
        offenders.push(`${binding.file} binds tm8.${binding.claim} and is not on the allowlist`);
      } else if (!(entry.claims as readonly string[]).includes(binding.claim)) {
        offenders.push(
          `${binding.file} is allowlisted but binds tm8.${binding.claim}, which its entry does not cover`,
        );
      }
    }
    expect(
      offenders,
      `a claim namespace was bound outside the allowlist:\n  ${offenders.join('\n  ')}\n` +
        'Adding an entry is a RECORDED DECISION and must carry its reason — do not ' +
        'add a bare file path, and do not add an exemption comment.',
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // THE COMPANION, AND THE SHARPENING DOES NOT STAND WITHOUT IT.
  //
  // db/client.ts carries a long header on why every claim must be bound
  // LOCAL-SCOPE: a claim that survives commit hands the NEXT request someone
  // else's identity. The delivery file independently re-implements that same
  // discipline — and until now NOTHING IN THE TREE CHECKED THE SECOND
  // IMPLEMENTATION. Narrowing the binder rule without adding this would answer
  // drift and leave duplicated discipline unguarded, which is the worse trade.
  //
  // This assertion is textual and admits no judgement: every set_config anywhere
  // in src passes `true` as its third argument. It applies to binders that exist
  // and to every binder that will ever exist, allowlisted or not.
  // ---------------------------------------------------------------------------
  it('every set_config in every binder passes true as its third argument', () => {
    const nonLocal = bindings()
      .filter((b) => b.localScope !== 'true')
      .map((b) => `${b.file}: set_config('tm8.${b.claim}', …, ${b.localScope}) is not local-scope`);
    expect(
      nonLocal,
      `a claim is bound with a NON-LOCAL scope:\n  ${nonLocal.join('\n  ')}\n` +
        'A claim that survives commit is handed to the NEXT request on that ' +
        "connection — someone else's identity, silently. The third argument must be " +
        'literally `true`.',
    ).toEqual([]);
  });
});
