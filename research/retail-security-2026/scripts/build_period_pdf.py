"""Build the monthly (period) PDF from build/periods/<id>/period.json: cover.html + body.html -> Chromium -> build/periods/<id>/pdf/report.pdf
(two passes so the contents page carries real page numbers). Same CSS, globe and chart modules as the annual PDF (report_assets, report_charts).
Usage: build_period_pdf.py <period-id>   e.g. 2026-10-01_2026-10-16   (RSR_BROWSER=auto|docker|local)"""
import json, os, sys, html, io, base64, subprocess, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from PIL import Image
import report_charts as C
from report_common import CAT, REGION_ORDER, CAT_ICON, icon
from report_assets import globe_svg as _globe_svg, PDF_CSS as CSS, COVER_CSS, PCAT

E = html.escape
def fdate(d): return datetime.date.fromisoformat(d).strftime("%d %b %Y")
def flong(d): return datetime.date.fromisoformat(d).strftime("%d %B %Y")
def n(v): return f"{v:,}"
def big(v): return f"{v/1e6:.1f}M" if v >= 1e6 else (f"{v/1e3:.0f}k" if v >= 1000 else str(v))

def build(pid):
    pdir = os.path.join(ROOT, "build", "periods", pid)
    P = json.load(open(os.path.join(pdir, "period.json"), encoding="utf-8"))
    PDF = os.path.join(pdir, "pdf"); os.makedirs(PDF, exist_ok=True)
    SHOTS = os.path.join(pdir, "shots")
    W = P["window"]; INC = P["incidents"]; SRC = P["sources"]; S = P["stats"]; CCN = P["cc_names"]; TL = P["theme_labels"]
    period_label = f"{flong(W['frm'])} – {flong(W['to'])}"
    short_label = f"{fdate(W['frm'])} – {fdate(W['to'])}"
    title_month = datetime.date.fromisoformat(W["to"]).strftime("%B %Y")
    generated = P["generated_at"][:10]
    GEO = json.load(open(os.path.join(ROOT, "build", "geo_s.json")))["countries"]

    # ---- citations: S-numbers in order of first use
    NUM, ORDER = {}, []
    def K(keys): return [k for k in keys if k in SRC]
    def cite(keys):
        out = []
        for k in K(keys):
            if k not in NUM: NUM[k] = len(ORDER) + 1; ORDER.append(k)
            out.append(f'<a href="#s{NUM[k]}">S{NUM[k]}</a>')
        return '<span class="cites">' + "".join(out) + '</span>'

    # ---- screenshots captured for this period (shots.json -> shots/<id>.png); placeholder when absent, never faked
    SHOT_LIST = {s["id"]: s for s in json.load(open(os.path.join(pdir, "shots.json"), encoding="utf-8"))} if os.path.exists(os.path.join(pdir, "shots.json")) else {}
    ABSENT, USED, _cache = [], [], {}
    def placeholder(sid, width=880, height=420):
        from PIL import ImageDraw
        im = Image.new("RGB", (width, height), (235, 238, 243)); d = ImageDraw.Draw(im)
        d.rectangle((0, 0, width-1, height-1), outline=(180, 186, 196), width=2)
        d.text((28, 150), "Screenshot not captured on this run", fill=(60, 70, 85))
        d.text((28, 180), "The page was not reachable from this machine; see the evidence index for the source.", fill=(100, 110, 125))
        d.text((28, 210), SHOT_LIST.get(sid, {}).get("url", sid)[:120], fill=(100, 110, 125))
        ABSENT.append(sid); return im
    def img64(sid, width=880, crop_h=900):
        if sid in _cache: return _cache[sid]
        path = os.path.join(SHOTS, sid + ".png")
        im = Image.open(path).convert("RGB") if os.path.exists(path) else placeholder(sid)
        if crop_h: im = im.crop((0, 0, im.width, min(im.height, crop_h)))
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        b = io.BytesIO(); im.save(b, "JPEG", quality=80, optimize=True)
        _cache[sid] = "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode(); return _cache[sid]
    def fig(sid):
        s = SHOT_LIST[sid]; USED.append(sid); inc = next((i for i in INC if i["id"] == sid), None)
        cap = E(s["title"]) + (f' — {E(inc["name"])} {cite(inc["src"][:1])}' if inc else "")
        return f'<figure class="shot"><img src="{img64(sid)}" alt="{E(s["title"])}"><figcaption>{cap}</figcaption></figure>'
    def figrow(*figs): return f'<div class="figrow{" one" if len(figs) == 1 else ""}">' + "".join(figs) + "</div>" if figs else ""
    def figs_for(region):
        ids = [sid for sid in SHOT_LIST if any(i["id"] == sid and i["region"] == region for i in INC)]
        out = ""
        for j in range(0, len(ids), 2): out += figrow(*[fig(x) for x in ids[j:j+2]])
        return out

    # ---- building blocks
    ST = {"confirmed": '<span class="st ok">confirmed</span>', "claimed": '<span class="st cl">reported, unconfirmed</span>', "context": '<span class="st cx">roundup / context</span>'}
    KIND = {"incident": "incident", "roundup": "roundup", "leak": "leak-site listing", "hibp": "breach load (HIBP)"}
    def pcard(i):
        color = PCAT[i["cat"]]; label = CAT[i["cat"]][0]
        sev = '<span class="sev">' + "".join('<i class="%s"></i>' % ("on" if j < i["sev"] else "") for j in range(5)) + "</span>"
        when = fdate(i["date"]) + (f' → {fdate(i["last"])}' if i.get("last") and i["last"] != i["date"] else "")
        meta = f'{KIND[i["kind"]]} · {i["n_news"]} news · {i["n_social"]} social'
        return (f'<div class="pc" style="--c:{color}"><div class="pch">{icon(CAT_ICON[i["cat"]], 11, color)}<b>{E(i["name"])}</b></div>'
                f'<div class="pcm"><span>{when}</span><span>{E(CCN.get(i["country"], i["country"]))}</span><span style="color:{color}">{E(label)}</span>{sev}{ST[i["status"]]}</div>'
                f'<div class="pct">{E(i["type"])} · <b>{E(i["impact"])}</b> · <span class="small">{meta}</span></div><p>{E(i["summary"])}</p><div class="pcf">{cite(i["src"])}</div></div>')
    def cards(items): return '<div class="pcg">' + "".join(pcard(i) for i in items) + "</div>" if items else '<p class="lede">No entries in this period.</p>'
    def tile(b, t, keys=()): return f'<div class="tile"><b>{E(str(b))}</b><span>{E(t)}</span>{cite(keys)}</div>'
    def by_region(r, kinds=("incident", "hibp", "roundup")): return [i for i in INC if i["region"] == r and i["kind"] in kinds]
    def scorecard(region):
        items = [i for i in INC if i["region"] == region]
        cats = {}
        for i in items: cats[i["cat"]] = cats.get(i["cat"], 0) + 1
        conf = sum(1 for i in items if i["status"] == "confirmed"); cl = sum(1 for i in items if i["status"] == "claimed")
        top = sorted(items, key=lambda i: -i["weight"])[:3]
        cs = " · ".join(f'<span style="color:{PCAT[c]}">{E(CAT[c][0])} {k}</span>' for c, k in sorted(cats.items(), key=lambda x: -x[1]))
        return (f'<div class="score"><div><b>{len(items)}</b><span>entries</span></div><div><b>{conf}</b><span>confirmed</span></div><div><b>{cl}</b><span>reported / claimed</span></div>'
                f'<div class="sc-cats">{cs}</div><div class="sc-top"><span>Most covered:</span> {"; ".join(E(t["name"]) for t in top)}</div></div>')
    def sec(num, id_, title, kicker, inner, first=False):
        return f'<section class="sec{" first" if first else ""}" id="{id_}"><span class="mk">@@{id_}@@</span><div class="kicker">{E(kicker)}</div><h1><span class="num">{num}</span>{E(title)}</h1>{inner}</section>'

    named = [i for i in INC if i["kind"] in ("incident", "hibp")]
    roundups = [i for i in INC if i["kind"] == "roundup"]
    leaks = [i for i in INC if i["kind"] == "leak"]
    top = sorted(named, key=lambda i: -i["weight"])[:6]
    n_conf = S["status"].get("confirmed", 0); n_cl = S["status"].get("claimed", 0); n_ctx = S["status"].get("context", 0)

    # ---- 01 executive summary (written from the data; every line cites its sources)
    findings = "".join(f'<li><b>{E(i["name"])}.</b> {E(i["summary"])} {cite(i["src"][:4])}</li>' for i in top)
    busiest = max(S["days"], key=lambda d: d[1]) if S["days"] else None
    exec_html = (f'<p class="lede">What the public record said about retail security between {short_label}: {len(INC)} entries built from {n(S["news_total"])} news titles, '
                 f'{n(S["social_total"])} social posts, {S["leak_total"]} leak-site listings and {S["hibp_total"]} Have I Been Pwned loads. Named incidents first, then country roundups, then leak-site claims kept as claims.</p>'
                 f'<div class="tiles six">{tile(len(named), "named incidents and breach loads")}{tile(len(roundups), "country / theme roundups")}{tile(len(leaks), "leak-site listings (claims)")}'
                 f'{tile(n_conf, "confirmed by the company, a regulator or a court")}{tile(n(S["hibp_accounts"]), "accounts in HIBP loads this period")}{tile(fdate(busiest[0]) if busiest else "—", f"busiest day ({busiest[1]} titles)" if busiest else "no dated news")}</div>'
                 f'<h2>Top stories of the period</h2><ol class="steps">{findings}</ol>'
                 f'<h2>Themes this period</h2><div class="two"><div class="panel">{C.hbars(S["themes"][:10], color="#b45309", title="Entries by theme", dark=False, w=700, label_w=260)}</div>'
                 f'<div class="panel">{C.hbars([(CCN.get(c, c), k) for c, k in S["countries"][:10]], color="#0369a1", title="Entries by country", dark=False, w=700, label_w=200)}</div></div>')

    # ---- 02 map + region × category matrix
    cats_order = ["cyber", "ot", "physical", "fraud", "geopolitical", "regulatory", "enforcement", "market"]
    regs = [r for r in REGION_ORDER + ["Global"] if any(i["region"] == r for i in INC)]
    regcount = {}
    for i in INC: regcount.setdefault(i["region"], {}).setdefault(i["cat"], 0); regcount[i["region"]][i["cat"]] += 1
    mrows = "".join(f'<tr><td><b>{E(r)}</b></td>' + "".join(f'<td class="c">{regcount[r].get(c, "") or "·"}</td>' for c in cats_order) + f'<td class="c"><b>{sum(regcount[r].values())}</b></td></tr>' for r in regs)
    matrix = f'<table class="tbl"><thead><tr><th>Region</th>' + "".join(f'<th style="color:{PCAT[c]}">{E(CAT[c][0])}</th>' for c in cats_order) + '<th>Total</th></tr></thead><tbody>' + mrows + '</tbody></table>'
    regions_html = (f'<p class="lede">Every entry placed at the retailer\'s home country, or the country the coverage is about; leak-site listings at the victim\'s country; global studies and HIBP loads under "Global". Marker size follows weight (news × outlets × social).</p>'
                    f'<div class="two"><div class="panel" style="text-align:center">{_globe_svg(GEO, [i for i in INC if i["country"] != "XX"], 40, 22, 520, False, "pm")}<div class="cap">Centred on the Gulf: Middle East first, as briefed.</div></div>'
                    f'<div class="panel">{C.donut(S["regions"], ["#0369a1","#b45309","#be123c","#0f766e","#6d28d9","#c2410c","#475569"], title="Regions", w=300, dark=False, unit="")}<div class="cap">{"; ".join(f"{r} {k}" for r, k in S["regions"])}</div></div></div>'
                    f'<h2>Region × category</h2>{matrix}')

    # ---- 03 Middle East, 04 world
    def region_block(r, h2=True):
        items = by_region(r); lk = [i for i in leaks if i["region"] == r]
        inner = (f'<h2>{E(r)}</h2>' if h2 else "") + scorecard(r) + figs_for(r) + cards(sorted(items, key=lambda i: (i["kind"] != "incident", -i["weight"])))
        if lk: inner += f'<h3>Leak-site listings naming {E(r)} victims (claims, not confirmed breaches)</h3><table class="tbl"><thead><tr><th>Victim</th><th>Country</th><th>Group</th><th>Listed</th><th>Src</th></tr></thead><tbody>' + "".join(f'<tr><td><b>{E(i["entity"])}</b></td><td>{E(CCN.get(i["country"], i["country"]))}</td><td>{E(i.get("group") or "unattributed")}</td><td class="d">{fdate(i["date"])}</td><td>{cite(i["src"][:2])}</td></tr>' for i in lk) + "</tbody></table>"
        return inner
    me_items = [i for i in INC if i["region"] == "Middle East"]
    me_html = (f'<p class="lede">Gulf and wider Middle East coverage in English and Arabic for {short_label}: {len(me_items)} entries. '
               + ("Thin coverage this period is itself a finding: it is what the public record showed, not a gap in collection." if len(me_items) < 6 else "Named retailers first, then country roundups, then leak-site claims.") + "</p>"
               + region_block("Middle East", h2=False))
    world_html = f'<p class="lede">Other regions in the briefed order, each with its scorecard; "Global" holds studies, vendor reports and HIBP loads without a single country.</p>' + "".join(region_block(r) for r in regs if r != "Middle East")

    # ---- 05 numbers
    L = dict(dark=False, w=700)
    days = C.iso_bars([(d[8:], k) for d, k in S["days"]], color="#0369a1", title=f"Retail-security news titles per day, {short_label}", label_size=8, **L)
    themes = C.hbars(S["themes"][:12], color="#b45309", title="Entries by theme", label_w=260, **L)
    outlets = C.hbars(S["outlets"][:12], color="#0f766e", title="Outlets with the most relevant titles", label_w=220, **L)
    groups = C.hbars([(g or "unattributed", k) for g, k in S["leak_groups"][:10]], color="#6d28d9", title="Leak-site listings by group (retail + Middle East scope)", label_w=200, **L)
    lcountries = C.hbars([(CCN.get(c, c), k) for c, k in S["leak_countries"][:10]], color="#be123c", title="Leak-site listings by victim country", label_w=200, **L)
    hibp = C.hbars([(h["name"], h["pwn"]) for h in S["hibp"][:10]], color="#0369a1", title="Breaches loaded to Have I Been Pwned this period (accounts)", fmt=big, label_w=220, **L) if S["hibp"] else '<p class="lede">No HIBP loads in this period.</p>'
    social = C.donut(S["social"], ["#0369a1","#c2410c","#b45309","#6d28d9","#0f766e","#475569","#be123c"], title="Social", w=280, dark=False, unit="")
    sevd = C.donut([(f"sev {k}", v) for k, v in sorted(S["sev"].items(), reverse=True)], ["#be123c","#c2410c","#b45309","#0369a1","#94a3b8"], title="Severity", w=280, dark=False, unit="")
    numbers_html = (f'<div class="two"><div class="panel">{days}<div class="cap">Dated titles from Google News and Bing News that pass the retail + security filter. Undated web-search hits are excluded from period counts.</div></div><div class="panel">{themes}</div></div>'
                    f'<div class="two"><div class="panel">{groups}<div class="cap">Source: ransomware.live listings in the period; a listing is a claim by a criminal group, never a confirmed breach.</div></div><div class="panel">{lcountries}</div></div>'
                    f'<div class="two"><div class="panel">{hibp}</div><div class="panel">{outlets}</div></div>'
                    f'<div class="two"><div class="panel"><div class="donuts"><div>{social}</div><div>{sevd}</div></div></div><div class="panel">{C.hbars([(TL.get(t, t), k) for t, k in S.get("cats", [])[:8]], color="#475569", title="Entries by category", label_w=200, **L)}</div></div>'
                    f'<div class="tiles six">{tile(n(S["news_total"]), "relevant news titles")}{tile(n(S["social_total"]), "relevant social posts")}{tile(S["leak_total"], "leak-site listings")}{tile(S["hibp_total"], "HIBP loads")}{tile(n(S["hibp_accounts"]), "accounts in those loads")}{tile(" / ".join(f"{k} {v}" for k, v in S["langs"].items()), "titles by language")}</div>')

    # ---- 06 timeline
    trows = "".join(f'<tr><td class="d">{fdate(i["date"])}</td><td><i class="dot" style="background:{PCAT[i["cat"]]}"></i> <b>{E(i["name"])}</b><div class="small">{E(i["type"])} · {E(i["impact"])}</div></td><td>{E(i["region"])}<div class="small">{E(CCN.get(i["country"], i["country"]))}</div></td><td class="c">{i["sev"]}</td><td class="c small">{ {"confirmed":"confirmed","claimed":"reported","context":"roundup"}[i["status"]] }</td><td>{cite(i["src"][:3])}</td></tr>'
                    for i in sorted([i for i in INC if i["kind"] != "leak"], key=lambda i: i["date"]))
    timeline_html = f'<p class="lede">First public report of each entry inside the period; roundups carry the date of their earliest title. Leak-site listings are in section 08.</p><table class="tbl tl"><thead><tr><th>Date</th><th>Entry</th><th>Region</th><th>Sev</th><th>Status</th><th>Sources</th></tr></thead><tbody>{trows}</tbody></table>'

    # ---- 07 voices + method
    qcards = "".join(f'<blockquote class="q"><p>“{E(q["text"])}”</p><footer>— {E(q["who"])}, {E(q["where"])}, {fdate(q["date"])}<div class="url">{E(q["url"])}</div></footer></blockquote>' for q in P["quotes"][:8])
    cov = C.hbars([(ch, v["in_window"]) for ch, v in P["coverage"].items() if v["in_window"]], color="#0f766e", title="Dated records inside the window, per channel", label_w=140, **L)
    steps = (f'<li>Collector window {W["frm"]} → {W["to"]} (RSR_SINCE) over Google News, Bing News, Reddit, Bluesky, Mastodon, Hacker News, Lemmy, YouTube, ransomware.live and Have I Been Pwned. No logins, no paywalls, polite pacing.</li>'
             f'<li>{n(P["counts"]["in_window"])} dated records in the window; {n(P["counts"]["relevant"])} pass the retail + security lexicon (English and Arabic); near-duplicate titles merged.</li>'
             f'<li>Clustered by named retailer (or country) and theme into {len(INC)} entries; status from the wording of the coverage (confirmed only when a company, regulator or court is quoted); severity from breadth of coverage.</li>'
             f'<li>Summaries are {"written by a language model from the titles and checked against the evidence list" if any(i.get("summary_by") == "llm" for i in INC) else "rule-built from the titles (no language model on this run)"}; every entry cites its sources in section 08.</li>')
    lims = ["Period reports are built automatically from public coverage; a retailer that disclosed quietly, or only in a language the lexicon does not cover, can be missing.",
            "Roundups group titles by country and theme; they show what was reported, not that one event happened.",
            "Leak-site listings and HIBP loads are reproduced as published by those services; a listing is a claim by a criminal group.",
            "Google News links resolve through news.google.com; the outlet name is printed beside each one.",
            "Blocked or unreachable pages are shown as 'not captured', never replaced."]
    voices_html = (f'<h2>What practitioners and customers said</h2><p class="lede">Verbatim public posts from this period, ranked by engagement, collected without logins.</p><div class="qgrid">{qcards or "<p>No qualifying posts this period.</p>"}</div>'
                   f'<h2>Method, coverage and limitations</h2><div class="two"><div class="panel">{cov}</div><div class="panel"><ol class="steps">{steps}</ol></div></div>'
                   f'<h3>Limitations</h3><ul class="lims">{"".join(f"<li>{E(l)}</li>" for l in lims)}</ul>')

    # ---- 08 evidence: leak table, HIBP table, sources
    lrows = "".join(f'<tr><td><b>{E(i["entity"])}</b></td><td>{E(CCN.get(i["country"], i["country"]))}</td><td>{E(i.get("group") or "unattributed")}</td><td class="d">{fdate(i["date"])}</td><td class="small">{E(i["summary"][:160])}</td><td>{cite(i["src"][:2])}</td></tr>' for i in leaks)
    hrows = "".join(f'<tr><td><b>{E(h["name"])}</b></td><td class="c">{n(h["pwn"])}</td><td class="d">{fdate(h["date"])}</td><td class="small">{E(", ".join(h["classes"][:6]))}</td><td class="small">{E(h["url"])}</td></tr>' for h in S["hibp"])
    for i in INC: cite(i["src"])            # every source used anywhere gets its number
    erows = "".join(f'<li id="s{NUM[k]}"><span class="sn">S{NUM[k]}</span><div><a href="{E(SRC[k][1])}">{E(SRC[k][0])}</a><div class="so">{E(SRC[k][2])}{(" · " + E(SRC[k][3])) if SRC[k][3] else ""}</div><div class="url">{E(SRC[k][1])}</div></div></li>' for k in ORDER)
    evidence_html = ((f'<h2>Leak-site listings ({len(leaks)})</h2><table class="tbl"><thead><tr><th>Victim</th><th>Country</th><th>Group</th><th>Listed</th><th>Note</th><th>Src</th></tr></thead><tbody>{lrows}</tbody></table>' if leaks else "")
                     + (f'<h2>Have I Been Pwned loads ({len(S["hibp"])})</h2><table class="tbl"><thead><tr><th>Breach</th><th>Accounts</th><th>Date</th><th>Data classes</th><th>URL</th></tr></thead><tbody>{hrows}</tbody></table>' if S["hibp"] else "")
                     + f'<h2>Sources ({len(ORDER)})</h2><p class="lede">In citation order; each entry prints its URL.</p><ol class="ev">{erows}</ol>')

    SECTIONS = [("01", "exec", "Executive summary", f"What changed between {short_label}"),
                ("02", "regions", "Map and regional matrix", "Where the period's entries sit"),
                ("03", "me", "Middle East", "KSA, UAE and the wider region first"),
                ("04", "world", "Rest of the world", "Europe, North America, Asia-Pacific, Africa, Latin America, Global"),
                ("05", "numbers", "The numbers", "Volumes, themes, groups, outlets"),
                ("06", "timeline", "Timeline", "Day by day"),
                ("07", "voices", "Voices and method", "Public posts; how this was built"),
                ("08", "evidence", "Leak listings, HIBP and sources", "Every URL")]
    bodies = dict(exec=exec_html, regions=regions_html, me=me_html, world=world_html, numbers=numbers_html, timeline=timeline_html, voices=voices_html, evidence=evidence_html)

    def body_html(toc_pages=None):
        toc = "".join(f'<div><span><span class="n">{nn}</span>{E(t)}<span class="k">{E(k)}</span></span><span class="p">{(toc_pages or {}).get(i, "")}</span></div>' for nn, i, t, k in SECTIONS)
        scope = (f'<div class="tiles four" style="margin-top:6mm">{tile(short_label, "period covered; dates are first public report")}{tile("ME → EU → NA → APAC → Africa → LatAm", "Middle East first, then the briefed order")}'
                 f'{tile(f"{n_conf} / {n_cl} / {n_ctx}", "confirmed / reported-unconfirmed / roundups and context")}{tile(f"{len([c for c in P['coverage'] if P['coverage'][c]['in_window']])} channels, 0 logins", "news RSS, Reddit, Bluesky, Mastodon, Hacker News, Lemmy, ransomware.live, HIBP")}</div>'
                 f'<div class="howto" style="margin-top:4mm"><b>How to read this report.</b> Every entry carries S-numbers that point to the evidence index (section 08), where the original URL is printed. "Confirmed" means the company, a regulator or a court is quoted; "reported, unconfirmed" means outlets or a leak site reported it and the company has not confirmed; "roundup / context" groups a period\'s coverage by country and theme. Severity (1–5) reflects breadth of coverage. Leak-site claims are never treated as breaches. Built automatically on {generated} from public sources; screenshots are of the cited pages as captured, downscaled.</div>'
                 f'<div class="legend" style="justify-content:flex-start;margin-top:4mm">{"".join(f"<span><i style=\"background:{PCAT[c]}\"></i>{E(CAT[c][0])}</span>" for c in cats_order)}</div>')
        parts = [f'<div class="kicker">Contents</div><div class="toc">{toc}</div>{scope}'] + [sec(nn, i, t, k, bodies[i]) for nn, i, t, k in SECTIONS]
        return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Retail Security {E(title_month)} — {E(short_label)}</title><style>{CSS}</style></head><body>{"".join(parts)}</body></html>'

    def cover_html():
        s1 = top[0] if top else None
        stats = (f'<div class="stat"><b>{len(INC)}</b><span>entries: {len(named)} named incidents, {len(roundups)} roundups, {len(leaks)} leak-site listings</span></div>'
                 f'<div class="stat"><b>{n(S["news_total"])}</b><span>relevant news titles and {n(S["social_total"])} social posts in the period</span></div>'
                 f'<div class="stat"><b>{n(S["hibp_accounts"]) if S["hibp_accounts"] else S["leak_total"]}</b><span>{"accounts in Have I Been Pwned loads this period" if S["hibp_accounts"] else "leak-site listings in scope"}</span></div>')
        return (f'<!doctype html><html><head><meta charset="utf-8"><style>{COVER_CSS}</style></head><body><div class="cover">'
                f'<div class="eyebrow">Product Intelligence · Retail Security Monthly · {E(period_label)}</div>'
                f'<h1>Retail Security<br><span class="y">{E(title_month)}</span></h1>'
                f'<div class="sub">What happened between {E(short_label)}, where, and what it means for a security director. Middle East first; every other region in the briefed order.</div>'
                f'<div class="lede">{E(s1["name"]) + " leads the period. " if s1 else ""}Cyber, OT sabotage, fraud, physical crime, geopolitics and regulation across retail: {len(INC)} entries, {len(SRC)} cited sources, verbatim evidence. Leak-site claims are marked as claims and never counted as breaches.</div>'
                f'<div class="globe">{_globe_svg(GEO, [i for i in INC if i["country"] != "XX"], 40, 22, 560, True, "cv")}</div>'
                f'<div class="stats">{stats}</div>'
                f'<div class="foot"><span>Generated {E(generated)} · retail-security-report, Product Intelligence</span><span>Evidence index: S1–S{len(ORDER)}</span></div></div></body></html>')

    footer_text = f"Retail Security {title_month} · {short_label} · Product Intelligence · generated {generated}"
    def render(html_name, pdf_name, footer):
        mode = os.environ.get("RSR_BROWSER", "auto")
        if mode == "auto":
            try: mode = "docker" if subprocess.run(["docker", "image", "inspect", "mcr.microsoft.com/playwright:v1.64.0-noble"], capture_output=True).returncode == 0 else "local"
            except FileNotFoundError: mode = "local"
        env = dict(os.environ, RSR_FOOTER_TEXT=footer_text)
        if mode == "local":
            cmd = [sys.executable, "-P", os.path.join(HERE, "rsr_browser.py"), "pdf", os.path.join(PDF, html_name), os.path.join(PDF, pdf_name)] + (["footer"] if footer else [])
            with open(os.path.join(PDF, pdf_name + ".log"), "w") as lf: subprocess.run(cmd, check=True, stdout=lf, stderr=subprocess.STDOUT, timeout=900, env=env)
        else:
            cmd = ["docker", "run", "--rm", "--network", "host", "--shm-size=1g", "--ipc=host", "-e", f"RSR_FOOTER_TEXT={footer_text}", "-v", f"{ROOT}/build/pw:/pw", "-v", f"{PDF}:/pdf",
                   "-v", "/opt/tm8/prod/node_modules:/opt/tm8/prod/node_modules:ro", "mcr.microsoft.com/playwright:v1.64.0-noble", "bash", "-c",
                   f"node /pw/render.mjs pdf /pdf/{html_name} /pdf/{pdf_name} {'footer' if footer else ''} > /pdf/{pdf_name}.log 2>&1"]
            subprocess.run(cmd, check=True, timeout=900)
        print(open(os.path.join(PDF, pdf_name + ".log")).read().strip())

    import fitz
    from pypdf import PdfWriter, PdfReader
    # first body pass numbers the sources; cover is written after so its S-range is right
    open(os.path.join(PDF, "body.html"), "w", encoding="utf-8").write(body_html())
    open(os.path.join(PDF, "cover.html"), "w", encoding="utf-8").write(cover_html())
    print("shots used:", USED, "| absent:", sorted(set(ABSENT)))
    render("cover.html", "cover.pdf", False)
    render("body.html", "body.pdf", True)
    doc = fitz.open(os.path.join(PDF, "body.pdf")); pages = {}
    for pno in range(len(doc)):
        txt = doc[pno].get_text()
        for nn, i, t, k in SECTIONS:
            if i not in pages and f"@@{i}@@" in txt: pages[i] = pno + 1
    print("section pages:", pages, "total body pages:", len(doc)); doc.close()
    open(os.path.join(PDF, "body.html"), "w", encoding="utf-8").write(body_html(pages))
    render("body.html", "body.pdf", True)
    w = PdfWriter()
    for f in ("cover.pdf", "body.pdf"): w.append(PdfReader(os.path.join(PDF, f)))
    w.add_metadata({"/Title": f"Retail Security {title_month} — {short_label}", "/Author": "Product Intelligence · retail-security-report", "/Subject": f"Retail security incidents, regions, leak listings and evidence, {period_label}"})
    out = os.path.join(PDF, "report.pdf")
    if os.path.exists(out): os.remove(out)
    with open(out, "wb") as fh: w.write(fh)
    doc = fitz.open(out); print("report.pdf pages:", len(doc), "bytes:", os.path.getsize(out))
    for pno in sorted({0, 1, 2} | set(pages.values())):
        if pno < len(doc): doc[pno].get_pixmap(dpi=55).save(os.path.join(PDF, f"preview_{pno+1:02d}.png"))
    doc.close()
    return out

if __name__ == "__main__":
    if len(sys.argv) < 2: sys.exit("usage: build_period_pdf.py <period-id>")
    build(sys.argv[1])
