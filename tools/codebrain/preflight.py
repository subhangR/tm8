#!/usr/bin/env python3
"""
CodeBrain PREFLIGHT — probe the environment, emit an access manifest, GENERATE the gates.

Why this exists. Across thirteen ratified decisions in the clinfolio run, not one gate asked
the human for access, credentials or an environment. Every gate asked a DESIGN question
(403 vs 200, 409 vs 410, refactor vs patch) while six access problems were worked around
silently: no email provider, no test database, no venv, no node_modules, no staging, no MCP.

The sharpest cost: REVIEW found that send-otp discarded the email-delivery flag — the defect
that most resembles a user reporting "sign-in doesn't work". It was fixed and tested by
MONKEYPATCHING a failure, because this box has no email provider. So the fix is gated on
`environment == "production"` and has never once been exercised against a real provider.
Nobody was told that at a gate. It surfaced only because a human thought to ask.

The rule this encodes: A GATE MUST CARRY THREE THINGS, not one.
  1. the decision to make
  2. what CANNOT be verified in this environment, and why
  3. what access would close it, and what that unlocks

Gates are not a fixed list. They are DERIVED: each probe that comes back BLOCKER or DEGRADED
generates a gate, so a repo needing Stripe keys gets a Stripe gate and one needing a Kafka
broker gets a Kafka gate, without anyone enumerating them in advance.
"""
import json
import os
import re
import shutil
import subprocess
import sys

# Severity — what a probe result does to the run.
BLOCKER = "BLOCKER"    # the phase that needs it cannot produce trustworthy evidence. Gate, halt.
DEGRADED = "DEGRADED"  # work can proceed, but a class of claim becomes unprovable. Gate, warn.
OK = "OK"              # verified present and working.


def sh(cmd, cwd=None, timeout=60):
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:  # noqa: BLE001 - a probe must never take the run down
        return 1, str(e)


class Probe:
    """One environment capability, and what is unprovable without it."""

    def __init__(self, key, what, unlocks, blocks_phase=None):
        self.key, self.what, self.unlocks = key, what, unlocks
        self.blocks_phase = blocks_phase or []
        self.status, self.detail, self.ask = OK, "", ""

    def result(self, status, detail, ask=""):
        self.status, self.detail, self.ask = status, detail, ask
        return self


# --------------------------------------------------------------------------- probes

def probe_language_deps(repo):
    """Can the test suites actually RUN? A phase that cannot run tests cannot verify anything."""
    out = []
    for name, marker, check in (
        ("python", "requirements.txt", "python3 -c 'import pytest'"),
        ("node", "package.json", "node -e 'require(\"typescript\")'"),
    ):
        hits = sh(f"find {repo} -name {marker} -not -path '*/node_modules/*' "
                  f"-not -path '*/.git/*' | head -5")[1].strip().splitlines()
        if not hits:
            continue
        p = Probe(f"deps:{name}", f"{name} test dependencies",
                  f"any phase that runs {name} tests", ["IMPLEMENT", "REVIEW", "VERIFY"])
        rc, _ = sh(check, cwd=os.path.dirname(hits[0]))
        if rc == 0:
            out.append(p.result(OK, f"{name} deps importable"))
        else:
            out.append(p.result(
                BLOCKER,
                f"{marker} exists at {hits[0]} but deps are not importable",
                f"install {name} dependencies, or confirm the install command and any private "
                f"registry credentials"))
    return out


def probe_database(repo):
    """A suite that resets a schema needs a DISPOSABLE database, and concurrent phases need one each."""
    p = Probe("database", "a disposable test database",
              "running the API suite at all; concurrent review lenses need one EACH",
              ["IMPLEMENT", "REVIEW"])
    rc, out = sh("psql 'postgresql://127.0.0.1:5442/postgres' -t -A -c 'select 1'")
    if rc != 0:
        return [p.result(BLOCKER, "no reachable postgres on the usual local port",
                         "a connection string for a THROWAWAY database — never a shared one; "
                         "the suite drops the public schema of whatever it connects to")]
    hits = sh(f"grep -rl '_reset_public_schema\\|drop_all\\|DROP SCHEMA' {repo} "
              f"--include=conftest.py --include='*.py' 2>/dev/null | head -3")[1].strip()
    note = " (suite DROPS the schema — isolation is mandatory, not hygiene)" if hits else ""
    return [p.result(OK, f"postgres reachable{note}")]


def probe_outbound_services(repo):
    """Third-party services the code CALLS. Absent ones make whole failure paths unprovable."""
    out = []
    catalog = [
        ("email", r"sendgrid|smtplib|\\bses\\b|mailgun|postmark|send_otp_email|send_email|aiosmtplib",
         "verifying that a real send succeeds, and that a real failure is surfaced"),
        ("payments", r"stripe|razorpay|paddle|braintree", "any payment path end to end"),
        ("storage", r"boto3|s3_client|supabase\\.storage|\\bgcs\\b|azure\\.storage",
         "upload/download paths against real object storage"),
        ("sms", r"twilio|vonage|messagebird", "SMS delivery paths"),
        ("push", r"firebase_admin|apns|onesignal", "push delivery paths"),
        ("llm", r"openai|anthropic|bedrock|vertexai", "model-backed features"),
    ]
    for key, pat, unlocks in catalog:
        # Match where a dependency DECLARES itself — a manifest entry, an import, or a
        # settings field — not any mention anywhere. The loose version cited
        # SocialAuthButtons.tsx as evidence of an email provider and marketing copy as
        # evidence of SMS. A gate that cites the wrong file teaches people to ignore gates.
        rc, hits = sh(
            f"grep -rilE '^\\s*(import|from)\\s+.*({pat})|\"({pat})\":|^({pat})[=><~ ]' "
            f"{repo} --include='requirements.txt' --include='package.json' --include='*.py' "
            f"--include='*.ts' --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -3")
        if not hits.strip():
            continue
        files = ", ".join(os.path.relpath(f, repo) for f in hits.strip().splitlines()[:2])
        p = Probe(f"service:{key}", f"{key} provider credentials", unlocks, ["IMPLEMENT", "VERIFY"])
        # Configured? Look for a non-empty env var or a settings default that is not obviously a stub.
        envs = [v for v in os.environ
                if key.upper() in v.upper() and os.environ.get(v) not in (None, "", "none")]
        if envs:
            out.append(p.result(OK, f"configured via {envs[0]}"))
        else:
            out.append(p.result(
                DEGRADED,
                f"referenced in {files} but no credentials in the environment — the code will "
                f"take its fallback path, so success AND failure are both unobservable",
                f"{key} credentials for a SANDBOX/test account (never production), or an explicit "
                f"decision that {key} stays untested and the readiness report says so"))
    return out


def probe_browser():
    p = Probe("browser", "a working headless browser",
              "VERIFY — any claim about what actually renders", ["VERIFY"])
    root = os.path.expanduser("~/.cache/ms-playwright")
    found = sh(f"ls -d {root}/chromium* 2>/dev/null | head -2")[1].strip()
    if not found:
        return [p.result(DEGRADED, "no chromium in the playwright cache",
                         "confirm a browser install, or accept that no rendering claim can be made")]
    return [p.result(OK, "chromium present (this kernel needs --js-flags=--jitless)")]


def probe_git_and_ship(repo):
    out = []
    p = Probe("git:push", "push rights on the origin remote", "SHIP — opening a PR at all", ["SHIP"])
    rc, out_s = sh("git ls-remote --heads origin >/dev/null 2>&1 && echo ok", cwd=repo)
    out.append(p.result(OK, "origin reachable") if "ok" in out_s else
               p.result(BLOCKER, "cannot reach origin",
                        "a token or deploy key with push access to the target repository"))
    q = Probe("ci", "visibility of the project's CI gate",
              "knowing whether the PR would actually pass the project's own checks", ["SHIP"])
    ci = sh(f"ls {repo}/.github/workflows/*.yml 2>/dev/null | head -3")[1].strip()
    out.append(q.result(OK, f"{len(ci.splitlines())} workflow(s) found — run them locally where possible")
               if ci else q.result(DEGRADED, "no CI config found",
                                   "confirm what gate this project uses before merge"))
    return out


def probe_environments(repo):
    """Staging / production. Never assume access; never assume it is wanted."""
    p = Probe("env:staging", "a non-production environment to exercise",
              "end-to-end verification against real infrastructure", ["VERIFY", "SHIP"])
    return [p.result(DEGRADED,
                     "no staging/production endpoint was provided to this run",
                     "a staging URL plus a test account, IF end-to-end verification is wanted. "
                     "Without it, every behavioural claim is limited to a local harness.")]


def probe_secrets_hygiene(repo):
    p = Probe("secrets", "real config values for defaulted secrets",
              "knowing the code behaves as it will in production", [])
    rc, hits = sh(f"grep -rn 'default.*secret\\|SECRET.*=.*\"' {repo} --include='*.py' "
                  f"--exclude-dir=node_modules 2>/dev/null | grep -i 'default\\|change' | head -3")
    if hits.strip():
        first = hits.strip().splitlines()[0][:110]
        return [p.result(DEGRADED, f"defaulted secret in use: {first}",
                         "confirm production values are injected at deploy time, not defaulted")]
    return [p.result(OK, "no obviously defaulted secrets")]


# --------------------------------------------------------------------------- manifest

def run(repo):
    probes = []
    for fn in (probe_language_deps, probe_database, probe_outbound_services,
               probe_git_and_ship, probe_environments, probe_secrets_hygiene):
        try:
            probes += fn(repo)
        except Exception as e:  # noqa: BLE001
            probes.append(Probe(fn.__name__, "probe", "").result(DEGRADED, f"probe failed: {e}"))
    probes += probe_browser()
    return probes


def render(probes, repo):
    blockers = [p for p in probes if p.status == BLOCKER]
    degraded = [p for p in probes if p.status == DEGRADED]
    ok = [p for p in probes if p.status == OK]

    L = ["## PREFLIGHT — access manifest", "",
         f"Target: `{repo}`", "",
         f"**{len(blockers)} BLOCKER · {len(degraded)} DEGRADED · {len(ok)} OK**", ""]

    if blockers:
        L += ["### BLOCKERS — a phase cannot produce trustworthy evidence without these", ""]
        for p in blockers:
            L += [f"**{p.key}** — {p.what}", f"- found: {p.detail}",
                  f"- blocks: {', '.join(p.blocks_phase) or 'the run'}",
                  f"- **ASK THE HUMAN:** {p.ask}", ""]

    if degraded:
        L += ["### DEGRADED — work proceeds, but these claims become unprovable", ""]
        for p in degraded:
            L += [f"**{p.key}** — {p.what}", f"- found: {p.detail}",
                  f"- unprovable without it: {p.unlocks}",
                  f"- **ASK THE HUMAN:** {p.ask}", ""]

    if ok:
        L += ["### OK", ""] + [f"- `{p.key}` — {p.detail}" for p in ok] + [""]

    L += ["### Gate rule", "",
          "Every BLOCKER is a gate: the run HALTS until a human supplies the access or",
          "explicitly rules it out of scope. Every DEGRADED item must be RESTATED at every",
          "later gate and must appear in the readiness report — a claim that was never",
          "checkable must never be reported as checked.", ""]
    return "\n".join(L)


if __name__ == "__main__":
    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    probes = run(os.path.abspath(repo))
    print(render(probes, os.path.abspath(repo)))
    out = {p.key: {"status": p.status, "detail": p.detail, "ask": p.ask,
                   "blocks": p.blocks_phase} for p in probes}
    dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_preflight.json")
    json.dump(out, open(dest, "w"), indent=1)
    sys.exit(2 if any(p.status == BLOCKER for p in probes) else 0)
