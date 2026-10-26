import json, sys, time
from curl_cffi import requests
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"}
def probe(name, url, **kw):
    t=time.time()
    try:
        r = requests.get(url, impersonate="chrome", timeout=25, headers=UA, **kw)
        body = r.text
        print(f"{name:14s} HTTP {r.status_code} {len(body):7d}B {time.time()-t:4.1f}s :: {body[:160]!r}")
    except Exception as e:
        print(f"{name:14s} ERR {type(e).__name__}: {e}")
probe("reddit-json", "https://www.reddit.com/r/cybersecurity/search.json?q=retail%20breach&restrict_sr=1&sort=new&t=year&limit=5")
probe("old-reddit", "https://old.reddit.com/r/LossPrevention/new.json?limit=3")
probe("gnews-rss", "https://news.google.com/rss/search?q=retail+data+breach+2026&hl=en-US&gl=US&ceid=US:en")
probe("bing-news", "https://www.bing.com/news/search?q=retail+data+breach+2026&format=rss")
probe("hn-algolia", "https://hn.algolia.com/api/v1/search_by_date?query=retail%20breach&tags=story&numericFilters=created_at_i>1767225600")
probe("ransomware.live", "https://api.ransomware.live/v2/countryvictims/AE")
probe("hibp", "https://haveibeenpwned.com/api/v3/breaches")
probe("bluesky", "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=retail%20ransomware&limit=5&sort=latest")
probe("mastodon-tag", "https://infosec.exchange/api/v1/timelines/tag/ransomware?limit=3")
probe("youtube", "https://www.youtube.com/results?search_query=retail+cyber+attack+2026")
probe("ddg-html", "https://html.duckduckgo.com/html/?q=retail+data+breach+2026")
