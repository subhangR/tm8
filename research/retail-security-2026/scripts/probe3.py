import time
from curl_cffi import requests
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"}
def probe(name, url, imp="chrome", headers=UA):
    t=time.time()
    try:
        r = requests.get(url, impersonate=imp, timeout=25, headers=headers)
        body = r.text
        print(f"{name:16s} HTTP {r.status_code} {len(body):7d}B {time.time()-t:4.1f}s :: {body[:150]!r}")
    except Exception as e:
        print(f"{name:16s} ERR {type(e).__name__}: {e}")
probe("pullpush", "https://api.pullpush.io/reddit/search/submission/?q=retail%20breach&after=1767225600&size=5&sort=desc")
probe("arctic-shift", "https://arctic-shift.photon-reddit.com/api/posts/search?query=retail%20breach&after=2026-01-01&limit=5")
probe("redlib-catsarch", "https://redlib.catsarch.com/r/cybersecurity/search?q=retail+breach&restrict_sr=on&sort=new&t=year")
probe("safereddit", "https://safereddit.com/r/cybersecurity/search?q=retail+breach&restrict_sr=on&sort=new&t=year")
probe("fxtwitter", "https://api.fxtwitter.com/CyberPulse56/status/2110538761352450247")
probe("ddg-x", "https://html.duckduckgo.com/html/?q=site%3Ax.com+retail+data+breach+2026")
probe("ddg-li", "https://html.duckduckgo.com/html/?q=site%3Alinkedin.com%2Fposts+retail+cyber+attack+2026")
probe("bing-web", "https://www.bing.com/search?q=site%3Alinkedin.com%2Fposts+retail+cyber+attack+2026&count=30")
probe("linkedin-pulse", "https://www.linkedin.com/pulse/topics/home/")
probe("telegram-s", "https://t.me/s/ransomwarelive")
