# Quantitative evidence for the 2026 retail security report. Every block names its source key (see report_sources.SOURCES).
DBIR = {
  "src": ["dbir-retail", "dbir-full"],
  "edition": "19th edition; >31,000 incidents, >22,000 breaches, 145 countries; data window Oct 2024 - Nov 2025",
  "retail_incidents": 997, "retail_breaches": 806,
  "retail_breaches_note": "Breaches in retail nearly doubled year on year",
  "patterns": [("System Intrusion", 61, 53, 36), ("Social Engineering", 17, 18, 25), ("Basic Web Application Attacks", 10, 17, 22)],
  "patterns_share": 95,
  "actors": {"External": 99, "Internal": 1},
  "motives": {"Financial": 85, "Espionage": 19}, "espionage_prev": 9,
  "data_compromised": {"Internal": 84, "Credentials": 26, "Secrets": 20, "Other": 14}, "internal_prev": 65,
  "initial_access_retail": {"Vulnerability exploitation": 42, "Credential abuse": 14, "Phishing": 9},
  "third_party_retail": 68, "human_element_retail": 58,
  "global": {"vuln_exploitation": 31, "cred_abuse": 13, "kev_remediated": 26, "kev_remediated_prev": 38, "kev_median_days": 43, "kev_median_days_prev": 32,
             "ransomware_share": 48, "ransomware_share_prev": 44, "no_pay": 69, "median_ransom": 139875, "median_ransom_prev": 150000,
             "third_party": 48, "third_party_growth": 60, "human_element": 62, "social_engineering": 16, "phishing": 16, "pretexting": 6,
             "mobile_click_uplift": 40, "genai_median_techniques": 15, "genai_novel": 2.5, "shadow_ai_noncorp": 67, "shadow_ai_regular_users": 45, "shadow_ai_prev": 15},
}
IBM = {"src": ["ibm-me", "ibm-sa", "wam-ibm"], "me_avg_cost_usd_m": 8.0, "me_lost_business_m": 3.57, "me_financial_sector_m": 10.67,
       "me_phishing_share": 18, "me_phishing_cost_m": 10.41, "me_supply_chain_share": 16, "me_ai_enabled_share": 26,
       "me_soc_ai_agents": 55, "me_raising_spend": 59, "global_avg_m": 4.99, "us_avg_m": 11.5, "saudi_avg_sar_m": 27}
AKAMAI = {"src": ["akamai-pr", "akamai-report"], "commerce_ai_bot_share": 47.9, "monitor_only": 90, "api_attack_growth": 9,
          "commerce_api_incident": 85, "l7_ddos_trillion": 3, "retail_ddos_share": 84, "phishing_per_day_from": 56600, "phishing_per_day_to": 134600}
RANSOMWARE = {"src": ["comparitech-h1", "grit-q3", "infosec-q3", "blackkite", "cisa-gunra"],
  "h1_attacks": 4217, "h1_growth": 13.8, "h1_retail": 326, "h1_retail_growth": 28, "h1_groups": [("Qilin", 641), ("The Gentlemen", 464), ("Akira", 317)],
  "h1_median_demand": 150000, "h1_avg_demand": 1360000,
  "q3_record": 2627, "q3_yoy": 61, "grit_q3": 2760, "grit_actors": 112, "retail_q3": 199, "retail_q3_qoq": 29, "retail_q3_yoy": 97, "aug_record": 997,
  "blackkite_victims": 7551, "blackkite_growth": 24.9, "sophos_paid": 48, "sophos_retail_paid": 32}
# ransomware.live retail + Middle East listings collected 2026-01-01..2026-10-16 (own collection, raw/ransomware_live.jsonl)
RL = {"src": ["ransomwarelive"], "total": 607,
  "by_country": [("TR", 99), ("US", 96), ("AE", 66), ("IL", 38), ("EG", 36), ("SA", 27), ("GB", 20), ("CA", 15), ("MA", 15), ("AU", 10), ("IR", 10), ("PK", 10), ("IN", 9), ("MX", 8), ("IT", 8), ("DE", 8), ("TH", 7), ("QA", 7), ("OM", 7), ("TW", 6), ("FR", 6), ("KW", 6)],
  "by_group": [("The Gentlemen", 71), ("DragonForce", 23), ("Akira", 18), ("INC Ransom", 17), ("Coinbase Cartel", 14), ("Payload", 7), ("Emperador", 6), ("Dark Project", 5), ("Everest", 5), ("M3RX", 5), ("WorldLeaks", 5)],
  "by_month": [("Jan", 39), ("Feb", 59), ("Mar", 69), ("Apr", 65), ("May", 62), ("Jun", 47), ("Jul", 81), ("Aug", 67), ("Sep", 61), ("Oct*", 57)],
  "note": "Leak-site claims, not confirmed breaches; 316 of 607 records carry no group tag; Oct covers 1-16 only."}
NEWS = {"unique_titles": 7124, "window": "2026-01-01 to 2026-10-16",
  "by_month": [("Jan", 343), ("Feb", 384), ("Mar", 624), ("Apr", 506), ("May", 506), ("Jun", 570), ("Jul", 855), ("Aug", 999), ("Sep", 931), ("Oct*", 1406)],
  "themes": [("Violence / robbery", 950), ("Data breach", 778), ("Fraud / scam", 592), ("Iran war / Hormuz", 358), ("Shoplifting / ORC", 336), ("OT / IoT (fridges)", 211), ("AI agents / bots", 151), ("Ransomware", 136), ("Third party", 134), ("Regulation / fines", 123), ("Cargo theft", 57)],
  "entities": [("Intermarché / fridges", 209), ("ASOS", 103), ("Coupang", 95), ("Target", 88), ("ShinyHunters", 70), ("Amazon", 59), ("Ahold Delhaize", 54), ("Walmart", 43), ("M&S", 31), ("TFG London", 29), ("Scattered Spider", 29), ("H&M", 25), ("7-Eleven", 24), ("Salesforce", 22), ("Qilin", 21), ("noon", 18), ("Home Depot", 16), ("Al-Futtaim", 16), ("Snowflake", 14), ("Shopify", 14), ("Shein / Temu", 14), ("Sainsbury's", 13), ("Tabby / Tamara", 13), ("Dior / LVMH", 12), ("Costco", 12)],
  "regions": [("Middle East", 1239), ("Asia-Pacific", 613), ("Europe", 596), ("North America", 426), ("Africa", 55), ("Latin America", 47)],
  "top_sources": [("Gulf News", 203), ("Gulf Business", 126), ("اليوم السابع", 116), ("Reuters", 92), ("Insurance Business", 72), ("BBC", 68), ("Cybernews", 67), ("BleepingComputer", 47), ("The Guardian", 46), ("CBS", 46), ("Khaleej Times", 44), ("Times of India", 44), ("CTV", 44), ("Arabian Business", 41)],
  "note": "Title mentions; Middle East count is inflated by UAE/KSA-scoped queries. Oct covers 1-16 only."}
NRF = {"src": ["nrf-pr", "nrf-report"], "shoplifting_change": -12.4, "merch_theft_change": -8.1, "repeat_offenders_up": 50, "orc_up": 40, "pushout_up": 37,
       "phone_scams": 69, "loyalty_fraud": 51, "gift_card_fraud": 42, "brc_incidents_per_day": 1600, "cargo_q2_usd_m": 304.6}
UAE = {"src": ["uae-800k", "uae-200k", "aviatrix-me", "ibm-me"], "daily_attacks_2026": 800000, "daily_attacks_2025": 200000, "aviatrix_from": "90k-200k", "aviatrix_to": "600k-800k"}
COVERAGE = [("Google News RSS (news titles, 2026)", 18073), ("Bing News RSS", 907), ("Unique 2026 news titles after de-dup", 7124), ("Reddit (public RSS, as a normal browser)", 2745), ("Bluesky", 2704), ("Mastodon (3 instances)", 2037), ("X / LinkedIn public pages via search engines", 1323), ("Hacker News", 389), ("YouTube", 488), ("Lemmy", 352), ("DuckDuckGo report search", 180), ("ransomware.live listings (retail + Middle East)", 607), ("Have I Been Pwned 2026 breaches", 110), ("Verizon DBIR 2026 Retail Snapshot (full text)", 1)]
HIBP_RETAIL = [  # (slug, name, breach date, added, accounts, note)
  ("UnderArmour", "Under Armour", "2026-01", "2026-01-21", 72742892, "Everest claim, 343 GB"),
  ("Panera", "Panera Bread", "2026-01", "2026-01-07", 5112502, "ShinyHunters; 14M records; help-desk vishing / Entra"),
  ("CarGurus", "CarGurus", "2026-02", "2026-02-14", 12461887, ""),
  ("CanadianTire", "Canadian Tire", "2025-10-02", "2026-02-25", 38306562, "~42M records; SportChek, Mark's, Party City; class action Jul 2026"),
  ("Odido", "Odido (NL telecom)", "2026-02", "2026-02-12", 6077025, "consumer adjacent"),
  ("Baydoner", "Baydöner (TR restaurant chain)", "2026-03", "2026-03-08", 1266822, ""),
  ("Crunchyroll", "Crunchyroll", "2026-03", "2026-03-12", 1195684, "Zendesk; 6.8M claimed"),
  ("Addi", "Addi (CO BNPL)", "2026-03", "2026-03-25", 34532941, ""),
  ("Hallmark", "Hallmark", "2026-03", "2026-03-31", 1736520, "Salesforce"),
  ("7Eleven", "7-Eleven", "2026-04", "2026-04-08", 185256, "ShinyHunters"),
  ("Mytheresa", "Mytheresa", "2026-04", "2026-04-12", 84108, ""),
  ("Zara", "Zara", "2026-04", "2026-04-15", 197376, "ShinyHunters"),
  ("ADT", "ADT", "2026-04", "2026-04-20", 5488888, "security vendor"),
  ("Aman", "Aman Resorts", "2026-04", "2026-04-20", 215563, "Salesforce"),
  ("GooseCreekCandle", "Goose Creek Candle", "2026-06", "2026-06-09", 6574121, ""),
  ("RalphLauren", "Ralph Lauren", "2026-06", "2026-06-11", 139903, "hundreds of GB claimed"),
  ("JCPenney", "JCPenney", "2026-06", "2026-06-12", 368418, "ShinyHunters; zero-day"),
  ("Sysco", "Sysco", "2026-06", "2026-06-15", 2691852, "food distribution"),
  ("InterConSecurity", "Inter-Con Security", "2026-06", "2026-06-18", 276114, "security vendor"),
  ("BrinksHome", "Brinks Home", "2026-07", "2026-07-13", 732162, "security vendor"),
  ("Carhartt", "Carhartt", "2026-08", "2026-08-13", 12933413, "ShinyHunters; $3.3M demand; 50M claim exaggerated"),
  ("OzHairAndBeauty", "Oz Hair and Beauty (AU)", "2026-08", "2026-08-15", 1988331, "xpl0itrs"),
]
MARKET = [  # (segment, scope, from, to, cagr, publisher, src)
  ("Physical security", "Middle East", "$6.19B (2025)", "$10.75B (2034)", "6.3%", "IMARC", "imarc-me"),
  ("Cybersecurity", "Middle East", "—", "$26.04B (2030s)", "—", "MarketsandMarkets", "mm-me"),
  ("Cybersecurity", "Saudi Arabia", "—", "$10.5B (2032)", "—", "GlobeNewswire / ResearchAndMarkets", "gnw-sa"),
  ("Retail loss-prevention intelligence", "Global", "+$1.64B 2025-2030", "", "14.4%", "Technavio", "technavio"),
  ("Retail security (software + hardware)", "Global", "$18.7B", "$46.2B (2035)", "9.5%", "MarketsandMarkets", "mm-retail"),
  ("Asset protection", "Global", "$7.45B", "$16.91B", "10.8%", "SkyQuest", "skyquest"),
]
