import re, time, sys
from curl_cffi import requests
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
     "Accept-Language": "en-US,en;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1"}
tests = [
 ("old-search-html", "https://old.reddit.com/search?q=retail+data+breach&sort=new&t=year"),
 ("old-sub-new", "https://old.reddit.com/r/LossPrevention/new/"),
 ("www-search-html", "https://www.reddit.com/search/?q=retail+data+breach&sort=new&t=year"),
 ("www-sub-rss", "https://www.reddit.com/r/LossPrevention/new/.rss"),
 ("www-search-rss", "https://www.reddit.com/search.rss?q=retail+data+breach&sort=new&t=year"),
 ("old-search-rss", "https://old.reddit.com/search.rss?q=retail+data+breach&sort=new&t=year"),
 ("www-search-json", "https://www.reddit.com/search.json?q=retail+data+breach&sort=new&t=year&limit=100"),
 ("old-sub-json", "https://old.reddit.com/r/LossPrevention/new.json?limit=100"),
]
s = requests.Session(impersonate="chrome")
for name, url in tests:
    try:
        r = s.get(url, headers=H, timeout=30, allow_redirects=True)
        body = r.text; head = body.lstrip()[:300]
        kind = "json" if head.startswith("{") else ("xml" if head.startswith("<?xml") or "<feed" in head else "html")
        n = len(re.findall(r'data-fullname="t3_', body)) + len(re.findall(r'<shreddit-post', body)) + len(re.findall(r'<entry>', body)) + body.count('"kind": "t3"')
        t = re.search(r"<title>(.*?)</title>", body, re.S)
        print(name, r.status_code, kind, len(body), "posts~", n, "|", (t.group(1).strip()[:70] if t else head[:70].replace("\n"," ")), flush=True)
    except Exception as e:
        print(name, "ERR", e, flush=True)
    time.sleep(2)
