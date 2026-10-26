"""Decode a world-atlas TopoJSON (countries-110m / land-110m) into plain lon/lat polygons for the canvas globe.
Output: build/geo.json = {"countries":[{"id":"...","name":"...","rings":[[[lon,lat],...],...]}], "land":[rings...]}
Rings are simplified by a tolerance to keep the HTML small."""
import json, sys, os
src = sys.argv[1]; out = sys.argv[2]; tol = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
topo = json.load(open(src))
tr = topo.get("transform"); sc = tr["scale"] if tr else [1, 1]; tl = tr["translate"] if tr else [0, 0]
arcs = []
for arc in topo["arcs"]:
    x = y = 0; pts = []
    for dx, dy in arc:
        x += dx; y += dy
        pts.append((round(x * sc[0] + tl[0], 3), round(y * sc[1] + tl[1], 3)))
    arcs.append(pts)
def ring(arc_ids):
    pts = []
    for a in arc_ids:
        seg = arcs[a] if a >= 0 else list(reversed(arcs[~a]))
        if pts and pts[-1] == seg[0]: seg = seg[1:]
        pts.extend(seg)
    return pts
def rdp(pts, eps):
    if eps <= 0 or len(pts) < 5: return pts
    # iterative Douglas-Peucker
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        if e <= s + 1: continue
        (x1, y1), (x2, y2) = pts[s], pts[e]
        dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(s + 1, e):
            px, py = pts[i]
            if L2 == 0: d = ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5
            else:
                t = max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / L2))
                d = ((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2) ** 0.5
            if d > best: best, bi = d, i
        if best > eps:
            keep[bi] = True; stack.append((s, bi)); stack.append((bi, e))
    return [p for p, k in zip(pts, keep) if k]
def geom_rings(g):
    if g["type"] == "Polygon": return [ring(r) for r in g["arcs"]]
    if g["type"] == "MultiPolygon": return [ring(r) for poly in g["arcs"] for r in poly]
    return []
res = {}
for name, obj in topo["objects"].items():
    items = []
    for g in obj["geometries"]:
        rings = [rdp(r, tol) for r in geom_rings(g)]
        rings = [r for r in rings if len(r) >= 4]
        items.append({"id": g.get("id"), "name": (g.get("properties") or {}).get("name"), "rings": rings})
    res[name] = items
json.dump(res, open(out, "w"), separators=(",", ":"))
n = sum(len(r) for it in res.get("countries", res.get("land", [])) for r in it["rings"])
print("wrote", out, os.path.getsize(out), "bytes;", "points:", n)
