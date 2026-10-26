#!/usr/bin/env python3
"""Local browser backend (python-playwright) for the Retail Security 2026 pipeline.

Same modes as build/pw/render.mjs + check.mjs, without docker:
  rsr_browser.py pdf   <html-path> <pdf-path> [footer]
  rsr_browser.py shot  <url|html-path> <png-path> [wait-ms]
  rsr_browser.py shots <list.json> <out-dir>
  rsr_browser.py check <html-path-or-file-url> <out-prefix>
  rsr_browser.py probe                       (exit 0 if Chromium launches and can render a page)
Needs:  pip install playwright && python -m playwright install chromium
        or, where Playwright has no Chromium build for the OS (e.g. macOS 12), an installed Google Chrome /
        Microsoft Edge: the launcher falls back to them (RSR_BROWSER_CHANNEL=auto|chromium|chrome|msedge).
If Chromium crashes (containers, minimal sandboxes) every mode relaunches once with
--single-process --no-zygote and retries; set RSR_CHROMIUM_ARGS to add flags up front.
"""
import faulthandler, functools, json, os, sys
print = functools.partial(print, flush=True)   # logs are read live from a redirected stdout
LAUNCH_TIMEOUT = int(os.environ.get("RSR_LAUNCH_TIMEOUT_MS", "60000"))

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
EXTRA_ARGS = os.environ.get("RSR_CHROMIUM_ARGS", "").split()
IN_CONTAINER = os.path.exists("/.dockerenv") or ("docker" in open("/proc/1/cgroup", errors="ignore").read() if os.path.exists("/proc/1/cgroup") else False)
if IN_CONTAINER and not os.environ.get("RSR_NO_CONTAINER_FLAGS"):
    EXTRA_ARGS = EXTRA_ARGS + [a for a in ("--single-process", "--no-zygote") if a not in EXTRA_ARGS]
FALLBACK_ARGS = ["--single-process", "--no-zygote"]
CHANNEL = os.environ.get("RSR_BROWSER_CHANNEL", "auto").strip().lower() or "auto"
CHANNELS = [None, "chrome", "msedge"] if CHANNEL == "auto" else [None if CHANNEL in ("chromium", "bundled") else CHANNEL]
USED_CHANNEL = {"v": None, "announced": False}


def _launch(pw, args, timeout):
    """Launch the first channel that exists: bundled Chromium, else Google Chrome, else Edge (same engine)."""
    errs = []
    order = ([USED_CHANNEL["v"]] + [c for c in CHANNELS if c != USED_CHANNEL["v"]]) if USED_CHANNEL["announced"] else CHANNELS
    for ch in order:
        try:
            b = pw.chromium.launch(args=args, timeout=timeout, **({"channel": ch} if ch else {}))
            if not USED_CHANNEL["announced"]:
                print("browser: using %s" % ({None: "bundled Chromium", "chrome": "Google Chrome", "msedge": "Microsoft Edge"}.get(ch, ch)))
                USED_CHANNEL.update(v=ch, announced=True)
            return b
        except Exception as e:
            m = str(e)
            errs.append("%s: %s" % (ch or "chromium", m.strip().splitlines()[0][:140] if m.strip() else m))
            if not any(k in m for k in ("Executable doesn't exist", "does not support", "not found", "No such file", "Chromium distribution")): raise
    raise RuntimeError("no Chromium-based browser launches (" + " | ".join(errs) + "). Install Google Chrome from https://www.google.com/chrome/ or run: python -m playwright install chromium")
FOOTER_TEXT = os.environ.get("RSR_FOOTER_TEXT") or "Retail Security 2026 · Middle East first, world ranked by trend · Product Intelligence · compiled 16 Oct 2026"
FOOTER = ('<div style="font-size:7.5px;color:#64748b;width:100%;margin:0 14mm;display:flex;justify-content:space-between;'
          'font-family:Arial,sans-serif"><span>' + FOOTER_TEXT.replace("<", "").replace(">", "").replace("&", "") +
          '</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>')
COOKIE_BTNS = ['button:has-text("Accept all")', 'button:has-text("Accept All")', 'button:has-text("Accept")', 'button:has-text("I agree")',
               'button:has-text("Agree")', '#onetrust-accept-btn-handler', 'button:has-text("OK")']


def _url(p):
    if p.startswith(("http://", "https://", "file://")): return p
    path, q = (p.split("?", 1) + [""])[:2]
    return "file://" + os.path.abspath(path) + ("?" + q if q else "")


def _is_crash(e):
    m = str(e).lower()
    return any(k in m for k in ("crash", "has been closed", "target closed", "frame was detached", "err_aborted"))


class Browser:
    """Chromium + one context, with a one-time relaunch using the container-safe flags after a crash."""
    def __init__(self, pw, ua=True):
        self.pw, self.ua, self.extra, self.b, self.ctx = pw, ua, list(EXTRA_ARGS), None, None
        self.open()

    def open(self):
        self.close()
        self.b = _launch(self.pw, ARGS + self.extra, LAUNCH_TIMEOUT)
        kw = {"viewport": {"width": 1440, "height": 900}, "device_scale_factor": 1}
        if self.ua: kw.update(user_agent=UA, locale="en-US")
        self.ctx = self.b.new_context(**kw)
        self.ctx.set_default_timeout(60000)

    def fallback(self, why=""):
        """Relaunch with FALLBACK_ARGS. Returns False if they were already in use (nothing more to try)."""
        if all(a in self.extra for a in FALLBACK_ARGS): return False
        print("browser: crashed (%s); relaunching with %s" % (why.strip().splitlines()[0][:90] if why else "?", " ".join(FALLBACK_ARGS)), flush=True)
        self.extra += [a for a in FALLBACK_ARGS if a not in self.extra]
        self.open()
        return True

    def page(self):
        return self.ctx.new_page()

    def close(self):
        try:
            if self.b: self.b.close()
        except Exception: pass
        self.b = self.ctx = None


def _run(fn, ua=True):
    """Run fn(page) in a fresh page; on a crash relaunch with the fallback flags and retry once."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = Browser(pw, ua)
        try:
            while True:
                try:
                    return fn(b.page())
                except Exception as e:
                    if _is_crash(e) and b.fallback(str(e)): continue
                    raise
        finally:
            b.close()


def pdf(inp, out, footer=False):
    def go(page):
        page.goto(_url(inp), wait_until="load", timeout=120000)
        page.wait_for_timeout(1500)
        page.emulate_media(media="print")
        m = {"top": "13mm", "bottom": "15mm", "left": "13mm", "right": "13mm"} if footer else {"top": "0", "bottom": "0", "left": "0", "right": "0"}
        page.pdf(path=out, format="A4", print_background=True, prefer_css_page_size=not footer, display_header_footer=footer,
                 header_template="<span></span>", footer_template=FOOTER, margin=m)
        print("pdf ok", out)
    _run(go)


def shot(inp, out, wait=2500):
    def go(page):
        page.goto(_url(inp), wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(int(wait))
        page.screenshot(path=out, full_page=False)
        print("shot ok", out)
    _run(go)


def probe():
    def go(page):
        page.set_content("<p>ok</p>")
        print("probe ok")
    _run(go, ua=False)


def shots(list_path, out_dir):
    """Capture every {id,url} in list.json as <out_dir>/<id>.png. A failure is logged and skipped."""
    from playwright.sync_api import sync_playwright
    items = json.load(open(list_path))
    os.makedirs(out_dir, exist_ok=True)
    ok = 0
    with sync_playwright() as pw:
        b = Browser(pw)
        try:
            i = 0
            while i < len(items):
                it = items[i]
                page = None
                try:
                    page = b.page()
                    page.goto(it["url"], wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(3500)
                    for sel in COOKIE_BTNS:
                        try:
                            btn = page.locator(sel).first
                            if btn.is_visible(timeout=300):
                                btn.click(timeout=1000); page.wait_for_timeout(600); break
                        except Exception: pass
                    title = page.title()
                    page.screenshot(path=os.path.join(out_dir, it["id"] + ".png"), full_page=False)
                    print("shot ok", it["id"], json.dumps(title)); ok += 1
                except Exception as e:
                    if _is_crash(e):
                        if b.fallback(str(e)): continue          # retry the same item with the safe flags
                        try: b.open()                            # already on safe flags: fresh browser, move on
                        except Exception as e2: print("browser: relaunch failed", str(e2)[:120])
                    print("shot FAIL", it["id"], str(e)[:160])
                finally:
                    try:
                        if page: page.close()
                    except Exception: pass
                i += 1
        finally:
            b.close()
    return ok


def check(inp, out_prefix):
    errors = []
    def go(page):
        errors.clear()
        page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
        page.on("console", lambda m: errors.append(m.type.upper() + " " + m.text) if m.type in ("error", "warning") else None)
        page.goto(_url(inp), wait_until="load", timeout=120000)
        page.wait_for_timeout(2500)
        print("page height", page.evaluate("document.body.scrollHeight"))
        page.screenshot(path=out_prefix + "_top.png", full_page=False)
        globe = page.query_selector("#globe")
        if globe:
            globe.scroll_into_view_if_needed(); page.wait_for_timeout(1200)
            page.screenshot(path=out_prefix + "_globe.png", full_page=False)
            box = globe.bounding_box()
            if box: page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); page.wait_for_timeout(500)
        for sel in ("#charts", "#middle-east", "#timeline", "#evidence"):
            el = page.query_selector(sel)
            if not el: print("missing", sel); continue
            el.scroll_into_view_if_needed(); page.wait_for_timeout(800)
            page.screenshot(path=out_prefix + "_" + sel[1:] + ".png", full_page=False)
        print("errors:", len(errors))
        for e in errors[:20]: print(e)
        return len(errors)
    return _run(go, ua=False)


HARD_TIMEOUTS = {"probe": 120, "pdf": 600, "shot": 180, "check": 240, "shots": 1800}   # seconds; watchdog, see below


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] not in ("pdf", "shot", "shots", "check", "probe"): print(__doc__); sys.exit(64)
    # Watchdog: Playwright's timeouts run inside its node driver, so when the driver itself wedges (seen in
    # containers after a renderer crash) the Python side would wait forever. Dump the stack and exit instead.
    hard = int(os.environ.get("RSR_HARD_TIMEOUT", "0")) or HARD_TIMEOUTS[a[0]]
    faulthandler.dump_traceback_later(hard, exit=True)
    print("rsr_browser %s (watchdog %ds)" % (a[0], hard))
    if a[0] == "probe":
        try: probe()
        except Exception as e:
            lines = [l.strip() for l in str(e).splitlines() if l.strip()]
            key = [l for l in lines if "error while loading" in l or "Executable doesn't exist" in l or "cannot open" in l or "install" in l.lower()]
            print("probe FAIL", (key or lines or ["?"])[0][:300]); sys.exit(1)
    elif a[0] == "pdf": pdf(a[1], a[2], "footer" in a[3:])
    elif a[0] == "shot": shot(a[1], a[2], a[3] if len(a) > 3 else 2500)
    elif a[0] == "shots": shots(a[1], a[2])
    else: check(a[1], a[2])
