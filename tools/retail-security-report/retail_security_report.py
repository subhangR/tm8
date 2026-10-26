#!/usr/bin/env python3
"""
retail-security-report: run the Retail Security 2026 research pipeline end to end and write a
local run report.

It reproduces, as stages, exactly what the Crawl Engineer did by hand on 16 Oct 2026:

  collect   multi-channel public collection (Google News + Bing News RSS per query and country
            edition, Bing web, DuckDuckGo, Hacker News, Reddit JSON, ransomware.live, HIBP)
            -> raw/<channel>.jsonl                                   [scripts/collect.py]
  reddit    Reddit as a normal browser user (public RSS, no login)
            -> raw/reddit_web.jsonl                                  [scripts/collect_reddit.py]
  social    Bluesky, Mastodon, Lemmy, YouTube, X/LinkedIn via Bing, report queries
            -> raw/bluesky|mastodon|lemmy|youtube|bingweb|ddg.jsonl   [scripts/collect2.py]
  period    MONTHLY MODE: take every dated record between the previous run's end date and today
            (build/state.json), filter, de-duplicate and cluster it into NEW incidents, roundups,
            leak-site listings and HIBP loads with sources, stats and quotes
            -> build/periods/<from>_<to>/period.json                 [scripts/period.py]
            With ANTHROPIC_API_KEY set, summaries are written by a Claude model (default
            claude-sonnet-5-5) from the evidence titles; otherwise rule-built.
  geo       world-atlas TopoJSON -> build/geo.json + build/geo_s.json (tolerance 0.25) for the globe
  shots     evidence screenshots for the PDF (build/shots/list.json -> build/shots/<id>.png)
  site      self-contained interactive HTML, light + dark          [scripts/build_site.py]
  check     headless Chromium check of the site in both themes: console errors + screenshots
  pdf       cover + body -> Chromium -> merged 46-page PDF + previews [scripts/build_pdf.py]
  verify    magic bytes, page count, sha256, theme markers, curated-register integrity
  report    build/runs/<run-id>/report.md + run.json (always written, even on failure)

In MONTHLY mode (--stages monthly, the local runner's default) the collectors only keep records
published on or after the window start (RSR_SINCE), the site/check/pdf stages build the period
report under build/periods/<from>_<to>/ instead of the annual one, and build/state.json advances
to the window end only after the site exists, so a failed run is simply re-run. The first monthly
run starts the day after the annual report's cut-off (16 Oct 2026); --period-from/--period-to
rebuild any window on demand.
  publish   optional: new artifact revision, PDF file upload with a .pdf name, produces edges,
            message on the task (needs tm8 access)

The ANNUAL report (stage sets all/build) is rebuilt from the analyst-written register
(scripts/report_sources.py, report_incidents.py, report_stats.py); the MONTHLY report is built
entirely from the raw evidence of its window, so every run on a new window yields new content.

Exit status: 0 all requested stages ok, 1 a stage failed (report still written), 2 harness
error (bad project dir), 64 bad arguments.
"""
import argparse, collections, datetime as dt, hashlib, json, os, platform, re, shutil, subprocess, sys, time

ALL_STAGES = ["collect", "reddit", "social", "period", "geo", "shots", "site", "check", "pdf", "verify", "report", "publish"]
STAGE_SETS = {
    "all": ["collect", "reddit", "social", "geo", "shots", "site", "check", "pdf", "verify", "report"],
    "build": ["geo", "shots", "site", "check", "pdf", "verify", "report"],
    "collect": ["collect", "reddit", "social", "verify", "report"],
    "verify": ["verify", "report"],
    "monthly": ["collect", "reddit", "social", "period", "geo", "shots", "site", "check", "pdf", "verify", "report"],
    "monthly-build": ["period", "geo", "shots", "site", "check", "pdf", "verify", "report"],
}
ANNUAL_END = "2026-10-16"       # the annual report's evidence cut-off (ledger baseline when build/state.json is absent)
FIRST_FROM = "2026-10-01"       # the very first monthly run (no runs in the ledger) starts here, so the first report is a whole month
WORLD_ATLAS = "https://cdn.jsdelivr.net/npm/world-atlas@2/"
GEO_TOL = 0.25
PW_IMAGE_DEFAULT = "mcr.microsoft.com/playwright:v1.64.0-noble"
PW_HOST_MODULES = "/opt/tm8/prod/node_modules"
PDF_NAME = "Retail-Security-2026-Middle-East-first-world-ranked-by-trend.pdf"
RAW_CHANNELS = ["gnews", "bingnews", "bingweb", "ddg", "hn", "reddit", "reddit_web", "bluesky", "mastodon", "lemmy", "youtube", "ransomware_live", "hibp"]


DEPS = ["curl_cffi", "bs4", "pypdf", "fitz", "PIL"]


def pick_python():
    """First interpreter that imports the pipeline deps; falls back to the current one."""
    cands = [sys.executable, shutil.which("python3"), "/usr/bin/python3", "/usr/local/bin/python3"]
    seen, report = [], {}
    for c in cands:
        if not c or c in seen or not os.path.exists(c): continue
        seen.append(c)
        p = subprocess.run([c, "-P", "-c", "import importlib,sys; print(' '.join(m for m in sys.argv[1:] if importlib.util.find_spec(m)))", *DEPS], capture_output=True, text=True)
        have = p.stdout.split() if p.returncode == 0 else []
        report[c] = have
        if set(DEPS) <= set(have): return c, report
    best = max(seen, key=lambda c: len(report[c]))
    return best, report


def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def env_bool(name, default=False):
    v = env(name)
    if v is None: return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()


def pdf_pages(path):
    try:
        from pypdf import PdfReader
        return len(PdfReader(path).pages)
    except Exception: pass
    try:
        import fitz
        return fitz.open(path).page_count
    except Exception: pass
    data = open(path, "rb").read()
    return len(re.findall(rb"/Type\s*/Page(?![s/])", data)) or None


def load_jsonl(path):
    out = []
    if not os.path.exists(path): return out
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            try: out.append(json.loads(line))
            except Exception: pass
    return out


class Run:
    def __init__(self, project, out_root, stages, args):
        self.project = project
        self.args = args
        self.id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.dir = os.path.join(out_root, self.id)
        os.makedirs(self.dir, exist_ok=True)
        self.stages = stages
        self.results = {}       # stage -> {status, seconds, note, log}
        self.facts = {}         # everything the report prints
        self.started = time.time()
        self.python, deps = pick_python()
        self.facts["python"] = {"used": self.python, "deps": deps, "runner": sys.executable}
        self.period = None      # {"frm","to","id","dir"} in monthly mode (set by set_period)

    # -- monthly window ----------------------------------------------------------------------
    def set_period(self):
        """Decide the window: --period-from/--period-to, else the day after build/state.json's last_end .. today (UTC)."""
        st = {}
        sp = self.p("build", "state.json")
        if os.path.exists(sp):
            try: st = json.load(open(sp, encoding="utf-8"))
            except Exception: st = {}
        last_end = st.get("last_end") or st.get("baseline_end") or ANNUAL_END
        today = dt.datetime.now(dt.timezone.utc).date().isoformat()
        first = not (st.get("runs") or [])
        frm = self.args.period_from or (self.args.first_from if first and self.args.first_from else (dt.date.fromisoformat(last_end) + dt.timedelta(days=1)).isoformat())
        to = self.args.period_to or today
        note = ""
        if frm > to:
            runs = st.get("runs") or []
            if runs and not self.args.period_from:
                frm, to = runs[-1]["frm"], runs[-1]["to"]; note = f"window already covered through {last_end}; rebuilding the latest period {frm}..{to} (pass --period-from/--period-to for another window)"
            else: raise SystemExit(f"error: period start {frm} is after its end {to}")
        for v in (frm, to): dt.date.fromisoformat(v)
        pid = f"{frm}_{to}"
        self.period = {"frm": frm, "to": to, "id": pid, "dir": self.p("build", "periods", pid), "last_end_before": last_end, "note": note}
        os.environ["RSR_SINCE"] = frm          # collectors keep only records published on/after the window start
        self.facts["period"] = dict(self.period)
        return self.period

    def commit_period(self):
        """Advance build/state.json to the window end; called only after the period site was built."""
        rc, out = self.sh("period", [self.python, "-P", self.p("scripts", "period.py"), "--commit-state", "--from", self.period["frm"], "--to", self.period["to"]], check=False)
        self.facts["period"]["state_advanced"] = (rc == 0)
        return rc == 0

    def site_path(self): return os.path.join(self.period["dir"], "site", "index.html") if self.period else self.p("build", "site", "index.html")
    def pdf_dir(self): return os.path.join(self.period["dir"], "pdf") if self.period else self.p("build", "pdf")
    def pdf_name(self): return f"Retail-Security-Monthly-{self.period['frm']}-to-{self.period['to']}.pdf" if self.period else PDF_NAME

    # -- process helpers -------------------------------------------------------------------
    def log_path(self, stage): return os.path.join(self.dir, f"{stage}.log")

    def sh(self, stage, cmd, timeout=None, cwd=None, check=True):
        """Run a command, tee its output to the stage log, return (rc, tail)."""
        logp = self.log_path(stage)
        with open(logp, "a", encoding="utf-8") as lf:
            lf.write(f"\n$ {' '.join(cmd)}\n")
            lf.flush()
            try:
                p = subprocess.run(cmd, cwd=cwd or self.project, stdout=lf, stderr=subprocess.STDOUT, timeout=timeout)
                rc = p.returncode
            except subprocess.TimeoutExpired:
                lf.write(f"\n[timeout after {timeout}s]\n"); rc = 124
        tail = ""
        try:
            with open(logp, encoding="utf-8", errors="ignore") as f: tail = "".join(f.readlines()[-6:])
        except Exception: pass
        if check and rc != 0: raise RuntimeError(f"{cmd[0]} exited {rc}; see {logp}\n{tail}")
        return rc, tail

    def py(self, stage, script, *a, timeout=None):
        return self.sh(stage, [self.python, "-P", os.path.join(self.project, "scripts", script), *a], timeout=timeout)

    def browser(self):
        """'docker' or 'local' (python-playwright, scripts/rsr_browser.py) or None with a reason."""
        if getattr(self, "_browser", None) is not None: return self._browser
        want = self.args.browser
        ok, why = self.docker_ok()
        if want == "none": self._browser = (None, "browser stages disabled (--browser none: Chromium not available)")
        elif want in ("auto", "docker") and ok: self._browser = ("docker", "")
        elif want == "docker": self._browser = (None, why)
        else:
            p = None
            if os.path.exists(self.p("scripts", "rsr_browser.py")):
                try: p = subprocess.run([self.python, "-P", self.p("scripts", "rsr_browser.py"), "probe"], capture_output=True, text=True, timeout=180)
                except subprocess.TimeoutExpired: p = subprocess.CompletedProcess([], 1, "probe FAIL timed out after 180s (Chromium hung)", "")
            if p is not None and p.returncode == 0: self._browser = ("local", "")
            else: self._browser = (None, (why + "; " if want == "auto" else "") + "no local browser (python -m playwright install chromium, or install Google Chrome): " + ((p.stdout.strip().splitlines() or [p.stderr.strip()[-200:]])[-1][:300] if p else "scripts/rsr_browser.py missing"))
        self.facts["browser"] = {"requested": want, "used": self._browser[0], "note": self._browser[1]}
        return self._browser

    def rsr_browser(self, stage, *a, timeout=1800):
        return self.sh(stage, [self.python, "-P", self.p("scripts", "rsr_browser.py"), *a], timeout=timeout)

    def docker_ok(self):
        if shutil.which("docker") is None: return False, "docker not installed"
        p = subprocess.run(["docker", "image", "inspect", self.args.pw_image], capture_output=True)
        if p.returncode != 0: return False, f"docker image {self.args.pw_image} not present (never prune it; it re-pulls 3.4 GB)"
        return True, ""

    def docker(self, stage, mounts, script, timeout=1800):
        cmd = ["docker", "run", "--rm", "--network", "host", "--shm-size=1g", "--ipc=host"]
        for host, guest, ro in mounts: cmd += ["-v", f"{host}:{guest}{':ro' if ro else ''}"]
        cmd += ["-v", f"{PW_HOST_MODULES}:{PW_HOST_MODULES}:ro", self.args.pw_image, "bash", "-c", script]
        return self.sh(stage, cmd, timeout=timeout)

    # -- stage runner ----------------------------------------------------------------------
    def stage(self, name, fn):
        if name not in self.stages: return
        t = time.time()
        print(f"[{name}] start", flush=True)
        try:
            note = fn() or ""
            self.results[name] = {"status": "ok", "seconds": round(time.time() - t, 1), "note": note, "log": self.log_path(name)}
            print(f"[{name}] ok {note}", flush=True)
        except Skip as s:
            self.results[name] = {"status": "skipped", "seconds": round(time.time() - t, 1), "note": str(s), "log": self.log_path(name)}
            print(f"[{name}] skipped: {s}", flush=True)
        except Partial as pa:
            self.results[name] = {"status": "partial", "seconds": round(time.time() - t, 1), "note": str(pa)[:900], "log": self.log_path(name)}
            print(f"[{name}] PARTIAL: {str(pa)[:300]}", flush=True)
        except Exception as e:
            self.results[name] = {"status": "failed", "seconds": round(time.time() - t, 1), "note": str(e)[:900], "log": self.log_path(name)}
            print(f"[{name}] FAILED: {str(e)[:300]}", flush=True)

    def transport_note(self):
        """Which HTTP transport the collectors used. Browser-impersonating TLS (curl_cffi) is the reference setup;
        a plain-requests fallback is reported so a thinner Reddit/social harvest is never mistaken for a quiet month."""
        if "transport" in self.facts: return self.facts["transport"]
        plain = []
        for st in ("collect", "reddit", "social"):
            lp = self.log_path(st)
            if st in self.results and os.path.exists(lp) and "curl_cffi unavailable" in open(lp, encoding="utf-8", errors="ignore").read(): plain.append(st)
        self.facts["transport"] = {"collectors_run": [st for st in ("collect", "reddit", "social") if st in self.results], "plain_requests": plain,
                                   "note": ("stages " + ", ".join(plain) + " ran WITHOUT browser-impersonating TLS (curl_cffi could not load): the public feeds and APIs still answer, but Reddit may answer less; compare the per-channel counts with a reference run before reading a low number as a quiet month" if plain else "curl_cffi (browser-impersonating TLS), the reference setup")}
        return self.facts["transport"]

    # -- stages ----------------------------------------------------------------------------
    def collector(self, stage, script):
        """Run a collector with a time budget 2 min under the stage timeout: it then ends PARTIAL (exit 0, records kept,
        the log says where it stopped) instead of being killed at the timeout with nothing recorded. Returns the PARTIAL note or None."""
        budget = max(60, self.args.collect_minutes * 60 - 120)
        os.environ["RSR_TIME_BUDGET"] = str(budget)
        self.py(stage, script, timeout=self.args.collect_minutes * 60 + 180)
        try: log = open(self.log_path(stage), encoding="utf-8", errors="ignore").read()
        except OSError: log = ""
        m = re.search(r"PARTIAL: (.*)", log)
        return m.group(1).strip()[:300] if m else None

    def s_collect(self):
        before = {c: len(load_jsonl(self.p("raw", c + ".jsonl"))) for c in RAW_CHANNELS}
        partial = self.collector("collect", "collect.py")
        after = {c: len(load_jsonl(self.p("raw", c + ".jsonl"))) for c in RAW_CHANNELS}
        self.facts["collect_delta"] = {c: after[c] - before[c] for c in RAW_CHANNELS if after[c] != before[c]}
        note = f"new records: {self.facts['collect_delta']}"
        if partial: raise Partial(note + " — stopped early: " + partial + f" (raise --collect-minutes, now {self.args.collect_minutes}, for a fuller pass)")
        return note

    def s_reddit(self):
        before = len(load_jsonl(self.p("raw", "reddit_web.jsonl")))
        partial = self.collector("reddit", "collect_reddit.py")
        after = len(load_jsonl(self.p("raw", "reddit_web.jsonl")))
        note = f"reddit_web.jsonl +{after - before}"
        if partial: raise Partial(note + " — stopped early: " + partial)
        return note

    def s_social(self):
        chans = ["bluesky", "mastodon", "lemmy", "youtube", "bingweb", "ddg"]
        before = {c: len(load_jsonl(self.p("raw", c + ".jsonl"))) for c in chans}
        partial = self.collector("social", "collect2.py")
        after = {c: len(load_jsonl(self.p("raw", c + ".jsonl"))) for c in chans}
        note = "new: " + json.dumps({c: after[c] - before[c] for c in chans})
        if partial: raise Partial(note + " — stopped early: " + partial)
        return note

    def prune_periods(self):
        """Remove build/periods/<id> folders that no ledger run owns and that hold no entries (left by a run that failed
        or had an empty window, e.g. a first run started on the same day). The current window and every committed run are kept."""
        pdir = self.p("build", "periods")
        if not os.path.isdir(pdir): return []
        try: runs = {r["id"] for r in (json.load(open(self.p("build", "state.json"), encoding="utf-8")).get("runs") or [])}
        except Exception: runs = set()
        removed = []
        for d in sorted(os.listdir(pdir)):
            full = os.path.join(pdir, d)
            if not os.path.isdir(full) or d in runs or d == self.period["id"] or not re.fullmatch(r"\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}", d): continue
            pj = os.path.join(full, "period.json")
            try: empty = not json.load(open(pj, encoding="utf-8")).get("incidents")
            except Exception: empty = True
            if empty:
                shutil.rmtree(full, ignore_errors=True); removed.append(d)
        if removed: print(f"[period] removed {len(removed)} empty period folder(s) from earlier runs: {', '.join(removed)}", flush=True)
        self.facts["period"]["removed_empty_periods"] = removed
        return removed

    def s_period(self):
        if not self.period: self.set_period()
        P = self.period
        self.prune_periods()
        a = ["--from", P["frm"], "--to", P["to"], "--no-state"]
        if self.args.no_llm: a.append("--no-llm")
        if self.args.model: os.environ["RSR_MODEL"] = self.args.model
        self.py("period", "period.py", *a, timeout=3600)
        pj = os.path.join(P["dir"], "period.json")
        if not os.path.exists(pj): raise RuntimeError(f"period.py wrote no {pj}")
        d = json.load(open(pj, encoding="utf-8"))
        kinds = collections.Counter(i["kind"] for i in d["incidents"])
        self.facts["period"].update({"in_window": d["counts"]["in_window"], "relevant": d["counts"]["relevant"], "incidents": d["counts"]["incidents"],
                                     "kinds": dict(kinds), "regions": d["stats"]["regions"], "sources": len(d["sources"]), "news": d["stats"]["news_total"],
                                     "social": d["stats"]["social_total"], "leaks": d["stats"]["leak_total"], "hibp": d["stats"]["hibp_total"],
                                     "top": [(i["name"], i["weight"], i["status"]) for i in d["incidents"][:8]],
                                     "summaries_by": "llm" if any(i.get("summary_by") == "llm" for i in d["incidents"]) else "rules",
                                     "coverage": {c: v["in_window"] for c, v in d["coverage"].items()}})
        if not d["incidents"]: return f"window {P['frm']}..{P['to']}: {d['counts']['in_window']} dated records, none relevant (nothing new this period)"
        return f"window {P['frm']}..{P['to']}: {d['counts']['in_window']} records -> {d['counts']['incidents']} entries ({dict(kinds)}), summaries by {self.facts['period']['summaries_by']}"

    def s_geo(self):
        os.makedirs(self.p("raw", "geo"), exist_ok=True)
        for f in ("countries-110m.json", "land-110m.json"):
            dst = self.p("raw", "geo", f)
            if not os.path.exists(dst) or self.args.force:
                self.sh("geo", ["curl", "-sSL", "--max-time", "60", "-o", dst, WORLD_ATLAS + f])
        full, simp = self.p("build", "geo.json"), self.p("build", "geo_s.json")
        if self.args.force or not os.path.exists(simp):
            self.py("geo", "topo2poly.py", self.p("raw", "geo", "countries-110m.json"), full, "0")
            self.py("geo", "topo2poly.py", self.p("raw", "geo", "countries-110m.json"), simp, str(GEO_TOL))
        g = json.load(open(simp))
        pts = sum(len(r) for c in g["countries"] for r in c["rings"])
        self.facts["geo"] = {"countries": len(g["countries"]), "points": pts, "bytes": os.path.getsize(simp)}
        return f"{len(g['countries'])} countries, {pts} points"

    def s_shots(self):
        if self.period:
            lst, sdir = os.path.join(self.period["dir"], "shots.json"), os.path.join(self.period["dir"], "shots")
            if not os.path.exists(lst): raise Skip("no period shots.json (period stage did not run)")
        else: lst, sdir = self.p("build", "shots", "list.json"), self.p("build", "shots")
        if not os.path.exists(lst): raise Skip("build/shots/list.json missing (the PDF's evidence screenshot list)")
        os.makedirs(sdir, exist_ok=True)
        items = json.load(open(lst))
        if not items: return "no screenshots listed for this period"
        missing = [i["id"] for i in items if not os.path.exists(os.path.join(sdir, i["id"] + ".png"))]
        self.facts["shots"] = {"listed": len(items), "missing_before": missing}
        if not missing and not self.args.force: return f"all {len(items)} screenshots present"
        be, why = self.browser()
        if not be: raise Skip(why)
        if self.args.force or len(missing) == len(items): todo = items
        else: todo = [i for i in items if i["id"] in missing]
        tmp = os.path.join(self.dir, "shots_todo.json"); json.dump(todo, open(tmp, "w"))
        if be == "local":
            self.rsr_browser("shots", "shots", tmp, sdir, timeout=3600)
        else:
            self.docker("shots", [(self.p("build", "pw"), "/pw", True), (sdir, "/shots", False), (self.dir, "/run", False)],
                        "node /pw/render.mjs shots /run/shots_todo.json /shots", timeout=3600)
        still = [i["id"] for i in items if not os.path.exists(os.path.join(sdir, i["id"] + ".png"))]
        self.facts["shots"]["missing_after"] = still
        return f"captured {len(todo) - len(still)}/{len(todo)}; still missing: {still}"

    def s_site(self):
        if self.period:
            if not os.path.exists(os.path.join(self.period["dir"], "period.json")): raise Skip("no period.json (period stage did not run)")
            self.py("site", "build_period_site.py", self.period["id"])
        else: self.py("site", "build_site.py")
        out = self.site_path()
        html = open(out, encoding="utf-8").read()
        self.facts["site"] = {"path": out, "bytes": os.path.getsize(out), "sha256": sha256(out),
                              "light_charts": html.count('class="chv l"'), "theme_attr": html.count("data-theme"),
                              "theme_button": html.count("themeBtn"), "cdn_refs": len(re.findall(r'https?://[^"\']+\.(?:js|css)', html))}
        tail = ""
        if self.period:          # the period now has an output: advance the ledger, unless the primary collection plainly failed
            status = {st: self.results.get(st, {}).get("status") for st in ("collect", "reddit", "social")}
            failed = [st for st, v in status.items() if v == "failed"]
            partial = [st for st, v in status.items() if v == "partial"]
            warn = []
            if failed: warn.append(", ".join(failed) + " failed (" + "; ".join(self.results[st]["note"].splitlines()[0][:120] for st in failed) + ")")
            if partial: warn.append(", ".join(partial) + " stopped on the time budget (" + "; ".join(self.results[st]["note"].split("stopped early: ", 1)[-1][:120] for st in partial) + ")")
            redo = f"redo this window with --period-from {self.period['frm']} --period-to {self.period['to']} after fixing it"
            if status["collect"] == "failed": tail = f"; state.json NOT advanced (collect failed; re-run to cover {self.period['frm']}..{self.period['to']})"
            elif not self.facts["period"].get("in_window"): tail = "; state.json NOT advanced (no dated records in the window: a collection gap, not a quiet period)"
            elif self.commit_period(): tail = f"; state.json last_end -> {self.period['to']}" + (f"; COLLECTION WARNING: {' / '.join(warn)} — the window is built from what was fetched; {redo}" if warn else "")
            self.facts["period"]["state_note"] = tail.lstrip("; ")
            self.facts["period"]["collection_warnings"] = warn
        return f"{self.facts['site']['bytes']//1024} KB, {self.facts['site']['light_charts']} dual-theme charts" + tail

    def s_check(self):
        be, why = self.browser()
        if not be: raise Skip(why)
        site = self.site_path()
        if not os.path.exists(site): raise Skip(f"no {site}")
        shots = os.path.join(self.dir, "site_shots"); os.makedirs(shots, exist_ok=True)
        res = {}
        for theme in ("dark", "light"):
            logp = os.path.join(shots, f"{theme}.log")
            if be == "local":
                cmd = [self.python, "-P", self.p("scripts", "rsr_browser.py"), "check", site + f"?theme={theme}", os.path.join(shots, theme)]
                for attempt in (1, 2):   # a wedged Chromium (watchdog exit / timeout) gets one fresh process
                    try:
                        with open(logp, "w") as lf: rc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, timeout=480).returncode
                    except subprocess.TimeoutExpired: rc = 124
                    with open(self.log_path("check"), "a") as lf: lf.write(f"$ {' '.join(cmd)}  [attempt {attempt}]\n" + open(logp, errors="ignore").read())
                    if rc == 0 or "errors:" in open(logp, errors="ignore").read(): break
            else:
                rc, _ = self.docker("check", [(self.p("build", "pw"), "/pw", True), (os.path.dirname(site), "/site", True), (shots, "/out", False)],
                                    f"node /pw/check.mjs '/site/index.html?theme={theme}' /out/{theme} > /out/{theme}.log 2>&1", timeout=600)
            txt = open(logp, errors="ignore").read()
            m = re.search(r"page height (\d+)", txt); e = re.search(r"errors: (\d+)", txt)
            res[theme] = {"height": int(m.group(1)) if m else None, "console_errors": int(e.group(1)) if e else None, "rc": rc,
                          "shots": sorted(f for f in os.listdir(shots) if f.startswith(theme + "_"))}
        self.facts["check"] = res
        hung = [t for t, r in res.items() if r["console_errors"] is None]
        if hung: raise Skip(f"console check could not run for {hung} (Chromium crashed or hung twice; site and PDF are unaffected) — see check.log")
        bad = [t for t, r in res.items() if r["console_errors"] != 0 or r["rc"] != 0]
        if bad: raise RuntimeError(f"theme check failed for {bad}: {res}")
        return f"dark/light heights {res['dark']['height']}/{res['light']['height']}, 0 console errors"

    def s_pdf(self):
        be, why = self.browser()
        if not be: raise Skip(why)
        os.environ["RSR_BROWSER"] = be
        if self.period:
            if not os.path.exists(os.path.join(self.period["dir"], "period.json")): raise Skip("no period.json (period stage did not run)")
            self.py("pdf", "build_period_pdf.py", self.period["id"], timeout=1800)
        else: self.py("pdf", "build_pdf.py", timeout=1800)
        src = os.path.join(self.pdf_dir(), "report.pdf")
        dst = os.path.join(self.pdf_dir(), self.pdf_name())
        shutil.copyfile(src, dst)
        self.facts["pdf"] = {"path": dst, "bytes": os.path.getsize(dst), "sha256": sha256(dst), "pages": pdf_pages(dst),
                             "previews": sorted(f for f in os.listdir(self.pdf_dir()) if f.startswith("preview_"))}
        return f"{os.path.getsize(dst)//1024} KB, {self.facts['pdf']['pages']} pages -> {self.pdf_name()}"

    def s_verify(self):
        f = self.facts
        # raw coverage
        cov = {}
        for c in RAW_CHANNELS:
            recs = load_jsonl(self.p("raw", c + ".jsonl"))
            y26 = sum(1 for r in recs if str(r.get("published") or r.get("date") or r.get("created") or r.get("ts") or "").startswith("2026"))
            cov[c] = {"records": len(recs), "in_2026": y26}
        f["coverage"] = cov
        # unique 2026 news titles (same rule as the report's "unique 2026 news titles read")
        seen, news = set(), []
        for r in load_jsonl(self.p("raw", "gnews.jsonl")) + load_jsonl(self.p("raw", "bingnews.jsonl")):
            t = re.sub(r"\s+-\s+[^-]{2,40}$", "", r.get("title") or "").strip().lower()
            if t and t not in seen and (r.get("published") or "").startswith("2026"): seen.add(t); news.append(r)
        f["news"] = {"unique_2026_titles": len(news),
                     "by_month": sorted(collections.Counter(r["published"][:7] for r in news).items()),
                     "top_outlets": collections.Counter(r.get("source") for r in news).most_common(12)}
        # curated register integrity
        sys.path.insert(0, self.p("scripts"))
        try:
            import report_sources as S, report_incidents as I  # noqa
            keys = set(S.SOURCES)
            missing = sorted({k for inc in I.INCIDENTS for k in inc.get("src", inc.get("sources", [])) if k not in keys})
            f["register"] = {"sources": len(S.SOURCES), "incidents": len(I.INCIDENTS),
                             "by_region": sorted(collections.Counter(i.get("region") for i in I.INCIDENTS).items()),
                             "by_category": sorted(collections.Counter(i.get("cat") for i in I.INCIDENTS).items()),
                             "by_status": sorted(collections.Counter(i.get("status") for i in I.INCIDENTS).items()),
                             "missing_source_keys": missing, "quotes": len(getattr(I, "QUOTES", [])), "vendors": len(getattr(I, "VENDORS", []))}
        except Exception as e:
            f["register"] = {"error": repr(e)}
        # outputs on disk (may pre-date this run)
        site = self.site_path()
        if os.path.exists(site) and "site" not in f:
            html = open(site, encoding="utf-8").read()
            f["site"] = {"path": site, "bytes": os.path.getsize(site), "sha256": sha256(site), "light_charts": html.count('class="chv l"'),
                         "theme_attr": html.count("data-theme"), "theme_button": html.count("themeBtn"), "prebuilt": True}
        pdf = os.path.join(self.pdf_dir(), self.pdf_name()) if os.path.exists(os.path.join(self.pdf_dir(), self.pdf_name())) else os.path.join(self.pdf_dir(), "report.pdf")
        if os.path.exists(pdf):
            head = open(pdf, "rb").read(8)
            info = f.setdefault("pdf", {"path": pdf, "bytes": os.path.getsize(pdf), "sha256": sha256(pdf), "prebuilt": True})
            info["magic_ok"] = head.startswith(b"%PDF-")
            info["pages"] = pdf_pages(pdf)
            info["name_has_pdf_ext"] = os.path.basename(pdf).lower().endswith(".pdf")
        problems = []
        if f.get("register", {}).get("missing_source_keys"): problems.append("incidents cite unknown source keys")
        if "pdf" in f and not f["pdf"].get("magic_ok", True): problems.append("pdf magic bytes wrong")
        if "site" in f and f["site"].get("light_charts", 0) == 0: problems.append("site has no light-theme charts")
        if self.period and "period" in f and "incidents" in f["period"]:
            pj = os.path.join(self.period["dir"], "period.json")
            d = json.load(open(pj, encoding="utf-8")) if os.path.exists(pj) else {"incidents": [], "sources": {}}
            dangling = sorted({k for i in d["incidents"] for k in i["src"] if k not in d["sources"]})
            out_of_window = [i["name"] for i in d["incidents"] if not (self.period["frm"] <= i["date"] <= self.period["to"])]
            f["period"]["verify"] = {"dangling_source_keys": dangling, "dated_outside_window": out_of_window}
            if dangling: problems.append("period entries cite unknown source keys")
            if out_of_window: problems.append("period entries dated outside the window")
        if problems: raise RuntimeError("; ".join(problems))
        if self.period: return f"period {self.period['id']}: {f['period'].get('incidents', 0)} entries, {f['period'].get('sources', 0)} sources; register import {'ok' if 'error' not in f.get('register', {}) else 'failed'}"
        return f"{f['news']['unique_2026_titles']} unique 2026 titles, {f.get('register', {}).get('sources', '?')} sources, {f.get('register', {}).get('incidents', '?')} incidents"

    def s_publish(self):
        if not self.args.publish: raise Skip("--publish not set")
        if shutil.which("tm8") is None: raise Skip("tm8 CLI not on PATH")
        rec = {}
        def tm8(*a, stdin=None):
            p = subprocess.run(["tm8", *a], input=stdin, capture_output=True, text=True, cwd=self.project)
            with open(self.log_path("publish"), "a") as lf: lf.write(f"$ tm8 {' '.join(a)}\n{p.stdout}{p.stderr}\n")
            if p.returncode != 0: raise RuntimeError(f"tm8 {a[0]} {a[1] if len(a)>1 else ''} failed: {(p.stderr or p.stdout)[:400]}")
            return p.stdout
        def find_id(text):
            m = re.search(r'"id"\s*:\s*"([0-9a-f-]{36})"', text) or re.search(r"\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b", text)
            return m.group(1) if m else None
        site_dir = os.path.dirname(self.site_path())
        if self.period:
            P = self.period
            summary = (f"Monthly retail-security report for {P['frm']} to {P['to']}, built automatically from the period's public evidence: named incidents, country roundups, leak-site listings (as claims) and HIBP loads, "
                       "with a 3D globe, charts, timeline, social voices, method and a numbered evidence index; light and dark themes.")
            wtu = f"Open when asked what happened in retail security between {P['frm']} and {P['to']}; the annual report covers 1 Jan–16 Oct 2026."
        else: summary = ("Self-contained HTML (no CDN) in light AND dark themes (toggle in the sticky nav, system default, remembered per browser, ?theme=light|dark): "
                   "canvas 3D incident globe with filters, isometric SVG charts, month timeline, actors, vendors, social voices, market table, method and a numbered evidence index.")
        if not self.period: wtu = "Open when briefing or deciding on 2026 retail security: incidents, threats, regions (Middle East first), actors, vendors and the numbered evidence behind each claim."
        art_name = f"Retail Security Monthly — {self.period['frm']} to {self.period['to']}" if self.period else "Retail Security 2026 — interactive report"
        if os.path.exists(os.path.join(site_dir, "index.html")):
            if self.args.artifact and not self.period:
                ver = json.loads(tm8("entity", "get", self.args.artifact, "--format", "json").split("\n[journal")[0])["version"]
                out = tm8("artifact", "publish", site_dir, "--artifact", self.args.artifact, "--expect-version", str(ver), "--summary", summary, "--when-to-use", wtu)
                rec["artifact"] = {"id": self.args.artifact, "revision_from": ver, "receipt": out.strip()[-300:]}
            else:
                out = tm8("artifact", "publish", site_dir, "--name", art_name, "--summary", summary, "--when-to-use", wtu,
                          "--keyword", "retail", "--keyword", "security", "--keyword", "2026", "--keyword", "report")
                rec["artifact"] = {"id": find_id(out), "receipt": out.strip()[-300:]}
                if self.args.task and rec["artifact"]["id"]: tm8("edge", "create", self.args.task, "produces", rec["artifact"]["id"])
        pdf = self.facts.get("pdf", {}).get("path")
        if pdf and os.path.exists(pdf):
            out = tm8("file", "upload", pdf, "--name", self.pdf_name(), "--mime", "application/pdf", "--format", "json")
            fid = find_id(out)
            rec["pdf_file"] = {"id": fid, "name": self.pdf_name()}
            if fid:
                tm8("entity", "header", "set", fid, "--when-to-use", (f"Open when the printable monthly retail-security report for {self.period['frm']} to {self.period['to']} (PDF) is needed." if self.period else "Open when the printable Retail Security 2026 report (PDF) is needed; the interactive version is the artifact."),
                    "--summary", f"PDF report built by the retail-security-report tool, run {self.id}.", "--keyword", "retail", "--keyword", "security", "--keyword", "pdf")
                if self.args.task: tm8("edge", "create", self.args.task, "produces", fid)
        if self.args.task:
            body = self.summary_text(rec)
            tm8("message", "send", "--to", self.args.task, "-", "--wait", "stored", stdin=body[:9900])
            rec["task_message"] = "posted"
        self.facts["publish"] = rec
        return json.dumps({k: (v.get("id") if isinstance(v, dict) else v) for k, v in rec.items()})

    # -- report ------------------------------------------------------------------------------
    def p(self, *a): return os.path.join(self.project, *a)

    def summary_text(self, rec=None):
        f = self.facts
        lines = [f"retail-security-report run {self.id} on {platform.node()} — project {self.project}" + (f" — MONTHLY {self.period['frm']}..{self.period['to']}" if self.period else ""), ""]
        if "period" in f and "incidents" in f["period"]:
            P = f["period"]; lines.append(f"- period: {P['in_window']} dated records -> {P['relevant']} relevant -> {P['incidents']} entries {json.dumps(P['kinds'])}; {P['sources']} sources; summaries by {P['summaries_by']}; state advanced: {P.get('state_advanced')}")
            for name, w, stt in P["top"][:5]: lines.append(f"  - {name} ({stt}, weight {w})")
            if P.get("collection_warnings"): lines.append("- COLLECTION WARNING: " + " / ".join(P["collection_warnings"]))
        T = self.transport_note()
        if T["collectors_run"]: lines.append(("- TRANSPORT WARNING: " if T["plain_requests"] else "- transport: ") + T["note"])
        for s in ALL_STAGES:
            r = self.results.get(s)
            if r: lines.append(f"- {s}: {r['status']} ({r['seconds']}s) {r['note'][:160]}")
        if "news" in f: lines.append(f"- evidence: {f['news']['unique_2026_titles']} unique 2026 news titles; register {f.get('register',{}).get('sources','?')} sources / {f.get('register',{}).get('incidents','?')} incidents")
        if "site" in f: lines.append(f"- site: {f['site']['bytes']} bytes sha256 {f['site']['sha256'][:12]}… light charts {f['site'].get('light_charts')}")
        if "pdf" in f: lines.append(f"- pdf: {os.path.basename(f['pdf']['path'])} {f['pdf'].get('pages','?')} pages {f['pdf']['bytes']} bytes sha256 {f['pdf']['sha256'][:12]}…")
        if rec: lines.append(f"- published: {json.dumps({k: (v.get('id') if isinstance(v, dict) else v) for k, v in rec.items()})}")
        lines.append(f"- local report: {os.path.join(self.dir, 'report.md')}")
        return "\n".join(lines)

    def write_report(self):
        f = self.facts
        total = round(time.time() - self.started, 1)
        worst = "failed" if any(r["status"] == "failed" for r in self.results.values()) else ("ok (partial collection: " + ", ".join(s for s, r in self.results.items() if r["status"] == "partial") + ")" if any(r["status"] == "partial" for r in self.results.values()) else "ok")
        title = f"Retail Security Monthly {self.period['frm']} → {self.period['to']} — run {self.id}" if self.period else f"Retail Security 2026 — pipeline run {self.id}"
        md = [f"# {title}", "",
              f"- Result: **{worst}** in {total}s on `{platform.node()}`", f"- Project: `{self.project}`",
              f"- Stages requested: {', '.join(self.stages)}", f"- Run directory: `{self.dir}`", "",
              "## Stages", "", "| stage | status | seconds | note |", "|---|---|---:|---|"]
        for s in ALL_STAGES:
            r = self.results.get(s)
            if r: md.append(f"| {s} | {r['status']} | {r['seconds']} | {r['note'].replace('|', '/').replace(chr(10), ' ')[:300]} |")
        if "coverage" in f:
            md += ["", "## Evidence coverage (raw/)", "", "| channel | records | dated 2026 |", "|---|---:|---:|"]
            md += [f"| {c} | {v['records']} | {v['in_2026']} |" for c, v in f["coverage"].items()]
            n = f["news"]
            md += ["", f"Unique 2026 news titles (Google News + Bing News, de-duplicated by title): **{n['unique_2026_titles']}**", "",
                   "| month | titles |", "|---|---:|"] + [f"| {m} | {k} |" for m, k in n["by_month"]]
            md += ["", "Top outlets: " + ", ".join(f"{o} ({k})" for o, k in n["top_outlets"])]
        if "collect_delta" in f: md += ["", ("New raw records this run: `" if self.period else "New raw records this run (to triage into the register): `") + json.dumps(f["collect_delta"]) + "`"]
        if "period" in f:
            P = f["period"]
            md += ["", f"## Period {P['frm']} → {P['to']}", "", f"- Window: {P['frm']} to {P['to']} (previous ledger end {P.get('last_end_before')}; " + (f"advanced to {P['to']}" if P.get("state_advanced") else "ledger NOT advanced — " + (P.get("state_note") or "re-run after fixing the failed stage")) + ")"]
            if P.get("collection_warnings"): md.append("- **Collection warning:** " + " / ".join(P["collection_warnings"]) + f". The entries below come from what was fetched; to redo the window completely run with --period-from {P['frm']} --period-to {P['to']} (and a larger --collect-minutes).")
            if P.get("removed_empty_periods"): md.append("- Removed empty period folders left by earlier runs: " + ", ".join(P["removed_empty_periods"]))
            if P.get("note"): md.append(f"- Note: {P['note']}")
            if "incidents" in P:
                md += [f"- Dated records in window: {P['in_window']}; relevant after the retail + security filter: {P['relevant']}; entries built: **{P['incidents']}** " + ", ".join(f"{k} {v}" for k, v in P["kinds"].items()),
                       f"- News titles {P['news']}, social posts {P['social']}, leak-site listings {P['leaks']}, HIBP loads {P['hibp']}; {P['sources']} cited sources; summaries by {P['summaries_by']}",
                       "- By region: " + ", ".join(f"{r} {k}" for r, k in P["regions"]),
                       "- Records per channel in window: " + ", ".join(f"{c} {v}" for c, v in P["coverage"].items() if v)]
                T = self.transport_note()
                if T["collectors_run"]: md.append(("- **Transport warning:** " if T["plain_requests"] else "- Transport: ") + T["note"])
                md += ["", "Top entries:", ""]
                md += [f"{j+1}. {name} — {stt}, weight {w}" for j, (name, w, stt) in enumerate(P["top"])]
                if P.get("verify"): md.append(f"\nVerify: dangling source keys {P['verify']['dangling_source_keys'] or 'none'}; entries dated outside the window {P['verify']['dated_outside_window'] or 'none'}")
            md += ["", "Outputs live under `build/periods/" + P["id"] + "/` (period.json, candidates.md, site/index.html, pdf/). The next run without --period-from starts on " + (dt.date.fromisoformat(P["to"]) + dt.timedelta(days=1)).isoformat() + "."]
        if "register" in f:
            r = f["register"]
            md += ["", "## Curated register (scripts/report_*.py)", ""]
            if "error" in r: md.append(f"Could not import the register: `{r['error']}`")
            else:
                md += [f"- {r['sources']} sources, {r['incidents']} incidents, {r['quotes']} social quotes, {r['vendors']} vendors",
                       "- by region: " + ", ".join(f"{k} {v}" for k, v in r["by_region"]),
                       "- by category: " + ", ".join(f"{k} {v}" for k, v in r["by_category"]),
                       "- by status: " + ", ".join(f"{k} {v}" for k, v in r["by_status"]),
                       "- incidents citing unknown source keys: " + (", ".join(r["missing_source_keys"]) or "none")]
        if "geo" in f: md += ["", f"Globe geometry: {f['geo']['countries']} countries, {f['geo']['points']} points, {f['geo']['bytes']} bytes (tolerance {GEO_TOL})."]
        if "shots" in f: md += ["", f"Evidence screenshots: {f['shots']['listed']} listed; missing before run: {f['shots']['missing_before'] or 'none'}; missing after: {f['shots'].get('missing_after', f['shots']['missing_before']) or 'none'}."]
        md += ["", "## Outputs", ""]
        if "site" in f:
            s = f["site"]
            md += [f"- Interactive site: `{s['path']}` — {s['bytes']} bytes, sha256 `{s['sha256']}`" + (" (pre-built, not rebuilt this run)" if s.get("prebuilt") else ""),
                   f"  - dual-theme charts: {s.get('light_charts')}, theme attributes: {s.get('theme_attr')}, toggle button refs: {s.get('theme_button')}, external script/css refs: {s.get('cdn_refs', 'n/a')}"]
        if "check" in f:
            for t, r in f["check"].items():
                md.append(f"- Browser check `{t}`: page height {r['height']}, console errors {r['console_errors']}, screenshots {len(r['shots'])} in `{os.path.join(self.dir, 'site_shots')}`")
        if "pdf" in f:
            p = f["pdf"]
            md += [f"- PDF: `{p['path']}` — {p.get('pages', '?')} pages, {p['bytes']} bytes, sha256 `{p['sha256']}`, magic bytes {'ok' if p.get('magic_ok', True) else 'WRONG'}, name ends in .pdf: {p.get('name_has_pdf_ext', True)}" + (" (pre-built)" if p.get("prebuilt") else "")]
            if p.get("previews"): md.append(f"  - page previews: {len(p['previews'])} PNGs in `{os.path.relpath(self.pdf_dir(), self.project)}/`")
        if "publish" in f: md += ["", "## Published to tm8", "", "```", json.dumps(f["publish"], indent=1), "```"]
        if "browser" in f: md += ["", f"Browser backend: {f['browser']['used'] or 'none'} (requested {f['browser']['requested']}) {f['browser']['note']}"]
        if "python" in f:
            md += ["", f"Interpreter for pipeline scripts: `{f['python']['used']}` (runner `{f['python']['runner']}`); deps found: " + json.dumps(f['python']['deps'])]
        md += ["", "## How to read this", "",
               ("- Monthly mode: every entry above was built from the raw records dated inside the window; nothing is carried over from the annual register. Confirmed means a company, regulator or court is quoted; a leak-site listing is a claim." if self.period else
                "- Collection stages only refresh `raw/`; the incident register, source index and statistics are analyst-written files and are rebuilt as they stand. New raw records are counted above for triage."),
               "- `skipped` means the stage had nothing to do or its prerequisite (docker image, screenshot list) was absent; `failed` means it ran and broke — open the stage log.",
               "- Upload the PDF with a name ending in `.pdf` (the tool does); the tm8 download filename is the stored name, and phones pick the viewer from the extension.",
               "- Hard lines kept by every collector: no logins, no paywall bypass, no cart/checkout, no Tor, polite per-host pacing; a 403/429 wall is recorded, never worked around."]
        open(os.path.join(self.dir, "report.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
        json.dump({"run": self.id, "project": self.project, "stages": self.stages, "results": self.results, "facts": self.facts, "seconds": total},
                  open(os.path.join(self.dir, "run.json"), "w"), indent=1, default=str)
        latest = os.path.join(os.path.dirname(self.dir), "latest.md")
        try: shutil.copyfile(os.path.join(self.dir, "report.md"), latest)
        except Exception: pass
        return worst


class Skip(Exception): pass
class Partial(Exception): pass   # a collector stopped on its time budget (or Reddit kept rate-limiting): what it fetched is kept, the stage is "partial"


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="retail-security-report", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=env("RSR_PROJECT", "research/retail-security-2026"), help="pipeline directory holding scripts/, raw/, build/")
    ap.add_argument("--stages", default=env("RSR_STAGES", "build"), help="comma list of stages, or a set: all | build | collect | verify (default build)")
    ap.add_argument("--out", default=env("RSR_OUT"), help="where run reports go (default <project>/build/runs)")
    ap.add_argument("--publish", action="store_true", default=env_bool("RSR_PUBLISH"), help="publish site/PDF to tm8 and message the task")
    ap.add_argument("--artifact", default=env("RSR_ARTIFACT"), help="existing artifact id to publish a new revision of (else a new artifact)")
    ap.add_argument("--task", default=env("RSR_TASK"), help="tm8 task to link outputs to and report on")
    ap.add_argument("--force", action="store_true", default=env_bool("RSR_FORCE"), help="redo geo and screenshots even if present")
    ap.add_argument("--collect-minutes", type=int, default=int(env("RSR_COLLECT_MINUTES", "120")), help="timeout per collector stage")
    ap.add_argument("--browser", default=env("RSR_BROWSER", "auto"), choices=["auto", "docker", "local", "none"], help="browser backend for shots/check/pdf: docker (Playwright image), local (python-playwright), none (skip those stages); auto prefers docker when its image is present")
    ap.add_argument("--pw-image", default=env("RSR_PW_IMAGE", PW_IMAGE_DEFAULT), help="Playwright docker image for checks and PDF")
    ap.add_argument("--period-from", default=env("RSR_PERIOD_FROM"), help="monthly mode: window start YYYY-MM-DD (default: day after build/state.json last_end)")
    ap.add_argument("--period-to", default=env("RSR_PERIOD_TO"), help="monthly mode: window end YYYY-MM-DD (default: today UTC)")
    ap.add_argument("--first-from", default=env("RSR_FIRST_FROM", FIRST_FROM), help=f"monthly mode: start of the very first window when the ledger has no runs (default {FIRST_FROM}; '' = day after the annual cut-off)")
    ap.add_argument("--browser-channel", default=env("RSR_BROWSER_CHANNEL", "auto"), choices=["auto", "chromium", "chrome", "msedge"], help="local browser: auto = bundled Chromium, else installed Google Chrome, else Edge")
    ap.add_argument("--no-llm", action="store_true", default=env_bool("RSR_NO_LLM"), help="monthly mode: rule-built summaries even if ANTHROPIC_API_KEY is set")
    ap.add_argument("--model", default=env("RSR_MODEL"), help="monthly mode: Claude model for summaries (default claude-sonnet-5-5)")
    return ap.parse_args(argv)


def main(argv=None):
    try: args = parse_args(argv)
    except SystemExit as e: return 0 if e.code == 0 else 64
    project = os.path.abspath(args.project)
    if not os.path.isdir(os.path.join(project, "scripts")):
        print(f"error: {project} has no scripts/ directory; pass --project <dir> (the research/retail-security-2026 pipeline)", file=sys.stderr); return 2
    stages = STAGE_SETS.get(args.stages.strip(), [s.strip() for s in args.stages.split(",") if s.strip()])
    bad = [s for s in stages if s not in ALL_STAGES]
    if bad: print(f"error: unknown stage(s) {bad}; known: {ALL_STAGES}; sets: {list(STAGE_SETS)}", file=sys.stderr); return 64
    if (args.period_from or args.period_to) and "period" not in stages: print("error: --period-from/--period-to need the period stage (--stages monthly or monthly-build)", file=sys.stderr); return 64
    if args.publish and "publish" not in stages: stages.append("publish")
    if "report" not in stages: stages.append("report")
    os.environ["RSR_BROWSER_CHANNEL"] = args.browser_channel
    run = Run(project, os.path.abspath(args.out or os.path.join(project, "build", "runs")), stages, args)
    print(f"run {run.id} -> {run.dir}", flush=True)
    if "period" in stages:
        try: P = run.set_period()
        except SystemExit as e: print(e, file=sys.stderr); return 64
        print(f"monthly window {P['frm']} .. {P['to']}" + (f" ({P['note']})" if P["note"] else ""), flush=True)
    run.stage("collect", run.s_collect)
    run.stage("reddit", run.s_reddit)
    run.stage("social", run.s_social)
    run.stage("period", run.s_period)
    run.stage("geo", run.s_geo)
    run.stage("shots", run.s_shots)
    run.stage("site", run.s_site)
    run.stage("check", run.s_check)
    run.stage("pdf", run.s_pdf)
    run.stage("verify", run.s_verify)
    run.stage("publish", run.s_publish)
    worst = run.write_report()
    run.results["report"] = {"status": "ok", "seconds": 0, "note": os.path.join(run.dir, "report.md"), "log": ""}
    print(run.summary_text(run.facts.get("publish")))
    return 1 if worst == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
