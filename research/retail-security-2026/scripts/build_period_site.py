#!/usr/bin/env python3
"""Build the interactive HTML for one reporting period: build/periods/<id>/site/index.html.

Reads build/periods/<id>/period.json (written by period.py) and reuses the annual site's CSS, JS,
globe and chart code, so the monthly page looks and behaves like the annual briefing (light/dark,
3D globe with filters, SVG charts, evidence index) but every word of content comes from the period.
Usage: python3 build_period_site.py <period-id>      (e.g. 2026-10-01_2026-10-16)
"""
import json, os, sys, html, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import report_charts as C
from report_common import CAT, REGION_ORDER, CAT_ICON, icon
from report_assets import SITE_CSS as CSS, SITE_JS as JS
E = html.escape
LCAT = {"cyber": "#0369a1", "ot": "#be123c", "physical": "#b45309", "fraud": "#4d7c0f", "geopolitical": "#c2410c", "regulatory": "#6d28d9", "enforcement": "#0f766e", "market": "#475569"}
LIGHT = {"#38bdf8": "#0369a1", "#fb7185": "#be123c", "#f5b942": "#b45309", "#a78bfa": "#6d28d9", "#2dd4bf": "#0f766e", "#f97316": "#c2410c", "#94a3b8": "#94a3b8", "#64748b": "#94a3b8", "#a3e635": "#4d7c0f", "#334155": "#cbd5e1"}
def _lc(v):
    if isinstance(v, str): return LIGHT.get(v, v)
    if isinstance(v, (list, tuple)): return [LIGHT.get(x, x) for x in v]
    return v
def chart(fn, *a, **kw):
    d = fn(*a, dark=True, **kw); l = fn(*a, dark=False, **{k: (_lc(v) if k in ("color", "colors") else v) for k, v in kw.items()})
    return f'<span class="chv d">{d}</span><span class="chv l">{l}</span>'
def fmt_d(s):
    try: return datetime.date.fromisoformat(s).strftime("%d %b %Y")
    except Exception: return s
def js(obj): return json.dumps(obj, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')

def build(pid):
    pdir = os.path.join(ROOT, "build", "periods", pid)
    P = json.load(open(os.path.join(pdir, "period.json"), encoding="utf-8"))
    W, S, INC, SRC, Q, CCN = P["window"], P["stats"], P["incidents"], P["sources"], P["quotes"], P["cc_names"]
    frm, to = W["frm"], W["to"]; span = f"{fmt_d(frm)} – {fmt_d(to)}"
    NUM = {k: i + 1 for i, k in enumerate(SRC)}
    def cname(cc): return CCN.get(cc, cc)
    def src_badges(keys):
        out = [f'<a class="src" href="{E(SRC[k][1])}" target="_blank" rel="noopener" title="{E(SRC[k][0])} — {E(SRC[k][2])} {E(SRC[k][3])}">S{NUM[k]}</a>' for k in keys if k in SRC]
        return '<span class="srcs">' + "".join(out) + ' <a class="srcidx" href="#evidence" title="Open the evidence index">index</a></span>'
    def sev_dots(s): return '<span class="sev" title="Severity %d of 5">%s</span>' % (s, "".join('<i class="%s"></i>' % ('on' if i < s else '') for i in range(5)))
    SB = {'confirmed': '<span class="st ok">confirmed</span>', 'claimed': '<span class="st cl">reported, unconfirmed</span>', 'context': '<span class="st cx">roundup / context</span>'}
    def inc_card(i, compact=False):
        color = f"var(--cat-{i['cat']})"
        body = "" if compact else f'<p class="sum">{E(i["summary"])}</p>'
        kind = {"incident": "", "roundup": '<span class="chip">roundup</span>', "leak": '<span class="chip">leak-site listing</span>', "hibp": '<span class="chip">HIBP</span>'}[i["kind"]]
        return f'''<article class="card inc" id="inc-{i['id']}" data-id="{i['id']}" data-region="{E(i['region'])}" data-cat="{i['cat']}" data-status="{i['status']}" style="--c:{color}">
  <header><span class="ci" style="color:{color}">{icon(CAT_ICON[i['cat']],16)}</span><h4>{E(i['name'])}</h4></header>
  <div class="meta"><span class="chip">{fmt_d(i['date'])}{'' if i['last']==i['date'] else ' → '+fmt_d(i['last'])}</span><span class="chip">{E(cname(i['country']))}</span><span class="chip" style="border-color:{color};color:{color}">{E(CAT[i['cat']][0])}</span>{kind}{sev_dots(i['sev'])}{SB[i['status']]}</div>
  <p class="type">{E(i['type'])} · <strong>{E(i['impact'])}</strong> · {i['n_news']} news, {i['n_social']} social</p>
  {body}
  <footer>{src_badges(i['src'])}<button class="fly" data-id="{i['id']}" title="Show on the globe">{icon('pin',14)} globe</button></footer>
</article>'''
    def section(id_, title, kicker, inner, cls=""):
        return f'<section id="{id_}" class="sec {cls}"><div class="wrap"><div class="kicker">{E(kicker)}</div><h2>{E(title)}</h2>{inner}</div></section>'
    named = [i for i in INC if i["kind"] == "incident"]; rounds = [i for i in INC if i["kind"] == "roundup"]; leaks = [i for i in INC if i["kind"] == "leak"]; hibps = [i for i in INC if i["kind"] == "hibp"]
    n_conf = S["status"].get("confirmed", 0); n_claim = S["status"].get("claimed", 0)
    top = sorted(named, key=lambda i: -i["weight"])[:10]
    # ---------- hero
    hero = f'''
<header class="hero"><div class="wrap">
 <div class="eyebrow">{icon('shield',16)} Product Intelligence · Retail Security Monthly · {span}</div>
 <h1>Retail Security <span class="grad">{fmt_d(frm)[3:]}</span><br><small>What happened in retail security between {fmt_d(frm)} and {fmt_d(to)}, from the public record</small></h1>
 <p class="lede">New this period: {len(named)} named incidents, {len(rounds)} country roundups, {len(leaks)} leak-site listings and {len(hibps)} breaches loaded to Have I Been Pwned, built automatically from {P['counts']['relevant']:,} relevant records out of {P['counts']['in_window']:,} collected for the window. Every item links to its sources; leak-site claims stay claims until the company confirms.</p>
 <div class="stats">
  <div class="stat"><b data-n="{len(INC)}">0</b><span>incidents & signals this period</span><i>{n_conf} confirmed · {n_claim} unconfirmed</i></div>
  <div class="stat"><b data-n="{len(SRC)}">0</b><span>cited sources</span><i>news, leak sites, HIBP, social</i></div>
  <div class="stat"><b data-n="{S['news_total']}">0</b><span>relevant news titles in the window</span><i>Google News + Bing News</i></div>
  <div class="stat"><b data-n="{S['leak_total']}">0</b><span>leak-site listings (retail scope)</span><i>ransomware.live</i></div>
  <div class="stat"><b data-n="{S['hibp_accounts']}">0</b><span>accounts in new HIBP breaches</span><i>{S['hibp_total']} breaches loaded</i></div>
  <div class="stat"><b data-n="{S['social_total']}">0</b><span>relevant social posts</span><i>Reddit, Bluesky, Mastodon, HN, Lemmy</i></div>
 </div>
 <nav class="toc">
  <a href="#globe-sec">Globe</a><a href="#top">Top stories</a><a href="#middle-east">Middle East</a><a href="#world">Other regions</a><a href="#roundups">Roundups</a><a href="#charts">Numbers</a><a href="#leaks">Leak sites</a><a href="#timeline">Timeline</a><a href="#voices">Voices</a><a href="#method">Method</a><a href="#evidence">Evidence</a><button id="themeBtn" class="theme" type="button" aria-label="Switch colour theme"></button>
 </nav>
</div></header>'''
    # ---------- globe
    legend = "".join(f'<label class="lg"><input type="checkbox" class="fcat" value="{k}" checked><i style="background:var(--cat-{k})"></i>{E(l)}</label>' for k, (l, c) in CAT.items())
    regions_f = "".join(f'<label class="lg"><input type="checkbox" class="freg" value="{E(r)}" checked>{E(r)}</label>' for r in REGION_ORDER + ["Global"])
    globe = f'''
<div class="globe-grid">
 <div class="globe-box"><canvas id="globe" aria-label="Interactive 3D globe of this period's retail security incidents"></canvas>
  <div class="globe-hint">drag to rotate · scroll to zoom · click a marker · <button id="autoBtn" class="mini">pause rotation</button> <button id="meBtn" class="mini">centre on the Gulf</button></div>
 </div>
 <aside class="globe-side">
  <div class="filters"><div class="fh">Regions</div><div class="fl">{regions_f}</div><div class="fh">Categories</div><div class="fl">{legend}</div>
   <div class="fh">Status</div><div class="fl"><label class="lg"><input type="checkbox" class="fst" value="confirmed" checked>confirmed</label><label class="lg"><input type="checkbox" class="fst" value="claimed" checked>reported / claimed</label><label class="lg"><input type="checkbox" class="fst" value="context" checked>roundups</label></div></div>
  <div id="detail" class="detail"><div class="dh">Select a marker</div><p class="muted">Marker size = severity (1–5). Dashed ring = unconfirmed report or leak-site claim. Colour = category.</p></div>
  <div class="fh">Incidents in view <span id="cnt"></span></div><ol id="list" class="glist"></ol>
 </aside>
</div>'''
    # ---------- top stories
    tcards = "".join(f'''<div class="tcard" style="--i:{n}"><div class="rank">{n:02d}</div><div><h3>{E(i['name'])}</h3><div class="trend">{E(i['type'])} · {E(cname(i['country']))} · {i['n_news']} news items, {len(i['outlets'])} outlets · {E(i['status'])}</div><p>{E(i['summary'])}</p><div class="links"><a href="#inc-{i['id']}" class="ilink">open card</a>{"".join(f'<a href="{E(e["url"])}" class="ilink" target="_blank" rel="noopener">{E(e["outlet"][:30])}</a>' for e in i['evidence'][:3] if e['url'])}</div></div></div>''' for n, i in enumerate(top, 1))
    topsec = f'<p class="muted">Ranked by evidence weight: distinct outlets, news volume and social discussion inside the window. Automatic clustering; read the sources before acting on any item.</p><div class="tgrid">{tcards}</div>' if top else '<p class="muted">No named retailer incident reached the evidence threshold in this window. See the roundups and leak-site sections.</p>'
    # ---------- regions
    def by_region(r, kinds=("incident", "hibp")): return sorted([i for i in INC if i["region"] == r and i["kind"] in kinds], key=lambda i: (-i["weight"], i["date"]))
    me = by_region("Middle East"); me_r = [i for i in rounds if i["region"] == "Middle East"]
    me_leaks = [i for i in leaks if i["region"] == "Middle East"]
    me_html = f'''<p class="lede2">Middle East first, as briefed. {len(me)} named incident{'s' if len(me)!=1 else ''}, {len(me_r)} country roundup{'s' if len(me_r)!=1 else ''} and {len(me_leaks)} leak-site listing{'s' if len(me_leaks)!=1 else ''} with a Middle East location in this window. Thin disclosure in the region means absence of a named incident is not absence of activity.</p>
<h3 class="sub">{icon('pin')} Named incidents ({len(me)})</h3><div class="cards">{"".join(inc_card(i) for i in me) or '<p class="muted">None reached the threshold this period.</p>'}</div>
<h3 class="sub">{icon('globe')} Country roundups ({len(me_r)})</h3><div class="cards">{"".join(inc_card(i) for i in me_r) or '<p class="muted">None this period.</p>'}</div>
<h3 class="sub">{icon('lock')} Leak-site listings in the region ({len(me_leaks)})</h3><div class="cards">{"".join(inc_card(i, compact=True) for i in me_leaks) or '<p class="muted">None this period.</p>'}</div>'''
    world_parts = []
    for r in [x for x in REGION_ORDER if x != "Middle East"] + ["Global"]:
        items = by_region(r)
        if not items: continue
        world_parts.append(f'<h3 class="sub rh"><span class="rbadge">{len(items)}</span> {E(r)} <small>named incidents and HIBP loads</small></h3><div class="cards">{"".join(inc_card(i) for i in items)}</div>')
    world_html = "".join(world_parts) or '<p class="muted">No named incidents outside the Middle East this period.</p>'
    round_html = f'<p class="muted">A roundup groups the window\'s press coverage of one theme in one country when no single retailer is named in the headline. Use it for pattern, not for attribution.</p><div class="cards">{"".join(inc_card(i) for i in sorted(rounds, key=lambda i: -i["weight"]))}</div>' if rounds else '<p class="muted">No roundups this period.</p>'
    # ---------- charts
    days = chart(C.iso_bars, [(d[8:], n) for d, n in S["days"]], color="#38bdf8", title=f"Relevant news titles per day, {span}", label_size=9 if len(S["days"]) > 20 else 11)
    themes = chart(C.hbars, S["themes"], color="#f5b942", title="What the coverage clustered into (incidents + roundups per theme)")
    countries = chart(C.hbars, S["countries"], color="#2dd4bf", title="Incidents and roundups by country") if S["countries"] else ""
    regions = chart(C.donut, S["regions"], colors=["#f97316", "#38bdf8", "#a78bfa", "#2dd4bf", "#f5b942", "#a3e635", "#94a3b8"], title="By region", w=260, unit="")
    groups = chart(C.hbars, [(g or "unattributed", n) for g, n in S["leak_groups"]], color="#fb7185", title="Leak-site listings by group (retail scope, this window)") if S["leak_groups"] else ""
    lcc = chart(C.hbars, S["leak_countries"], color="#a78bfa", title="Leak-site listings by victim country") if S["leak_countries"] else ""
    outlets = chart(C.hbars, S["outlets"], color="#94a3b8", title="Outlets with the most relevant titles", label_w=230) if S["outlets"] else ""
    social = chart(C.donut, S["social"], colors=["#38bdf8", "#f5b942", "#a78bfa", "#fb7185", "#2dd4bf", "#a3e635", "#f97316"], title="Social channels", w=260, unit="") if S["social"] else ""
    hibp_ch = chart(C.hbars, [(h["name"], h["pwn"]) for h in S["hibp"][:12]], color="#38bdf8", title="Breaches loaded to Have I Been Pwned in the window (accounts)", fmt=lambda v: f"{v/1e6:.1f}M" if v >= 1e6 else f"{v/1e3:.0f}k") if S["hibp"] else ""
    charts = f'''
<div class="two"><div class="panel">{days}<div class="cap">Titles that passed the retail + security relevance filter, after de-duplication.</div></div><div class="panel">{themes}</div></div>
<div class="two"><div class="panel">{countries}</div><div class="panel"><div class="three-d"><div>{regions}</div><div>{social}</div></div></div></div>
<div class="two"><div class="panel">{groups}<div class="cap">Claims from ransomware.live, not confirmed breaches.</div></div><div class="panel">{lcc}</div></div>
<div class="two"><div class="panel">{hibp_ch}</div><div class="panel">{outlets}</div></div>'''
    # ---------- leaks
    lrows = "".join(f'<tr><td><b>{E(i["entity"])}</b></td><td>{E(i.get("group") or "—")}</td><td>{E(cname(i["country"]))}</td><td>{fmt_d(i["date"])}</td><td>{src_badges(i["src"])}</td></tr>' for i in sorted(leaks, key=lambda i: i["date"]))
    leak_html = f'<p class="muted">Every retail-scope listing ransomware.live recorded inside the window. A listing is an extortion claim; it is reported here as a claim and never as a confirmed breach.</p><table class="tbl"><thead><tr><th>Victim (as listed)</th><th>Group</th><th>Country</th><th>Discovered</th><th>Source</th></tr></thead><tbody>{lrows}</tbody></table>' if leaks else '<p class="muted">No retail-scope leak-site listings in this window.</p>'
    # ---------- timeline
    tl_items = sorted([i for i in INC if i["kind"] != "leak"], key=lambda i: i["date"])
    rows = "".join(f'<li data-region="{E(i["region"])}" data-cat="{i["cat"]}" data-status="{i["status"]}"><span class="td">{i["date"][8:]}</span><i class="dot" style="background:var(--cat-{i["cat"]})"></i><a href="#inc-{i["id"]}"><b>{E(i["name"])}</b></a> <span class="tr">{E(i["region"])} · {E(cname(i["country"]))}</span> {sev_dots(i["sev"])} {src_badges(i["src"][:3])}</li>' for i in tl_items)
    timeline = f'<div class="tl-filter"><button class="tf on" data-r="all">All regions</button>{"".join(f"<button class=\"tf\" data-r=\"{E(r)}\">{E(r)}</button>" for r in REGION_ORDER + ["Global"])}</div><div class="tl"><div class="tm"><h3>{span}</h3><ul>{rows}</ul></div></div><p class="muted">Dates are the earliest in-window item of each cluster.</p>'
    # ---------- voices
    qcards = "".join(f'<blockquote class="q"><p>“{E(q["text"])}”</p><footer>— {E(q["who"])}, {E(q["ch"])}, {fmt_d(q["date"])} <a class="src" href="{E(q["url"])}" target="_blank" rel="noopener">post</a></footer></blockquote>' for q in Q)
    voices = f'<p class="muted">Verbatim public posts from the window, ranked by engagement (no logins, no private content).</p><div class="qgrid">{qcards}</div>' if Q else '<p class="muted">No relevant social posts passed the filter this period.</p>'
    # ---------- method
    cov = chart(C.hbars, [(k, v["in_window"]) for k, v in P["coverage"].items() if v["in_window"]], color="#2dd4bf", title="Records inside the window, per channel", label_w=200)
    undated = [k for k, v in P["coverage"].items() if v["total"] and not v["in_window"]]
    method = f'''<div class="two"><div class="panel">{cov}</div><div class="panel"><h4>How this period was built</h4><ol class="steps"><li>Collectors ran with the window start as their cut-off (Google News, Bing News, Reddit, Bluesky, Mastodon, Hacker News, Lemmy, YouTube, ransomware.live, Have I Been Pwned). Public endpoints only, no logins, no paywall bypass, polite pacing.</li><li>{P['counts']['in_window']:,} records dated inside {span}; {P['counts']['relevant']:,} passed the retail-and-security relevance filter after de-duplication.</li><li>Records were clustered by named retailer (or country when none is named) and theme; status was set from the wording of the coverage: confirmed only where a company, regulator, court or HIBP confirms.</li><li>Summaries: {E(", ".join(sorted(set(i.get("summary_by","rules") for i in INC))) or "rules")}. Undated channels ({E(", ".join(undated)) or "none"}) are excluded because they cannot prove recency.</li></ol></div></div>
<h3 class="sub">Limitations</h3><ul class="lims"><li>Automatic clustering: a retailer named in passing can be attached to a story about someone else; read the sources.</li><li>Coverage is what the public web surfaced in the window; a blocked or thin channel lowers counts and is reported as thin coverage, not as fewer incidents.</li><li>Leak-site listings are claims. HIBP loads are confirmed breaches but the breach itself may predate the window.</li><li>Middle East disclosure is thin, so Arabic-language and leak-site signals carry more weight there.</li></ul>'''
    erows = "".join(f'<li id="s{NUM[k]}"><span class="sn">S{NUM[k]}</span><a href="{E(v[1])}" target="_blank" rel="noopener">{E(v[0])}</a><span class="so">{E(v[2])}{(" · " + E(v[3])) if v[3] else ""}</span></li>' for k, v in SRC.items())
    evidence = f'<p class="muted">{len(SRC)} sources in citation order. Links open the original page.</p><ol class="ev">{erows}</ol>'
    # ---------- data for JS
    GEO = json.load(open(os.path.join(ROOT, 'build', 'geo_s.json')))
    geo_js = [{"n": c["name"], "r": [[[round(x, 2), round(y, 2)] for x, y in ring] for ring in c["rings"]]} for c in GEO["countries"]]
    inc_js = [dict(id=i['id'], name=i['name'], country=cname(i['country']), region=i['region'], lat=i['lat'], lon=i['lon'], date=i['date'], cat=i['cat'], type=i['type'], sev=i['sev'], status=i['status'], impact=i['impact'], summary=i['summary'], src=[[NUM[k], SRC[k][0], SRC[k][1], SRC[k][2]] for k in i['src'] if k in SRC]) for i in INC]
    JS2 = JS.replace("claim, unverified", "reported, unconfirmed").replace("statistic / policy", "roundup / context")
    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Retail Security Monthly — {span}</title>
<meta name="color-scheme" content="dark light">
<script>(function(){{var t=null,m=/[?&]theme=(light|dark)/.exec(location.search);if(m)t=m[1];else{{try{{t=localStorage.getItem('rs26-theme')}}catch(e){{}}}}if(t!=='light'&&t!=='dark')t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';document.documentElement.setAttribute('data-theme',t)}})()</script>
<meta name="description" content="Retail security incidents, roundups, leak-site claims and HIBP breaches between {frm} and {to}, built automatically from public evidence with {len(SRC)} cited sources.">
<style>{CSS}</style></head><body>
{hero}
{section('globe-sec', 'Where it happened this period', 'Interactive 3D', globe)}
{section('top', 'Top stories of the period', 'Ranked by evidence weight', topsec)}
{section('middle-east', 'Middle East & North Africa', 'Region 1 of 6', me_html)}
{section('world', 'Other regions', 'Europe · North America · Asia-Pacific · Africa · Latin America · Global', world_html)}
{section('roundups', 'Country roundups', 'Theme × country clusters without a named retailer', round_html)}
{section('charts', 'The numbers for the period', 'Volume, themes, countries, leak sites, HIBP', charts)}
{section('leaks', 'Leak-site listings', f'{len(leaks)} retail-scope claims on ransomware.live', leak_html)}
{section('timeline', 'Timeline', span, timeline)}
{section('voices', 'What people said', 'Verbatim public posts', voices)}
{section('method', 'Method, coverage and limitations', 'Automatic build', method)}
{section('evidence', 'Evidence index', f'{len(SRC)} numbered sources', evidence)}
<footer class="end"><div class="wrap">Generated {P['generated_at'][:16].replace('T', ' ')} UTC by the retail-security-report monthly pipeline for the window {span}. Collection used only public endpoints, no logins and no paywall bypass. Leak-site claims are reported as claims; blocked or thin channels are reported as thin coverage, never as "nothing happened".</div></footer>
<script>{JS2 % dict(catd=js({k: v[1] for k, v in CAT.items()}), catl=js(LCAT), geo=js(geo_js), inc=js(inc_js))}</script>
</body></html>'''
    os.makedirs(os.path.join(pdir, "site"), exist_ok=True)
    out = os.path.join(pdir, "site", "index.html")
    open(out, "w", encoding="utf-8").write(page)
    print("wrote", out, f"{len(page.encode())/1024:.0f} KB", "| incidents", len(INC), "| sources", len(SRC))
    return out
if __name__ == "__main__":
    if len(sys.argv) < 2: raise SystemExit("usage: build_period_site.py <period-id>")
    build(sys.argv[1])
