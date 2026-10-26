"""Run the remaining collect.py phases (bluesky, mastodon, lemmy, youtube, bingweb x/linkedin, report queries) after the dead pullpush phase was skipped."""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import collect as c
log = c.log
log("collect2 start")

def _run():
    BS_Q = ["retail breach", "retailer hacked", "ransomware retail", "supermarket cyberattack", "ASOS breach", "shoplifting", "organized retail crime", "Scattered Spider",
            "ShinyHunters", "Magecart", "ecommerce fraud", "refrigeration hack supermarket", "Danfoss", "Coupang breach", "Canadian Tire", "M&S cyber", "Talabat leak",
            "UAE data breach", "Saudi data breach", "Dubai scam", "retail theft", "loss prevention", "self-checkout theft", "facial recognition retail", "agentic commerce fraud", "bot attacks retail",
            "Ahold Delhaize", "Albert Heijn cyber", "Intermarché", "Carhartt breach", "Under Armour breach", "Panera breach", "Hobbs Whistles Phase Eight", "H&M hack"]
    for q in BS_Q:
        try: log("bluesky", q, c.bluesky(q))
        except Exception as e: log("bluesky-err", q, repr(e))
    for tag in ["ransomware", "databreach", "cybersecurity", "infosec", "retail", "cybercrime", "shoplifting", "fraud", "threatintel"]:
        for inst in ["mastodon.social", "fosstodon.org", "mstdn.social"]:
            try: log("mastodon", tag, inst, c.mastodon(tag, inst))
            except Exception as e: log("mastodon-err", tag, inst, repr(e))
    for q in ["retail breach", "retailer hacked", "ransomware retail", "shoplifting", "supermarket hack", "ASOS", "ecommerce fraud", "self checkout", "data breach customers", "Coupang", "Canadian Tire", "facial recognition store"]:
        try: log("lemmy", q, c.lemmy(q))
        except Exception as e: log("lemmy-err", q, repr(e))
    YT_Q = ["retail cyber attack 2026", "retail data breach 2026", "ransomware retailer 2026", "shoplifting 2026", "organized retail crime 2026", "loss prevention 2026", "retail security 2026",
            "French supermarket fridge hack", "ASOS data breach", "self checkout theft 2026", "retail fraud 2026", "Dubai scam 2026 shopping", "Saudi cyber attack 2026", "UAE cyber attack 2026",
            "GISEC 2026", "Intersec 2026", "retail theft caught camera 2026", "Scattered Spider 2026", "ShinyHunters 2026", "Middle East retail security 2026", "ecommerce fraud 2026", "AI agents shopping fraud 2026",
            "Black Hat MEA 2026", "retail cybersecurity CISO 2026", "mall security 2026", "Lulu hypermarket 2026", "Talabat hack", "retail robbery 2026", "gift card scam 2026", "NRF retail theft 2026",
            "Albert Heijn cyberaanval", "Intermarché cyberattaque frigo", "Ahold Delhaize cyber attack"]
    for q in YT_Q:
        try: log("youtube", q, c.youtube(q))
        except Exception as e: log("youtube-err", q, repr(e))
    XQ = ["retail data breach 2026", "retailer hacked 2026", "ransomware retail 2026", "supermarket cyberattack fridge", "ASOS breach", "shoplifting 2026", "organized retail crime 2026",
          "Scattered Spider 2026", "ShinyHunters 2026", "Talabat leak", "UAE data breach 2026", "Saudi data breach 2026", "Dubai scam shopping 2026", "retail theft 2026", "loss prevention 2026",
          "self-checkout theft 2026", "ecommerce fraud 2026", "Coupang breach", "Canadian Tire breach", "M&S cyber attack 2026", "GISEC 2026", "Intersec 2026", "retail security Middle East 2026",
          "Carrefour cyber", "Lulu data", "noon.com breach", "Saudi NCA alert 2026", "UAE Cybersecurity Council 2026 retail", "Magecart 2026", "gift card fraud 2026", "Ahold Delhaize cyber", "Albert Heijn hack", "Intermarché cyberattaque"]
    for q in XQ:
        for tag, pat in (("bingweb-x", "site:x.com {q}"), ("bingweb-li", "site:linkedin.com/posts {q}"), ("bingweb-li2", "site:linkedin.com/pulse {q}")):
            try: log(tag, q, c.bingweb(pat.format(q=q), 1))
            except Exception as e: log(tag + "-err", q, repr(e))
    for q in ["retail security report 2026", "retail cyber threat report 2026", "Middle East retail cyber 2026", "GCC retail data breach 2026", "retail ransomware 2026 report", "retail fraud 2026 report",
              "organized retail crime 2026 report", "shoplifting statistics 2026", "retail security survey 2026", "UAE retail cybersecurity 2026", "Saudi retail cybersecurity 2026", "retail loss prevention 2026 trends",
              "retail physical security 2026 trends", "retail security technology 2026", "retail breach 2026 list", "ecommerce fraud 2026 statistics", "Middle East cyber threat report 2026", "Gulf cyber attacks 2026 report"]:
        try: log("bingweb", q, c.bingweb(q, 2)); log("ddg", q, c.ddg(q))
        except Exception as e: log("web-err", q, repr(e))
    log("collect2 done", json.dumps(c.STATS))


try: _run()
except c.Budget as b:
    log("PARTIAL:", str(b), "- the channels after this point were not collected this run;", json.dumps(c.STATS))
