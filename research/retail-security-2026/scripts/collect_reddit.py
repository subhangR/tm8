"""Reddit as a normal browser user: Reddit's own public RSS/Atom feeds (no API key, no login).
search.rss + subreddit new/top feeds, then each 2026 post's own feed for its comments."""
import json, re, sys, time, html, os
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus
try:
    from curl_cffi import requests
    IMP = {"impersonate": "chrome"}
except Exception as _e:
    import requests
    IMP = {}
    print("reddit: curl_cffi unavailable (%s); using plain requests" % str(_e).strip().splitlines()[0][:120], flush=True)

OUT = "raw/reddit_web.jsonl"
LOG = "build/collect_reddit.log"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/html;q=0.8,*/*;q=0.7",
     "Accept-Language": "en-US,en;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none"}
NS = {"a": "http://www.w3.org/2005/Atom"}
S = requests.Session(**IMP)
DELAY = 8.0
BUDGET = float(os.environ.get("RSR_TIME_BUDGET", "0") or 0)   # seconds for this whole pass; 0 = unbounded. The orchestrator sets it
T0 = time.time()                                                # just under its stage timeout so the pass ends PARTIAL instead of killed.
MAX_429_ROW = 12                                                # consecutive 429 exhaustions (~5 min of nothing) before giving up on Reddit
class Budget(BaseException):
    """Raised inside get() when the time budget is spent or Reddit keeps rate-limiting; run() turns it into a PARTIAL exit 0."""
    pass
PROG = "build/reddit_done.txt"
DONE = set(open(PROG).read().split("\n")) if os.path.exists(PROG) else set()
STATS = {"req": 0, "ok": 0, "err": 0, "posts": 0, "comments": 0, "posts_2026": 0}
seen_posts = set()
_last = 0.0

def log(*a):
    line = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)
    with open(LOG, "a") as f: f.write(line + "\n")

def get(url):
    global _last
    if BUDGET and time.time() - T0 > BUDGET: raise Budget("time budget of %ds spent" % BUDGET)
    if STATS.get("row429", 0) >= MAX_429_ROW: raise Budget("Reddit answered 429 to %d requests in a row (rate-limited from this network)" % STATS["row429"])
    for attempt in range(3):
        wait = DELAY - (time.time() - _last)
        if wait > 0: time.sleep(wait)
        _last = time.time()
        STATS["req"] += 1
        try:
            r = S.get(url, headers=H, timeout=40)
        except Exception as e:
            log("ERR", url[:120], e); STATS["err"] += 1; time.sleep(10); continue
        if r.status_code == 429:
            ra = r.headers.get("retry-after"); rs = r.headers.get("x-ratelimit-reset"); rem = r.headers.get("x-ratelimit-remaining")
            try: wait429 = max(float(ra or 0), float(rs or 0), 20.0)
            except ValueError: wait429 = 45.0
            log("429", url[:90], "retry-after", ra, "reset", rs, "remaining", rem, "-> sleep", int(wait429) + 5)
            STATS["row429"] = STATS.get("row429", 0) + 1
            time.sleep(min(wait429 + 5, 180)); continue
        STATS["row429"] = 0
        if r.status_code != 200 or not r.text.lstrip().startswith("<?xml"):
            STATS["err"] += 1
            log("bad", r.status_code, url[:120]); return None
        STATS["ok"] += 1
        return r.text
    return None

def parse_feed(xml_text):
    try:
        root = ET.fromstring(xml_text.encode("utf-8"))
    except ET.ParseError as e:
        log("parse error", e); return []
    out = []
    for e in root.findall("a:entry", NS):
        g = lambda tag: (e.find(f"a:{tag}", NS).text or "").strip() if e.find(f"a:{tag}", NS) is not None else ""
        link = e.find("a:link", NS)
        cat = e.find("a:category", NS)
        auth = e.find("a:author/a:name", NS)
        content = g("content")
        text = re.sub(r"<[^>]+>", " ", html.unescape(content))
        text = re.sub(r"\s+", " ", text).strip()
        out.append({"id": g("id"), "title": html.unescape(g("title")), "url": link.get("href") if link is not None else "",
                    "published": g("published") or g("updated"), "updated": g("updated"),
                    "author": (auth.text or "") if auth is not None else "", "subreddit": cat.get("label") if cat is not None else "",
                    "text": text[:4000]})
    return out

def emit(rec):
    with open(OUT, "a") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")

SINCE = os.environ.get("RSR_SINCE", "2026-01-01").strip()[:10]   # YYYY-MM-DD; period runs pass the window start
def is_2026(ts): return bool(ts) and ts[:10] >= SINCE   # name kept for the call sites: "in the collection window"

def harvest(url, kind, q=None, pages=2):
    key = f"{SINCE}|{kind}|{q}|{url[:60]}"   # progress is per collection window, so a new period re-harvests
    if key in DONE: return 0
    after = None; n = 0
    for p in range(pages):
        u = url + ("&" if "?" in url else "?") + "limit=100" + (f"&after={after}" if after else "")
        xml_text = get(u)
        if not xml_text: break
        entries = parse_feed(xml_text)
        if not entries: break
        for en in entries:
            pid = en["id"]
            if pid in seen_posts: continue
            seen_posts.add(pid)
            rec = dict(en, kind=kind, query=q, channel="reddit_rss", fetched=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            emit(rec); STATS["posts"] += 1; n += 1
            if is_2026(en["published"]): STATS["posts_2026"] += 1
        after = entries[-1]["id"]
        if len(entries) < 100: break
    log(kind, q or url[:80], "->", n, "new posts")
    with open(PROG, "a") as f: f.write(key + "\n")
    return n

RD_Q = [
 "retail data breach", "retailer hacked", "retail cyber attack", "ransomware retailer", "store systems down cyber", "POS outage cyber attack",
 "ASOS hacked", "ASOS data breach", "Marks and Spencer cyber attack", "Co-op cyber attack", "Harrods cyber", "Ahold Delhaize cyber", "Albert Heijn storing",
 "Giant Food website down", "Stop and Shop cyber", "Hannaford outage", "Food Lion outage", "Canadian Tire data breach", "Coupang data breach",
 "H&M data breach ShinyHunters", "ShinyHunters Salesforce retail", "Scattered Spider retail", "Snowflake breach retailer", "supermarket fridge hack France",
 "Intermarché cyberattaque", "refrigeration controller hack Danfoss", "Talabat data leak", "Talabat hacked", "Lulu hypermarket breach", "Carrefour data breach",
 "noon.com scam", "Namshi account hacked", "Amazon.ae scam", "Dubai delivery scam SMS", "UAE scam call bank", "Dubai Police scam warning", "Saudi scam text",
 "Tabby fraud", "Tamara scam", "Careem scam", "Jahez scam", "HungerStation hacked", "Dubai Mall Iran war", "Mall of the Emirates closed", "Riyadh mall missile",
 "shopping mall evacuated UAE", "Kuwait Avenues mall closed", "Bahrain mall closed war", "Qatar mall missile", "Global Village scam", "Dubai counterfeit raid",
 "shoplifting 2026", "organized retail crime", "ORC ring", "self checkout theft", "locked up merchandise", "retail theft rising", "retail theft falling",
 "flash mob robbery store", "smash and grab", "retail worker assaulted", "shop worker abuse UK", "Usdaw survey", "BRC crime report", "NRF theft report",
 "loss prevention AI cameras", "Everseen", "Verkada retail", "Evolv weapons detection", "Sensormatic", "facial recognition store shoplifters", "Facewatch",
 "refund fraud 2026", "return fraud", "gift card scam store", "card testing attack Shopify", "chargeback fraud surge", "bot attack checkout", "AI shopping agent blocked",
 "Amazon blocks Perplexity", "account takeover retail loyalty", "loyalty points stolen", "promo abuse", "friendly fraud", "triangulation fraud", "deepfake customer service scam",
 "Oracle EBS Cl0p retail", "BigCommerce breach", "Shopify app breach", "Magento skimmer 2026", "Magecart 2026", "Salesforce Experience Cloud leak",
 "Walmart data breach", "Target data breach", "Home Depot theft", "Walgreens closing theft", "CVS locked shelves", "Kroger cyber", "Costco scam", "Best Buy breach",
 "Tesco cyber", "Sainsbury's outage", "Asda IT", "Morrisons cameras", "JD Sports breach", "Boots cyber", "Primark theft", "Zara breach", "IKEA ransomware",
 "Pick n Pay breach", "Shoprite cyber", "Nick Scali cyber", "Oz Hair and Beauty breach", "Myntra data leak", "Flipkart breach", "Zepto data", "Trendyol veri sızıntısı",
 "Mercado Libre ransomware", "Falabella ciber", "Askul ransomware", "Seicomart", "Murauchi", "Japan retail cyber attack",
 "cargo theft 2026", "warehouse robbery", "jewellery store robbery 2026", "pharmacy robbery", "store shooting 2026", "mall shooting 2026",
 "Iran war shopping Dubai", "panic buying UAE", "Dubai expat leaving war", "Saudi drones Riyadh shopping", "Hormuz closure supermarket prices",
]
RD_SUBS = ["LossPrevention", "AssetProtection", "retail", "TalesFromRetail", "Target", "walmart", "HomeDepot", "Lowes", "kroger", "Costco", "WalgreensStores", "CVS",
           "cybersecurity", "netsec", "sysadmin", "msp", "blueteamsec", "cybersecurity_news", "ecommerce", "shopify", "FulfillmentByAmazon", "AmazonSeller", "Scams",
           "dubai", "UAE", "saudiarabia", "qatar", "Kuwait", "Bahrain", "Oman", "Egypt", "Tesco", "asda", "sainsburys", "UKRetail", "unitedkingdom", "france", "Netherlands",
           "southafrica", "australia", "canada", "korea", "japan", "india", "Turkey", "Jordan", "iraq", "lebanon", "pakistan", "AbuDhabi", "Riyadh", "jeddah", "DubaiPetrolHeads"]
RD_SUBS = list(dict.fromkeys(RD_SUBS))

def run():
    try: _run()
    except Budget as b:
        log("PARTIAL:", str(b), "after", STATS["req"], "requests;", json.dumps(STATS), "- posts and comments fetched so far are kept; progress file lets a re-run of the same window continue")
        return 0
    return 0

def _run():
    os.makedirs("raw", exist_ok=True); os.makedirs("build", exist_ok=True)
    if os.path.exists(OUT):
        for line in open(OUT):
            try: seen_posts.add(json.loads(line)["id"])
            except Exception: pass
    log("start reddit rss collector", len(RD_Q), "queries", len(RD_SUBS), "subs", "seen", len(seen_posts), "done", len(DONE))
    for q in RD_Q:
        for sort, pages in (("new", 2), ("relevance", 1)):
            harvest(f"https://www.reddit.com/search.rss?q={quote_plus(q)}&sort={sort}&t=year", f"search-{sort}", q, pages=pages)
    for sub in RD_SUBS:
        harvest(f"https://www.reddit.com/r/{sub}/new/.rss", "sub-new", sub, pages=2)
        harvest(f"https://www.reddit.com/r/{sub}/top/.rss?t=year", "sub-top", sub, pages=1)
    log("posts phase done", json.dumps(STATS))
    # comments: 2026 posts whose title/text match security keywords
    kw = re.compile(r"breach|hack|cyber|ransom|scam|fraud|theft|shoplift|steal|stole|robber|security|leak|phish|outage|attack|missile|drone|war|evacuat|closed|counterfeit|fake|skimm|chargeback|refund", re.I)
    cands = []
    with open(OUT) as f:
        for line in f:
            r = json.loads(line)
            if r.get("kind", "").startswith(("search", "sub")) and is_2026(r.get("published", "")) and kw.search(r["title"] + " " + r.get("text", "")[:500]):
                cands.append(r)
    cands.sort(key=lambda r: r["published"], reverse=True)
    cands = cands[:400]
    log("comment phase: candidates", len(cands))
    for i, p in enumerate(cands):
        url = p["url"].split("?")[0].rstrip("/") + "/.rss?limit=100"
        xml_text = get(url)
        if not xml_text: continue
        entries = parse_feed(xml_text)
        n = 0
        for en in entries[1:]:
            if not en["text"]: continue
            emit(dict(en, kind="comment", post_id=p["id"], post_title=p["title"], post_url=p["url"], channel="reddit_rss", fetched=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
            STATS["comments"] += 1; n += 1
        if i % 25 == 0: log("comments", i, "/", len(cands), p["title"][:60], "->", n)
    log("done", json.dumps(STATS))

if __name__ == "__main__":
    sys.exit(run())
