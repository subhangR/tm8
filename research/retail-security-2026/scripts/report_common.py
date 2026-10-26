"""Shared constants and icon helpers for the site and PDF builders."""
import html
E = html.escape
CAT = {
 "cyber": ("Cyber / data breach", "#38bdf8"), "ot": ("OT / IoT sabotage", "#fb7185"), "physical": ("Physical / loss prevention", "#f5b942"),
 "fraud": ("Fraud / scams", "#a3e635"), "geopolitical": ("Geopolitical", "#f97316"), "regulatory": ("Regulatory", "#a78bfa"),
 "enforcement": ("Law enforcement", "#2dd4bf"), "market": ("Market / vendors", "#94a3b8"),
}
COUNTRY = {"AE":"UAE","SA":"Saudi Arabia","QA":"Qatar","KW":"Kuwait","IL":"Israel","JO":"Jordan","EG":"Egypt","TR":"Türkiye","FR":"France","NL":"Netherlands","GB":"United Kingdom","SE":"Sweden","ES":"Spain","DE":"Germany","DK":"Denmark","CA":"Canada","US":"United States","KR":"South Korea","JP":"Japan","SG":"Singapore","PH":"Philippines","IN":"India","AU":"Australia","UZ":"Uzbekistan","ZA":"South Africa","CO":"Colombia","AR":"Argentina"}
REGION_ORDER = ["Middle East","Europe","North America","Asia-Pacific","Africa","Latin America"]
ICON = {
 "shield": '<path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3z"/>',
 "flame": '<path d="M12 2c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>',
 "lock": '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
 "bolt": '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
 "globe": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
 "gavel": '<path d="M3 21h8M14 4l6 6M10 8l6 6M4 20l8-8"/>',
 "cart": '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M2 3h3l3 12h11l2-8H6"/>',
 "truck": '<rect x="2" y="7" width="12" height="9"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/>',
 "eye": '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 "chip": '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
 "chart": '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
 "pin": '<path d="M12 22s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
}
CAT_ICON = {"cyber":"lock","ot":"flame","physical":"eye","fraud":"cart","geopolitical":"globe","regulatory":"gavel","enforcement":"shield","market":"chart"}
def icon(name, size=18, color="currentColor"):
    return f'<svg class="ic" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICON[name]}</svg>'

