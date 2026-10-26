#!/usr/bin/env python3
"""Multi-channel public collector for the 2026 retail-security landscape.
No logins, no paywall bypass. Polite pacing per host. Output: raw/<channel>.jsonl"""
import json, re, sys, time, html, os, urllib.parse, datetime as dt, email.utils, xml.etree.ElementTree as ET
try:
    from curl_cffi import requests            # browser-impersonating TLS (preferred)
    IMP = {"impersonate": "chrome"}
except Exception as _e:                        # no wheel for this OS/Python, or a dylib built for a newer OS
    import requests                            # plain HTTP; the public feeds and APIs used here accept it
    IMP = {}
    print("collect: curl_cffi unavailable (%s); using plain requests" % str(_e).strip().splitlines()[0][:120], flush=True)
from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
os.makedirs(RAW, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9,ar;q=0.6"}
def _since():
    """Collection window start: RSR_SINCE=YYYY-MM-DD (period runs) or 1 Jan 2026 (the annual baseline)."""
    v = os.environ.get("RSR_SINCE", "").strip()
    try: return dt.datetime.strptime(v, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc) if v else dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    except ValueError: raise SystemExit(f"RSR_SINCE must be YYYY-MM-DD, got {v!r}")
SINCE = _since()
SINCE_TS = int(SINCE.timestamp())
LAST = {}
STATS = {}
BUDGET = float(os.environ.get("RSR_TIME_BUDGET", "0") or 0)   # seconds for the whole pass; 0 = unbounded (the orchestrator sets it just under its stage timeout)
T0 = time.time()
class Budget(BaseException):
    """Raised by get() once the time budget is spent so run() ends PARTIAL (exit 0, everything fetched so far kept) instead of being killed."""
    pass
def log(*a):
    print(dt.datetime.now().strftime("%H:%M:%S"), *a, flush=True)

def get(url, host_delay=1.0, **kw):
    if BUDGET and time.time() - T0 > BUDGET: raise Budget("time budget of %ds spent" % BUDGET)
    host = urllib.parse.urlparse(url).netloc
    wait = LAST.get(host, 0) + host_delay - time.time()
    if wait > 0: time.sleep(wait)
    LAST[host] = time.time()
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=30, headers=UA, **IMP, **kw)
            if r.status_code == 429:
                time.sleep(8 * (attempt + 1)); continue
            return r
        except Exception as e:
            time.sleep(2 * (attempt + 1))
    return None

def emit(channel, rec):
    rec.setdefault("channel", channel)
    rec["fetched_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    with open(os.path.join(RAW, f"{channel}.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    STATS[channel] = STATS.get(channel, 0) + 1

def parse_date(s):
    if not s: return None
    try:
        d = email.utils.parsedate_to_datetime(s)
        if d.tzinfo is None: d = d.replace(tzinfo=dt.timezone.utc)
        return d
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%d"):
        try:
            d = dt.datetime.strptime(s.replace("Z", "+0000"), fmt)
            if d.tzinfo is None: d = d.replace(tzinfo=dt.timezone.utc)
            return d
        except Exception: continue
    return None

# ---------------- queries ----------------
GLOBAL_Q = [
 "retail data breach", "retailer cyberattack", "retail ransomware attack", "supermarket cyberattack", "grocery chain cyber attack",
 "e-commerce data breach", "fashion retailer hacked", "luxury brand data breach", "department store cyber incident",
 "retail chain hackers customer data stolen", "online store data leak customers", "retail POS malware", "Magecart card skimming",
 "retail credential stuffing attack", "loyalty program account takeover", "gift card fraud ring", "refund fraud scheme retailers",
 "buy now pay later fraud", "retail third-party supplier breach", "Snowflake retail breach", "Salesforce data theft retailer extortion",
 "ShinyHunters retail", "Scattered Spider retailer", "DragonForce ransomware retailer", "Qilin ransomware retail", "Cl0p retail victims",
 "Akira ransomware retail", "retail website DDoS attack", "brand impersonation phishing retailer", "fake online shop scam warning",
 "counterfeit goods seizure", "retail insider threat employee data", "supermarket refrigeration cyberattack", "self-checkout theft losses",
 "organized retail crime", "shoplifting surge", "retail worker violence abuse", "shop staff assault", "mall security incident",
 "armed robbery store", "smash and grab robbery", "cargo theft trucks", "facial recognition shoplifters", "body cameras retail staff",
 "AI loss prevention retail", "retail security budget spending", "retail CISO breach lessons", "retail cybersecurity investment",
 "PCI DSS 4.0 retailers", "retail fraud report", "retail bot attacks", "agentic commerce security", "AI shopping agents fraud",
 "retail cyber insurance claims", "retail outage cyber incident stores closed", "retail ransomware disruption supply", "Verizon DBIR retail",
 "Cost of a Data Breach retail", "retail cyber attack Japan", "retail data breach Australia", "retail data breach India", "retail cyber attack Europe",
 "retail hackers Canada", "retail data breach UK", "retail cyberattack Germany", "retail cyber attack France", "retail breach Latin America",
 "retail cyber attack Africa", "retail data breach South Korea", "retail cyber attack Singapore", "retail data breach Brazil",
]
ME_Q = [
 "UAE retailer cyber attack", "Dubai retail data breach", "Abu Dhabi retail cyber", "Saudi retailer hacked", "Saudi e-commerce data leak",
 "Gulf retail fraud scam", "Dubai Police online shopping scam", "Saudi cybersecurity authority warning", "Talabat data leak", "noon data breach",
 "Lulu hypermarket cyber", "Carrefour UAE cyber", "Majid Al Futtaim cyber security", "Alshaya cyber", "Chalhoub data", "Landmark Group cyber",
 "Apparel Group breach", "Al-Futtaim cyber", "Jarir data breach", "eXtra stores hackers", "Panda retail", "BinDawood", "Othaim markets",
 "Nahdi pharmacy data", "Tabby fraud", "Tamara fraud", "Jahez breach", "HungerStation data", "Careem data breach", "Mrsool",
 "Qatar retail cyber attack", "Kuwait retail data breach", "Bahrain data breach", "Oman cyber attack retail", "Egypt retail hack",
 "Jordan data breach retail", "Turkey retail data breach", "Israel retail cyber attack", "Iran hackers Gulf retail", "Middle East retail security",
 "Intersec 2026 retail security", "GISEC 2026 retail", "Saudi PDPL fine", "UAE PDPL enforcement", "Riyadh mall security", "Dubai mall theft gang",
 "Iran strikes Saudi retail impact", "Hormuz shipping retail supply chain", "counterfeit seizure Dubai", "shoplifting Dubai", "Saudi shoplifting",
 "GCC ransomware", "Middle East ransomware retail", "UAE cybersecurity council warning", "Saudi NCA alert", "Middle East e-commerce fraud",
 "Gulf malls drone attack", "Saudi retail cyber", "UAE retail cyber", "Qatar e-commerce fraud", "Middle East data breach customers",
 "Dubai scam delivery SMS", "Saudi scam fake store", "Mada card fraud", "Gulf loyalty points fraud", "Middle East retail physical security",
]
AR_Q = [
 "اختراق بيانات متجر", "هجوم سيبراني متجر إلكتروني", "تسريب بيانات عملاء", "سرقة متاجر عصابة", "الاحتيال الإلكتروني التسوق",
 "تحذير الأمن السيبراني متجر", "الهيئة الوطنية للأمن السيبراني تحذير", "شرطة دبي تحذر تسوق", "سرقة مول", "تسريب بيانات نون",
 "اختراق طلبات", "جرائم السرقة في المتاجر", "برامج الفدية الشرق الأوسط", "احتيال بطاقات مدى", "متاجر وهمية احتيال",
 "تسريب بيانات السعودية", "اختراق الإمارات بيانات", "هجوم إلكتروني قطر", "سرقة بضائع شاحنات", "الاعتداء على عامل متجر",
]
GNEWS_ED = {"US": ("en", "US"), "GB": ("en", "GB"), "AE": ("en", "AE"), "SA": ("en", "SA"), "IN": ("en", "IN"), "AU": ("en", "AU"),
            "SA_ar": ("ar", "SA"), "AE_ar": ("ar", "AE"), "EG_ar": ("ar", "EG")}

def gnews(q, ed):
    hl, gl = GNEWS_ED[ed]
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(q + ' after:2025-12-31')}&hl={hl}&gl={gl}&ceid={gl}:{hl}"
    r = get(url, 1.2)
    if not r or r.status_code != 200: return 0
    try: root = ET.fromstring(r.content)
    except Exception: return 0
    n = 0
    for it in root.iter("item"):
        title = it.findtext("title") or ""; link = it.findtext("link") or ""; pub = parse_date(it.findtext("pubDate"))
        src = it.find("source"); srcname = src.text if src is not None else ""; srcurl = src.get("url") if src is not None else ""
        if pub and pub < SINCE: continue
        emit("gnews", {"query": q, "region": ed, "title": html.unescape(title), "url": link, "published": pub.isoformat() if pub else None,
                       "source": srcname, "source_url": srcurl}); n += 1
    return n

def bingnews(q, cc=None):
    url = f"https://www.bing.com/news/search?q={urllib.parse.quote(q)}&format=rss" + (f"&cc={cc}" if cc else "")
    r = get(url, 1.0)
    if not r or r.status_code != 200: return 0
    try: root = ET.fromstring(r.content)
    except Exception: return 0
    n = 0
    for it in root.iter("item"):
        title = it.findtext("title") or ""; link = it.findtext("link") or ""; pub = parse_date(it.findtext("pubDate"))
        desc = it.findtext("description") or ""
        if "apiclick" in link:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(link).query); link = qs.get("url", [link])[0]
        src = ""
        for el in it.iter():
            if el.tag.endswith("Source"): src = el.text or ""
        if pub and pub < SINCE: continue
        emit("bingnews", {"query": q, "region": cc or "global", "title": html.unescape(title), "url": link,
                          "published": pub.isoformat() if pub else None, "source": src, "snippet": html.unescape(re.sub("<[^>]+>", "", desc))[:400]}); n += 1
    return n

def bingweb(q, pages=2):
    n = 0
    for p in range(pages):
        url = f"https://www.bing.com/search?q={urllib.parse.quote(q)}&count=30&first={1+30*p}&setlang=en"
        r = get(url, 1.5)
        if not r or r.status_code != 200: break
        soup = BeautifulSoup(r.text, "html.parser")
        got = 0
        for li in soup.select("li.b_algo"):
            a = li.select_one("h2 a")
            if not a: continue
            snip = li.select_one(".b_caption p, p")
            emit("bingweb", {"query": q, "title": a.get_text(" ", strip=True), "url": a.get("href"),
                             "snippet": snip.get_text(" ", strip=True)[:500] if snip else ""}); n += 1; got += 1
        if got < 10: break
    return n

def ddg(q):
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(q)}&df=y"
    r = get(url, 2.5)
    if not r or r.status_code != 200: return 0
    soup = BeautifulSoup(r.text, "html.parser"); n = 0
    for res in soup.select(".result"):
        a = res.select_one("a.result__a")
        if not a: continue
        href = a.get("href", "")
        if "uddg=" in href:
            href = urllib.parse.unquote(urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0])
        snip = res.select_one(".result__snippet")
        emit("ddg", {"query": q, "title": a.get_text(" ", strip=True), "url": href, "snippet": snip.get_text(" ", strip=True)[:500] if snip else ""}); n += 1
    return n

def hn(q):
    url = f"https://hn.algolia.com/api/v1/search_by_date?query={urllib.parse.quote(q)}&tags=story&numericFilters=created_at_i>{SINCE_TS}&hitsPerPage=100"
    r = get(url, 0.6)
    if not r or r.status_code != 200: return 0
    n = 0
    for h in r.json().get("hits", []):
        emit("hn", {"query": q, "title": h.get("title"), "url": h.get("url"), "hn_url": f"https://news.ycombinator.com/item?id={h.get('objectID')}",
                    "published": h.get("created_at"), "points": h.get("points"), "comments": h.get("num_comments"), "author": h.get("author")}); n += 1
    return n

def reddit(q, kind="submission", sub=None):
    base = f"https://api.pullpush.io/reddit/search/{kind}/?q={urllib.parse.quote(q)}&after={SINCE_TS}&size=100&sort=desc"
    if sub: base += f"&subreddit={sub}"
    r = get(base, 1.5)
    if not r or r.status_code != 200: return 0
    n = 0
    try: data = r.json().get("data", [])
    except Exception: return 0
    for d in data:
        if kind == "submission":
            emit("reddit", {"query": q, "kind": "post", "subreddit": d.get("subreddit"), "title": d.get("title"),
                            "url": "https://www.reddit.com" + (d.get("permalink") or ""), "link_url": d.get("url"),
                            "published": dt.datetime.fromtimestamp(int(d.get("created_utc", 0)), dt.timezone.utc).isoformat(),
                            "score": d.get("score"), "comments": d.get("num_comments"), "text": (d.get("selftext") or "")[:1500]})
        else:
            emit("reddit", {"query": q, "kind": "comment", "subreddit": d.get("subreddit"), "title": d.get("link_title") or "",
                            "url": "https://www.reddit.com" + (d.get("permalink") or ""),
                            "published": dt.datetime.fromtimestamp(int(d.get("created_utc", 0)), dt.timezone.utc).isoformat(),
                            "score": d.get("score"), "text": (d.get("body") or "")[:1500]})
        n += 1
    return n

def bluesky(q):
    url = f"https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q={urllib.parse.quote(q)}&limit=100&sort=latest&since=2026-01-01T00:00:00Z"
    r = get(url, 1.0)
    if not r or r.status_code != 200: return 0
    n = 0
    for p in r.json().get("posts", []):
        rec = p.get("record", {}); handle = p.get("author", {}).get("handle", ""); rkey = p.get("uri", "").split("/")[-1]
        emit("bluesky", {"query": q, "author": handle, "url": f"https://bsky.app/profile/{handle}/post/{rkey}", "published": rec.get("createdAt"),
                         "text": rec.get("text", "")[:1000], "likes": p.get("likeCount"), "reposts": p.get("repostCount")}); n += 1
    return n

def mastodon(tag, inst="mastodon.social", pages=3):
    n = 0; max_id = None
    for _ in range(pages):
        url = f"https://{inst}/api/v1/timelines/tag/{tag}?limit=40" + (f"&max_id={max_id}" if max_id else "")
        r = get(url, 1.0)
        if not r or r.status_code != 200: break
        data = r.json()
        if not data: break
        for s in data:
            pub = parse_date(s.get("created_at"))
            if pub and pub < SINCE: return n
            txt = BeautifulSoup(s.get("content", ""), "html.parser").get_text(" ", strip=True)
            emit("mastodon", {"query": "#" + tag, "instance": inst, "author": s.get("account", {}).get("acct"), "url": s.get("url"),
                              "published": s.get("created_at"), "text": txt[:1000], "boosts": s.get("reblogs_count"), "favs": s.get("favourites_count")}); n += 1
        max_id = data[-1]["id"]
    return n

def lemmy(q):
    url = f"https://lemmy.world/api/v3/search?q={urllib.parse.quote(q)}&type_=Posts&sort=New&limit=50"
    r = get(url, 1.5)
    if not r or r.status_code != 200: return 0
    n = 0
    for p in r.json().get("posts", []):
        post = p.get("post", {}); pub = parse_date(post.get("published"))
        if pub and pub < SINCE: continue
        emit("lemmy", {"query": q, "title": post.get("name"), "url": post.get("ap_id"), "link_url": post.get("url"), "published": post.get("published"),
                       "community": p.get("community", {}).get("name"), "score": p.get("counts", {}).get("score"), "comments": p.get("counts", {}).get("comments")}); n += 1
    return n

def youtube(q):
    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(q)}&sp=EgIIBQ%253D%253D"  # this year
    r = get(url, 2.0)
    if not r or r.status_code != 200: return 0
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", r.text, re.S)
    if not m: return 0
    try: data = json.loads(m.group(1))
    except Exception: return 0
    n = 0
    def walk(o):
        nonlocal n
        if isinstance(o, dict):
            if "videoRenderer" in o:
                v = o["videoRenderer"]
                def txt(k):
                    x = v.get(k, {})
                    return x.get("simpleText") or "".join(r.get("text", "") for r in x.get("runs", []))
                emit("youtube", {"query": q, "title": txt("title"), "url": f"https://www.youtube.com/watch?v={v.get('videoId')}", "channel_name": txt("ownerText"),
                                 "published_text": txt("publishedTimeText"), "views": txt("viewCountText"), "length": txt("lengthText")}); n += 1
            for vv in o.values(): walk(vv)
        elif isinstance(o, list):
            for vv in o: walk(vv)
    walk(data); return n

def ransomware_live():
    n = 0
    r = get("https://api.ransomware.live/v2/searchvictims/retail", 1.0)
    if r and r.status_code == 200:
        for v in r.json():
            d = parse_date(v.get("discovered") or v.get("attackdate"))
            if d and d < SINCE: continue
            emit("ransomware_live", {"scope": "sector:retail", **{k: v.get(k) for k in ("victim", "group", "country", "activity", "discovered", "attackdate", "claim_url", "post_url", "description", "website")}}); n += 1
    for cc in ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "IQ", "LB", "TR", "IL", "IR", "MA", "PK"]:
        r = get(f"https://api.ransomware.live/v2/countryvictims/{cc}", 1.0)
        if not r or r.status_code != 200: continue
        for v in r.json():
            d = parse_date(v.get("discovered") or v.get("attackdate"))
            if d and d < SINCE: continue
            emit("ransomware_live", {"scope": f"country:{cc}", **{k: v.get(k) for k in ("victim", "group", "country", "activity", "discovered", "attackdate", "claim_url", "post_url", "description", "website")}}); n += 1
    return n

def hibp():
    r = get("https://haveibeenpwned.com/api/v3/breaches", 1.0)
    if not r or r.status_code != 200: return 0
    n = 0
    for b in r.json():
        bd = parse_date(b.get("BreachDate")); ad = parse_date(b.get("AddedDate"))
        if (bd and bd >= SINCE) or (ad and ad >= SINCE):
            emit("hibp", {"name": b.get("Name"), "title": b.get("Title"), "domain": b.get("Domain"), "breach_date": b.get("BreachDate"), "added_date": b.get("AddedDate"),
                          "pwn_count": b.get("PwnCount"), "data_classes": b.get("DataClasses"), "description": BeautifulSoup(b.get("Description", ""), "html.parser").get_text(" ", strip=True)[:800],
                          "url": f"https://haveibeenpwned.com/Breach/{b.get('Name')}"}); n += 1
    return n

def run():
    try: _run()
    except Budget as b:
        log("PARTIAL:", str(b), "- the channels after this point were not collected this run;", json.dumps(STATS))
        return 0
    return 0

def _run():
    log("start", "since", SINCE.date().isoformat())
    log("ransomware.live", ransomware_live()); log("hibp", hibp())
    for q in GLOBAL_Q:
        t = sum(gnews(q, ed) for ed in ("US", "GB")); log("gnews", q, t)
    for q in ME_Q:
        t = sum(gnews(q, ed) for ed in ("AE", "SA", "US")); log("gnews-me", q, t)
    for q in AR_Q:
        t = sum(gnews(q, ed) for ed in ("SA_ar", "AE_ar", "EG_ar")); log("gnews-ar", q, t)
    for q in GLOBAL_Q: log("bingnews", q, bingnews(q + " 2026"))
    for q in ME_Q: log("bingnews-me", q, bingnews(q + " 2026", "AE") + bingnews(q + " 2026", "SA"))
    for q in AR_Q: log("bingnews-ar", q, bingnews(q, "SA"))
    HN_Q = ["retail breach", "retailer hacked", "ransomware retail", "supermarket cyberattack", "ASOS breach", "shoplifting", "organized retail crime", "Scattered Spider",
            "ShinyHunters", "Magecart", "e-commerce fraud", "bot attacks shopping", "AI agents shopping fraud", "refrigeration hack", "Danfoss", "Snowflake breach", "Salesforce breach",
            "Coupang", "Canadian Tire", "Marks Spencer cyber", "Co-op cyber", "Harrods", "data breach customers", "credential stuffing", "gift card", "loyalty fraud", "self-checkout", "facial recognition shop"]
    for q in HN_Q: log("hn", q, hn(q))
    RD_Q = ["retail breach", "retailer hacked", "ransomware retail", "store cyber attack", "ASOS breach", "shoplifting", "organized retail crime", "loss prevention",
            "self checkout theft", "retail theft", "shoplifters", "Scattered Spider", "ShinyHunters", "Magecart", "ecommerce fraud", "chargeback fraud", "refund fraud",
            "gift card scam", "account takeover shop", "bot attack store", "supermarket hack fridge", "Danfoss", "Snowflake breach", "Salesforce breach", "Coupang breach",
            "Canadian Tire breach", "M&S cyber", "Co-op cyber", "Harrods", "Talabat", "noon.com", "Lulu hypermarket", "Carrefour hack", "Dubai scam", "Saudi scam", "UAE data breach",
            "Saudi data breach", "mall theft", "armed robbery store", "retail worker assault", "facial recognition store", "body cam retail", "Walmart theft", "Target theft", "Amazon fraud refund"]
    for q in RD_Q: log("reddit", q, reddit(q))
    for q in ["retail breach", "shoplifting", "ransomware retailer", "ecommerce fraud", "self checkout theft", "ASOS hack", "Dubai scam", "loss prevention"]:
        log("reddit-comments", q, reddit(q, "comment"))
    for sub in ["LossPrevention", "AssetProtection", "cybersecurity", "retail", "ecommerce", "dubai", "saudiarabia", "UAE", "qatar", "Kuwait", "Bahrain", "Oman", "netsec", "sysadmin", "Scams", "shopify", "FulfillmentByAmazon"]:
        for q in ["breach", "hack", "theft", "scam", "fraud", "security"]:
            log("reddit-sub", sub, q, reddit(q, "submission", sub))
    BS_Q = ["retail breach", "retailer hacked", "ransomware retail", "supermarket cyberattack", "ASOS breach", "shoplifting", "organized retail crime", "Scattered Spider",
            "ShinyHunters", "Magecart", "ecommerce fraud", "refrigeration hack supermarket", "Danfoss", "Coupang breach", "Canadian Tire", "M&S cyber", "Talabat leak",
            "UAE data breach", "Saudi data breach", "Dubai scam", "retail theft", "loss prevention", "self-checkout theft", "facial recognition retail", "agentic commerce fraud", "bot attacks retail"]
    for q in BS_Q: log("bluesky", q, bluesky(q))
    for tag in ["ransomware", "databreach", "cybersecurity", "infosec", "retail", "cybercrime", "shoplifting", "fraud", "threatintel"]:
        for inst in ["mastodon.social", "fosstodon.org", "mstdn.social"]:
            log("mastodon", tag, inst, mastodon(tag, inst))
    for q in ["retail breach", "retailer hacked", "ransomware retail", "shoplifting", "supermarket hack", "ASOS", "ecommerce fraud", "self checkout", "data breach customers", "Coupang", "Canadian Tire", "facial recognition store"]:
        log("lemmy", q, lemmy(q))
    YT_Q = ["retail cyber attack 2026", "retail data breach 2026", "ransomware retailer 2026", "shoplifting 2026", "organized retail crime 2026", "loss prevention 2026", "retail security 2026",
            "French supermarket fridge hack", "ASOS data breach", "self checkout theft 2026", "retail fraud 2026", "Dubai scam 2026 shopping", "Saudi cyber attack 2026", "UAE cyber attack 2026",
            "GISEC 2026", "Intersec 2026", "retail theft caught camera 2026", "Scattered Spider 2026", "ShinyHunters 2026", "Middle East retail security 2026", "ecommerce fraud 2026", "AI agents shopping fraud 2026",
            "Black Hat MEA 2026", "retail cybersecurity CISO 2026", "mall security 2026", "Lulu hypermarket 2026", "Talabat hack", "retail robbery 2026", "gift card scam 2026", "NRF retail theft 2026"]
    for q in YT_Q: log("youtube", q, youtube(q))
    XQ = ["retail data breach 2026", "retailer hacked 2026", "ransomware retail 2026", "supermarket cyberattack fridge", "ASOS breach", "shoplifting 2026", "organized retail crime 2026",
          "Scattered Spider 2026", "ShinyHunters 2026", "Talabat leak", "UAE data breach 2026", "Saudi data breach 2026", "Dubai scam shopping 2026", "retail theft 2026", "loss prevention 2026",
          "self-checkout theft 2026", "ecommerce fraud 2026", "Coupang breach", "Canadian Tire breach", "M&S cyber attack 2026", "GISEC 2026", "Intersec 2026", "retail security Middle East 2026",
          "Carrefour cyber", "Lulu data", "noon.com breach", "Saudi NCA alert 2026", "UAE Cybersecurity Council 2026 retail", "Magecart 2026", "gift card fraud 2026"]
    for q in XQ:
        log("bingweb-x", q, bingweb(f"site:x.com {q}", 1)); log("bingweb-li", q, bingweb(f"site:linkedin.com/posts {q}", 1)); log("bingweb-li2", q, bingweb(f"site:linkedin.com/pulse {q}", 1))
    for q in ["retail security report 2026", "retail cyber threat report 2026", "Middle East retail cyber 2026", "GCC retail data breach 2026", "retail ransomware 2026 report", "retail fraud 2026 report",
              "organized retail crime 2026 report", "shoplifting statistics 2026", "retail security survey 2026", "UAE retail cybersecurity 2026", "Saudi retail cybersecurity 2026", "retail loss prevention 2026 trends",
              "retail physical security 2026 trends", "retail security technology 2026", "retail breach 2026 list", "ecommerce fraud 2026 statistics", "Middle East cyber threat report 2026", "Gulf cyber attacks 2026 report"]:
        log("bingweb", q, bingweb(q, 2)); log("ddg", q, ddg(q))
    log("done", json.dumps(STATS))

if __name__ == "__main__":
    sys.exit(run())
