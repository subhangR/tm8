import json, time
from curl_cffi import requests
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Accept": "application/json, text/xml;q=0.9, */*;q=0.8"}
def probe(name, url, imp="chrome", headers=UA):
    t=time.time()
    try:
        r = requests.get(url, impersonate=imp, timeout=25, headers=headers)
        body = r.text
        print(f"{name:16s} HTTP {r.status_code} {len(body):7d}B {time.time()-t:4.1f}s :: {body[:140]!r}")
    except Exception as e:
        print(f"{name:16s} ERR {type(e).__name__}: {e}")
probe("old-sub-json", "https://old.reddit.com/r/cybersecurity/new.json?limit=3")
probe("old-search-json", "https://old.reddit.com/search.json?q=retail+data+breach&sort=new&t=year&limit=5")
probe("old-search-rss", "https://old.reddit.com/search.rss?q=retail+data+breach&sort=new&t=year&limit=5")
probe("www-search-rss", "https://www.reddit.com/r/cybersecurity/search.rss?q=retail+breach&restrict_sr=1&sort=new&t=year")
probe("reddit-noimp", "https://www.reddit.com/r/cybersecurity/search.json?q=retail%20breach&restrict_sr=1&sort=new&t=year&limit=5", imp=None, headers={"User-Agent":"tm8-research/0.1 (public read-only; contact via tm8)"})
probe("old-noimp", "https://old.reddit.com/search.json?q=retail+data+breach&sort=new&t=year&limit=5", imp=None, headers={"User-Agent":"tm8-research/0.1 (public read-only)"})
probe("bsky-api", "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=retail%20ransomware&limit=5&sort=latest")
probe("bsky-noimp", "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=retail%20ransomware&limit=5&sort=latest", imp=None, headers={"User-Agent":"tm8-research/0.1"})
probe("mastodon.social", "https://mastodon.social/api/v1/timelines/tag/ransomware?limit=3")
probe("ioc.exchange", "https://ioc.exchange/api/v1/timelines/tag/ransomware?limit=3")
probe("rl-sector", "https://api.ransomware.live/v2/sectorvictims/Retail")
probe("rl-search", "https://api.ransomware.live/v2/searchvictims/retail")
probe("rl-recent", "https://api.ransomware.live/v2/recentvictims")
probe("gnews-ae", "https://news.google.com/rss/search?q=%D8%A7%D8%AE%D8%AA%D8%B1%D8%A7%D9%82+%D8%A8%D9%8A%D8%A7%D9%86%D8%A7%D8%AA+%D9%85%D8%AA%D8%AC%D8%B1&hl=ar&gl=SA&ceid=SA:ar")
probe("lemmy", "https://lemmy.world/api/v3/search?q=retail%20breach&type_=Posts&sort=New&limit=5")
