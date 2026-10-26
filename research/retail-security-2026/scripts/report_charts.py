# Inline-SVG chart helpers shared by the HTML artifact and the PDF. Pure functions returning SVG strings.
from html import escape as esc

def _lighten(hexc, f=0.35):
    r,g,b=int(hexc[1:3],16),int(hexc[3:5],16),int(hexc[5:7],16)
    r=int(r+(255-r)*f); g=int(g+(255-g)*f); b=int(b+(255-b)*f)
    return f"#{r:02x}{g:02x}{b:02x}"
def _darken(hexc, f=0.35):
    r,g,b=int(hexc[1:3],16),int(hexc[3:5],16),int(hexc[5:7],16)
    r=int(r*(1-f)); g=int(g*(1-f)); b=int(b*(1-f))
    return f"#{r:02x}{g:02x}{b:02x}"
def _fmt(v):
    if isinstance(v,float): return f"{v:,.1f}"
    if v>=1000: return f"{v:,}"
    return str(v)

def iso_bars(items, w=760, h=280, depth=14, color="#38bdf8", colors=None, unit="", max_val=None, fmt=_fmt, label_size=11, title="", dark=True):
    """items: [(label, value)] -> isometric 3D bar chart SVG."""
    n=len(items); 
    if n==0: return ""
    mv = max_val or max(v for _,v in items) or 1
    pad_l, pad_r, pad_t, pad_b = 16, 46, 36 if title else 26, 46
    cw = w - pad_l - pad_r - depth
    slot = cw / n; bw = slot*0.62
    base_y = h - pad_b
    plot_h = base_y - pad_t - depth
    txt = "#e5e7eb" if dark else "#111827"; sub = "#9ca3af" if dark else "#4b5563"; grid = "rgba(148,163,184,0.18)" if dark else "rgba(17,24,39,0.12)"
    out=[f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="{esc(title)}" xmlns="http://www.w3.org/2000/svg" style="font-family:Inter,system-ui,sans-serif">']
    if title: out.append(f'<text x="{pad_l}" y="18" fill="{txt}" font-size="13" font-weight="600">{esc(title)}</text>')
    # floor
    out.append(f'<polygon points="{pad_l},{base_y} {pad_l+depth},{base_y-depth} {w-pad_r+depth},{base_y-depth} {w-pad_r},{base_y}" fill="{grid}"/>')
    for i in range(1,5):
        gy = base_y - plot_h*i/4
        out.append(f'<line x1="{pad_l+depth}" y1="{gy-depth:.1f}" x2="{w-pad_r+depth}" y2="{gy-depth:.1f}" stroke="{grid}" stroke-width="1"/>')
        out.append(f'<text x="{w-pad_r+depth+2}" y="{gy-depth+4:.1f}" fill="{sub}" font-size="9">{fmt(mv*i/4) if isinstance(mv,float) else fmt(round(mv*i/4))}</text>')
    for i,(lab,v) in enumerate(items):
        c = (colors[i] if colors else color)
        x = pad_l + i*slot + (slot-bw)/2
        bh = max(0.0, plot_h * (v/mv))
        y = base_y - bh
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{bh:.1f}" fill="{c}" rx="1"/>')
        out.append(f'<polygon points="{x:.1f},{y:.1f} {x+depth:.1f},{y-depth:.1f} {x+bw+depth:.1f},{y-depth:.1f} {x+bw:.1f},{y:.1f}" fill="{_lighten(c,0.38)}"/>')
        out.append(f'<polygon points="{x+bw:.1f},{y:.1f} {x+bw+depth:.1f},{y-depth:.1f} {x+bw+depth:.1f},{base_y-depth:.1f} {x+bw:.1f},{base_y:.1f}" fill="{_darken(c,0.38)}"/>')
        out.append(f'<text x="{x+bw/2+depth/2:.1f}" y="{y-depth-5:.1f}" fill="{txt}" font-size="10.5" font-weight="600" text-anchor="middle">{esc(fmt(v))}{esc(unit)}</text>')
        out.append(f'<text x="{x+bw/2:.1f}" y="{base_y+16}" fill="{sub}" font-size="{label_size}" text-anchor="middle">{esc(str(lab))}</text>')
    out.append('</svg>')
    return "".join(out)

def hbars(items, w=760, row_h=26, color="#f5b942", colors=None, max_val=None, fmt=_fmt, unit="", label_w=190, dark=True, title=""):
    """items: [(label, value)] -> horizontal bars with a 3D lip. Negative values draw left of a zero line."""
    n=len(items)
    if n==0: return ""
    mv = max_val or max(v for _,v in items) or 1
    mn = min(0, min(v for _,v in items))
    span = (mv - mn) or 1
    top = 26 if title else 8
    h = top + n*row_h + 8
    txt = "#e5e7eb" if dark else "#111827"; sub = "#9ca3af" if dark else "#4b5563"; grid="rgba(148,163,184,0.15)" if dark else "rgba(17,24,39,0.1)"
    bar_w = w - label_w - 70
    zx = label_w + bar_w * (-mn/span)
    out=[f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="{esc(title)}" xmlns="http://www.w3.org/2000/svg" style="font-family:Inter,system-ui,sans-serif">']
    if title: out.append(f'<text x="0" y="16" fill="{txt}" font-size="13" font-weight="600">{esc(title)}</text>')
    for i,(lab,v) in enumerate(items):
        c = colors[i] if colors else color
        y = top + i*row_h; bh = row_h*0.58
        bl = abs(bar_w * (v/span))
        bx = zx if v >= 0 else zx - bl
        out.append(f'<rect x="{label_w}" y="{y+4}" width="{bar_w}" height="{bh:.1f}" fill="{grid}" rx="2"/>')
        out.append(f'<rect x="{bx:.1f}" y="{y+4}" width="{bl:.1f}" height="{bh:.1f}" fill="{c}" rx="2"/>')
        out.append(f'<polygon points="{bx:.1f},{y+4} {bx+4:.1f},{y} {bx+bl+4:.1f},{y} {bx+bl:.1f},{y+4}" fill="{_lighten(c,0.4)}"/>')
        out.append(f'<text x="{label_w-8}" y="{y+4+bh*0.72:.1f}" fill="{txt}" font-size="11.5" text-anchor="end">{esc(str(lab))}</text>')
        tx = (zx + bl + 8) if v >= 0 else (zx + 8)
        out.append(f'<text x="{tx:.1f}" y="{y+4+bh*0.72:.1f}" fill="{sub}" font-size="11" font-weight="600">{esc(fmt(v))}{esc(unit)}</text>')
    if mn < 0:
        out.append(f'<line x1="{zx:.1f}" y1="{top}" x2="{zx:.1f}" y2="{h-6}" stroke="{sub}" stroke-width="1" stroke-dasharray="3,3"/>')
    out.append('</svg>')
    return "".join(out)

def grouped_iso(groups, series, colors, w=760, h=300, depth=10, unit="%", title="", dark=True, max_val=None):
    """groups: [(group_label, [v_series1, v_series2,...])]; series: names."""
    g=len(groups); s=len(series)
    mv = max_val or max(v for _,vs in groups for v in vs) or 1
    pad_l,pad_r,pad_t,pad_b = 16,24,58,46
    cw = w-pad_l-pad_r-depth; slot = cw/g; bw = slot*0.8/s
    base_y = h-pad_b; plot_h = base_y-pad_t-depth
    txt="#e5e7eb" if dark else "#111827"; sub="#9ca3af" if dark else "#4b5563"; grid="rgba(148,163,184,0.18)" if dark else "rgba(17,24,39,0.12)"
    out=[f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="{esc(title)}" xmlns="http://www.w3.org/2000/svg" style="font-family:Inter,system-ui,sans-serif">']
    if title: out.append(f'<text x="{pad_l}" y="18" fill="{txt}" font-size="13" font-weight="600">{esc(title)}</text>')
    lx = pad_l
    for j,name in enumerate(series):
        out.append(f'<rect x="{lx}" y="26" width="10" height="10" fill="{colors[j]}"/><text x="{lx+14}" y="35" fill="{sub}" font-size="10.5">{esc(name)}</text>')
        lx += 14 + 7*len(name) + 18
    out.append(f'<polygon points="{pad_l},{base_y} {pad_l+depth},{base_y-depth} {w-pad_r+depth},{base_y-depth} {w-pad_r},{base_y}" fill="{grid}"/>')
    for gi,(gl,vs) in enumerate(groups):
        for j,v in enumerate(vs):
            c=colors[j]; x = pad_l + gi*slot + slot*0.1 + j*bw
            bh = plot_h*(v/mv); y = base_y-bh
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw-2:.1f}" height="{bh:.1f}" fill="{c}"/>')
            out.append(f'<polygon points="{x:.1f},{y:.1f} {x+depth:.1f},{y-depth:.1f} {x+bw-2+depth:.1f},{y-depth:.1f} {x+bw-2:.1f},{y:.1f}" fill="{_lighten(c,0.38)}"/>')
            out.append(f'<polygon points="{x+bw-2:.1f},{y:.1f} {x+bw-2+depth:.1f},{y-depth:.1f} {x+bw-2+depth:.1f},{base_y-depth:.1f} {x+bw-2:.1f},{base_y:.1f}" fill="{_darken(c,0.38)}"/>')
            out.append(f'<text x="{x+(bw-2)/2+depth/2:.1f}" y="{y-depth-4:.1f}" fill="{txt}" font-size="9.5" text-anchor="middle">{v}{esc(unit)}</text>')
        out.append(f'<text x="{pad_l+gi*slot+slot/2:.1f}" y="{base_y+16}" fill="{sub}" font-size="11" text-anchor="middle">{esc(gl)}</text>')
    out.append('</svg>')
    return "".join(out)

def donut(parts, colors, w=220, title="", dark=True, unit="%"):
    """parts: [(label, value)] -> donut with legend."""
    import math
    total = sum(v for _,v in parts) or 1
    cx,cy,r,ri = 70,70,60,38
    txt="#e5e7eb" if dark else "#111827"; sub="#9ca3af" if dark else "#4b5563"
    out=[f'<svg viewBox="0 0 {w} 150" width="100%" xmlns="http://www.w3.org/2000/svg" style="font-family:Inter,system-ui,sans-serif" role="img" aria-label="{esc(title)}">']
    a0=-math.pi/2
    for i,(lab,v) in enumerate(parts):
        a1 = a0 + 2*math.pi*v/total
        x0,y0 = cx+r*math.cos(a0), cy+r*math.sin(a0); x1,y1 = cx+r*math.cos(a1), cy+r*math.sin(a1)
        xi0,yi0 = cx+ri*math.cos(a1), cy+ri*math.sin(a1); xi1,yi1 = cx+ri*math.cos(a0), cy+ri*math.sin(a0)
        large = 1 if (a1-a0)>math.pi else 0
        out.append(f'<path d="M{x0:.1f},{y0:.1f} A{r},{r} 0 {large} 1 {x1:.1f},{y1:.1f} L{xi0:.1f},{yi0:.1f} A{ri},{ri} 0 {large} 0 {xi1:.1f},{yi1:.1f} Z" fill="{colors[i%len(colors)]}"/>')
        out.append(f'<rect x="150" y="{28+i*22}" width="10" height="10" fill="{colors[i%len(colors)]}"/><text x="165" y="{37+i*22}" fill="{sub}" font-size="10.5">{esc(lab)} {v}{esc(unit)}</text>')
        a0=a1
    if title: out.append(f'<text x="{cx}" y="{cy+4}" fill="{txt}" font-size="11" font-weight="700" text-anchor="middle">{esc(title)}</text>')
    out.append('</svg>')
    return "".join(out)
