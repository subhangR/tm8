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
    it('keeps the bare loopback single-machine path', async () => {
      expect(await autoOwnerResolver({}, {
        remoteAddress: '127.0.0.1',
        disableAutoOwner: false,
      })).toEqual({ kind: 'auto-owner' });
    });

    it('treats a loopback proxy hop as anonymous when any forwarding evidence exists', async () => {
      for (const header of ['x-forwarded-for', 'X-Forwarded-Host', 'x-real-ip', 'Forwarded']) {
        expect(await autoOwnerResolver({ [header]: '' }, {
          remoteAddress: '::ffff:127.0.0.1',
          disableAutoOwner: false,
        })).toEqual({ kind: 'anonymous' });
      }
    });

    it('the kill switch disables auto-owner even for a bare loopback peer', async () => {
      expect(await autoOwnerResolver({}, {
        remoteAddress: '::1',
        disableAutoOwner: true,
      })).toEqual({ kind: 'anonymous' });
    });

    it('unknown and non-loopback peers never auto-own', async () => {
      for (const remoteAddress of [undefined, '10.0.0.8']) {
        expect(await autoOwnerResolver({}, {
          remoteAddress,
          disableAutoOwner: false,
        })).toEqual({ kind: 'anonymous' });
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
  // service began binding tm8.principal_type and five tm8.delivery_* claims, and
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
  // auth session's SERVER-RESOLVED kind (browser / cli / agent), which
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
        'delivery_pair_budget_version',
      ],
      reason:
        'The system delivery adapter. Permitted on four facts, each checkable: ' +
        '(1) the namespaces are DISJOINT from the caller-identity claims — this file ' +
        'binds none of identity_id/actor_id/node_admin/request_id, and db/client.ts ' +
        'binds none of the delivery claims; (2) they are ACTIVELY EXCLUSIVE, because ' +
        'internal.require_delivery_principal (015:1348-1355) raises 42501 unless the ' +
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
