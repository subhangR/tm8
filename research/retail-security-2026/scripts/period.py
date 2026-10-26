"""Period engine: turn the raw evidence collected for a date window into a fresh incident register.

Reads raw/<channel>.jsonl, keeps the records published inside [FROM, TO], scores them for
retail + security relevance, clusters them by (retailer or place, theme) and writes

  build/periods/<FROM>_<TO>/period.json    incidents, sources, stats, quotes, window, coverage
  build/periods/<FROM>_<TO>/candidates.md  every cluster with its evidence, for a human read
  build/periods/<FROM>_<TO>/shots.json     the source pages the shots stage screenshots
  build/state.json                         ledger: last window end + run list (advanced on success)

Usage:  python3 period.py [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--no-llm] [--dry]
Without --from the window starts the day after the ledger's last_end (or baseline_end);
without --to it ends today (UTC). Optional: ANTHROPIC_API_KEY (+ RSR_MODEL) rewrites the
one-line summaries with a model; every fact still comes from the raw records (strict fallback).
Status vocabulary: confirmed (company/regulator/HIBP confirmation), claimed (leak-site listing or
press report without confirmation), context (regulation, market, policy). Never out-of-stock /
removed semantics here: a thin window is reported as thin coverage, not as "nothing happened".
"""
import argparse, collections, datetime as dt, hashlib, json, os, re, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report_common import CAT, COUNTRY

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw"); BUILD = os.path.join(ROOT, "build")
STATE = os.path.join(BUILD, "state.json")
BASELINE_END = "2026-10-16"     # the annual report's evidence cut-off (compiled 16 Oct 2026)
CHANNELS = ["gnews", "bingnews", "bingweb", "ddg", "hn", "reddit", "reddit_web", "bluesky", "mastodon", "lemmy", "youtube", "ransomware_live", "hibp"]
NEWS = {"gnews", "bingnews", "bingweb", "ddg"}
SOCIAL = {"hn", "reddit", "reddit_web", "bluesky", "mastodon", "lemmy", "youtube"}

# ---------- lexicons ----------
RETAIL = r"(retail|retailer|supermarket|grocer|grocery|hypermarket|store|stores|shop|shopping|mall|e-?commerce|marketplace|merchant|pos\b|point[- ]of[- ]sale|checkout|loyalty|boutique|department store|chain|franchise|warehouse club|convenience store|pharmacy chain|fashion|apparel|footwear|luxury brand|cosmetics|electronics retailer|home improvement|wholesale|discounter|outlet|shopify|magento|dropship|تجزئة|متجر|متاجر|سوبر ماركت|مول|تسوق)"
SECURITY = r"(breach|hack|hacked|hacker|cyber|ransomware|ransom|malware|phishing|scam|fraud|leak|leaked|stolen|theft|shoplift|robbery|robbed|loot|arson|attack|attacked|explosion|bomb|threat|extort|skimm|card[- ]testing|account takeover|credential|ddos|outage|data protection|gdpr|fine[ds]?\b|penalt|sanction|arrest|charged|sentenced|police|raid|smash[- ]and[- ]grab|organi[sz]ed retail crime|orc\b|violence|assault|stabb|shooting|knife|security guard|loss prevention|surveillance|cctv|facial recognition|counterfeit|bot attack|scraper|vulnerab|exploit|zero[- ]day|intrusion|infostealer|dark web|اختراق|قرصنة|احتيال|نصب|سرقة|تسريب|فدية|هجوم|سيبران|غرامة)"
RE_RETAIL = re.compile(RETAIL, re.I); RE_SEC = re.compile(SECURITY, re.I)
NOISE = re.compile(r"(grand theft auto|\bgta\b|stock price|shares (rise|fall|jump|drop)|earnings call|dividend|horoscope|recipe|coupon code|black friday deals|best deals|discount code|review:|how to buy|price target|analyst rating|job vacanc|hiring now|casting|celebrity|fashion week|trailer)", re.I)

THEMES = [  # (key, cat, label, regex) -- first match wins, so order matters
 ("ot", "ot", "OT / IoT / supply-chain sabotage", r"refrigerat|fridge|freezer|cold chain|cold-chain|scada|hvac|building management|industrial control|smart (lock|shelf|shelves)|\bot security|\bot/|operational technology|supply[- ]chain attack|third[- ]party (vendor|provider|supplier) (breach|hack|attack)|supplier (breach|hack|attack|compromise)"),
 ("ransomware", "cyber", "Ransomware / extortion", r"ransomware|ransom|extort|leak site|lockbit|akira|qilin|clop|cl0p|ransomhub|play group|blackcat|alphv|scattered spider|shinyhunters|double extortion|فدية"),
 ("breach", "cyber", "Data breach / intrusion", r"breach|hack(ed|er|ers)?\b|data leak|leaked|exposed (data|records|customers)|intrusion|unauthori[sz]ed access|compromis|infostealer|credential stuffing|account takeover|cyberattack|cyber attack|cyber-attack|cyber incident|اختراق|قرصنة|تسريب|سيبران"),
 ("ai_bots", "cyber", "AI agents / bots / scraping", r"\b(ai agent|agentic|shopping agent|bot attack|scraper bot|bot traffic|bots?\b.*(checkout|inventory|scalp)|scalper|llm)\b"),
 ("fraud", "fraud", "Fraud / scams", r"fraud|scam|phishing|skimm|counterfeit|fake (store|shop|website|site|app)|refund abuse|return fraud|chargeback|card testing|gift card|احتيال|نصب"),
 ("orc", "physical", "Shoplifting / organised retail crime", r"shoplift|organi[sz]ed retail crime|\borc\b|smash[- ]and[- ]grab|theft ring|retail theft|retail crime|steal|stole|stolen goods|looting|looters|سرقة"),
 ("geopolitical", "geopolitical", "Geopolitics / boycott / conflict", r"boycott|sanction|tariff|hamas|hezbollah|houthi|iran|israel|gaza|war\b|conflict|drone strike|missile|protest|unrest|blockade|red sea"),
 ("violence", "physical", "Violence / attacks on stores and staff", r"stabb|shooting|shot dead|knife|assault|attack(ed)? (staff|workers|employees|guard)|armed robbery|robbery|robbed|arson|firebomb|set (on )?fire|explosion|blast|bomb|hostage|riot|violence|abuse of (staff|workers)"),
 ("iot", "ot", "OT / IoT / supply-chain sabotage", r"\biot\b|smart (camera|device|lock)|saas (provider|vendor) (breach|hack|attack|compromise)|managed service provider (breach|hack|attack)"),
 ("regulation", "regulatory", "Regulation / fines / data protection", r"regulat|fine[ds]?\b|penalt|gdpr|data protection|privacy (law|authority|regulator|commissioner)|ico\b|cnil|dpc\b|pdpl|sdaia|compliance|legislation|bill\b|law\b|lawsuit|class action|غرامة"),
 ("enforcement", "enforcement", "Law enforcement / arrests", r"arrest|charged|sentenced|convicted|police|interpol|europol|fbi|nca\b|raid|seiz|dismantl|busted|prosecut|jailed|extradit"),
 ("market", "market", "Market / vendors / reports", r"report (finds|shows|reveals)|survey|study|launch|partnership|acquire|acquisition|funding|raises \$|announce|unveil|forecast|market size|spending on security|security spend"),
]
THEME_RE = [(k, c, l, re.compile(r, re.I)) for k, c, l, r in THEMES]
CONFIRM_RE = re.compile(r"(confirm(s|ed|ing)?|admit(s|ted)?|acknowledg|notif(y|ied|ies|ication)|disclos(e|ed|es|ure)|says it was|said it was|has been fined|fined £|fined \$|fined €|was fined|arrested|charged|sentenced|convicted|pleaded|regulator (said|found)|statement from|in a statement|filed with|sec filing|8-k)", re.I)

# ---------- entities: name -> (display, country code, lat, lon) ----------
ENTITIES = {
 # Middle East
 "carrefour": ("Carrefour", "FR", 48.9, 2.3), "carrefour uae": ("Carrefour UAE (MAF)", "AE", 25.08, 55.14), "carrefour saudi": ("Carrefour KSA (MAF)", "SA", 24.7, 46.7), "majid al futtaim": ("Majid Al Futtaim", "AE", 25.08, 55.14), "lulu": ("LuLu Group", "AE", 24.45, 54.4), "noon": ("noon", "AE", 25.2, 55.27), "namshi": ("Namshi", "AE", 25.2, 55.27), "talabat": ("talabat", "AE", 25.2, 55.27), "careem": ("Careem", "AE", 25.2, 55.27), "amazon.ae": ("Amazon UAE", "AE", 25.2, 55.27), "sharaf dg": ("Sharaf DG", "AE", 25.2, 55.27), "jumbo electronics": ("Jumbo", "AE", 25.2, 55.27), "chalhoub": ("Chalhoub Group", "AE", 25.2, 55.27), "al futtaim": ("Al-Futtaim", "AE", 25.2, 55.27), "apparel group": ("Apparel Group", "AE", 25.2, 55.27), "landmark group": ("Landmark Group", "AE", 25.2, 55.27), "centrepoint": ("Centrepoint", "AE", 25.2, 55.27), "spinneys": ("Spinneys", "AE", 25.2, 55.27), "union coop": ("Union Coop", "AE", 25.2, 55.27), "dubai mall": ("Dubai Mall", "AE", 25.2, 55.28), "mall of the emirates": ("Mall of the Emirates", "AE", 25.12, 55.2), "dubai": ("Dubai retail", "AE", 25.2, 55.27), "abu dhabi": ("Abu Dhabi retail", "AE", 24.45, 54.4), "sharjah": ("Sharjah retail", "AE", 25.35, 55.4), "uae": ("UAE retail", "AE", 24.45, 54.4), 
 "panda": ("Panda Retail", "SA", 21.5, 39.2), "bindawood": ("BinDawood", "SA", 21.5, 39.2), "danube": ("Danube", "SA", 21.5, 39.2), "tamimi": ("Tamimi Markets", "SA", 26.4, 50.1), "jarir": ("Jarir Bookstore", "SA", 24.7, 46.7), "almarai": ("Almarai", "SA", 24.7, 46.7), "cenomi": ("Cenomi", "SA", 24.7, 46.7), "fawaz alhokair": ("Cenomi Retail", "SA", 24.7, 46.7), "al othaim": ("Al Othaim", "SA", 24.7, 46.7), "othaim": ("Al Othaim", "SA", 24.7, 46.7), "nahdi": ("Nahdi", "SA", 21.5, 39.2), "al nahdi": ("Nahdi", "SA", 21.5, 39.2), "salla": ("Salla", "SA", 21.4, 39.8), "zid": ("Zid", "SA", 24.7, 46.7), "riyadh": ("Riyadh retail", "SA", 24.7, 46.7), "jeddah": ("Jeddah retail", "SA", 21.5, 39.2), "saudi": ("Saudi retail", "SA", 24.7, 46.7), "mecca": ("Makkah retail", "SA", 21.4, 39.8), "makkah": ("Makkah retail", "SA", 21.4, 39.8),
 "qatar": ("Qatar retail", "QA", 25.3, 51.5), "doha": ("Doha retail", "QA", 25.3, 51.5), "kuwait": ("Kuwait retail", "KW", 29.4, 48.0), "bahrain": ("Bahrain retail", "BH", 26.2, 50.6), "oman": ("Oman retail", "OM", 23.6, 58.5), "muscat": ("Oman retail", "OM", 23.6, 58.5), "egypt": ("Egypt retail", "EG", 30.0, 31.2), "cairo": ("Cairo retail", "EG", 30.0, 31.2), "مصر": ("Egypt retail", "EG", 30.0, 31.2), "الإمارات": ("UAE retail", "AE", 24.45, 54.4), "دبي": ("Dubai retail", "AE", 25.2, 55.27), "السعودية": ("Saudi retail", "SA", 24.7, 46.7), "الرياض": ("Riyadh retail", "SA", 24.7, 46.7), "جدة": ("Jeddah retail", "SA", 21.5, 39.2), "الكويت": ("Kuwait retail", "KW", 29.4, 48.0), "قطر": ("Qatar retail", "QA", 25.3, 51.5),
 "israel": ("Israel retail", "IL", 32.1, 34.8), "shufersal": ("Shufersal", "IL", 32.1, 34.8), "rami levy": ("Rami Levy", "IL", 31.8, 35.2), "turkey": ("Türkiye retail", "TR", 41.0, 29.0), "türkiye": ("Türkiye retail", "TR", 41.0, 29.0), "migros": ("Migros", "TR", 41.0, 29.0), "trendyol": ("Trendyol", "TR", 41.0, 29.0), "hepsiburada": ("Hepsiburada", "TR", 41.0, 29.0),
 # Europe
 "marks & spencer": ("Marks & Spencer", "GB", 51.5, -0.12), "marks and spencer": ("Marks & Spencer", "GB", 51.5, -0.12), "m&s": ("Marks & Spencer", "GB", 51.5, -0.12), "co-op": ("Co-op", "GB", 53.48, -2.24), "harrods": ("Harrods", "GB", 51.5, -0.16), "tesco": ("Tesco", "GB", 51.65, -0.2), "sainsbury": ("Sainsbury's", "GB", 51.5, -0.12), "asda": ("Asda", "GB", 53.8, -1.55), "morrisons": ("Morrisons", "GB", 53.8, -1.75), "aldi": ("Aldi", "DE", 51.5, 7.5), "lidl": ("Lidl", "DE", 49.4, 8.7), "boots": ("Boots", "GB", 52.95, -1.15), "jd sports": ("JD Sports", "GB", 53.6, -2.3), "next plc": ("Next", "GB", 52.6, -1.1), "asos": ("ASOS", "GB", 51.5, -0.12), "primark": ("Primark", "GB", 53.3, -6.3), "currys": ("Currys", "GB", 51.5, -0.12), "argos": ("Argos", "GB", 51.5, -0.12), "john lewis": ("John Lewis", "GB", 51.5, -0.12), "waitrose": ("Waitrose", "GB", 51.5, -0.12), "b&q": ("B&Q", "GB", 51.5, -0.12), "greggs": ("Greggs", "GB", 54.97, -1.6), "superdrug": ("Superdrug", "GB", 51.5, -0.12), "selfridges": ("Selfridges", "GB", 51.5, -0.15), "ocado": ("Ocado", "GB", 51.76, -0.33), "london": ("London retail", "GB", 51.5, -0.12), "uk retail": ("UK retail", "GB", 52.0, -1.0), "british retail": ("UK retail", "GB", 52.0, -1.0), "britain": ("UK retail", "GB", 52.0, -1.0),
 "zara": ("Zara / Inditex", "ES", 43.3, -8.4), "inditex": ("Zara / Inditex", "ES", 43.3, -8.4), "mango": ("Mango", "ES", 41.4, 2.2), "el corte ingl": ("El Corte Inglés", "ES", 40.4, -3.7), "mercadona": ("Mercadona", "ES", 39.5, -0.4), "h&m": ("H&M", "SE", 59.3, 18.1), "ikea": ("IKEA", "SE", 59.3, 18.1), "carrefour france": ("Carrefour", "FR", 48.9, 2.3), "auchan": ("Auchan", "FR", 50.6, 3.1), "leclerc": ("E.Leclerc", "FR", 48.9, 2.3), "decathlon": ("Decathlon", "FR", 50.6, 3.1), "lvmh": ("LVMH", "FR", 48.9, 2.3), "louis vuitton": ("Louis Vuitton", "FR", 48.9, 2.3), "dior": ("Dior", "FR", 48.9, 2.3), "kering": ("Kering", "FR", 48.9, 2.3), "gucci": ("Gucci", "IT", 43.8, 11.3), "chanel": ("Chanel", "FR", 48.9, 2.3), "hermès": ("Hermès", "FR", 48.9, 2.3), "sephora": ("Sephora", "FR", 48.9, 2.3), "fnac": ("Fnac Darty", "FR", 48.9, 2.3), "boulanger": ("Boulanger", "FR", 50.6, 3.1), "intermarch": ("Intermarché", "FR", 48.9, 2.3), "système u": ("Système U", "FR", 48.9, 2.3), "systeme u": ("Système U", "FR", 48.9, 2.3), "super u": ("Système U", "FR", 48.9, 2.3), "hyper u": ("Système U", "FR", 48.9, 2.3), "co-op u": ("Système U", "FR", 48.9, 2.3), "coopérative u": ("Système U", "FR", 48.9, 2.3), "casino guichard": ("Casino", "FR", 45.4, 4.4), "monoprix": ("Monoprix", "FR", 48.9, 2.3), "franprix": ("Franprix", "FR", 48.9, 2.3), "picard": ("Picard", "FR", 48.9, 2.3), "tfg london": ("TFG London (Hobbs, Whistles, Phase Eight)", "GB", 51.5, -0.12), "hobbs": ("TFG London (Hobbs, Whistles, Phase Eight)", "GB", 51.5, -0.12), "whistles": ("TFG London (Hobbs, Whistles, Phase Eight)", "GB", 51.5, -0.12), "phase eight": ("TFG London (Hobbs, Whistles, Phase Eight)", "GB", 51.5, -0.12), "food lion": ("Food Lion (Ahold Delhaize USA)", "US", 35.7, -80.5), "giant food": ("Giant Food (Ahold Delhaize USA)", "US", 39.0, -76.7), "hannaford": ("Hannaford (Ahold Delhaize USA)", "US", 43.7, -70.3), "ahold": ("Ahold Delhaize", "NL", 52.4, 4.9), "albert heijn": ("Albert Heijn", "NL", 52.4, 4.9), "jumbo supermark": ("Jumbo", "NL", 51.7, 5.3), "bol.com": ("bol", "NL", 52.1, 5.1), "coolblue": ("Coolblue", "NL", 51.9, 4.5), "rewe": ("REWE", "DE", 50.9, 6.9), "edeka": ("Edeka", "DE", 53.5, 10.0), "mediamarkt": ("MediaMarkt", "DE", 48.1, 11.6), "zalando": ("Zalando", "DE", 52.5, 13.4), "douglas": ("Douglas", "DE", 51.5, 7.5), "coop": ("Coop", "SE", 59.3, 18.1), "ica": ("ICA", "SE", 59.3, 18.1), "salling": ("Salling Group", "DK", 55.7, 12.6), "netto": ("Netto", "DK", 55.7, 12.6), "allegro": ("Allegro", "PL", 52.2, 21.0), "zabka": ("Żabka", "PL", 52.2, 21.0), "x5": ("X5 Group", "RU", 55.8, 37.6), "magnit": ("Magnit", "RU", 45.0, 39.0), "esselunga": ("Esselunga", "IT", 45.5, 9.2), "dunnes": ("Dunnes Stores", "IE", 53.3, -6.3), "musgrave": ("Musgrave", "IE", 51.9, -8.5),
 # North America
 "walmart": ("Walmart", "US", 36.4, -94.2), "target": ("Target", "US", 44.98, -93.27), "amazon": ("Amazon", "US", 47.6, -122.3), "costco": ("Costco", "US", 47.6, -122.2), "kroger": ("Kroger", "US", 39.1, -84.5), "albertsons": ("Albertsons", "US", 43.6, -116.2), "home depot": ("Home Depot", "US", 33.75, -84.4), "lowe's": ("Lowe's", "US", 35.2, -80.8), "best buy": ("Best Buy", "US", 44.9, -93.3), "cvs": ("CVS", "US", 41.8, -71.4), "walgreens": ("Walgreens", "US", 42.1, -87.8), "dollar general": ("Dollar General", "US", 36.2, -86.8), "dollar tree": ("Dollar Tree", "US", 36.8, -76.1), "macy's": ("Macy's", "US", 40.75, -73.99), "nordstrom": ("Nordstrom", "US", 47.6, -122.3), "kohl's": ("Kohl's", "US", 43.0, -88.0), "tj maxx": ("TJX", "US", 42.4, -71.4), "tjx": ("TJX", "US", 42.4, -71.4), "nike": ("Nike", "US", 45.5, -122.8), "lululemon": ("Lululemon", "CA", 49.3, -123.1), "victoria's secret": ("Victoria's Secret", "US", 39.96, -83.0), "dick's": ("Dick's Sporting Goods", "US", 40.4, -80.0), "ulta": ("Ulta Beauty", "US", 41.8, -87.9), "7-eleven": ("7-Eleven", "US", 32.8, -96.8), "wawa": ("Wawa", "US", 39.9, -75.4), "trader joe": ("Trader Joe's", "US", 34.1, -118.1), "whole foods": ("Whole Foods", "US", 30.3, -97.7), "publix": ("Publix", "US", 28.0, -81.9), "h-e-b": ("H-E-B", "US", 29.4, -98.5), "wegmans": ("Wegmans", "US", 43.2, -77.6), "meijer": ("Meijer", "US", 42.9, -85.7), "giant eagle": ("Giant Eagle", "US", 40.4, -80.0), "stop & shop": ("Stop & Shop (Ahold Delhaize USA)", "US", 42.3, -71.1), "loblaw": ("Loblaw", "CA", 43.7, -79.4), "sobeys": ("Sobeys", "CA", 45.0, -63.0), "canadian tire": ("Canadian Tire", "CA", 43.7, -79.4), "shoppers drug mart": ("Shoppers Drug Mart", "CA", 43.7, -79.4), "hudson's bay": ("Hudson's Bay", "CA", 43.7, -79.4), "shopify": ("Shopify", "CA", 45.4, -75.7), "united natural foods": ("UNFI", "US", 41.9, -71.4), "unfi": ("UNFI", "US", 41.9, -71.4), "ahold delhaize usa": ("Ahold Delhaize USA", "US", 39.0, -76.7), "sam's club": ("Sam's Club", "US", 36.4, -94.2), "wayfair": ("Wayfair", "US", 42.4, -71.1), "ebay": ("eBay", "US", 37.3, -121.9), "etsy": ("Etsy", "US", 40.7, -74.0), "instacart": ("Instacart", "US", 37.8, -122.4), "doordash": ("DoorDash", "US", 37.8, -122.4), "new york": ("New York retail", "US", 40.7, -74.0), "los angeles": ("Los Angeles retail", "US", 34.05, -118.25), "chicago": ("Chicago retail", "US", 41.9, -87.6), "california": ("California retail", "US", 36.8, -119.4), "philadelphia": ("Philadelphia retail", "US", 39.95, -75.17), "toronto": ("Toronto retail", "CA", 43.7, -79.4), "mexico": ("Mexico retail", "MX", 19.4, -99.1), "oxxo": ("OXXO", "MX", 25.7, -100.3), 
 # Asia-Pacific
 "woolworths": ("Woolworths", "AU", -33.9, 151.2), "coles": ("Coles", "AU", -37.8, 145.0), "bunnings": ("Bunnings", "AU", -37.8, 145.0), "kmart australia": ("Kmart Australia", "AU", -37.8, 145.0), "jb hi-fi": ("JB Hi-Fi", "AU", -37.8, 145.0), "the warehouse": ("The Warehouse", "NZ", -36.9, 174.8), "foodstuffs": ("Foodstuffs", "NZ", -36.9, 174.8), "seven & i": ("Seven & i", "JP", 35.7, 139.7), "aeon": ("AEON", "JP", 35.6, 140.1), "rakuten": ("Rakuten", "JP", 35.7, 139.7), "uniqlo": ("Uniqlo", "JP", 35.7, 139.7), "fast retailing": ("Uniqlo / Fast Retailing", "JP", 35.7, 139.7), "muji": ("Muji", "JP", 35.7, 139.7), "lotte": ("Lotte", "KR", 37.6, 127.0), "shinsegae": ("Shinsegae", "KR", 37.6, 127.0), "emart": ("E-mart", "KR", 37.6, 127.0), "coupang": ("Coupang", "KR", 37.6, 127.0), "alibaba": ("Alibaba", "CN", 30.3, 120.2), "jd.com": ("JD.com", "CN", 39.9, 116.4), "pinduoduo": ("PDD / Temu", "CN", 31.2, 121.5), "temu": ("Temu", "CN", 31.2, 121.5), "shein": ("Shein", "SG", 1.35, 103.8), "lazada": ("Lazada", "SG", 1.35, 103.8), "shopee": ("Shopee", "SG", 1.35, 103.8), "fairprice": ("FairPrice", "SG", 1.35, 103.8), "flipkart": ("Flipkart", "IN", 13.0, 77.6), "reliance retail": ("Reliance Retail", "IN", 19.1, 72.9), "dmart": ("DMart", "IN", 19.1, 72.9), "bigbasket": ("BigBasket", "IN", 13.0, 77.6), "zepto": ("Zepto", "IN", 19.1, 72.9), "blinkit": ("Blinkit", "IN", 28.6, 77.2), "myntra": ("Myntra", "IN", 13.0, 77.6), "tata": ("Tata", "IN", 19.1, 72.9), "india": ("India retail", "IN", 20.6, 78.9), "sm supermalls": ("SM", "PH", 14.6, 121.0), "sm retail": ("SM Retail", "PH", 14.6, 121.0), "puregold": ("Puregold", "PH", 14.6, 121.0), "jollibee": ("Jollibee", "PH", 14.6, 121.0), "indomaret": ("Indomaret", "ID", -6.2, 106.8), "alfamart": ("Alfamart", "ID", -6.2, 106.8), "tokopedia": ("Tokopedia", "ID", -6.2, 106.8), "central group": ("Central Group", "TH", 13.8, 100.5), "cp all": ("CP All", "TH", 13.8, 100.5), "vietnam": ("Vietnam retail", "VN", 21.0, 105.8), "australia": ("Australian retail", "AU", -33.9, 151.2), "japan": ("Japan retail", "JP", 35.7, 139.7), "korea": ("Korean retail", "KR", 37.6, 127.0), "singapore": ("Singapore retail", "SG", 1.35, 103.8), "hong kong": ("Hong Kong retail", "HK", 22.3, 114.2), "china": ("China retail", "CN", 39.9, 116.4), "pakistan": ("Pakistan retail", "PK", 24.9, 67.0), "bangladesh": ("Bangladesh retail", "BD", 23.8, 90.4),
 # Africa / LatAm
 "shoprite": ("Shoprite", "ZA", -33.9, 18.4), "pick n pay": ("Pick n Pay", "ZA", -33.9, 18.4), "woolworths sa": ("Woolworths SA", "ZA", -33.9, 18.4), "spar": ("SPAR", "ZA", -29.9, 31.0), "massmart": ("Massmart", "ZA", -26.2, 28.0), "jumia": ("Jumia", "NG", 6.5, 3.4), "south africa": ("South African retail", "ZA", -29.0, 24.0), "nigeria": ("Nigeria retail", "NG", 9.1, 8.7), "kenya": ("Kenya retail", "KE", -1.3, 36.8), "naivas": ("Naivas", "KE", -1.3, 36.8), "morocco": ("Morocco retail", "MA", 33.6, -7.6), "marjane": ("Marjane", "MA", 33.6, -7.6),
 "mercado libre": ("Mercado Libre", "AR", -34.6, -58.4), "mercadolibre": ("Mercado Libre", "AR", -34.6, -58.4), "magazine luiza": ("Magazine Luiza", "BR", -23.5, -46.6), "americanas": ("Americanas", "BR", -22.9, -43.2), "falabella": ("Falabella", "CL", -33.4, -70.6), "cencosud": ("Cencosud", "CL", -33.4, -70.6), "éxito": ("Grupo Éxito", "CO", 6.2, -75.6), "exito": ("Grupo Éxito", "CO", 6.2, -75.6), "brazil": ("Brazil retail", "BR", -15.8, -47.9), "argentina": ("Argentina retail", "AR", -34.6, -58.4), "chile": ("Chile retail", "CL", -33.4, -70.6), "colombia": ("Colombia retail", "CO", 4.7, -74.1),
}
# names that are ordinary words too: matched case-sensitively in the form given (word-bounded), the rest case-insensitively
CASE_FORMS = {"ica": "ICA", "spar": "SPAR", "boots": "Boots", "coop": "Coop", "mango": "Mango", "dior": "Dior", "tata": "Tata", "zid": "Zid", "noon": "noon.com|Noon", "danube": "Danube", "panda": "Panda", "lotte": "Lotte", "nova": "Nova", "next plc": "Next plc|Next's|Next store", "temu": "Temu", "shein": "Shein|SHEIN", "muji": "Muji|MUJI", "lulu": "LuLu|Lulu", "aeon": "AEON|Aeon", "extra": "eXtra", "target": "Target's|Target stores?|Target Corp|Target shoppers?|Target employees?|Target customers?|Target (?:says|said|confirms|confirmed|data|breach|cyber|refrigerat|store)|(?:at|from|outside|inside|near) Target"}
def _ent_pat(k):
    if k in CASE_FORMS: return r"\b(?:" + CASE_FORMS[k] + r")\b"
    return r"\b" + re.escape(k) + r"\b"
ENT_RE_CI = re.compile("|".join(_ent_pat(k) for k in sorted(ENTITIES, key=len, reverse=True) if k not in CASE_FORMS and not re.search(r"[\u0600-\u06FF]", k)), re.I)
ENT_RE_CS = re.compile("|".join(_ent_pat(k) for k in sorted(ENTITIES, key=len, reverse=True) if k in CASE_FORMS))
ENT_RE_AR = re.compile("|".join(re.escape(k) for k in ENTITIES if re.search(r"[\u0600-\u06FF]", k)))
_CS_BACK = {}
for k, f in CASE_FORMS.items():
    for alt in f.split("|"): _CS_BACK[re.sub(r"[^a-z]", "", alt.lower().split("(?:")[0])[:6]] = k
def ent_matches(text):
    """yield entity keys found in text, in order of appearance"""
    found = []
    for m in ENT_RE_CI.finditer(text): found.append((m.start(), m.group(0).lower()))
    for m in ENT_RE_CS.finditer(text):
        g = m.group(0)
        key = next((k for k, f in CASE_FORMS.items() if re.fullmatch(r"(?:" + f + r")", g)), None)
        if key: found.append((m.start(), key))
    for m in ENT_RE_AR.finditer(text): found.append((m.start(), m.group(0)))
    for _, k in sorted(found):
        if k in ENTITIES: yield k
PARENT = {"albert heijn": "ahold", "stop & shop": "ahold", "food lion": "ahold", "giant food": "ahold", "hannaford": "ahold", "hobbs": "tfg london", "whistles": "tfg london", "phase eight": "tfg london", "super u": "système u", "hyper u": "système u", "systeme u": "système u", "co-op u": "système u", "coopérative u": "système u", "sam's club": "walmart", "centrepoint": "landmark group", "majid al futtaim": "carrefour uae", "fawaz alhokair": "cenomi", "othaim": "al othaim", "al nahdi": "nahdi", "mercadolibre": "mercado libre", "exito": "éxito", "marks and spencer": "marks & spencer", "m&s": "marks & spencer", "fast retailing": "uniqlo", "cl0p": "clop", "pinduoduo": "temu"}
# edition/region of the search → fallback country (news only)
EDITION_CC = {"AE": "AE", "AE_ar": "AE", "SA": "SA", "SA_ar": "SA", "EG_ar": "EG", "GB": "GB", "US": "US"}
CC_REGION = {
 "AE": "Middle East", "SA": "Middle East", "SY": "Middle East", "DZ": "Africa", "QA": "Middle East", "KW": "Middle East", "BH": "Middle East", "OM": "Middle East", "EG": "Middle East", "IL": "Middle East", "JO": "Middle East", "TR": "Middle East", "LB": "Middle East", "IQ": "Middle East", "IR": "Middle East",
 "GB": "Europe", "IE": "Europe", "FR": "Europe", "DE": "Europe", "NL": "Europe", "ES": "Europe", "IT": "Europe", "SE": "Europe", "DK": "Europe", "PL": "Europe", "RU": "Europe", "NO": "Europe", "FI": "Europe", "BE": "Europe", "CH": "Europe", "AT": "Europe", "PT": "Europe",
 "US": "North America", "CA": "North America", "MX": "North America",
 "AU": "Asia-Pacific", "NZ": "Asia-Pacific", "JP": "Asia-Pacific", "KR": "Asia-Pacific", "CN": "Asia-Pacific", "HK": "Asia-Pacific", "SG": "Asia-Pacific", "IN": "Asia-Pacific", "PH": "Asia-Pacific", "ID": "Asia-Pacific", "TH": "Asia-Pacific", "VN": "Asia-Pacific", "MY": "Asia-Pacific", "PK": "Asia-Pacific", "BD": "Asia-Pacific", "TW": "Asia-Pacific",
 "ZA": "Africa", "NG": "Africa", "KE": "Africa", "MA": "Africa", "GH": "Africa", "TN": "Africa",
 "BR": "Latin America", "AR": "Latin America", "CL": "Latin America", "CO": "Latin America", "PE": "Latin America",
}
CC_NAME = dict(COUNTRY); CC_NAME.update({"BH": "Bahrain", "OM": "Oman", "LB": "Lebanon", "SY": "Syria", "DZ": "Algeria", "IQ": "Iraq", "IR": "Iran", "IE": "Ireland", "IT": "Italy", "PL": "Poland", "RU": "Russia", "NO": "Norway", "FI": "Finland", "BE": "Belgium", "CH": "Switzerland", "AT": "Austria", "PT": "Portugal", "MX": "Mexico", "NZ": "New Zealand", "CN": "China", "HK": "Hong Kong", "ID": "Indonesia", "TH": "Thailand", "VN": "Vietnam", "MY": "Malaysia", "PK": "Pakistan", "BD": "Bangladesh", "TW": "Taiwan", "NG": "Nigeria", "KE": "Kenya", "MA": "Morocco", "GH": "Ghana", "TN": "Tunisia", "BR": "Brazil", "CL": "Chile", "PE": "Peru", "XX": "Global"})
CC_LATLON = {"AE": (24.45, 54.4), "SA": (24.7, 46.7), "QA": (25.3, 51.5), "KW": (29.4, 48.0), "BH": (26.2, 50.6), "OM": (23.6, 58.5), "EG": (30.0, 31.2), "IL": (32.1, 34.8), "JO": (31.9, 35.9), "TR": (41.0, 29.0), "LB": (33.9, 35.5), "SY": (33.5, 36.3), "DZ": (36.8, 3.1), "IQ": (33.3, 44.4), "IR": (35.7, 51.4), "GB": (51.5, -0.12), "IE": (53.3, -6.3), "FR": (48.9, 2.3), "DE": (52.5, 13.4), "NL": (52.4, 4.9), "ES": (40.4, -3.7), "IT": (41.9, 12.5), "SE": (59.3, 18.1), "DK": (55.7, 12.6), "PL": (52.2, 21.0), "RU": (55.8, 37.6), "NO": (59.9, 10.8), "FI": (60.2, 24.9), "BE": (50.8, 4.4), "CH": (46.9, 7.4), "AT": (48.2, 16.4), "PT": (38.7, -9.1), "US": (38.9, -77.0), "CA": (45.4, -75.7), "MX": (19.4, -99.1), "AU": (-33.9, 151.2), "NZ": (-41.3, 174.8), "JP": (35.7, 139.7), "KR": (37.6, 127.0), "CN": (39.9, 116.4), "HK": (22.3, 114.2), "SG": (1.35, 103.8), "IN": (28.6, 77.2), "PH": (14.6, 121.0), "ID": (-6.2, 106.8), "TH": (13.8, 100.5), "VN": (21.0, 105.8), "MY": (3.1, 101.7), "PK": (33.7, 73.1), "BD": (23.8, 90.4), "TW": (25.0, 121.6), "ZA": (-26.2, 28.0), "NG": (9.1, 8.7), "KE": (-1.3, 36.8), "MA": (33.6, -7.6), "GH": (5.6, -0.2), "TN": (36.8, 10.2), "BR": (-15.8, -47.9), "AR": (-34.6, -58.4), "CL": (-33.4, -70.6), "CO": (4.7, -74.1), "PE": (-12.0, -77.0), "XX": (20.0, 10.0)}
COUNTRY_WORDS = {  # title words → country when no entity matched
 "uae": "AE", "emirati": "AE", "dubai": "AE", "abu dhabi": "AE", "saudi": "SA", "riyadh": "SA", "jeddah": "SA", "qatar": "QA", "doha": "QA", "kuwait": "KW", "bahrain": "BH", "oman": "OM", "egypt": "EG", "egyptian": "EG", "israel": "IL", "israeli": "IL", "jordan": "JO", "turkey": "TR", "turkish": "TR", "lebanon": "LB", "iraq": "IQ", "iran": "IR",
 "uk": "GB", "u.k.": "GB", "britain": "GB", "british": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "london": "GB", "manchester": "GB", "ireland": "IE", "irish": "IE", "france": "FR", "french": "FR", "paris": "FR", "germany": "DE", "german": "DE", "berlin": "DE", "netherlands": "NL", "dutch": "NL", "amsterdam": "NL", "spain": "ES", "spanish": "ES", "italy": "IT", "italian": "IT", "sweden": "SE", "swedish": "SE", "denmark": "DK", "danish": "DK", "poland": "PL", "polish": "PL", "russia": "RU", "russian": "RU", "norway": "NO", "finland": "FI", "belgium": "BE", "swiss": "CH", "switzerland": "CH", "austria": "AT", "portugal": "PT",
 "u.s.": "US", "us ": "US", "american": "US", "texas": "US", "florida": "US", "new york": "US", "california": "US", "chicago": "US", "fbi": "US", "canada": "CA", "canadian": "CA", "mexico": "MX", "mexican": "MX",
 "australia": "AU", "australian": "AU", "sydney": "AU", "melbourne": "AU", "new zealand": "NZ", "japan": "JP", "japanese": "JP", "tokyo": "JP", "korea": "KR", "korean": "KR", "seoul": "KR", "china": "CN", "chinese": "CN", "beijing": "CN", "hong kong": "HK", "singapore": "SG", "india": "IN", "indian": "IN", "mumbai": "IN", "delhi": "IN", "bengaluru": "IN", "philippines": "PH", "manila": "PH", "indonesia": "ID", "jakarta": "ID", "thailand": "TH", "bangkok": "TH", "vietnam": "VN", "malaysia": "MY", "pakistan": "PK", "bangladesh": "BD", "taiwan": "TW",
 "south africa": "ZA", "johannesburg": "ZA", "cape town": "ZA", "nigeria": "NG", "lagos": "NG", "kenya": "KE", "nairobi": "KE", "morocco": "MA", "ghana": "GH", "tunisia": "TN",
 "brazil": "BR", "brazilian": "BR", "são paulo": "BR", "argentina": "AR", "chile": "CL", "colombia": "CO", "peru": "PE",
}
AR_COUNTRY = {"فرنسا": "FR", "الفرنسية": "FR", "بريطانيا": "GB", "لندن": "GB", "البريطانية": "GB", "أمريكا": "US", "الولايات المتحدة": "US", "الأمريكية": "US", "ألمانيا": "DE", "الهند": "IN", "الصين": "CN", "اليابان": "JP", "تركيا": "TR", "إسرائيل": "IL", "الأردن": "JO", "البحرين": "BH", "لبنان": "LB", "العراق": "IQ", "إيران": "IR", "سوريا": "SY", "إدلب": "SY", "المغرب": "MA", "نيجيريا": "NG", "كندا": "CA", "أستراليا": "AU", "روسيا": "RU", "إسبانيا": "ES", "إيطاليا": "IT", "هولندا": "NL", "الإمارات": "AE", "دبي": "AE", "أبوظبي": "AE", "الشارقة": "AE", "السعودية": "SA", "الرياض": "SA", "جدة": "SA", "الكويت": "KW", "قطر": "QA", "الدوحة": "QA", "عُمان": "OM", "سلطنة عمان": "OM", "مصر": "EG", "القاهرة": "EG"}
AR_RE = re.compile("|".join(sorted((re.escape(k) for k in AR_COUNTRY), key=len, reverse=True)))
OUTLET_CC = {"gulf news": "AE", "khaleej times": "AE", "the national": "AE", "arabian business": "AE", "gulf business": "AE", "emirates 24|7": "AE", "صوت الإمارات": "AE", "البيان": "AE", "الاتحاد": "AE", "arab news": "SA", "saudi gazette": "SA", "al arabiya": "SA", "العربية": "SA", "عكاظ": "SA", "الرياض": "SA", "سبق": "SA", "اليوم السابع": "EG", "المصري اليوم": "EG", "الوطن": "EG", "egypt independent": "EG", "ahram": "EG", "times of israel": "IL", "jerusalem post": "IL", "haaretz": "IL", "jordan times": "JO", "daily sabah": "TR", "hurriyet": "TR", "bbc": "GB", "the guardian": "GB", "the independent": "GB", "sky news": "GB", "the telegraph": "GB", "daily mail": "GB", "the sun": "GB", "mirror": "GB", "evening standard": "GB", "city am": "GB", "retail week": "GB", "retail gazette": "GB", "the grocer": "GB", "nbc news": "US", "cnn": "US", "abc news": "US", "cbs news": "US", "fox news": "US", "nbc": "US", "6abc philadelphia": "US", "usa today": "US", "new york post": "US", "washington post": "US", "new york times": "US", "wsj": "US", "retail dive": "US", "supermarket news": "US", "grocery dive": "US", "cbc": "CA", "global news": "CA", "ctv": "CA", "le monde": "FR", "france 24": "FR", "le figaro": "FR", "bfm": "FR", "nl times": "NL", "dutchnews": "NL", "nos": "NL", "the straits times": "SG", "channel news asia": "SG", "abc news & headlines – australian broadcasting corporation": "AU", "the age": "AU", "sydney morning herald": "AU", "news.com.au": "AU", "9news": "AU", "times of india": "IN", "hindustan times": "IN", "ndtv": "IN", "the hindu": "IN", "economic times": "IN", "vietnam.vn": "VN", "korea herald": "KR", "korea times": "KR", "japan times": "JP", "nhk": "JP", "south china morning post": "HK", "iol": "ZA", "news24": "ZA", "timeslive": "ZA", "daily maverick": "ZA", "punch": "NG", "vanguard": "NG", "nation": "KE", "the star": "KE"}
def outlet_cc(o):
    o = (o or "").lower().strip()
    if o in OUTLET_CC: return OUTLET_CC[o]
    for k, v in OUTLET_CC.items():
        if len(k) > 4 and k in o: return v
    return ""
CW_RE = re.compile(r"\b(" + "|".join(sorted((re.escape(k) for k in COUNTRY_WORDS), key=len, reverse=True)) + r")\b", re.I)
GROUP_ALIASES = ["lockbit", "akira", "qilin", "clop", "cl0p", "ransomhub", "play", "blackcat", "alphv", "scattered spider", "shinyhunters", "medusa", "inc ransom", "lynx", "safepay", "dragonforce", "everest", "hunters international", "rhysida", "black basta", "sinobi", "kairos", "interlock", "nightspire", "devman", "worldleaks", "gentlemen", "coinbase cartel", "payouts king", "beast", "nova", "space bears"]

# ---------- helpers ----------
def log(*a): print("[period]", *a, flush=True)
def jl(ch):
    p = os.path.join(RAW, f"{ch}.jsonl")
    if not os.path.exists(p): return
    with open(p, encoding="utf-8") as f:
        for l in f:
            l = l.strip()
            if l:
                try: yield json.loads(l)
                except json.JSONDecodeError: continue
def d10(s): return (s or "")[:10]
def valid_date(s):
    try: dt.date.fromisoformat(s); return True
    except Exception: return False
REL_RE = re.compile(r"(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago", re.I)
def rel_to_date(txt, fetched):
    m = REL_RE.search(txt or "")
    if not m or not fetched: return ""
    n, u = int(m.group(1)), m.group(2).lower()
    base = dt.datetime.fromisoformat(fetched.replace("Z", "+00:00"))
    days = {"second": 0, "minute": 0, "hour": 0, "day": n, "week": 7 * n, "month": 30 * n, "year": 365 * n}[u]
    return (base - dt.timedelta(days=days)).date().isoformat()
def norm_title(t):
    t = re.sub(r"\s+[-–|]\s+[^-–|]{2,40}$", "", t or "")        # strip " - Outlet"
    t = re.sub(r"[^\w\s]", " ", t.lower()); t = re.sub(r"\s+", " ", t).strip()
    return t
def outlet_of(r, ch):
    if ch in ("gnews", "bingnews"): return (r.get("source") or "").strip() or _host(r.get("source_url") or r.get("url"))
    if ch in ("bingweb", "ddg"): return _host(r.get("url"))
    if ch == "youtube": return r.get("channel_name") or "YouTube"
    if ch in ("reddit", "reddit_web"): return r.get("subreddit") or "Reddit"
    if ch == "bluesky": return r.get("author") or "Bluesky"
    if ch == "mastodon": return r.get("instance") or "Mastodon"
    if ch == "lemmy": return r.get("community") or "Lemmy"
    if ch == "hn": return "Hacker News"
    if ch == "ransomware_live": return "ransomware.live"
    if ch == "hibp": return "Have I Been Pwned"
    return ch
def _host(u):
    m = re.match(r"https?://(?:www\.)?([^/]+)", u or ""); return m.group(1) if m else ""
def slug(s, n=48):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:n] or hashlib.sha1((s or "x").encode()).hexdigest()[:8]

# ---------- normalise ----------
def normalise(r, ch):
    """One raw record -> {ch,title,url,date,outlet,text,query,edition,eng,author} or None."""
    f = r.get("fetched_at") or ""
    if ch in ("gnews", "bingnews"):
        return dict(ch=ch, title=r.get("title") or "", url=r.get("url") or "", date=d10(r.get("published")), outlet=outlet_of(r, ch), text=r.get("snippet") or "", query=r.get("query") or "", edition=r.get("region") or "", eng=0, author="")
    if ch in ("bingweb", "ddg"):
        return dict(ch=ch, title=r.get("title") or "", url=r.get("url") or "", date="", outlet=outlet_of(r, ch), text=r.get("snippet") or "", query=r.get("query") or "", edition="", eng=0, author="")
    if ch == "hn":
        return dict(ch=ch, title=r.get("title") or "", url=r.get("url") or r.get("hn_url") or "", date=d10(r.get("published")), outlet="Hacker News", text="", query=r.get("query") or "", edition="", eng=int(r.get("points") or 0) + int(r.get("comments") or 0), author=r.get("author") or "")
    if ch in ("reddit", "reddit_web"):
        return dict(ch=ch, title=r.get("title") or "", url=r.get("url") or "", date=d10(r.get("published")), outlet=outlet_of(r, ch), text=(r.get("text") or "")[:600], query=r.get("query") or "", edition="", eng=int(r.get("score") or 0) + int(r.get("comments") or 0), author=r.get("author") or "")
    if ch == "bluesky":
        return dict(ch=ch, title=(r.get("text") or "")[:160], url=r.get("url") or "", date=d10(r.get("published")), outlet=r.get("author") or "Bluesky", text=r.get("text") or "", query=r.get("query") or "", edition="", eng=int(r.get("likes") or 0) + 2 * int(r.get("reposts") or 0), author=r.get("author") or "")
    if ch == "mastodon":
        txt = re.sub(r"<[^>]+>", " ", r.get("text") or ""); txt = re.sub(r"\s+", " ", txt).strip()
        return dict(ch=ch, title=txt[:160], url=r.get("url") or "", date=d10(r.get("published")), outlet=r.get("instance") or "Mastodon", text=txt, query=r.get("query") or "", edition="", eng=int(r.get("favs") or 0) + 2 * int(r.get("boosts") or 0), author=r.get("author") or "")
    if ch == "lemmy":
        return dict(ch=ch, title=r.get("title") or "", url=r.get("link_url") or r.get("url") or "", date=d10(r.get("published")), outlet=r.get("community") or "Lemmy", text="", query=r.get("query") or "", edition="", eng=int(r.get("score") or 0) + int(r.get("comments") or 0), author="")
    if ch == "youtube":
        v = re.sub(r"[^\d]", "", r.get("views") or "0") or "0"
        return dict(ch=ch, title=r.get("title") or "", url=r.get("url") or "", date=rel_to_date(r.get("published_text"), f), outlet=r.get("channel_name") or "YouTube", text="", query=r.get("query") or "", edition="", eng=int(v) // 100, author=r.get("channel_name") or "")
    if ch == "ransomware_live":
        return dict(ch=ch, title=f"{r.get('victim')} listed by {r.get('group')}", url=r.get("post_url") or r.get("claim_url") or "https://www.ransomware.live/", date=d10(r.get("discovered") or r.get("attackdate")), outlet="ransomware.live", text=(r.get("description") or "")[:400], query=r.get("scope") or "", edition=r.get("country") or "", eng=0, author=r.get("group") or "", victim=r.get("victim") or "", group=r.get("group") or "", cc=(r.get("country") or "").upper(), activity=r.get("activity") or "")
    if ch == "hibp":
        return dict(ch=ch, title=f"{r.get('title') or r.get('name')} breach ({int(r.get('pwn_count') or 0):,} accounts)", url=f"https://haveibeenpwned.com/Breach/{r.get('name')}", date=d10(r.get("added_date")), outlet="Have I Been Pwned", text=re.sub(r"<[^>]+>", "", r.get("description") or "")[:500], query="hibp", edition="", eng=0, author="", pwn=int(r.get("pwn_count") or 0), classes=r.get("data_classes") or [], breach_date=d10(r.get("breach_date")), domain=r.get("domain") or "")
    return None

def load_window(frm, to):
    """All normalised records inside the window, per channel, plus coverage counts."""
    recs, cov = [], {}
    for ch in CHANNELS:
        tot = inwin = undated = 0
        for r in jl(ch):
            tot += 1
            n = normalise(r, ch)
            if not n or not (n["title"] or n["text"]): continue
            if not n["date"]:
                undated += 1
                fd = d10(r.get("fetched_at"))
                continue                      # undated web-search hits cannot say "new this period"
            if not (frm <= n["date"] <= to): continue
            inwin += 1; recs.append(n)
        cov[ch] = dict(total=tot, in_window=inwin, undated=undated)
    return recs, cov

# ---------- relevance & dedupe ----------
def relevant(n):
    blob = f"{n['title']} {n['text']}"
    if n["ch"] in ("ransomware_live", "hibp"): return True
    if NOISE.search(blob): return False
    q = n.get("query") or ""
    # the retail side must be in the title (or a named retailer there); the security side may sit in the snippet
    named = any(not ENTITIES[k][0].endswith(" retail") for k in ent_matches(n["title"]))   # a place name alone is not retail
    has_r = bool(RE_RETAIL.search(n["title"])) or named or (n["ch"] in SOCIAL and bool(RE_RETAIL.search(blob)))
    has_s = bool(RE_SEC.search(blob))
    if has_r and has_s: return True
    # social hits came from retail-security queries: accept if the text itself carries the security side
    if n["ch"] in SOCIAL and has_s and RE_RETAIL.search(q): return True
    return False

def dedupe(recs):
    seen, out = {}, []
    for n in sorted(recs, key=lambda x: (x["date"], x["ch"] not in NEWS)):
        k = (n["ch"] if n["ch"] in ("ransomware_live", "hibp") else "t", norm_title(n["title"])[:90] or n["url"])
        if k in seen:
            seen[k]["dups"] = seen[k].get("dups", 0) + 1
            if n["outlet"] and n["outlet"] not in seen[k].setdefault("outlets", []): seen[k]["outlets"].append(n["outlet"])
            continue
        n["outlets"] = [n["outlet"]] if n["outlet"] else []
        seen[k] = n; out.append(n)
    return out

# ---------- classification ----------
def theme_of(n):
    blob = f"{n['title']} {n['text'][:300]}"
    if n["ch"] == "ransomware_live": return "ransomware"
    if n["ch"] == "hibp": return "breach"
    for k, c, l, rx in THEME_RE:
        if rx.search(blob): return k
    return "market"
THEME_CAT = {k: c for k, c, l, r in THEMES}; THEME_LABEL = {k: l for k, c, l, r in THEMES}
def entity_of(n):
    """-> (key, display, cc, lat, lon) or None."""
    if n["ch"] == "ransomware_live":
        cc = n.get("cc") or "XX"; la, lo = CC_LATLON.get(cc, CC_LATLON["XX"])
        return ("rl:" + slug(n.get("victim")), n.get("victim") or "Unnamed victim", cc, la, lo)
    if n["ch"] == "hibp":
        return ("hibp:" + slug(n.get("domain") or n["title"]), n["title"].split(" breach (")[0], "XX", *CC_LATLON["XX"])
    keys = list(ent_matches(n["title"]))
    named = [k for k in keys if not ENTITIES[k][0].endswith(" retail")]
    for k in named + keys:                      # a named retailer beats a place
        d, cc, la, lo = ENTITIES[k]; return (k, d, cc, la, lo)
    for k in ent_matches(n["text"][:300]):
        if not ENTITIES[k][0].endswith(" retail"):
            d, cc, la, lo = ENTITIES[k]; return (k, d, cc, la, lo)
    return None
def country_of(n, ent):
    if ent and ent[2] != "XX": return ent[2]
    m = CW_RE.search(n["title"]) or CW_RE.search(n["text"][:300])
    if m: return COUNTRY_WORDS[m.group(1).lower()]
    m = AR_RE.search(n["title"]) or AR_RE.search(n["text"][:300])
    if m: return AR_COUNTRY[m.group(0)]
    if n["ch"] in NEWS: return outlet_cc(n["outlet"]) or "XX"
    return "XX"
def status_of(n_list, theme):
    if any(n["ch"] == "hibp" for n in n_list): return "confirmed"
    if theme in ("regulation", "market", "geopolitical", "ai_bots"): return "context"
    if any(n["ch"] == "ransomware_live" for n in n_list) and not any(n["ch"] in NEWS for n in n_list): return "claimed"
    blob = " ".join(f"{n['title']} {n['text'][:300]}" for n in n_list if n["ch"] in NEWS)
    if CONFIRM_RE.search(blob): return "confirmed"
    if theme in ("enforcement",) and any(n["ch"] in NEWS for n in n_list): return "confirmed"
    return "claimed"
def group_in(text):
    t = text.lower()
    for g in GROUP_ALIASES:
        if g in t: return g
    return ""

# ---------- clustering ----------
def cluster(recs):
    """Group relevant, deduped records into incidents keyed by (entity|country, theme)."""
    groups = collections.OrderedDict()
    for n in recs:
        th = theme_of(n); ent = entity_of(n); cc = country_of(n, ent)
        if ent and ent[0] in PARENT:
            pk = PARENT[ent[0]]; d, pcc, la, lo = ENTITIES[pk]; sub_name = ent[1]; ent = (pk, d, pcc, la, lo); cc = pcc
        else: sub_name = ""
        named = bool(ent) and not ent[1].endswith(" retail")
        key = (ent[0] if named else f"cc:{cc}", th)
        g = groups.setdefault(key, {"ent": ent if named else None, "cc": cc, "theme": th, "recs": [], "subs": []})
        g["recs"].append(n)
        if sub_name and sub_name != ent[1] and sub_name not in g["subs"]: g["subs"].append(sub_name)
    # fold a named entity's market/ai_bots/breach/iot clusters into its strongest cyber cluster
    FOLD = {"ransomware": 0, "ot": 1, "breach": 2, "iot": 3, "market": 9, "ai_bots": 9}
    RFOLD = {"ot": 0, "breach": 1, "iot": 2}            # country roundups: one cyber-incident roundup, ransomware/market stay apart
    by_ent = collections.defaultdict(list)
    for (ek, th), g in groups.items():
        fold = RFOLD if ek.startswith("cc:") else FOLD
        if th in fold: by_ent[ek].append(th)
    for ek, ths in by_ent.items():
        fold = RFOLD if ek.startswith("cc:") else FOLD
        cyber = sorted((t for t in ths if fold[t] < 9), key=lambda t: (fold[t], -len(groups[(ek, t)]["recs"])))
        if len(ths) < 2 or not cyber: continue
        main = max(cyber, key=lambda t: len(groups[(ek, t)]["recs"])) if ek.startswith("cc:") else cyber[0]
        for t in ths:
            if t != main:
                src = groups.pop((ek, t)); groups[(ek, main)]["recs"].extend(src["recs"])
                for sn in src.get("subs", []):
                    if sn not in groups[(ek, main)]["subs"]: groups[(ek, main)]["subs"].append(sn)
    incs = []
    for (ek, th), g in groups.items():
        rs = sorted(g["recs"], key=lambda x: (x["ch"] not in NEWS, -x.get("eng", 0), x["date"]))
        news = [r for r in rs if r["ch"] in NEWS]; social = [r for r in rs if r["ch"] in SOCIAL]
        outlets = []
        for r in rs:
            for o in r.get("outlets", []):
                if o and o not in outlets: outlets.append(o)
        ent = g["ent"]; cc = g["cc"]
        if ent:
            name_ent, lat, lon = ent[1], ent[3], ent[4]
            if g.get("subs") and "(" not in name_ent: name_ent += " (" + ", ".join(re.sub(r"\s*\(.*?\)", "", x) for x in g["subs"][:3]) + ")"
        else: name_ent = (CC_NAME.get(cc, cc) if cc != "XX" else "worldwide") + " retail"; lat, lon = CC_LATLON.get(cc, CC_LATLON["XX"])
        is_country_bucket = ent is None
        head = rs[0]
        kind = "leak" if ek.startswith("rl:") else "hibp" if ek.startswith("hibp:") else "roundup" if is_country_bucket else "incident"
        # weight: distinct outlets + news count + social presence; thin country roundups are dropped
        weight = len(outlets) + len(news) + min(5, len(social)) + (3 if kind == "hibp" else 0)
        if kind == "roundup" and (len(news) < 3 or len(outlets) < 2): continue
        if kind == "incident" and not news and len(social) < 3: continue           # a lone social post is not an incident
        if kind == "incident" and not news and th in ("market", "ai_bots", "regulation"): continue
        if kind == "leak" and not head.get("victim"): continue
        status = "claimed" if kind == "leak" else "confirmed" if kind == "hibp" else "context" if kind == "roundup" else status_of(rs, th)
        sev = 1 + (len(outlets) >= 3) + (len(outlets) >= 8) + (len(news) >= 15) + (len(outlets) >= 20 and status == "confirmed")
        if any(r["ch"] == "hibp" and r.get("pwn", 0) > 1_000_000 for r in rs): sev = max(sev, 4)
        if th in ("violence", "ot") and len(outlets) >= 3: sev = max(sev, 3)
        if kind == "roundup": sev = min(sev, 3)
        lead = news[0] if news else rs[0]
        incs.append(dict(key=f"{ek}|{th}", name=_name(name_ent, th, rs), entity=name_ent, country=cc, region=CC_REGION.get(cc, "Global"), lat=lat, lon=lon,
                         date=min(r["date"] for r in rs), last=max(r["date"] for r in rs), theme=th, cat=THEME_CAT[th], type=THEME_LABEL[th], sev=sev, status=status,
                         weight=weight, n_news=len(news), n_social=len(social), outlets=outlets[:12], group=(head.get("group") or "") if kind == "leak" else next((g2 for g2 in (group_in(r["title"] + " " + r["text"][:200]) for r in rs) if g2), ""),
                         lead_title=lead["title"], recs=rs, is_bucket=is_country_bucket, kind=kind))
    incs.sort(key=lambda i: ({"incident": 0, "hibp": 0, "roundup": 1, "leak": 2}[i["kind"]], -i["weight"], i["date"]))
    return incs
def _name(ent, th, rs):
    short = {"ransomware": "ransomware claim", "breach": "data breach", "iot": "IoT / supplier incident", "ai_bots": "AI agents & bots", "fraud": "fraud / scam wave", "orc": "theft & organised retail crime", "violence": "violence at stores", "ot": "OT / supply-chain incident", "geopolitical": "geopolitical pressure", "regulation": "regulation & fines", "enforcement": "arrests & enforcement", "market": "market & vendor moves"}[th]
    if rs and rs[0]["ch"] == "ransomware_live": return f"{ent} listed by {rs[0].get('group') or 'a ransomware group'}"
    if rs and rs[0]["ch"] == "hibp": return rs[0]["title"]
    if ent.endswith(" retail"): return f"{short[0].upper() + short[1:]} — {ent.replace(' retail', '')} roundup"
    if th in ("ot", "breach", "ransomware", "iot") and len(rs) >= 8: short = "cyber incident" if th != "ransomware" else "ransomware / extortion"
    return f"{ent}: {short}"

# ---------- summaries ----------
def summarise(inc, frm, to):
    rs = inc["recs"]; news = [r for r in rs if r["ch"] in NEWS]
    lead = news[0] if news else rs[0]
    n_out = len(inc["outlets"]); first, last = inc["date"], inc["last"]
    span = first if first == last else f"{first} to {last}"
    if lead["ch"] == "hibp":
        return f"Have I Been Pwned added {lead['title'].split(' breach (')[0]} on {lead['date']} ({lead.get('pwn', 0):,} accounts; classes: {', '.join(lead.get('classes', [])[:5])}). Breach date {lead.get('breach_date') or 'n/a'}."
    if lead["ch"] == "ransomware_live":
        return f"ransomware.live records a claim against {lead.get('victim')} ({CC_NAME.get(inc['country'], inc['country'])}, {lead.get('activity') or 'retail'}) by {lead.get('group')} discovered {lead['date']}. A leak-site listing is a claim until the company confirms."
    heads = [r["title"] for r in news[:3]] or [r["title"] for r in rs[:2]]
    s = f"{n_out} outlet{'s' if n_out != 1 else ''} across {len(rs)} item{'s' if len(rs) != 1 else ''} ({span}). Lead: \"{heads[0][:140]}\"."
    if len(heads) > 1: s += f" Also: \"{heads[1][:110]}\"."
    if inc["n_social"]: s += f" {inc['n_social']} social post{'s' if inc['n_social'] != 1 else ''} discussed it."
    return s
def impact_of(inc):
    rs = inc["recs"]
    for r in rs:
        if r["ch"] == "hibp": return f"{r.get('pwn', 0):,} accounts"
    cands = []
    for r in rs[:40]:
        for m in re.finditer(r"(\d[\d,.]*\s*(million|m\b|bn|billion|k\b|thousand)?\s*(customers|accounts|records|people|users|stores|shops|supermarkets|staff|employees|arrests|victims)|[£$€]\s?\d[\d,.]*\s*(million|m\b|bn|billion|k\b)?)", f"{r['title']} {r['text']}", re.I):
            t = m.group(0).strip(); mult = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "bn": 1e9, "billion": 1e9}.get((m.group(2) or m.group(4) or "").lower(), 1)
            try: v = float(re.search(r"\d[\d,.]*", t).group(0).replace(",", "").rstrip(".")) * mult
            except ValueError: continue
            cands.append((v, t[:60].rstrip(".")))
    if cands: return max(cands)[1]                   # the biggest figure in the coverage, not the first price
    return f"{len(inc['outlets'])} outlets, {len(rs)} items"

def llm_rewrite(incs, frm, to):
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key or os.environ.get("RSR_NO_LLM"): return 0
    model = os.environ.get("RSR_MODEL", "claude-sonnet-5-5")
    done = 0
    for inc in incs[:40]:
        ev = "\n".join(f"- [{r['ch']}] {r['date']} {r['outlet']}: {r['title'][:160]} :: {r['text'][:200]}" for r in inc["recs"][:8])
        prompt = (f"You write one-paragraph incident summaries for a retail-security monthly report covering {frm} to {to}. Use ONLY the evidence lines below; do not add facts, numbers or names that are not in them. "
                  f"If the evidence is a leak-site listing or an unconfirmed press report, say so. 2-3 sentences, plain English, no markdown.\n\nIncident: {inc['name']} ({inc['type']}, {CC_NAME.get(inc['country'], inc['country'])}, status {inc['status']})\nEvidence:\n{ev}")
        body = json.dumps({"model": model, "max_tokens": 300, "messages": [{"role": "user", "content": prompt}]}).encode()
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                out = json.load(resp)
            txt = " ".join(b.get("text", "") for b in out.get("content", []) if b.get("type") == "text").strip()
            if 40 < len(txt) < 900: inc["summary"] = txt; inc["summary_by"] = model; done += 1
        except Exception as e:
            log("llm skipped:", type(e).__name__, str(e)[:120]); break
    return done

# ---------- stats & quotes ----------
def stats_of(recs_all, rel, incs, frm, to):
    by_day = collections.Counter(r["date"] for r in rel if r["ch"] in NEWS)
    days = []; d = dt.date.fromisoformat(frm)
    while d <= dt.date.fromisoformat(to): days.append(d.isoformat()); d += dt.timedelta(days=1)
    themes = collections.Counter(i["theme"] for i in incs)
    cats = collections.Counter(i["cat"] for i in incs)
    by_cc = collections.Counter(i["country"] for i in incs if i["country"] != "XX")
    by_region = collections.Counter(i["region"] for i in incs)
    outlets = collections.Counter()
    for r in rel:
        if r["ch"] in NEWS:
            for o in r.get("outlets", []): outlets[o] += 1
    rl = [r for r in recs_all if r["ch"] == "ransomware_live"]
    rl_groups = collections.Counter(r.get("group") for r in rl); rl_cc = collections.Counter(r.get("cc") or "XX" for r in rl)
    hibp = [r for r in recs_all if r["ch"] == "hibp"]
    social = collections.Counter(r["ch"] for r in rel if r["ch"] in SOCIAL)
    langs = collections.Counter(("ar" if re.search(r"[؀-ۿ]", r["title"]) else "en") for r in rel if r["ch"] in NEWS)
    return dict(days=[(d, by_day.get(d, 0)) for d in days], news_total=sum(by_day.values()), themes=[(THEME_LABEL[k], v) for k, v in themes.most_common()], cats=[(CAT[k][0], v) for k, v in cats.most_common()],
                countries=[(CC_NAME.get(k, k), v) for k, v in by_cc.most_common(14)], regions=[(k, v) for k, v in by_region.most_common()], outlets=outlets.most_common(12),
                leak_groups=rl_groups.most_common(10), leak_countries=[(CC_NAME.get(k, k), v) for k, v in rl_cc.most_common(10)], leak_total=len(rl),
                hibp=[dict(name=r["title"].split(" breach (")[0], pwn=r.get("pwn", 0), date=r["date"], classes=r.get("classes", [])[:6], url=r["url"]) for r in sorted(hibp, key=lambda x: -x.get("pwn", 0))], hibp_total=len(hibp), hibp_accounts=sum(r.get("pwn", 0) for r in hibp),
                social=social.most_common(), social_total=sum(social.values()), kinds=dict(collections.Counter(i["kind"] for i in incs)), langs=dict(langs), status=dict(collections.Counter(i["status"] for i in incs)), sev=dict(collections.Counter(i["sev"] for i in incs)))
def quotes_of(rel, n=8):
    qs = []
    for r in sorted((r for r in rel if r["ch"] in SOCIAL and len(r["text"] or r["title"]) > 40), key=lambda x: -x.get("eng", 0)):
        txt = (r["text"] or r["title"]).strip(); txt = re.sub(r"\s+", " ", txt)
        if len(txt) > 280: txt = txt[:277].rsplit(" ", 1)[0] + "…"
        if not RE_RETAIL.search(txt) or not RE_SEC.search(txt): continue
        if any(q["text"][:60] == txt[:60] for q in qs): continue
        qs.append(dict(text=txt, who=r.get("author") or r["outlet"], where=r["outlet"], ch=r["ch"], url=r["url"], date=r["date"], eng=r.get("eng", 0)))
        if len(qs) >= n: break
    return qs

# ---------- output ----------
def build_sources(incs):
    sources = {}
    for inc in incs:
        keys = []
        for r in inc["recs"][:5]:
            if not r["url"]: continue
            k = slug(f"{r['outlet']}-{r['title']}", 40) + "-" + hashlib.sha1(r["url"].encode()).hexdigest()[:4]
            sources[k] = (r["title"][:140] or r["url"], r["url"], r["outlet"], r["date"]); keys.append(k)
        inc["src"] = keys
    return sources
def state_load():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f: return json.load(f)
    return {"baseline_end": BASELINE_END, "last_end": BASELINE_END, "runs": []}
def window_from_state(st):
    frm = (dt.date.fromisoformat(st.get("last_end") or st.get("baseline_end") or BASELINE_END) + dt.timedelta(days=1)).isoformat()
    return frm, dt.datetime.now(dt.timezone.utc).date().isoformat()
def run(frm, to, no_llm=False, dry=False, write_state=True):
    if not (valid_date(frm) and valid_date(to)): raise SystemExit(f"bad window {frm}..{to}")
    if frm > to: raise SystemExit(f"window start {frm} is after end {to}: nothing to report yet (last run already covered up to {frm})")
    pid = f"{frm}_{to}"; out = os.path.join(BUILD, "periods", pid); os.makedirs(out, exist_ok=True)
    log("window", frm, "..", to)
    recs, cov = load_window(frm, to)
    log("in window:", len(recs), "records;", {k: v["in_window"] for k, v in cov.items() if v["in_window"]})
    rel = dedupe([r for r in recs if relevant(r)])
    log("relevant after dedupe:", len(rel))
    incs = cluster(rel)
    for inc in incs: inc["summary"] = summarise(inc, frm, to); inc["summary_by"] = "rules"; inc["impact"] = impact_of(inc)
    if not no_llm: log("llm summaries:", llm_rewrite(incs, frm, to))
    sources = build_sources(incs)
    for i, inc in enumerate(incs, 1): inc["id"] = f"P{i:03d}"
    stats = stats_of(recs, rel, incs, frm, to)
    quotes = quotes_of(rel)
    inc_out = [{k: v for k, v in inc.items() if k != "recs"} | {"evidence": [dict(ch=r["ch"], date=r["date"], outlet=r["outlet"], title=r["title"][:200], url=r["url"]) for r in inc["recs"][:10]]} for inc in incs]
    period = dict(window=dict(frm=frm, to=to, id=pid, days=len(stats["days"])), generated_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), coverage=cov, counts=dict(in_window=len(recs), relevant=len(rel), incidents=len(incs)),
                  incidents=inc_out, sources=sources, stats=stats, quotes=quotes, theme_labels=THEME_LABEL, cc_names=CC_NAME)
    if dry: print(json.dumps({k: period[k] for k in ("window", "counts", "stats")}, indent=1, ensure_ascii=False)[:4000]); return period
    with open(os.path.join(out, "period.json"), "w", encoding="utf-8") as f: json.dump(period, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "candidates.md"), "w", encoding="utf-8") as f:
        f.write(f"# Period {frm} → {to}: {len(incs)} clusters from {len(rel)} relevant records ({len(recs)} in window)\n\n")
        for inc in incs:
            f.write(f"## {inc['id']} {inc['name']}  [{inc['type']} · {CC_NAME.get(inc['country'], inc['country'])} · sev {inc['sev']} · {inc['status']} · weight {inc['weight']}]\n{inc['summary']}\n\n")
            for r in inc["recs"][:10]: f.write(f"- {r['date']} [{r['ch']}] {r['outlet']}: {r['title'][:150]}  {r['url']}\n")
            f.write("\n")
    shots = []
    for inc in incs:
        for r in inc["recs"]:
            if r["ch"] in NEWS and r["url"].startswith("http") and "news.google.com" not in r["url"] and r["url"] not in [s["url"] for s in shots]:
                shots.append(dict(id=inc["id"], url=r["url"], title=r["title"][:120])); break
        if len(shots) >= 6: break
    with open(os.path.join(out, "shots.json"), "w", encoding="utf-8") as f: json.dump(shots, f, ensure_ascii=False, indent=1)
    if write_state:
        st = state_commit(pid, frm, to, dict(incidents=len(incs), relevant=len(rel), in_window=len(recs), finished_at=period["generated_at"]))
        log("wrote", out, "| incidents", len(incs), "| state last_end", st["last_end"])
    else: log("wrote", out, "| incidents", len(incs), "| state not advanced (--no-state)")
    return period
def state_commit(pid, frm, to, extra=None):
    """Record a finished period in build/state.json; the next default window starts the day after last_end."""
    st = state_load()
    st["runs"] = [r for r in st.get("runs", []) if r.get("id") != pid] + [dict(id=pid, frm=frm, to=to, **(extra or {}))]
    if to > (st.get("last_end") or ""): st["last_end"] = to
    st.setdefault("baseline_end", BASELINE_END)
    with open(STATE, "w", encoding="utf-8") as f: json.dump(st, f, indent=1)
    return st
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="frm", default=""); ap.add_argument("--to", default=""); ap.add_argument("--no-llm", action="store_true"); ap.add_argument("--dry", action="store_true")
    ap.add_argument("--no-state", action="store_true", help="do not advance build/state.json (the orchestrator commits it after the outputs exist)")
    ap.add_argument("--print-window", action="store_true", help="print the default window as JSON and exit")
    ap.add_argument("--commit-state", action="store_true", help="only record --from/--to in build/state.json and exit")
    a = ap.parse_args(argv)
    st = state_load(); dfrm, dto = window_from_state(st)
    if a.print_window: print(json.dumps(dict(frm=dfrm, to=dto, last_end=st.get("last_end"), runs=st.get("runs", []))), flush=True); return
    if a.commit_state:
        st = state_commit(f"{a.frm}_{a.to}", a.frm, a.to); print(json.dumps(dict(last_end=st["last_end"]))); return
    run(a.frm or dfrm, a.to or dto, no_llm=a.no_llm, dry=a.dry, write_state=not a.no_state)
if __name__ == "__main__": main()
