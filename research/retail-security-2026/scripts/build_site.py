#!/usr/bin/env python3
"""Build the self-contained interactive HTML artifact: build/site/index.html (no CDN, inline CSS/JS/SVG)."""
import json, os, sys, html, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from report_sources import SOURCES, NUM, ORDER
from report_incidents import INCIDENTS, QUOTES, ACTORS, RANKINGS, THREATS, VENDORS, LIMITATIONS
import report_stats as T
import report_charts as C
E = html.escape
TODAY = "16 October 2026"

from report_common import CAT, COUNTRY, REGION_ORDER, ICON, CAT_ICON, icon
# Light-theme palettes. CAT holds the dark-theme category colours; LCAT is the deeper set used on white (same as the PDF).
LCAT = {"cyber":"#0369a1","ot":"#be123c","physical":"#b45309","fraud":"#4d7c0f","geopolitical":"#c2410c","regulatory":"#6d28d9","enforcement":"#0f766e","market":"#475569"}
LIGHT = {"#38bdf8":"#0369a1","#fb7185":"#be123c","#f5b942":"#b45309","#a78bfa":"#6d28d9","#2dd4bf":"#0f766e","#f97316":"#c2410c","#94a3b8":"#94a3b8","#64748b":"#94a3b8","#a3e635":"#4d7c0f","#334155":"#cbd5e1"}
def _lc(v):
    if isinstance(v, str): return LIGHT.get(v, v)
    if isinstance(v, (list, tuple)): return [LIGHT.get(x, x) for x in v]
    return v
def chart(fn, *a, **kw):
    """Render a chart twice, dark and light palette; CSS shows the variant matching the active theme."""
    d = fn(*a, dark=True, **kw)
    l = fn(*a, dark=False, **{k: (_lc(v) if k in ("color", "colors") else v) for k, v in kw.items()})
    return f'<span class="chv d">{d}</span><span class="chv l">{l}</span>'
def src_badges(keys):
    out=[]
    for k in keys:
        n=NUM[k]; t,u,o,d=SOURCES[k]
        out.append(f'<a class="src" href="{E(u)}" target="_blank" rel="noopener" title="{E(t)} — {E(o)} {E(d)}">S{n}</a>')
    return '<span class="srcs">'+"".join(out)+f' <a class="srcidx" href="#evidence" title="Open the evidence index">index</a></span>'

def sev_dots(s):
    return '<span class="sev" title="Severity %d of 5">%s</span>' % (s, "".join('<i class="%s"></i>' % ('on' if i < s else '') for i in range(5)))

def inc_card(inc, compact=False):
    label = CAT[inc['cat']][0]; color = f"var(--cat-{inc['cat']})"
    status = inc['status']
    sbadge = {'confirmed':'<span class="st ok">confirmed</span>','claimed':'<span class="st cl">claim, unverified</span>','context':'<span class="st cx">statistic / policy</span>'}[status]
    d = datetime.date.fromisoformat(inc['date']).strftime("%d %b %Y")
    body = "" if compact else f'<p class="sum">{E(inc["summary"])}</p>'
    return f'''<article class="card inc" id="inc-{inc['id']}" data-id="{inc['id']}" data-region="{E(inc['region'])}" data-cat="{inc['cat']}" data-status="{status}" style="--c:{color}">
  <header><span class="ci" style="color:{color}">{icon(CAT_ICON[inc['cat']],16)}</span><h4>{E(inc['name'])}</h4></header>
  <div class="meta"><span class="chip">{d}</span><span class="chip">{E(COUNTRY.get(inc['country'],inc['country']))}</span><span class="chip" style="border-color:{color};color:{color}">{E(label)}</span>{sev_dots(inc['sev'])}{sbadge}</div>
  <p class="type">{E(inc['type'])} · <strong>{E(inc['impact'])}</strong></p>
  {body}
  <footer>{src_badges(inc['src'])}<button class="fly" data-id="{inc['id']}" title="Show on the globe">{icon('pin',14)} globe</button></footer>
</article>'''

def section(id_, title, kicker, inner, cls=""):
    return f'<section id="{id_}" class="sec {cls}"><div class="wrap"><div class="kicker">{E(kicker)}</div><h2>{E(title)}</h2>{inner}</div></section>'

def by_region(r): return sorted([i for i in INCIDENTS if i['region']==r], key=lambda i:(-i['sev'], i['date']))

# ---------- data for JS
def inc_js(i):
    return dict(id=i['id'], name=i['name'], country=COUNTRY.get(i['country'],i['country']), region=i['region'], lat=i['lat'], lon=i['lon'], date=i['date'], cat=i['cat'], type=i['type'], sev=i['sev'], status=i['status'], impact=i['impact'], summary=i['summary'], src=[[NUM[k], SOURCES[k][0], SOURCES[k][1], SOURCES[k][2]] for k in i['src']])
GEO = json.load(open(os.path.join(ROOT,'build','geo_s.json')))
geo_js = [{"n":c["name"], "r":[[ [round(x,2),round(y,2)] for x,y in ring] for ring in c["rings"]]} for c in GEO["countries"]]
def js(obj): return json.dumps(obj, ensure_ascii=False, separators=(',',':')).replace('</','<\\/')

# ---------- hero
n_conf = sum(1 for i in INCIDENTS if i['status']=='confirmed'); n_claim = sum(1 for i in INCIDENTS if i['status']=='claimed')
hero = f'''
<header class="hero"><div class="wrap">
 <div class="eyebrow">{icon('shield',16)} Product Intelligence · Retail Security Briefing · 1 January – {TODAY}</div>
 <h1>Retail Security <span class="grad">2026</span><br><small>What happened, where, and what it means for a security director</small></h1>
 <p class="lede">Cyber, physical, fraud, geopolitical and regulatory events across retail, ranked Middle East first and then by how hard each region is trending. Every figure links to its source; leak-site claims are marked as claims.</p>
 <div class="stats">
  <div class="stat"><b data-n="{len(INCIDENTS)}">0</b><span>incidents & signals tracked</span><i>{n_conf} confirmed · {n_claim} claims</i></div>
  <div class="stat"><b data-n="{len(SOURCES)}">0</b><span>cited sources</span><i>news, regulators, vendors, social</i></div>
  <div class="stat"><b data-n="{T.NEWS['unique_titles']}">0</b><span>unique 2026 news titles read</span><i>Google News + Bing RSS</i></div>
  <div class="stat"><b data-n="{T.RL['total']}">0</b><span>leak-site listings (retail + Middle East)</span><i>ransomware.live</i></div>
  <div class="stat"><b data-n="800000">0</b><span>cyberattacks a day on the UAE</span><i>Cyber Security Council</i></div>
  <div class="stat"><b data-n="700">0</b><span>French stores with sabotaged fridges</span><i>11–12 Oct</i></div>
 </div>
 <nav class="toc">
  <a href="#globe-sec">Globe</a><a href="#threats">Top threats</a><a href="#regions">Region ranking</a><a href="#middle-east">Middle East</a><a href="#world">Other regions</a><a href="#charts">Numbers</a><a href="#timeline">Timeline</a><a href="#actors">Actors</a><a href="#vendors">Vendors</a><a href="#voices">Voices</a><a href="#market">Market</a><a href="#method">Method</a><a href="#evidence">Evidence</a><button id="themeBtn" class="theme" type="button" aria-label="Switch colour theme"></button>
 </nav>
</div></header>'''

# ---------- globe
legend = "".join(f'<label class="lg"><input type="checkbox" class="fcat" value="{k}" checked><i style="background:var(--cat-{k})"></i>{E(l)}</label>' for k,(l,c) in CAT.items())
regions_f = "".join(f'<label class="lg"><input type="checkbox" class="freg" value="{E(r)}" checked>{E(r)}</label>' for r in REGION_ORDER)
globe = f'''
<div class="globe-grid">
 <div class="globe-box"><canvas id="globe" aria-label="Interactive 3D globe of 2026 retail security incidents"></canvas>
  <div class="globe-hint">drag to rotate · scroll to zoom · click a marker · <button id="autoBtn" class="mini">pause rotation</button> <button id="meBtn" class="mini">centre on the Gulf</button></div>
 </div>
 <aside class="globe-side">
  <div class="filters"><div class="fh">Regions</div><div class="fl">{regions_f}</div><div class="fh">Categories</div><div class="fl">{legend}</div>
   <div class="fh">Status</div><div class="fl"><label class="lg"><input type="checkbox" class="fst" value="confirmed" checked>confirmed</label><label class="lg"><input type="checkbox" class="fst" value="claimed" checked>claims</label><label class="lg"><input type="checkbox" class="fst" value="context" checked>statistics / policy</label></div></div>
  <div id="detail" class="detail"><div class="dh">Select a marker</div><p class="muted">Marker size = severity (1–5). Dashed ring = unverified leak-site claim. Colour = category.</p></div>
  <div class="fh">Incidents in view <span id="cnt"></span></div><ol id="list" class="glist"></ol>
 </aside>
</div>'''

# ---------- threats
tcards = "".join(f'''<div class="tcard" style="--i:{t['rank']}"><div class="rank">{t['rank']:02d}</div><div><h3>{E(t['name'])}</h3><div class="trend">{E(t['trend'])}</div><p>{E(t['evidence'])}</p><div class="links">{"".join(f'<a href="#inc-{i}" class="ilink">{E(next(x for x in INCIDENTS if x["id"]==i)["name"][:46])}…</a>' for i in t['ids'][:3])}</div></div></div>''' for t in THREATS)
threats = f'<div class="tgrid">{tcards}</div>'

# ---------- region ranking
rrows = "".join(f'''<div class="rrow"><div class="rr">{r['rank']}</div><div class="rn">{E(r['region'])}</div><div class="rbar"><div class="rfill" style="width:{r['score']}%"><span>{r['score']}</span></div></div><div class="rwhy">{E(r['why'])}</div></div>''' for r in RANKINGS)
rank_sec = f'<p class="muted">Trend score is an analyst judgement over this evidence base (0–100): breadth of confirmed incidents, novelty of attack technique, financial and regulatory consequence, and momentum into Q4. Presented Middle East first below regardless of rank, as briefed.</p><div class="rtable">{rrows}</div>'

# ---------- Middle East section
me = by_region("Middle East")
uae_chart = chart(C.iso_bars, [("2025 (early)", T.UAE['daily_attacks_2025']), ("2026 (May–Oct)", T.UAE['daily_attacks_2026'])], colors=["#94a3b8","#f97316"], h=240, title="Daily cyberattack attempts on the UAE (Cyber Security Council)", fmt=lambda v: f"{int(v):,}")
rl_me = [(c, n) for c, n in T.RL['by_country'] if c in ("TR","AE","IL","EG","SA","MA","IR","PK","QA","OM","KW")]
rl_me_chart = chart(C.hbars, [(COUNTRY.get(c, {"MA":"Morocco","IR":"Iran","PK":"Pakistan","OM":"Oman"}.get(c,c)), n) for c,n in rl_me], color="#fb7185", title="Leak-site listings by country, Middle East scope, 2026 (ransomware.live)")
ibm_tiles = f'''<div class="tiles">
 <div class="tile"><b>$8.0M</b><span>average cost of a breach, Middle East</span>{src_badges(['ibm-me','wam-ibm'])}</div>
 <div class="tile"><b>SAR 27M</b><span>average cost, Saudi Arabia</span>{src_badges(['ibm-sa'])}</div>
 <div class="tile"><b>18%</b><span>of ME breaches start with phishing ($10.41M each)</span>{src_badges(['ibm-me'])}</div>
 <div class="tile"><b>26%</b><span>of ME breaches involved AI-enabled attacks</span>{src_badges(['ibm-me'])}</div>
 <div class="tile"><b>16%</b><span>supply-chain compromise share</span>{src_badges(['ibm-me'])}</div>
 <div class="tile"><b>59%</b><span>of ME firms raising security spend</span>{src_badges(['ibm-me'])}</div>
</div>'''
war = [("28 Feb","War begins; Gulf airspace closures"),("4 Mar","Strait of Hormuz closed to shipping"),("12 Mar","Lulu charters food airlifts to UAE and Kuwait"),("19 Mar","UAE tightens food-retail checks; panic buying"),("7 Apr","Ceasefire"),("17 Apr","Hormuz reopens"),("May","UAE: 800,000 attacks/day"),("12 Jul","Iran strikes five Gulf states; Hormuz closed again"),("19 Jul","UAE supermarkets report rising costs"),("19 Sep","Houthi attack near Riyadh airport"),("3 Oct","ShinyHunters member detained in Jordan"),("12 Oct","Fresh strikes; Riyadh airport shut to 17 Oct"),("16 Oct","UAE: sleeper cells active during strikes")]
war_strip = '<div class="strip">' + "".join(f'<div class="sp"><b>{E(d)}</b><span>{E(t)}</span></div>' for d,t in war) + '</div>'
me_html = f'''
<p class="lede2">The Gulf's 2026 security story is a war story first. Attack volume on the UAE quadrupled, Hormuz closed twice, food was airlifted, luxury footfall fell, and the leak sites filled with Gulf suppliers. Confirmed retail breaches remain rare in public, which is itself a finding: disclosure is thin, so claims and supplier compromises are the leading indicators.</p>
<h3 class="sub">{icon('globe')} The war timeline that shaped Gulf retail {src_badges(['aljazeera-hormuz','wiki-iran-econ','guardian-riyadh','uae-800k','uae-sleeper','lulu-gulfnews','rin-foodchecks','national-prices'])}</h3>{war_strip}
<div class="two"><div class="panel">{uae_chart}<div class="cap">Sources: {src_badges(['uae-800k','uae-800k-spike','uae-200k','aviatrix-me'])}</div></div><div class="panel">{rl_me_chart}<div class="cap">Claims, not confirmed breaches. {src_badges(['ransomwarelive'])}</div></div></div>
<h3 class="sub">{icon('chart')} What a breach costs here (IBM Cost of a Data Breach 2026)</h3>{ibm_tiles}
<h3 class="sub">{icon('pin')} Middle East incident register ({len(me)})</h3><div class="cards">{"".join(inc_card(i) for i in me)}</div>'''

# ---------- other regions
world_parts=[]
for r in RANKINGS:
    if r['region']=="Middle East": continue
    items = by_region(r['region'])
    world_parts.append(f'<h3 class="sub rh"><span class="rbadge">#{r["rank"]}</span> {E(r["region"])} <small>{E(r["why"])}</small></h3><div class="cards">{"".join(inc_card(i) for i in items)}</div>')
world_html = "".join(world_parts)

# ---------- charts
rans_month = chart(C.iso_bars, T.RL['by_month'], color="#fb7185", title="Retail + Middle East leak-site listings by month, 2026 (ransomware.live; Oct = 1–16)")
news_month = chart(C.iso_bars, T.NEWS['by_month'], color="#38bdf8", title="Retail-security news titles by month, 2026 (Google News + Bing RSS; Oct = 1–16)")
themes = chart(C.hbars, T.NEWS['themes'], color="#f5b942", title="What the 2026 coverage was about (title mentions)")
groups = chart(C.hbars, T.RL['by_group'], color="#a78bfa", title="Most active groups against retail / Middle East targets (listings)")
q_bars = chart(C.iso_bars, [("Q3 2025", round(T.RANSOMWARE['q3_record']/(1+T.RANSOMWARE['q3_yoy']/100))), ("H1 2026 /2", T.RANSOMWARE['h1_attacks']//2), ("Aug 2026", T.RANSOMWARE['aug_record']), ("Q3 2026", T.RANSOMWARE['q3_record'])], colors=["#94a3b8","#38bdf8","#f97316","#fb7185"], title="Global ransomware victims: Q3 2026 is a record (2,627, +61% YoY); August alone 997", h=250)
retail_q = chart(C.iso_bars, [("H1 2025", round(T.RANSOMWARE['h1_retail']/(1+T.RANSOMWARE['h1_retail_growth']/100))), ("H1 2026", T.RANSOMWARE['h1_retail']), ("Q3 2025", round(T.RANSOMWARE['retail_q3']/(1+T.RANSOMWARE['retail_q3_yoy']/100))), ("Q3 2026", T.RANSOMWARE['retail_q3'])], colors=["#94a3b8","#f5b942","#94a3b8","#f5b942"], title="Retail ransomware victims: H1 +28%, Q3 +97% year on year", h=250)
dbir = chart(C.grouped_iso, [(p[0], [p[3],p[2],p[1]]) for p in T.DBIR['patterns']], ["DBIR 2024","DBIR 2025","DBIR 2026"], colors=["#64748b","#38bdf8","#f5b942"], title="Retail breach patterns, share of breaches (Verizon DBIR retail snapshots)")
dbir_access = chart(C.hbars, list(T.DBIR['initial_access_retail'].items()), color="#2dd4bf", unit="%", title="Initial access in retail breaches, DBIR 2026")
hibp_items = sorted([(f"{r[1]}", r[4]) for r in T.HIBP_RETAIL], key=lambda x:-x[1])[:14]
hibp = chart(C.hbars, hibp_items, color="#38bdf8", title="Retail-adjacent breaches loaded to Have I Been Pwned in 2026 (accounts)", fmt=lambda v: f"{v/1e6:.1f}M" if v>=1e6 else f"{v/1e3:.0f}k")
nrf = chart(C.hbars, [("Shoplifting incidents", T.NRF['shoplifting_change']), ("Merchandise theft $", T.NRF['merch_theft_change']), ("Repeat offenders ↑ (share)", T.NRF['repeat_offenders_up']), ("ORC ↑ (share)", T.NRF['orc_up']), ("Push-outs ↑ (share)", T.NRF['pushout_up'])], colors=["#2dd4bf","#2dd4bf","#fb7185","#fb7185","#fb7185"], unit="%", title="NRF 2026: theft down, violence and repeat offending up", fmt=lambda v: f"{v:+.1f}" if isinstance(v,float) else f"{v:+d}", max_val=60)
fraud_d = chart(C.donut, [("Phone scams", T.NRF['phone_scams']), ("Loyalty fraud", T.NRF['loyalty_fraud']), ("Gift-card fraud", T.NRF['gift_card_fraud'])], colors=["#f5b942","#a3e635","#fb7185"], title="NRF fraud", w=260)
akamai_d = chart(C.donut, [("Commerce", T.AKAMAI['commerce_ai_bot_share']), ("All other sectors", round(100-T.AKAMAI['commerce_ai_bot_share'],1))], colors=["#f97316","#334155"], title="AI-bot traffic", w=260)
charts = f'''
<div class="two"><div class="panel">{rans_month}<div class="cap">{src_badges(['ransomwarelive'])} {E(T.RL['note'])}</div></div><div class="panel">{news_month}<div class="cap">{E(T.NEWS['note'])}</div></div></div>
<div class="two"><div class="panel">{q_bars}<div class="cap">{src_badges(['infosec-q3','grit-q3','comparitech-h1','comparitech-jul','blackkite'])}</div></div><div class="panel">{retail_q}<div class="cap">{src_badges(['comparitech-h1','grit-q3','infosec-q3'])}</div></div></div>
<div class="two"><div class="panel">{dbir}<div class="cap">{src_badges(['dbir-retail','dbir-full'])} {E(T.DBIR['edition'])}. Retail: {T.DBIR['retail_incidents']} incidents, {T.DBIR['retail_breaches']} breaches; {E(T.DBIR['retail_breaches_note'].lower())}; third party in {T.DBIR['third_party_retail']}%, human element in {T.DBIR['human_element_retail']}%.</div></div><div class="panel">{dbir_access}<div class="cap">Globally: vulnerability exploitation {T.DBIR['global']['vuln_exploitation']}%, credential abuse {T.DBIR['global']['cred_abuse']}%; only {T.DBIR['global']['kev_remediated']}% of KEV flaws fully remediated (median {T.DBIR['global']['kev_median_days']} days); ransomware in {T.DBIR['global']['ransomware_share']}% of breaches; {T.DBIR['global']['no_pay']}% refused to pay; median ransom ${T.DBIR['global']['median_ransom']:,}. {src_badges(['dbir-full'])}</div></div></div>
<div class="two"><div class="panel">{themes}<div class="cap">Theme counts over {T.NEWS['unique_titles']:,} unique titles.</div></div><div class="panel">{groups}<div class="cap">{src_badges(['ransomwarelive','comparitech-h1','qilin-1358'])}</div></div></div>
<div class="two"><div class="panel">{hibp}<div class="cap">{src_badges(['hibp','ct-hibp','carhartt-hibp'])} Under Armour's breach is dated Nov 2025 but was loaded in Jan 2026.</div></div><div class="panel">{nrf}<div class="three-d"><div>{fraud_d}<div class="cap">Share of retailers reporting more of each fraud type. {src_badges(['nrf-pr','nrf-report'])}</div></div><div>{akamai_d}<div class="cap">47.9% of AI-bot traffic targets commerce; 90% of retailers only monitor bots; 85% had an API incident. {src_badges(['akamai-pr','akamai-report'])}</div></div></div></div></div>
<div class="tiles">
 <div class="tile"><b>{T.RANSOMWARE['sophos_paid']}%</b><span>of ransomware victims paid (retail {T.RANSOMWARE['sophos_retail_paid']}%)</span>{src_badges(['sophos-2026'])}</div>
 <div class="tile"><b>${T.RANSOMWARE['h1_median_demand']:,}</b><span>median ransom demand H1 2026 (average $1.36M)</span>{src_badges(['comparitech-h1'])}</div>
 <div class="tile"><b>{T.RANSOMWARE['blackkite_victims']:,}</b><span>leak-site victims in Black Kite's 2026 report (+{T.RANSOMWARE['blackkite_growth']}%)</span>{src_badges(['blackkite','blackkite-retail'])}</div>
 <div class="tile"><b>${T.NRF['cargo_q2_usd_m']}M</b><span>Q2 cargo-theft losses, more than double</span>{src_badges(['verisk-cargo'])}</div>
 <div class="tile"><b>~{T.NRF['brc_incidents_per_day']:,}/day</b><span>violence & abuse incidents in UK retail</span>{src_badges(['brc-crime'])}</div>
 <div class="tile"><b>{T.AKAMAI['phishing_per_day_from']:,}→{T.AKAMAI['phishing_per_day_to']:,}</b><span>daily phishing attempts on commerce, per Akamai</span>{src_badges(['akamai-report'])}</div>
</div>'''

# ---------- timeline
months = ["January","February","March","April","May","June","July","August","September","October"]
tl=[]
for m in range(1,11):
    items = sorted([i for i in INCIDENTS if int(i['date'][5:7])==m], key=lambda i:i['date'])
    if not items: continue
    rows = "".join(f'<li data-region="{E(i["region"])}" data-cat="{i["cat"]}" data-status="{i["status"]}"><span class="td">{i["date"][8:]}</span><i class="dot" style="background:var(--cat-{i["cat"]})"></i><a href="#inc-{i["id"]}"><b>{E(i["name"])}</b></a> <span class="tr">{E(i["region"])} · {E(COUNTRY.get(i["country"],i["country"]))}</span> {sev_dots(i["sev"])} {src_badges(i["src"][:3])}</li>' for i in items)
    tl.append(f'<div class="tm"><h3>{months[m-1]} 2026</h3><ul>{rows}</ul></div>')
timeline = f'<div class="tl-filter"><button class="tf on" data-r="all">All regions</button>{"".join(f"<button class=\"tf\" data-r=\"{E(r)}\">{E(r)}</button>" for r in REGION_ORDER)}</div><div class="tl">{"".join(tl)}</div><p class="muted">Dates are the first public report or the key event in the story; multi-event entries use their anchor date. October covers 1–16.</p>'

# ---------- actors
arows = "".join(f'<tr><td><b>{E(a["name"])}</b><br><small>{E(a["kind"])}</small></td><td>{E(a["retail_hits"])}</td><td>{E(a["status"])}</td><td>{src_badges(a["src"])}</td></tr>' for a in ACTORS)
actors = f'<table class="tbl"><thead><tr><th>Actor</th><th>Retail / Middle East footprint in 2026</th><th>Status at 16 Oct</th><th>Sources</th></tr></thead><tbody>{arows}</tbody></table>'

# ---------- vendors
vcards = "".join(f'<div class="vcard"><h4>{E(v["name"])}</h4><div class="vseg">{E(v["seg"])}</div><p>{E(v["note"])}</p>{src_badges(v["src"])}</div>' for v in VENDORS)
vendors = f'<p class="muted">Who showed up in the 2026 evidence, and why it matters to a retail security budget. Not an endorsement; mentions are drawn from the incident and market coverage above.</p><div class="vgrid">{vcards}</div>'

# ---------- voices
qcards = "".join(f'<blockquote class="q"><p>“{E(q["text"])}”</p><footer>— {E(q["who"])}, {E(q["when"])} {src_badges([q["src"]])}</footer></blockquote>' for q in QUOTES)
voices = f'<p class="muted">Verbatim public posts collected from Bluesky, Mastodon, Reddit and Hacker News (no logins). They show how practitioners and customers read the year.</p><div class="qgrid">{qcards}</div>'

# ---------- market
mrows = "".join(f'<tr><td>{E(m[0])}</td><td>{E(m[1])}</td><td>{E(m[2])}</td><td>{E(m[3])}</td><td>{E(m[4])}</td><td>{E(m[5])} {src_badges([m[6]])}</td></tr>' for m in T.MARKET)
market = f'''<table class="tbl"><thead><tr><th>Segment</th><th>Geography</th><th>Base</th><th>Forecast</th><th>CAGR</th><th>Source</th></tr></thead><tbody>{mrows}
<tr><td>Video surveillance cameras</td><td>GCC</td><td>$1.86B</td><td>$4.60B (2034)</td><td>—</td><td>Precedence Research {src_badges(['precedence-gcc'])}</td></tr>
<tr><td>Cybersecurity</td><td>Saudi Arabia</td><td>SAR 16.3B (2025)</td><td>—</td><td>—</td><td>NCA / Argaam {src_badges(['argaam-sa-market'])}</td></tr></tbody></table>
<div class="tiles">
 <div class="tile"><b>GISEC 2026</b><span>120 countries in Dubai; 'Cyber First' leaders track; Censys debut</span>{src_badges(['gisec-cyberfirst','gisec-wrap','censys-gisec'])}</div>
 <div class="tile"><b>Intersec 2026</b><span>Motorola Visual Alerts expansion; AI CCTV across the halls</span>{src_badges(['intersec','intersec-motorola'])}</div>
 <div class="tile"><b>MAF × Checkout.com</b><span>15M monthly online customers; agentic-commerce controls</span>{src_badges(['checkout-maf','checkout-agentic'])}</div>
 <div class="tile"><b>Deloitte outlook</b><span>2026 global retail outlook: resilience and AI as the twin themes</span>{src_badges(['deloitte'])}</div>
</div>'''

# ---------- method
cov = chart(C.hbars, [(k, v) for k,v in T.COVERAGE if v>1], color="#2dd4bf", title="Records collected per channel", label_w=330)
lims = "".join(f'<li>{E(l)}</li>' for l in LIMITATIONS)
method = f'''<div class="two"><div class="panel">{cov}</div><div class="panel"><h4>How this was built</h4><ol class="steps"><li>Multi-channel collector (curl_cffi, public RSS/JSON) over Google News, Bing News, Reddit RSS, Bluesky, Mastodon, Hacker News, Lemmy, YouTube, DuckDuckGo and Bing web, plus the ransomware.live and Have I Been Pwned APIs. No logins, no paywalls, polite pacing.</li><li>7,124 unique 2026 titles de-duplicated and themed; 82 incidents and signals selected for retail relevance and evidence quality.</li><li>Every number traced to a URL; social posts quoted verbatim; leak-site items kept as claims.</li><li>Rendered as this self-contained page (hand-built canvas globe and SVG charts, no external scripts) and a companion PDF.</li></ol></div></div>
<h3 class="sub">Limitations</h3><ul class="lims">{lims}</ul>'''

# ---------- evidence
erows = "".join(f'<li id="s{NUM[k]}"><span class="sn">S{NUM[k]}</span><a href="{E(SOURCES[k][1])}" target="_blank" rel="noopener">{E(SOURCES[k][0])}</a><span class="so">{E(SOURCES[k][2])}{(" · "+E(SOURCES[k][3])) if SOURCES[k][3] else ""}</span></li>' for k in ORDER)
evidence = f'<p class="muted">{len(ORDER)} sources in citation order. Links open the original page; items marked "deep link not recovered" cite the outlet front page.</p><ol class="ev">{erows}</ol>'

from report_assets import SITE_CSS as CSS, SITE_JS as JS

page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Retail Security 2026 — Middle East first, world ranked by trend (1 Jan – 16 Oct 2026)</title>
<meta name="color-scheme" content="dark light">
<script>(function(){{var t=null,m=/[?&]theme=(light|dark)/.exec(location.search);if(m)t=m[1];else{{try{{t=localStorage.getItem('rs26-theme')}}catch(e){{}}}}if(t!=='light'&&t!=='dark')t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';document.documentElement.setAttribute('data-theme',t)}})()</script>
<meta name="description" content="Evidence-linked interactive briefing on retail security in 2026: cyber, OT sabotage, fraud, physical crime, geopolitics and regulation, with a 3D incident globe and {len(SOURCES)} cited sources.">
<style>{CSS}</style></head><body>
{hero}
{section('globe-sec','Where it happened: the 2026 incident globe','Interactive 3D', globe)}
{section('threats','The ten threats trending hardest into Q4','Ranked', threats)}
{section('regions','Region ranking by trend','Middle East first, then by momentum', rank_sec)}
{section('middle-east','Middle East & North Africa','Region 1 of 6 · war, volume, thin disclosure', me_html)}
{section('world','Other regions, ranked by trend','Europe · North America · Asia-Pacific · Africa · Latin America', world_html)}
{section('charts','The numbers behind the year','Ransomware, breaches, news volume, theft and fraud', charts)}
{section('timeline','Timeline, January to 16 October','Every tracked event in date order', timeline)}
{section('actors','Threat actors that shaped retail in 2026','Who, what, status', actors)}
{section('vendors','Vendor and competitor landscape','Who showed up in the evidence', vendors)}
{section('voices','What practitioners and customers said','Verbatim public posts', voices)}
{section('market','Market research','Security spend and vendor markets', market)}
{section('method','Method, coverage and limitations','How the evidence was gathered', method)}
{section('evidence','Evidence index','{len(SOURCES)} numbered sources', evidence)}
<footer class="end"><div class="wrap">Compiled {TODAY} by the Product Intelligence Crawl Engineer session for the Retail Security task. Collection used only public endpoints, no logins and no paywall bypass. Leak-site claims are reported as claims. Figures are as published by the cited sources on the dates shown.</div></footer>
<script>{JS % dict(catd=js({k:v[1] for k,v in CAT.items()}), catl=js(LCAT), geo=js(geo_js), inc=js([inc_js(i) for i in INCIDENTS]))}</script>
</body></html>'''
os.makedirs(os.path.join(ROOT,'build','site'), exist_ok=True)
out = os.path.join(ROOT,'build','site','index.html')
open(out,'w',encoding='utf-8').write(page)
print('wrote', out, f'{len(page.encode())/1024:.0f} KB')
