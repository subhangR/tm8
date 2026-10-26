import sys, time
from playwright.sync_api import sync_playwright
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
    ctx = b.new_context(user_agent=UA, viewport={"width": 1280, "height": 900}, locale="en-US")
    pg = ctx.new_page()
    for url in ["https://old.reddit.com/search?q=retail+data+breach&sort=new&t=year", "https://www.reddit.com/search/?q=retail+data+breach&sort=new&t=year"]:
        try:
            resp = pg.goto(url, wait_until="domcontentloaded", timeout=60000); time.sleep(4)
            html = pg.content()
            print(url, resp.status if resp else None, len(html), "t3:", html.count('data-fullname="t3_'), "shreddit:", html.count("<shreddit-post"), "title:", pg.title()[:60], flush=True)
        except Exception as e:
            print(url, "ERR", str(e)[:200], flush=True)
    pg.screenshot(path="build/pw_reddit_test.png", full_page=False)
    b.close()
print("playwright ok")
