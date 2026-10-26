#!/usr/bin/env python3
"""Build the premium PDF: cover.html + body.html -> docker Chromium -> merged build/pdf/report.pdf (two passes for TOC page numbers)."""
import json, os, sys, html, io, base64, subprocess, datetime, math, re
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from report_sources import SOURCES, NUM, ORDER
from report_incidents import INCIDENTS, QUOTES, ACTORS, RANKINGS, THREATS, VENDORS, LIMITATIONS
import report_stats as T
import report_charts as C
from report_common import CAT, COUNTRY, REGION_ORDER, ICON, CAT_ICON, icon
E = html.escape
TODAY = "16 October 2026"
PDF = os.path.join(ROOT, 'build', 'pdf'); os.makedirs(PDF, exist_ok=True)
PCAT = {"cyber":"#0369a1","ot":"#be123c","physical":"#b45309","fraud":"#4d7c0f","geopolitical":"#c2410c","regulatory":"#6d28d9","enforcement":"#0f766e","market":"#475569"}
MISSING = []
def K(*keys):
    for k in keys:
        if k not in SOURCES: MISSING.append(k)
    return [k for k in keys if k in SOURCES]
def cite(keys):
    return '<span class="cites">' + "".join(f'<a href="#s{NUM[k]}">S{NUM[k]}</a>' for k in K(*keys)) + '</span>'
def fdate(d): return datetime.date.fromisoformat(d).strftime("%d %b %Y")
def by_region(r): return sorted([i for i in INCIDENTS if i['region']==r], key=lambda i:(-i['sev'], i['date']))
def inc_by_id(i): return next((x for x in INCIDENTS if x['id']==i), {'name': i})

# ---------- static globe (orthographic, hand-projected)
GEO = json.load(open(os.path.join(ROOT,'build','geo_s.json')))['countries']
from report_assets import globe_svg as _globe_svg, PDF_CSS as CSS, COVER_CSS
def globe_svg(clon, clat, size=420, dark=False, incs=None, uid="g"):
    return _globe_svg(GEO, INCIDENTS if incs is None else incs, clon, clat, size, dark, uid)

# ---------- screenshots
SHOT_LIST = {s['id']: s['url'] for s in json.load(open(os.path.join(ROOT,'build','shots','list.json')))}
URL2KEY = {v[1].rstrip('/'): k for k, v in SOURCES.items()}
SHOT_OVERRIDE = {'dubai_police_oud':'dubai-oud','hibp_carhartt':'carhartt-hibp','comparitech_h1':'comparitech-h1','claires_breachsense':'claires-breachsense','cisa_gunra':'cisa-gunra','akamai_pr':'akamai-pr','aljazeera_hormuz':'aljazeera-hormuz','ibm_codb_saudi':'ibm-sa','national_supermarkets':'national-prices','omanobserver_food':'oman-foodbills','wiki_iran_econ':'wiki-iran-econ','blackkite_2026':'blackkite','sainsburys_grocer':'sainsburys-pause','uae_800k_gulfnews':'uae-800k','ibm_codb_me':'ibm-me','lulu_gulfnews':'lulu-gulfnews','dubai_luxury_fashionunited':'fu-dubai-luxury','budget_saudi_argaam':'budget-argaam','fridges_thn':'fridge-thn','wiki_fridges':'fridge-wiki','ah_therecord':'ah-therecord','asos_techcrunch':'asos-tc','met_ico_computerweekly':'met-ico-cw','brc_crime':'brc-crime','nrf_2026':'nrf-pr','ransomwarelive':'ransomwarelive','gambit_computerworld':'gambit-cw','coupang_upi':'coupang-upi','japan_nippon':'japan-wave','picknpay_iol':'pnp-iol'}
SHOT_USED = []
def shot_key(sid):
    u = SHOT_LIST.get(sid, '').rstrip('/')
    k = URL2KEY.get(u) or SHOT_OVERRIDE.get(sid)
    if k is None: MISSING.append('shot:'+sid)
    SHOT_USED.append((sid, k, 'url' if URL2KEY.get(u) else 'override'))
    return k
_imgcache = {}
SHOT_ABSENT = []
def placeholder(sid, width=880, height=420):
    """Grey card used when a screenshot was not captured on this run (site refused the page): the source is still cited, never faked."""
    from PIL import ImageDraw
    im = Image.new('RGB', (width, height), (235, 238, 243)); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, width-1, height-1), outline=(180, 186, 196), width=2)
    d.text((28, 150), 'Screenshot not captured on this run', fill=(60, 70, 85))
    d.text((28, 180), 'The page was not reachable from this machine; see the evidence index for the source.', fill=(100, 110, 125))
    d.text((28, 210), SHOT_LIST.get(sid, sid)[:120], fill=(100, 110, 125))
    SHOT_ABSENT.append(sid)
    return im
def img64(sid, width=880, crop_h=None):
    if sid in _imgcache: return _imgcache[sid]
    path = os.path.join(ROOT,'build','shots',sid+'.png')
    im = Image.open(path).convert('RGB') if os.path.exists(path) else placeholder(sid)
    if crop_h: im = im.crop((0,0,im.width,min(im.height,crop_h)))
    im = im.resize((width, round(im.height*width/im.width)), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=80, optimize=True)
    _imgcache[sid] = 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
    return _imgcache[sid]
def fig(sid, caption, crop_h=None):
    k = shot_key(sid)
    src = SOURCES[k] if k else None
    cap = f'{E(caption)}' + (f' — {E(src[2])}, {E(src[3])} {cite([k])}' if src else '')
    return f'<figure class="shot"><img src="{img64(sid, crop_h=crop_h)}" alt="{E(caption)}"><figcaption>{cap}</figcaption></figure>'
def figrow(*figs): return f'<div class="figrow{" one" if len(figs)==1 else ""}">' + "".join(figs) + '</div>'

# ---------- blocks
def pcard(inc):
    color = PCAT[inc['cat']]; label = CAT[inc['cat']][0]
    st = {'confirmed':'<span class="st ok">confirmed</span>','claimed':'<span class="st cl">claim, unverified</span>','context':'<span class="st cx">statistic / policy</span>'}[inc['status']]
    sev = '<span class="sev">' + "".join('<i class="%s"></i>' % ('on' if j < inc['sev'] else '') for j in range(5)) + '</span>'
    return (f'<div class="pc" style="--c:{color}"><div class="pch">{icon(CAT_ICON[inc["cat"]],11,color)}<b>{E(inc["name"])}</b></div>'
            f'<div class="pcm"><span>{fdate(inc["date"])}</span><span>{E(COUNTRY.get(inc["country"],inc["country"]))}</span><span style="color:{color}">{E(label)}</span>{sev}{st}</div>'
            f'<div class="pct">{E(inc["type"])} · <b>{E(inc["impact"])}</b></div><p>{E(inc["summary"])}</p><div class="pcf">{cite(inc["src"])}</div></div>')
def cards(items): return '<div class="pcg">' + "".join(pcard(i) for i in items) + '</div>'
def tile(big, text, keys): return f'<div class="tile"><b>{big}</b><span>{text}</span>{cite(keys)}</div>'
def scorecard(region):
    items = by_region(region)
    cats = {}
    for i in items: cats[i['cat']] = cats.get(i['cat'], 0) + 1
    conf = sum(1 for i in items if i['status']=='confirmed'); cl = sum(1 for i in items if i['status']=='claimed')
    top = sorted(items, key=lambda i:-i['sev'])[:3]
    cs = " · ".join(f'<span style="color:{PCAT[c]}">{E(CAT[c][0])} {n}</span>' for c, n in sorted(cats.items(), key=lambda x:-x[1]))
    return (f'<div class="score"><div><b>{len(items)}</b><span>entries</span></div><div><b>{conf}</b><span>confirmed</span></div><div><b>{cl}</b><span>claims</span></div>'
            f'<div class="sc-cats">{cs}</div><div class="sc-top"><span>Highest severity:</span> {"; ".join(E(t["name"]) for t in top)}</div></div>')

SECTIONS = [("01","exec","Executive summary","What a security director needs to know"),
            ("02","regions","Region ranking and the incident map","Middle East first, then by momentum"),
            ("03","me","Middle East and North Africa","Region 1 of 6 · war, volume, thin disclosure"),
            ("04","eu","Europe","Trend rank 1 · OT sabotage, identity-led intrusions, surveillance backlash"),
            ("05","na","North America","Trend rank 3 · mega breaches, AI-agent fraud, theft and violence"),
            ("06","apac","Asia-Pacific","Trend rank 4 · record fines and a Japanese breach wave"),
            ("07","afr","Africa and Latin America","Trend ranks 5 and 6"),
            ("08","numbers","The numbers behind the year","Ransomware, breaches, news volume, theft and fraud"),
            ("09","timeline","Timeline, January to 16 October","Every tracked event in date order"),
            ("10","actors","Threat actors and vendor landscape","Who attacked, who defended"),
            ("11","voices","Voices, market research, method","What people said · security spend · how this was built"),
            ("12","evidence","Evidence index","All sources, numbered in citation order")]
def sec(num, id_, title, kicker, inner, first=False):
    return f'<section class="sec{" first" if first else ""}" id="{id_}"><span class="mk">@@{id_}@@</span><div class="kicker">{E(kicker)}</div><h1><span class="num">{num}</span>{E(title)}</h1>{inner}</section>'

# ---------- 01 executive summary
FINDINGS = [
 ("OT sabotage became a retail safety problem.", "On 11–12 October an unknown actor took over internet-exposed Danfoss, Copeland and Dixell refrigeration controllers in roughly 700 French supermarkets, drove fridges to 50 °C, started fires and spoiled more than €10M of stock. CERT-FR widened its alert on 13 October; Shadowserver still counted ~1,200 Copeland XWEB and ~4,500 Danfoss panels exposed, and copycat disruption was reported in Belgium, Germany, Luxembourg, the Netherlands, Portugal, Poland and Spain. Insurers signalled they will not pay.", ["fridge-wiki","fridge-reuters","fridge-thn","fridge-certfr","fridge-shadowserver","fridge-martincid","fridge-insurance"]),
 ("Identity is the front door; October was the busiest fortnight of the year.", "ASOS (rogue 'ASOS HACKED' push notification, employee credentials obtained by social engineering and used on third-party platforms, ~17M customers, shares −10%), Ahold Delhaize (distribution centres and online grocery halted in the Netherlands and Belgium, US banner apps down, ~€10M), TFG London and an H&M claim all landed between 6 and 13 October. Earlier in the year Coupang (33.7M people), Canadian Tire (38.3M accounts) and Under Armour (72.7M) set the scale.", ["asos-tc","asos-reg","ah-therecord","ah-dutchnews-restock","tfg-therecord","hm-cerberus","coupang-upi","ct-securityweek","ua-infosec"]),
 ("Ransomware volume set records and retail grew fastest.", "Q3 2026 logged 2,627 leak-site victims (+61% year on year) with retail at 199 (+97%); H1 counted 4,217 with retail at 326. The Gentlemen, Qilin and DragonForce dominate retail and Middle East listings. 48% of victims paid (retail 32%); the DBIR puts ransomware in 48% of breaches with a median payment of $139,875.", ["infosec-q3","grit-q3","comparitech-h1","sophos-2026","dbir-full","ransomwarelive"]),
 ("The Middle East is a war-economy story with thin breach disclosure.", "Attack attempts on the UAE rose from ~200,000 to ~800,000 a day; the Strait of Hormuz closed twice; Lulu airlifted food; Dubai luxury footfall fell; IBM puts the regional breach cost at $8.0M (Saudi Arabia SAR 27M). Confirmed consumer-facing breaches are rare in public (Budget Saudi is the clean example), so leak-site claims against Gulf suppliers (Nodhom, Geidea, Raqib, GBM, Al Khaja, UAE Customs) are the leading indicator.", ["uae-800k","uae-200k","aljazeera-hormuz","lulu-gulfnews","fu-dubai-luxury","ibm-me","ibm-sa","budget-argaam","ransomwarelive"]),
 ("AI agents moved from theory to invoices.", "A Gambit interim report documented an operator using agentic tooling to compromise 27 organisations and 600,000+ payment cards at about $25 per target. Akamai measured 47.9% of all AI-bot traffic hitting commerce while 90% of retailers only monitor bots. India's CERT-In issued its first agentic-AI advisory on 15 October.", ["gambit-cw","gambit-csa","akamai-pr","akamai-report","certin-ai"]),
 ("Theft is down, violence and fraud are up.", "NRF 2026: shoplifting incidents −12.4% and merchandise theft −8.1%, but 50% of retailers see more repeat offenders, 40% more organised retail crime and 37% more push-outs; phone scams (69%), loyalty (51%) and gift-card fraud (42%) are rising. The BRC counts ~1,600 violence and abuse incidents a day in UK retail. US cargo theft losses more than doubled to $304.6M in Q2.", ["nrf-pr","nrf-report","brc-crime","verisk-cargo","selfcheckout"]),
 ("Surveillance backlash and regulators are now a line item.", "The ICO warned the Met over its Auror shadow-IT use (179 people, 29.4% of records in scope); Sainsbury's paused facial recognition after a wrongful ejection; Coupang was fined KRW 625bn and is suing; SDAIA published 48 PDPL decisions; the UAE's Cabinet Resolution 107/2026 gives retailers 24 hours to pull counterfeit goods; Dutch police invited Ahold Delhaize to file a criminal report.", ["met-ico-cw","sainsburys-pause","coupang-upi","sdaia-48","kt-fraudlaw","ah-dutchnews-police"]),
 ("Enforcement is biting.", "The NCA charged four over the M&S and Co-op attacks; a core ShinyHunters member was detained in Jordan on 3 October and a Canadian associate arrested on 13 October; a Qilin suspect was extradited from Japan to Germany; INTERPOL's Operation Ramz was the first MENA-wide cybercrime takedown.", ["nca-four","shiny-jordan","shiny-canadian-arrest","qilin-arrest-sw","groupib-ramz"]),
]
ACTIONS = [
 ("Pull OT off the internet.", "Inventory refrigeration, HVAC and BMS controllers (Danfoss AK-SM/AK-SC, Copeland XWEB/Dixell), remove public exposure, rotate 'code of the day' and default credentials, alarm on setpoint changes.", ["fridge-certfr","fridge-shadowserver","fridge-claroty"]),
 ("Harden the help desk and third-party SaaS.", "Callback verification, phishing-resistant MFA for admins, session and token controls on data-platform connectors; the ASOS and ShinyHunters playbooks start with a phone call.", ["asos-tc","scattered-spider-cisa","shiny-push"]),
 ("Treat suppliers as your attack surface.", "68% of retail breaches involve a third party; GBM, Global-e and Nodhom show how a single integrator reaches hundreds of retailers. Test incident clauses and offline fallbacks.", ["dbir-retail","gbm","ledger-globale","nodhom"]),
 ("Plan to run warehouses by hand.", "Ahold Delhaize and Fairlife lost distribution, not just data. Immutable backups, printed pick lists and store-level pricing fallbacks are the cheapest insurance.", ["ah-therecord","fairlife","sophos-2026"]),
 ("Move bot defence from monitoring to enforcement.", "Login, checkout, gift-card and loyalty APIs first; budget for agentic-commerce controls as Checkout.com and Ravelin now describe.", ["akamai-pr","checkout-agentic","ravelin-agentic"]),
 ("Re-score fraud by channel.", "Gift cards, loyalty, returns and delivery-scam calls are where the money went in 2026; Valve pulled Steam cards from shelves, Dubai Police broke up a Dh12M oud scam.", ["nrf-pr","valve-giftcards","chicago-fragrance","kt-fakedelivery","dubai-oud"]),
 ("Use facial recognition only with a lawful basis and an audit trail.", "The Met/Auror warning, Sainsbury's pause, Facewatch and Sports Direct backlash show the reputational price of getting this wrong.", ["met-ico-cw","sainsburys-pause","facewatch-police","sportsdirect"]),
 ("Gulf operators: run a war-mode playbook and disclose.", "Supply airlifts, store hours, staff safety and price controls during Hormuz closures; comply with Cabinet Resolution 107/2026 and SDAIA precedents; Budget Saudi's Tadawul disclosure is the model.", ["lulu-gulfnews","rin-foodchecks","kt-fraudlaw","sdaia-48","budget-argaam"]),
]
n_conf = sum(1 for i in INCIDENTS if i['status']=='confirmed'); n_claim = sum(1 for i in INCIDENTS if i['status']=='claimed')
exec_html = f'''
<div class="tiles six">
 {tile(str(len(INCIDENTS)), f"incidents and signals tracked ({n_conf} confirmed, {n_claim} claims)", [])}
 {tile(str(len(SOURCES)), "cited sources, numbered S1 to S"+str(len(SOURCES)), [])}
 {tile(f"{T.NEWS['unique_titles']:,}", "unique 2026 news titles read and themed", [])}
 {tile(f"{T.RL['total']}", "leak-site listings, retail and Middle East scope", ["ransomwarelive"])}
 {tile("$8.0M", "average breach cost, Middle East (IBM 2026)", ["ibm-me"])}
 {tile("~700", "French stores with sabotaged fridges, 11–12 Oct", ["fridge-wiki","fridge-reuters"])}
</div>
<h2>Eight findings</h2>
<ol class="findings">{"".join(f'<li><b>{E(h)}</b> {E(t)} {cite(k)}</li>' for h,t,k in FINDINGS)}</ol>
<h2>The ten threats trending hardest into Q4</h2>
<table class="tbl threats"><thead><tr><th>#</th><th>Threat</th><th>Trend</th><th>Evidence in 2026</th><th>Linked incidents</th></tr></thead><tbody>
{"".join(f'<tr><td class="rk">{t["rank"]}</td><td><b>{E(t["name"])}</b></td><td class="trend">{E(t["trend"])}</td><td>{E(t["evidence"])}</td><td class="small">{"; ".join(E(inc_by_id(i)["name"]) for i in t["ids"][:3])}</td></tr>' for t in THREATS)}
</tbody></table>
<h2>Priority actions for a 2027 plan</h2>
<div class="actions">{"".join(f'<div class="act"><div class="an">{n+1:02d}</div><div><b>{E(h)}</b> {E(t)} {cite(k)}</div></div>' for n,(h,t,k) in enumerate(ACTIONS))}</div>
<div class="howto" style="display:none"><b>How to read this report.</b> Every figure carries an S-number that points to the evidence index (section 12), where the original URL is printed. "Confirmed" means the company, a regulator or a court said it; "claim, unverified" means a leak site or researcher said it and the company has not; "statistic / policy" entries are studies, laws and market signals. Severity (1–5) is an analyst score on scale, consequence and novelty. Leak-site claims are never treated as breaches.</div>'''

# ---------- 02 regions
rank_chart = C.hbars([(r['region'], r['score']) for r in RANKINGS], color="#0f766e", max_val=100, title="Trend score by region (analyst judgement, 0–100)", dark=False, label_w=150, w=700)
rrows = "".join(f'<tr><td class="rk">{r["rank"]}</td><td><b>{E(r["region"])}</b></td><td>{r["score"]}</td><td>{E(r["why"])}</td></tr>' for r in RANKINGS)
regcount = {}
for i in INCIDENTS: regcount.setdefault(i['region'], {}).setdefault(i['cat'], 0); regcount[i['region']][i['cat']] += 1
cat_cols = ["cyber","ot","physical","fraud","geopolitical","regulatory","enforcement","market"]
matrix = "".join(f'<tr><td><b>{E(r)}</b></td>' + "".join(f'<td class="c">{regcount.get(r,{}).get(c,"") or "·"}</td>' for c in cat_cols) + f'<td class="c"><b>{sum(regcount.get(r,{}).values())}</b></td></tr>' for r in REGION_ORDER)
regions_html = f'''
<p class="lede">The trend score ranks regions by breadth of confirmed incidents, novelty of technique, financial and regulatory consequence, and momentum into Q4. Europe leads on all four because of the French refrigeration sabotage and the October identity-led intrusions; the Middle East is second on volume, war exposure and regulatory velocity, and is presented first in this report as briefed.</p>
<div class="globes">
 <figure><div class="gl">{globe_svg(38, 24, uid="ga")}</div><figcaption>Europe, Middle East and Africa</figcaption></figure>
 <figure><div class="gl">{globe_svg(-85, 30, uid="gb")}</div><figcaption>The Americas</figcaption></figure>
 <figure><div class="gl">{globe_svg(118, 22, uid="gc")}</div><figcaption>Asia-Pacific</figcaption></figure>
</div>
<div class="legend">{"".join(f'<span><i style="background:{PCAT[c]}"></i>{E(CAT[c][0])}</span>' for c in cat_cols)}<span><i class="dash"></i>unverified claim</span><span>marker size = severity</span></div>
<div class="two"><div class="panel">{rank_chart}</div><div class="panel"><table class="tbl matrix"><thead><tr><th>Region</th>{"".join(f'<th title="{E(CAT[c][0])}">{icon(CAT_ICON[c],10,PCAT[c])}</th>' for c in cat_cols)}<th>All</th></tr></thead><tbody>{matrix}</tbody></table><div class="cap">Entries per region and category. Columns: cyber, OT/IoT, physical, fraud, geopolitical, regulatory, enforcement, market.</div></div></div>
<table class="tbl"><thead><tr><th>#</th><th>Region</th><th>Score</th><th>Why</th></tr></thead><tbody>{rrows}</tbody></table>'''

# ---------- 03 middle east
war = [("28 Feb","War begins; Gulf airspace closures"),("4 Mar","Strait of Hormuz closed to shipping"),("12 Mar","Lulu charters food airlifts to UAE and Kuwait"),("19 Mar","UAE tightens food-retail checks amid panic buying"),("7 Apr","Ceasefire"),("17 Apr","Hormuz reopens"),("May","UAE: 800,000 attacks a day"),("12 Jul","Iran strikes five Gulf states; Hormuz closed again"),("19 Jul","UAE supermarkets report rising costs"),("19 Sep","Houthi attack near Riyadh airport"),("3 Oct","ShinyHunters member detained in Jordan"),("12 Oct","Fresh strikes; Riyadh airport shut to 17 Oct"),("16 Oct","UAE: sleeper cells active during strikes")]
uae_chart = C.iso_bars([("2025 (early)", T.UAE['daily_attacks_2025']), ("2026 (May–Oct)", T.UAE['daily_attacks_2026'])], colors=["#94a3b8","#c2410c"], h=230, title="Daily cyberattack attempts on the UAE (Cyber Security Council)", fmt=lambda v: f"{int(v):,}", dark=False, w=700)
rl_me = [(COUNTRY.get(c, {"MA":"Morocco","IR":"Iran","PK":"Pakistan","OM":"Oman"}.get(c,c)), n) for c, n in T.RL['by_country'] if c in ("TR","AE","IL","EG","SA","MA","IR","PK","QA","OM","KW")]
rl_me_chart = C.hbars(rl_me, color="#be123c", title="Leak-site listings by country, Middle East scope, 2026 (ransomware.live)", dark=False, w=700, label_w=120)
me_html = f'''
<p class="lede">The Gulf's 2026 security story is a war story first. Attack volume on the UAE quadrupled, Hormuz closed twice, food was airlifted, luxury footfall fell and the leak sites filled with Gulf suppliers. Confirmed retail breaches remain rare in public, which is itself a finding: disclosure is thin, so claims and supplier compromises are the leading indicators.</p>
{scorecard("Middle East")}
<h2>The war timeline that shaped Gulf retail {cite(["aljazeera-hormuz","wiki-iran-econ","guardian-riyadh","uae-800k","uae-sleeper","lulu-gulfnews","rin-foodchecks","national-prices"])}</h2>
<div class="strip">{"".join(f'<div class="sp"><b>{E(d)}</b><span>{E(t)}</span></div>' for d,t in war)}</div>
<div class="two"><div class="panel">{uae_chart}<div class="cap">{cite(["uae-800k","uae-800k-spike","uae-200k","aviatrix-me"])}</div></div><div class="panel">{rl_me_chart}<div class="cap">Claims, not confirmed breaches. {cite(["ransomwarelive"])}</div></div></div>
<h2>What a breach costs here (IBM Cost of a Data Breach 2026)</h2>
<div class="tiles six">{tile(f"${T.IBM['me_avg_cost_usd_m']}M","average cost of a breach, Middle East",["ibm-me","wam-ibm"])}{tile(f"SAR {T.IBM['saudi_avg_sar_m']}M","average cost, Saudi Arabia",["ibm-sa"])}{tile(f"{T.IBM['me_phishing_share']}%",f"of ME breaches start with phishing (${T.IBM['me_phishing_cost_m']}M each)",["ibm-me"])}{tile(f"{T.IBM['me_ai_enabled_share']}%","of ME breaches involved AI-enabled attacks",["ibm-me"])}{tile(f"{T.IBM['me_supply_chain_share']}%","supply-chain compromise share",["ibm-me"])}{tile(f"{T.IBM['me_raising_spend']}%","of ME firms raising security spend",["ibm-me"])}</div>
<h2>Evidence: what the region's press and vendors published</h2>
{figrow(fig("uae_800k_gulfnews","UAE faces over 800,000 cyberattacks daily"), fig("ibm_codb_me","IBM: Middle East breach cost reaches $8M in 2026"))}
{figrow(fig("aljazeera_hormuz","Iran attacks five Gulf nations and shuts Hormuz after US bombing", crop_h=790), fig("wiki_iran_econ","Economic impact of the 2026 Iran war: the IEA calls it the largest oil-supply disruption in history"))}
{figrow(fig("lulu_gulfnews","Lulu charters cargo flights to keep UAE shelves stocked"), fig("national_supermarkets","UAE economy ministry: food stocks will not be compromised; retailers report higher freight costs"))}
{figrow(fig("omanobserver_food","Hormuz blockage drives up food bills in some GCC states"), fig("dubai_luxury_fashionunited","Dubai luxury retail during the war"))}
{figrow(fig("budget_saudi_argaam","Budget Saudi discloses an app data breach on Tadawul"), fig("ibm_codb_saudi","IBM: average breach cost in Saudi Arabia reaches SAR 27M; one in four malicious breaches AI-enabled"))}
{figrow(fig("dubai_police_oud","Dubai Police bust a gang behind a Dh12M oud scam", crop_h=800))}
<h2>Middle East incident register ({len(by_region("Middle East"))})</h2>{cards(by_region("Middle East"))}'''

# ---------- 04–07 regions
def region_section(region, intro, figs):
    return f'<p class="lede">{E(intro)}</p>{scorecard(region)}{figs}<h2>{E(region)} incident register ({len(by_region(region))})</h2>{cards(by_region(region))}'
eu_html = region_section("Europe", "Europe is the trend leader because two new things happened here: the first cyberattack with a physical effect on a national food supply (the French refrigeration sabotage) and a fortnight of identity-led intrusions at ASOS, Ahold Delhaize, TFG London and H&M. The M&S and Co-op bills from 2025 (£131M and £285M) became the reference cost, and the surveillance backlash (Met/Auror, Sainsbury's, Facewatch) turned loss prevention into a regulatory topic.",
    figrow(fig("fridges_thn","Attackers heat French supermarket fridges to 50 °C (The Hacker News)"), fig("wiki_fridges","Wikipedia summary of the French refrigeration hack")) +
    figrow(fig("ah_therecord","Ahold Delhaize incident hits grocery stores in the US, Netherlands and Belgium (The Record)"), fig("asos_techcrunch","ASOS confirms breach after rogue app notification (TechCrunch)")) +
    figrow(fig("met_ico_computerweekly","ICO warns the Met over shadow-IT use of Auror (Computer Weekly)"), fig("brc_crime","BRC Crime Report 2026")) +
    figrow(fig("sainsburys_grocer","Sainsbury's planned to extend facial recognition to 200 stores by Christmas, before the October pause", crop_h=800)))
na_html = region_section("North America", "North America had the biggest numbers: IDScan (up to 153M ID numbers), Under Armour (72.7M), Canadian Tire (38.3M), Carhartt (12.9M), the PeopleSoft zero-day wave at Ralph Lauren and JCPenney, and Claire's 1.71 TB claim. It also produced the year's clearest AI-agent evidence (Gambit, PaperCut), the NRF's theft-down-violence-up picture, record cargo theft and a visible retreat from self-checkout.",
    figrow(fig("nrf_2026","NRF: fraud schemes evolve as shoplifting declines"), fig("gambit_computerworld","AI tools help a hacker break in for $25 per target (Computerworld)")) +
    figrow(fig("hibp_carhartt","Carhartt breach loaded to Have I Been Pwned: 12.9M addresses, ShinyHunters extortion"), fig("claires_breachsense","Claire's listed by DarkProject with a 1.71 TB leak size: a claim, not a confirmed breach")))
apac_html = region_section("Asia-Pacific", "Asia-Pacific is defined by regulators and by scale: Coupang's 33.7M-person breach drew a record KRW 625bn fine and lawsuits, Japan saw a wave of multi-million-customer breaches (Burger King Japan 11.18M, SourceNext 22.5M, Skyticket 14.64M, Monogatari 10.79M, Daiichikosho 8.72M, Bookoff 6.43M), and new groups (Orova, HYFLOCK, Seven Deadly Sins) listed Singapore, Taiwan and Philippine retailers.",
    figrow(fig("coupang_upi","Coupang challenges $466M privacy fines (UPI)"), fig("japan_nippon","More Japanese firms hit by large-scale data breaches (nippon.com)")))
afr_html = (f'<p class="lede">Africa and Latin America produced fewer public incidents but the ones that surfaced follow the global pattern: third-party and database exposures (Pick n Pay delivery users, Lego Certified Stores SA, Shoprite risk disclosures) and credential and payment-data breaches (Addi 34.5M, Mercado Libre).</p>'
            f'<h2>Africa</h2>{scorecard("Africa")}{figrow(fig("picknpay_iol","Pick n Pay confirms a data breach affecting delivery users (IOL)"))}{cards(by_region("Africa"))}'
            f'<h2>Latin America</h2>{scorecard("Latin America")}{cards(by_region("Latin America"))}')

# ---------- 08 numbers
L = dict(dark=False, w=700)
rans_month = C.iso_bars(T.RL['by_month'], color="#be123c", title="Retail + Middle East leak-site listings by month, 2026 (Oct = 1–16)", **L)
news_month = C.iso_bars(T.NEWS['by_month'], color="#0369a1", title="Retail-security news titles by month, 2026 (Oct = 1–16)", **L)
themes = C.hbars(T.NEWS['themes'], color="#b45309", title="What the 2026 coverage was about (title mentions)", **L)
groups = C.hbars(T.RL['by_group'], color="#6d28d9", title="Most active groups against retail / Middle East targets (listings)", **L)
q_bars = C.iso_bars([("Q3 2025", round(T.RANSOMWARE['q3_record']/(1+T.RANSOMWARE['q3_yoy']/100))), ("H1 2026 /2", T.RANSOMWARE['h1_attacks']//2), ("Aug 2026", T.RANSOMWARE['aug_record']), ("Q3 2026", T.RANSOMWARE['q3_record'])], colors=["#94a3b8","#0369a1","#c2410c","#be123c"], title="Global ransomware victims: Q3 2026 is a record (2,627, +61% YoY)", h=250, **L)
retail_q = C.iso_bars([("H1 2025", round(T.RANSOMWARE['h1_retail']/(1+T.RANSOMWARE['h1_retail_growth']/100))), ("H1 2026", T.RANSOMWARE['h1_retail']), ("Q3 2025", round(T.RANSOMWARE['retail_q3']/(1+T.RANSOMWARE['retail_q3_yoy']/100))), ("Q3 2026", T.RANSOMWARE['retail_q3'])], colors=["#94a3b8","#b45309","#94a3b8","#b45309"], title="Retail ransomware victims: H1 +28%, Q3 +97% year on year", h=250, **L)
dbir = C.grouped_iso([(p[0], [p[3],p[2],p[1]]) for p in T.DBIR['patterns']], ["DBIR 2024","DBIR 2025","DBIR 2026"], ["#94a3b8","#0369a1","#b45309"], title="Retail breach patterns, share of breaches (Verizon DBIR retail snapshots)", **L)
dbir_access = C.hbars(list(T.DBIR['initial_access_retail'].items()), color="#0f766e", unit="%", title="Initial access in retail breaches, DBIR 2026", **L)
hibp_items = sorted([(r[1], r[4]) for r in T.HIBP_RETAIL], key=lambda x:-x[1])[:14]
hibp = C.hbars(hibp_items, color="#0369a1", title="Retail-adjacent breaches loaded to Have I Been Pwned in 2026 (accounts)", fmt=lambda v: f"{v/1e6:.1f}M" if v>=1e6 else f"{v/1e3:.0f}k", **L)
nrf = C.hbars([("Shoplifting incidents", T.NRF['shoplifting_change']), ("Merchandise theft $", T.NRF['merch_theft_change']), ("Repeat offenders ↑ (share)", T.NRF['repeat_offenders_up']), ("ORC ↑ (share)", T.NRF['orc_up']), ("Push-outs ↑ (share)", T.NRF['pushout_up'])], colors=["#0f766e","#0f766e","#be123c","#be123c","#be123c"], unit="%", title="NRF 2026: theft down, violence and repeat offending up", fmt=lambda v: f"{v:+.1f}" if isinstance(v,float) else f"{v:+d}", max_val=60, **L)
fraud_d = C.donut([("Phone scams", T.NRF['phone_scams']), ("Loyalty fraud", T.NRF['loyalty_fraud']), ("Gift-card fraud", T.NRF['gift_card_fraud'])], ["#b45309","#4d7c0f","#be123c"], title="NRF fraud (share of retailers seeing more)", w=240, dark=False)
akamai_d = C.donut([("Commerce", T.AKAMAI['commerce_ai_bot_share']), ("All other sectors", round(100-T.AKAMAI['commerce_ai_bot_share'],1))], ["#c2410c","#cbd5e1"], title="Share of AI-bot traffic", w=240, dark=False)
numbers_html = f'''
<div class="two"><div class="panel">{rans_month}<div class="cap">{cite(["ransomwarelive"])} {E(T.RL['note'])}</div></div><div class="panel">{news_month}<div class="cap">{E(T.NEWS['note'])}</div></div></div>
<div class="two"><div class="panel">{q_bars}<div class="cap">{cite(["infosec-q3","grit-q3","comparitech-h1","comparitech-jul","blackkite"])}</div></div><div class="panel">{retail_q}<div class="cap">{cite(["comparitech-h1","grit-q3","infosec-q3"])}</div></div></div>
<div class="two"><div class="panel">{dbir}<div class="cap">{cite(["dbir-retail","dbir-full"])} {E(T.DBIR['edition'])}. Retail: {T.DBIR['retail_incidents']} incidents, {T.DBIR['retail_breaches']} breaches; third party in {T.DBIR['third_party_retail']}%, human element in {T.DBIR['human_element_retail']}%.</div></div><div class="panel">{dbir_access}<div class="cap">Globally: vulnerability exploitation {T.DBIR['global']['vuln_exploitation']}%, credential abuse {T.DBIR['global']['cred_abuse']}%; only {T.DBIR['global']['kev_remediated']}% of KEV flaws fully remediated (median {T.DBIR['global']['kev_median_days']} days); ransomware in {T.DBIR['global']['ransomware_share']}% of breaches; {T.DBIR['global']['no_pay']}% refused to pay; median ransom ${T.DBIR['global']['median_ransom']:,}. {cite(["dbir-full"])}</div></div></div>
<div class="two"><div class="panel">{themes}<div class="cap">Theme counts over {T.NEWS['unique_titles']:,} unique titles.</div></div><div class="panel">{groups}<div class="cap">{cite(["ransomwarelive","comparitech-h1","qilin-1358"])}</div></div></div>
<div class="two"><div class="panel">{hibp}<div class="cap">{cite(["hibp","ct-hibp","carhartt-hibp"])} Under Armour's breach is dated Nov 2025 but was loaded in Jan 2026.</div></div><div class="panel">{nrf}<div class="donuts"><div>{fraud_d}<div class="cap">{cite(["nrf-pr","nrf-report"])}</div></div><div>{akamai_d}<div class="cap">47.9% of AI-bot traffic targets commerce; 90% of retailers only monitor bots; 85% had an API incident. {cite(["akamai-pr","akamai-report"])}</div></div></div></div></div>
<div class="tiles six">{tile(f"{T.RANSOMWARE['sophos_paid']}%", f"of ransomware victims paid (retail {T.RANSOMWARE['sophos_retail_paid']}%)", ["sophos-2026"])}{tile(f"${T.RANSOMWARE['h1_median_demand']:,}", "median ransom demand H1 2026 (average $1.36M)", ["comparitech-h1"])}{tile(f"{T.RANSOMWARE['blackkite_victims']:,}", f"leak-site victims in Black Kite's 2026 report (+{T.RANSOMWARE['blackkite_growth']}%)", ["blackkite","blackkite-retail"])}{tile(f"${T.NRF['cargo_q2_usd_m']}M", "Q2 cargo-theft losses, more than double", ["verisk-cargo"])}{tile(f"~{T.NRF['brc_incidents_per_day']:,}/day", "violence and abuse incidents in UK retail", ["brc-crime"])}{tile(f"{T.AKAMAI['phishing_per_day_from']:,}→{T.AKAMAI['phishing_per_day_to']:,}", "daily phishing attempts on commerce (Akamai)", ["akamai-report"])}</div>
{figrow(fig("ransomwarelive","ransomware.live victims dashboard on 16 Oct 2026: 8,273 victims this year, +34.1% vs 2025"), fig("comparitech_h1","Comparitech H1 2026 roundup: 4,217 attacks, 23 a day", crop_h=840))}
{figrow(fig("blackkite_2026","Black Kite 2026 Ransomware Report: 7,551 victims disclosed, second-half pace +60%", crop_h=600), fig("akamai_pr","Akamai: commerce becomes the epicentre for AI-bot attacks and agentic fraud", crop_h=700))}'''

# ---------- 09 timeline
months = ["January","February","March","April","May","June","July","August","September","October"]
trows = []
for i in sorted(INCIDENTS, key=lambda i:i['date']):
    trows.append(f'<tr><td class="d">{i["date"][8:]} {months[int(i["date"][5:7])-1][:3]}</td><td><i class="dot" style="background:{PCAT[i["cat"]]}"></i> <b>{E(i["name"])}</b><div class="small">{E(i["type"])} · {E(i["impact"])}</div></td><td>{E(i["region"])}<div class="small">{E(COUNTRY.get(i["country"],i["country"]))}</div></td><td class="c">{i["sev"]}</td><td class="c small">{i["status"] if i["status"]!="context" else "statistic"}</td><td>{cite(i["src"][:4])}</td></tr>')
timeline_html = f'<p class="lede">Dates are the first public report or the key event in the story; multi-event entries use their anchor date. October covers 1–16.</p><table class="tbl tl"><thead><tr><th>Date</th><th>Event</th><th>Region</th><th>Sev</th><th>Status</th><th>Sources</th></tr></thead><tbody>{"".join(trows)}</tbody></table>'

# ---------- 10 actors + vendors
arows = "".join(f'<tr><td><b>{E(a["name"])}</b><div class="small">{E(a["kind"])}</div></td><td>{E(a["retail_hits"])}</td><td>{E(a["status"])}</td><td>{cite(a["src"])}</td></tr>' for a in ACTORS)
vcards = "".join(f'<div class="vc"><b>{E(v["name"])}</b><div class="vseg">{E(v["seg"])}</div><p>{E(v["note"])}</p>{cite(v["src"])}</div>' for v in VENDORS)
actors_html = f'{figrow(fig("cisa_gunra","CISA #StopRansomware advisory on Gunra ransomware, 10 Aug 2026", crop_h=640))}<h2>Threat actors</h2><table class="tbl"><thead><tr><th>Actor</th><th>Retail / Middle East footprint in 2026</th><th>Status at 16 Oct</th><th>Sources</th></tr></thead><tbody>{arows}</tbody></table><h2>Vendor and competitor landscape</h2><p class="lede">Who showed up in the 2026 evidence and why it matters to a retail security budget. Not an endorsement; mentions are drawn from the incident and market coverage.</p><div class="vgrid">{vcards}</div>'

# ---------- 11 voices + market + method
qcards = "".join(f'<blockquote class="q"><p>“{E(q["text"])}”</p><footer>— {E(q["who"])}, {E(q["when"])} {cite([q["src"]])}</footer></blockquote>' for q in QUOTES)
mrows = "".join(f'<tr><td>{E(m[0])}</td><td>{E(m[1])}</td><td>{E(m[2])}</td><td>{E(m[3])}</td><td>{E(m[4])}</td><td>{E(m[5])} {cite([m[6]])}</td></tr>' for m in T.MARKET)
cov = C.hbars([(k, v) for k,v in T.COVERAGE if v>1], color="#0f766e", title="Records collected per channel", label_w=300, dark=False, w=700)
voices_html = f'''<h2>What practitioners and customers said</h2><p class="lede">Verbatim public posts collected from Bluesky, Mastodon, Reddit and Hacker News without logins. They show how practitioners and customers read the year.</p><div class="qgrid">{qcards}</div>
<h2>Market research: security spend and vendor markets</h2>
<table class="tbl"><thead><tr><th>Segment</th><th>Geography</th><th>Base</th><th>Forecast</th><th>CAGR</th><th>Source</th></tr></thead><tbody>{mrows}
<tr><td>Video surveillance cameras</td><td>GCC</td><td>$1.86B</td><td>$4.60B (2034)</td><td>—</td><td>Precedence Research {cite(["precedence-gcc"])}</td></tr>
<tr><td>Cybersecurity</td><td>Saudi Arabia</td><td>SAR 16.3B (2025)</td><td>—</td><td>—</td><td>NCA / Argaam {cite(["argaam-sa-market"])}</td></tr></tbody></table>
<div class="tiles four">{tile("GISEC 2026","120 countries in Dubai; 'Cyber First' leaders track; Censys debut",["gisec-cyberfirst","gisec-wrap","censys-gisec"])}{tile("Intersec 2026","Motorola Visual Alerts expansion; AI CCTV across the halls",["intersec","intersec-motorola"])}{tile("MAF × Checkout.com","15M monthly online customers; agentic-commerce controls",["checkout-maf","checkout-agentic"])}{tile("Deloitte outlook","2026 global retail outlook: resilience and AI as the twin themes",["deloitte"])}</div>
<h2>Method, coverage and limitations</h2>
<div class="two"><div class="panel">{cov}</div><div class="panel"><ol class="steps"><li>Multi-channel collector (curl_cffi, public RSS/JSON) over Google News, Bing News, Reddit RSS, Bluesky, Mastodon, Hacker News, Lemmy, YouTube, DuckDuckGo and Bing web, plus the ransomware.live and Have I Been Pwned APIs. No logins, no paywalls, polite pacing.</li><li>{T.NEWS['unique_titles']:,} unique 2026 titles de-duplicated and themed; {len(INCIDENTS)} incidents and signals selected for retail relevance and evidence quality.</li><li>Every number traced to a URL; social posts quoted verbatim; leak-site items kept as claims.</li><li>Rendered as an interactive HTML artifact (canvas globe, SVG charts) and this PDF from the same data modules.</li></ol></div></div>
<h3>Limitations</h3><ul class="lims">{"".join(f'<li>{E(l)}</li>' for l in LIMITATIONS)}</ul>'''

# ---------- 12 evidence
erows = "".join(f'<li id="s{NUM[k]}"><span class="sn">S{NUM[k]}</span><div><a href="{E(SOURCES[k][1])}">{E(SOURCES[k][0])}</a><div class="so">{E(SOURCES[k][2])}{(" · "+E(SOURCES[k][3])) if SOURCES[k][3] else ""}</div><div class="url">{E(SOURCES[k][1])}</div></div></li>' for k in ORDER)
evidence_html = f'<p class="lede">{len(ORDER)} sources in citation order. Each entry prints its URL; items marked "deep link not recovered" cite the outlet front page.</p><ol class="ev">{erows}</ol>'


def body_html(toc_pages=None):
    toc = "".join(f'<div><span><span class="n">{n}</span>{E(t)}<span class="k">{E(k)}</span></span><span class="p">{(toc_pages or {}).get(i, "")}</span></div>' for n,i,t,k in SECTIONS)
    n_ctx = len(INCIDENTS) - n_conf - n_claim
    scope = (f'<div class="tiles four" style="margin-top:6mm">'
             f'{tile("1 Jan – 16 Oct 2026", "period covered; dates are first public report", [])}'
             f'{tile("ME → EU → NA → APAC → Africa → LatAm", "Middle East first as briefed, then the trend ranking from section 02", [])}'
             f'{tile(f"{n_conf} / {n_claim} / {n_ctx}", "confirmed incidents / unverified claims / statistics and policy signals", [])}'
             f'{tile("10 channels, 0 logins", "news RSS, Reddit, Bluesky, Mastodon, Hacker News, Lemmy, YouTube, web search, ransomware.live, HIBP", [])}</div>'
             f'<div class="howto" style="margin-top:4mm"><b>How to read this report.</b> Every figure carries an S-number that points to the evidence index (section 12), where the original URL is printed. "Confirmed" means the company, a regulator or a court said it; "claim, unverified" means a leak site or researcher said it and the company has not; "statistic / policy" entries are studies, laws and market signals. Severity (1–5) is an analyst score on scale, consequence and novelty. Leak-site claims are never treated as breaches. Screenshots are of the cited pages as captured on 8–16 October 2026, downscaled; cookie banners and advertisements belong to the source sites.</div>'
             f'<div class="legend" style="justify-content:flex-start;margin-top:4mm">{"".join(f"<span><i style=\"background:{PCAT[c]}\"></i>{E(CAT[c][0])}</span>" for c in ["cyber","ot","physical","fraud","geopolitical","regulatory","enforcement","market"])}</div>')
    parts = [f'<div class="kicker">Contents</div><div class="toc">{toc}</div>{scope}']
    bodies = dict(exec=exec_html, regions=regions_html, me=me_html, eu=eu_html, na=na_html, apac=apac_html, afr=afr_html, numbers=numbers_html, timeline=timeline_html, actors=actors_html, voices=voices_html, evidence=evidence_html)
    for idx,(n,i,t,k) in enumerate(SECTIONS):
        parts.append(sec(n,i,t,k,bodies[i]))
    return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Retail Security 2026 — Middle East first, world ranked by trend</title><style>{CSS}</style></head><body>{"".join(parts)}</body></html>'

def cover_html():
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{COVER_CSS}</style></head><body><div class="cover">
<div class="eyebrow">Product Intelligence · Retail Security Briefing · 1 January – {TODAY}</div>
<h1>Retail Security<br><span class="y">2026</span></h1>
<div class="sub">What happened, where, and what it means for a security director. Middle East first; every other region ranked by trend.</div>
<div class="lede">Cyber, OT sabotage, fraud, physical crime, geopolitics and regulation across retail, with {len(INCIDENTS)} incidents and signals, {len(SOURCES)} cited sources and verbatim evidence. Leak-site claims are marked as claims and never counted as breaches.</div>
<div class="globe">{globe_svg(40, 22, size=560, dark=True, uid="cv")}</div>
<div class="stats"><div class="stat"><b>800,000</b><span>cyberattack attempts a day on the UAE, up from 200,000</span></div><div class="stat"><b>~700</b><span>French supermarkets with sabotaged refrigeration, 11–12 October</span></div><div class="stat"><b>2,627</b><span>ransomware victims in Q3 2026, a record (+61% YoY); retail +97%</span></div></div>
<div class="foot"><span>Compiled {TODAY} · Crawl Engineer, Product Intelligence</span><span>Evidence index: S1–S{len(SOURCES)}</span></div>
</div></body></html>'''

def render(html_name, pdf_name, footer):
    """HTML -> PDF. Backend from RSR_BROWSER: docker (Playwright image + build/pw/render.mjs) or local (python-playwright via scripts/rsr_browser.py); auto = docker if usable else local."""
    mode = os.environ.get("RSR_BROWSER", "auto")
    if mode == "auto":
        try: mode = "docker" if subprocess.run(["docker","image","inspect","mcr.microsoft.com/playwright:v1.64.0-noble"], capture_output=True).returncode == 0 else "local"
        except FileNotFoundError: mode = "local"
    if mode == "local":
        cmd = [sys.executable, "-P", os.path.join(HERE, "rsr_browser.py"), "pdf", os.path.join(PDF, html_name), os.path.join(PDF, pdf_name)] + (["footer"] if footer else [])
        with open(os.path.join(PDF, pdf_name+'.log'), 'w') as lf: subprocess.run(cmd, check=True, stdout=lf, stderr=subprocess.STDOUT, timeout=900)
    else:
        cmd = ["docker","run","--rm","--network","host","--shm-size=1g","--ipc=host","-v",f"{ROOT}/build/pw:/pw","-v",f"{PDF}:/pdf","-v","/opt/tm8/prod/node_modules:/opt/tm8/prod/node_modules:ro","mcr.microsoft.com/playwright:v1.64.0-noble","bash","-c",f"node /pw/render.mjs pdf /pdf/{html_name} /pdf/{pdf_name} {'footer' if footer else ''} > /pdf/{pdf_name}.log 2>&1"]
        subprocess.run(cmd, check=True, timeout=900)
    print(open(os.path.join(PDF, pdf_name+'.log')).read().strip())

def main():
    import fitz
    from pypdf import PdfWriter, PdfReader
    open(os.path.join(PDF,'cover.html'),'w',encoding='utf-8').write(cover_html())
    open(os.path.join(PDF,'body.html'),'w',encoding='utf-8').write(body_html())
    print('shots:', SHOT_USED)
    if MISSING: print('MISSING SOURCE KEYS:', sorted(set(MISSING))); sys.exit(1)
    render('cover.html','cover.pdf',False)
    render('body.html','body.pdf',True)
    doc = fitz.open(os.path.join(PDF,'body.pdf')); pages = {}
    for pno in range(len(doc)):
        txt = doc[pno].get_text()
        for n,i,t,k in SECTIONS:
            if i not in pages and f'@@{i}@@' in txt: pages[i] = pno+1
    print('section pages:', pages, 'total body pages:', len(doc)); doc.close()
    open(os.path.join(PDF,'body.html'),'w',encoding='utf-8').write(body_html(pages))
    render('body.html','body.pdf',True)
    w = PdfWriter()
    for f in ('cover.pdf','body.pdf'): w.append(PdfReader(os.path.join(PDF,f)))
    w.add_metadata({'/Title':'Retail Security 2026 — Middle East first, world ranked by trend','/Author':'Product Intelligence · Crawl Engineer','/Subject':'Retail security incidents, threats, regions, vendors and evidence, 1 Jan–16 Oct 2026'})
    out = os.path.join(PDF,'report.pdf')
    if os.path.exists(out): os.remove(out)
    with open(out,'wb') as fh: w.write(fh)
    doc = fitz.open(out); print('report.pdf pages:', len(doc), 'bytes:', os.path.getsize(out))
    if SHOT_ABSENT: print('screenshots replaced by placeholders (not captured):', sorted(set(SHOT_ABSENT)))
    want = {0, 1, 2} | {p for p in pages.values()} | {pages.get('me',3)+1, pages.get('numbers',10)+1}
    for pno in sorted(want):
        if pno < len(doc):
            pix = doc[pno].get_pixmap(dpi=55); pix.save(os.path.join(PDF, f'preview_{pno+1:02d}.png'))
    print('previews:', sorted(p+1 for p in want if p < len(doc)))
    doc.close()

if __name__ == '__main__': main()
