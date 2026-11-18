"""Build public/house.json (+ plan overlay PNGs) from the MagMar plan PDFs and data/house-config.json.

The plan PDFs are vector drawings: walls are outlined with bold 1.44 pt strokes. We polygonize those
outlines (closing small drafting gaps), cut the openings listed in the config, derive rooms as the
spaces enclosed by walls + openings, and compute the roof faces from the plane definitions.

Run:  .venv/bin/python -I tools/build_house.py
"""
import json, math, os, sys
from collections import Counter
import pymupdf
from PIL import Image
from shapely.geometry import LineString, MultiLineString, Polygon, Point, box, MultiPolygon
from shapely.ops import unary_union, polygonize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PT = 25.4 / 72 / 10            # metres per PDF point at 1:100 (0.0352778)
ORIGIN = (252.56, 223.92)      # ground-floor sheet point = model (0,0): top-left outer wall corner
WALL_STROKE = 1.44
GAP = 4.5                      # pt; dangling wall lines are extended up to this to close drafting gaps

cfg = json.load(open(os.path.join(ROOT, 'data', 'house-config.json')))


def to_m(x, y, off):
    return ((x - off[0] - ORIGIN[0]) * PT, (y - off[1] - ORIGIN[1]) * PT)


def extract_walls(pdf, off):
    page = pymupdf.open(pdf)[0]
    lines = []
    for d in page.get_drawings():
        if d.get('type') != 's' or abs((d.get('width') or 0) - WALL_STROKE) > 0.01:
            continue
        for it in d['items']:
            if it[0] == 'l':
                lines.append(((it[1].x, it[1].y), (it[2].x, it[2].y)))
            elif it[0] == 're':
                r = it[1]; p = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
                lines += [(p[i], p[(i + 1) % 4]) for i in range(4)]
    snap = lambda v: round(v / 0.12) * 0.12
    segs = [((snap(a[0]), snap(a[1])), (snap(b[0]), snap(b[1]))) for a, b in lines]
    segs = [s for s in segs if s[0] != s[1]]
    deg = Counter(p for s in segs for p in s)
    allgeom = MultiLineString([LineString(s) for s in segs])
    ext = []
    for a, b in segs:
        a2, b2 = list(a), list(b)
        L = math.dist(a, b); ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        for end, sign, tgt in ((b, 1, b2), (a, -1, a2)):
            if deg[end] > 1:
                continue
            probe = LineString([end, (end[0] + sign * ux * GAP, end[1] + sign * uy * GAP)])
            hit = probe.intersection(allgeom.difference(LineString([a, b]).buffer(0.01)))
            if not hit.is_empty:
                dmin = min(Point(end).distance(g) for g in getattr(hit, 'geoms', [hit]))
                tgt[0] += sign * ux * dmin; tgt[1] += sign * uy * dmin
        ext.append(LineString([a2, b2]))
    polys = [p for p in polygonize(unary_union(MultiLineString(ext))) if p.area > 1]
    out = []
    for p in polys:
        out.append(Polygon([to_m(x, y, off) for x, y in p.exterior.coords]))
    return out, page


def parts(g):
    if g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    return [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon) and not p.is_empty]


def ring(coords):
    c = [(round(x, 3), round(y, 3)) for x, y in coords]
    if c[0] == c[-1]: c = c[:-1]
    return c


def poly_json(p):
    p = p.simplify(0.002)
    return {'outer': ring(p.exterior.coords), 'holes': [ring(h.coords) for h in p.interiors]}


def rect(r): return box(*r)


# ---------------------------------------------------------------- roof
def roof_planes(part, k):
    """Return list of planes (a, b, c) with h = a*x + b*y + c; part height = min over planes."""
    if 'ridge' in part:
        r = part['ridge']
        if r['axis'] == 'y':   # ridge line y = at
            return [(0, k, r['z'] - k * r['at']), (0, -k, r['z'] + k * r['at'])]
        return [(k, 0, r['z'] - k * r['at']), (-k, 0, r['z'] + k * r['at'])]
    x0, y0, x1, y1 = part['rect']; e = part['hip']['eaveZ']; pl = []
    for edge in part['hip']['edges']:
        if edge == 'x0': pl.append((k, 0, e - k * x0))
        if edge == 'x1': pl.append((-k, 0, e + k * x1))
        if edge == 'y0': pl.append((0, k, e - k * y0))
        if edge == 'y1': pl.append((0, -k, e + k * y1))
    return pl


BIG = box(-50, -50, 50, 50)


def halfplane_le(p, q):
    """Region where plane p <= plane q  ->  (p-q)(x,y) <= 0, as a polygon clipped to BIG."""
    a, b, c = p[0] - q[0], p[1] - q[1], p[2] - q[2]
    if abs(a) < 1e-12 and abs(b) < 1e-12:
        return BIG if c <= 0 else Polygon()
    # sample BIG corners, clip polygon by the line a x + b y + c <= 0 (Sutherland-Hodgman)
    pts = list(BIG.exterior.coords)[:-1]
    f = lambda pt: a * pt[0] + b * pt[1] + c
    out = []
    for i in range(len(pts)):
        P, Q = pts[i], pts[(i + 1) % len(pts)]
        fp, fq = f(P), f(Q)
        if fp <= 0: out.append(P)
        if (fp < 0 < fq) or (fq < 0 < fp):
            t = fp / (fp - fq); out.append((P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])))
    return Polygon(out) if len(out) >= 3 else Polygon()


def build_roof(rc):
    k = rc['k']
    P = [(p, roof_planes(p, k), rect(p['rect'])) for p in rc['parts']]
    # core = each part limited to its wallRect (gables only over their bays); extra = gable rake overhang strips
    regions, extras = [], []  # (part_idx, plane, polygon)
    for i, (p, planes, fp) in enumerate(P):
        core = rect(p.get('wallRect', p['rect']))
        for pl in planes:
            reg = fp
            for q in planes:
                if q is not pl: reg = reg.intersection(halfplane_le(pl, q))
            if reg.is_empty or reg.area < 1e-6: continue
            c = reg.intersection(core)
            if c.area > 1e-6: regions.append((i, pl, c))
            e = reg.difference(core)
            if e.area > 1e-6: extras.append((i, pl, e))
    # holes for roof windows / hatch: rectangle aligned with the slope of the face under its centre
    items_out, holes = [], []
    for it in cfg.get('roofItems', []):
        cx, cy = it['center']
        # visible roof surface = highest plane among the regions containing the centre
        host = max((pl for i, pl, reg in regions if reg.contains(Point(cx, cy))),
                   key=lambda pl: pl[0] * cx + pl[1] * cy + pl[2])
        a, b, _ = host
        proj = it['l'] / math.sqrt(1 + k * k)          # plan length of the slope run
        if abs(a) > abs(b):   # slope runs along x
            r = [cx - proj / 2, cy - it['w'] / 2, cx + proj / 2, cy + it['w'] / 2]
        else:
            r = [cx - it['w'] / 2, cy - proj / 2, cx + it['w'] / 2, cy + proj / 2]
        holes.append(box(*r))
        items_out.append({**it, 'rect': [round(v, 4) for v in r], 'plane': [round(v, 5) for v in host]})
    hole_union = unary_union(holes) if holes else Polygon()

    faces = []
    for i, pl, reg in regions:
        vis = reg
        for j, ql, oreg in regions:
            if j == i: continue
            # other part strictly higher here -> hidden; ties broken by part index
            higher = halfplane_le(pl, ql) if j > i else halfplane_le(pl, (ql[0], ql[1], ql[2] - 1e-6))
            vis = vis.difference(oreg.intersection(higher))
        for piece in parts(vis.buffer(0).difference(hole_union)):
            if piece.area > 1e-4:
                faces.append({'plane': [round(v, 5) for v in pl], **poly_json(piece)})
    # rake overhangs: lie on top of the main roof, visible only where higher than the core roof below
    for i, pl, reg in extras:
        vis = reg
        for j, ql, oreg in regions:
            vis = vis.difference(oreg.intersection(halfplane_le(pl, (ql[0], ql[1], ql[2] + 0.02))))
        for piece in parts(vis.buffer(0)):
            if piece.area > 1e-3:
                faces.append({'plane': [round(v, 5) for v in pl], 'overhang': True, **poly_json(piece)})
    parts_out = [{'name': p['name'], 'rect': p['rect'], 'wallRect': p.get('wallRect', p['rect']), 'planes': [[round(v, 5) for v in pl] for pl in planes]}
                 for p, planes, _ in P]
    # vertical steps: where two faces share an edge but meet at different heights, the slot between them is open
    steps = []
    def H(pl, x, y): return pl[0] * x + pl[1] * y + pl[2]
    core_faces = [f for f in faces if not f.get('overhang')]
    for i, fa in enumerate(core_faces):
        ra = fa['outer']
        for a0, a1 in zip(ra, ra[1:] + ra[:1]):
            ea = LineString([a0, a1])
            if ea.length < 0.02: continue
            for j, fb in enumerate(core_faces):
                if j <= i: continue
                rb = fb['outer']
                for b0, b1 in zip(rb, rb[1:] + rb[:1]):
                    eb = LineString([b0, b1])
                    if eb.length < 0.02 or ea.distance(eb) > 0.005: continue
                    ov = ea.buffer(0.005, cap_style=2).intersection(eb)
                    if ov.is_empty or ov.length < 0.02: continue
                    (x0, y0), (x1, y1) = ov.coords[0], ov.coords[-1]
                    d0 = H(fa['plane'], x0, y0) - H(fb['plane'], x0, y0)
                    d1 = H(fa['plane'], x1, y1) - H(fb['plane'], x1, y1)
                    if max(abs(d0), abs(d1)) > 0.01:
                        steps.append({'p': [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
                                      'lo': [round(min(H(fa['plane'], x0, y0), H(fb['plane'], x0, y0)), 3), round(min(H(fa['plane'], x1, y1), H(fb['plane'], x1, y1)), 3)],
                                      'hi': [round(max(H(fa['plane'], x0, y0), H(fb['plane'], x0, y0)), 3), round(max(H(fa['plane'], x1, y1), H(fb['plane'], x1, y1)), 3)]})

    # rafters: lines running up the slope, every `spacing` across it, clipped to each face
    rf = rc.get('rafters', {'width': 0.08, 'depth': 0.2, 'spacing': 0.9, 'offset': 0.05})
    ch = cfg.get('chimney')
    block = box(*ch['rect']).buffer(0.05, join_style=2) if ch else Polygon()
    rafters, hips, seen = [], [], {}
    for f in faces:
        poly = Polygon(f['outer'], f['holes']).buffer(0).difference(block)
        a, b, _ = f['plane']
        x0, y0, x1, y1 = poly.bounds
        across_x = abs(a) < abs(b)       # slope runs along y -> rafters are lines x = const
        lo, hi = (x0, x1) if across_x else (y0, y1)
        v = math.floor((lo - rf['offset']) / rf['spacing']) * rf['spacing'] + rf['offset']
        while v <= hi:
            if v >= lo:
                line = LineString([(v, y0 - 1), (v, y1 + 1)]) if across_x else LineString([(x0 - 1, v), (x1 + 1, v)])
                inter = poly.intersection(line)
                for seg in getattr(inter, 'geoms', [inter]):
                    if isinstance(seg, LineString) and seg.length > 0.25:
                        (ax, ay), (bx, by) = seg.coords[0], seg.coords[-1]
                        rafters.append({'p': [round(ax, 3), round(ay, 3), round(bx, 3), round(by, 3)], 'plane': f['plane']})
            v += rf['spacing']
        # hips and valleys = diagonal edges of the faces (each shared by two faces)
        ring = f['outer']
        for i in range(len(ring)):
            (ax, ay), (bx, by) = ring[i], ring[(i + 1) % len(ring)]
            if abs(ax - bx) > 0.05 and abs(ay - by) > 0.05 and math.dist((ax, ay), (bx, by)) > 0.3:
                key = tuple(sorted([(round(ax, 2), round(ay, 2)), (round(bx, 2), round(by, 2))]))
                if key in seen:
                    seen[key]['planes'].append(f['plane'])
                else:
                    seen[key] = {'p': [ax, ay, bx, by], 'planes': [f['plane']]}
    hips = list(seen.values())

    # collar ties (jętki): pair up rafters of one ridge at a given height
    def roof_h(x, y):
        H = -1e9
        for p_, planes, fp in P:
            if fp.covers(Point(x, y)):
                H = max(H, min(a_ * x + b_ * y + c_ for a_, b_, c_ in planes))
        return H
    ties = []
    tc = rc.get('ties')
    for lvl in (tc['levels'] if tc else []):
        d = (lvl['ridgeZ'] - lvl['z']) / k              # half span at the tie underside
        along_y = lvl['ridgeAxis'] == 'y'               # ridge parallel to x -> rafters are x = const
        vs = set()
        for r in rafters:
            a_, b_, _ = r['plane']
            if along_y and abs(b_) > abs(a_) and abs(r['p'][0] - r['p'][2]) < 1e-6:
                vs.add(round(r['p'][0], 3))
            if not along_y and abs(a_) > abs(b_) and abs(r['p'][1] - r['p'][3]) < 1e-6:
                vs.add(round(r['p'][1], 3))
        for v in sorted(vs):
            e0 = (v, lvl['ridgeAt'] - d) if along_y else (lvl['ridgeAt'] - d, v)
            e1 = (v, lvl['ridgeAt'] + d) if along_y else (lvl['ridgeAt'] + d, v)
            # both ends must sit on this ridge's own slopes (not hidden under another roof part)
            if abs(roof_h(*e0) - lvl['z']) < 0.02 and abs(roof_h(*e1) - lvl['z']) < 0.02 \
               and abs(roof_h(*((e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2)) - lvl['ridgeZ']) < 0.05:
                ties.append({'p': [round(e0[0], 3), round(e0[1], 3), round(e1[0], 3), round(e1[1], 3)], 'z': lvl['z'], 'name': lvl['name']})
    return {'k': k, 'thickness': rc['thickness'], 'parts': parts_out, 'faces': faces, 'items': items_out,
            'rafter': rf, 'rafters': rafters, 'hips': hips, 'steps': steps, 'ties': ties, 'tie': {k_: v_ for k_, v_ in (tc or {}).items() if k_ != 'levels'}}


# ---------------------------------------------------------------- main
def main():
    plans = cfg['plansDir']
    out = {'levels': [], 'openings': cfg['openings'], 'stairs': cfg['stairs'], 'outside': cfg['outside'],
           'spawn': cfg['spawn'], 'site': cfg.get('site'), 'furniture': cfg.get('furniture', []), 'chimney': cfg.get('chimney'), 'beams': cfg.get('beams', []), 'julietColor': cfg.get('julietColor', '#7a7c7b'), 'steel': cfg.get('steel'), 'timberPosts': cfg.get('timberPosts'), 'hvac': cfg.get('hvac', [])}
    os.makedirs(os.path.join(ROOT, 'public', 'plans'), exist_ok=True)
    st = cfg['stairs']
    ground_spaces = []   # (polygon, ceiling z) of ground-floor rooms, filled by the first level
    stair_band = box(st['x0'], st['y0'], st['x0'] + st['tread'] * st['treads'], st['y1'])

    for lv in cfg['levels']:
        walls, page = extract_walls(os.path.join(plans, lv['pdf']), lv['sheetOffsetPt'])
        ops = [o for o in cfg['openings'] if o['level'] == lv['id']]
        op_union = unary_union([rect(o['rect']) for o in ops])
        wall_union = unary_union(walls)
        cut = wall_union.difference(op_union.buffer(0.001, join_style=2))

        wall_items = []
        extra_floor = []
        z0, z1 = lv['wallZ']
        for w in parts(cut):
            if lv['id'] == 'parter':
                # walls under the stair flight stop below the treads
                under = w.intersection(stair_band)
                rest = w.difference(stair_band)
                for p in parts(rest):
                    wall_items.append({'z0': z0, 'z1': z1, **poly_json(p)})
                for p in parts(under):
                    xmin = p.bounds[0]
                    i = max(0, int((xmin - st['x0']) / st['tread']))
                    top = (i + 1) * st['rise'] - 0.05
                    if top > 0.3:
                        wall_items.append({'z0': z0, 'z1': round(top, 3), **poly_json(p)})
                    else:  # under the lowest steps the wall is gone: the floor continues there
                        wall_items.append({'z0': z0, 'z1': -0.005, **poly_json(p)})
                        extra_floor.append(p)
            else:
                # Attic walls: over a ground-floor room the wall starts just above that room's ceiling
                # (so it never shows below it); over ground walls / outside it goes down to the slab edge.
                covered = Polygon()
                for sp, cz in ground_spaces:
                    part = w.intersection(sp)
                    covered = covered.union(sp)
                    for pp in parts(part):
                        if pp.area > 0.002:
                            wall_items.append({'z0': round(cz + 0.01, 3), 'z1': z1, **poly_json(pp)})
                for pp in parts(w.difference(covered)):
                    if pp.area > 0.002:
                        wall_items.append({'z0': z0, 'z1': z1, **poly_json(pp)})

        # rooms = holes of (walls + openings) ; footprint = its outer shell
        solid = unary_union([wall_union, op_union]).buffer(0.002, join_style=2).buffer(-0.002, join_style=2)
        shells = sorted(parts(solid), key=lambda p: -p.area)
        footprint = Polygon(shells[0].exterior)
        spaces = [Polygon(h) for h in shells[0].interiors if Polygon(h).area > 0.5]
        rooms = []
        for sp in spaces:
            labels = [r for r in lv['rooms'] if sp.contains(Point(r['at']))]
            if not labels:
                print(f"  [{lv['id']}] unlabeled space area={sp.area:.2f} at {sp.representative_point().coords[0]}")
                continue
            main_r = labels[0]
            stair_cut = rect(st['void']['rect'])
            if lv['id'] == 'parter':
                floor_g, ceil_g = sp, sp.difference(stair_cut)
            else:
                floor_g = sp.difference(unary_union([stair_cut, rect(st['landing']['rect']), rect(st['topStep']['rect'])]))
                ceil_g = Polygon()
            rooms.append({
                'floor': [poly_json(p) for p in parts(floor_g) if p.area > 0.01],
                'ceil': [poly_json(p) for p in parts(ceil_g) if p.area > 0.01],
                'ids': [r['id'] for r in labels],
                'labels': [{'id': r['id'], 'name': r['name'], 'area': r['area'], 'at': r['at']} for r in labels],
                'floorZ': main_r.get('floorZ', lv['floorZ']),
                'ceilZ': main_r.get('ceilZ', lv.get('ceilZ')),
                'slabBottomZ': main_r.get('slabBottomZ', lv.get('slabBottomZ')),
                **poly_json(sp)})
            print(f"  [{lv['id']}] room {'+'.join(r['id'] for r in labels):16s} area={sp.area:6.2f} m2 (plan: {sum(r['area'] for r in labels):.2f})")
        if lv['id'] == 'parter':
            ground_spaces = [(Polygon(rm['outer'], rm['holes']).buffer(0), rm['ceilZ']) for rm in rooms]
        missing = [r['id'] for r in lv['rooms'] if not any(r['id'] in rm['ids'] for rm in rooms)]
        if missing: print(f"  [{lv['id']}] WARNING labels not inside any space: {missing}")

        # plan overlay image: lines dark, paper transparent
        x0, y0, x1, y1 = -1.5, -2.0, 15.5, 14.5
        off = lv['sheetOffsetPt']
        clip = pymupdf.Rect(x0 / PT + ORIGIN[0] + off[0], y0 / PT + ORIGIN[1] + off[1],
                            x1 / PT + ORIGIN[0] + off[0], y1 / PT + ORIGIN[1] + off[1])
        zoom = 2048 / clip.width
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
        im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples).convert('L')
        alpha = im.point(lambda v: 255 - v)
        rgba = Image.merge('RGBA', (Image.new('L', im.size, 20), Image.new('L', im.size, 40),
                                    Image.new('L', im.size, 120), alpha))
        name = f"plan_{lv['id']}.png"
        rgba.save(os.path.join(ROOT, 'public', 'plans', name), optimize=True)

        # continuous floors: per floor height, the rooms at that height plus every doorway whose sill is at it
        pass_kinds = ('door', 'extdoor', 'entrance', 'hs', 'balcony', 'gate')
        by_z = {}
        for rm in rooms:
            for f in rm['floor']:
                by_z.setdefault(rm['floorZ'], []).append(Polygon(f['outer'], f['holes']))
        strips = []
        if extra_floor and lv['floorZ'] in by_z: by_z[lv['floorZ']] += extra_floor
        for o in ops:
            if o['kind'] not in pass_kinds: continue
            z = min(by_z, key=lambda zz: abs(zz - o['sill'])) if by_z else None
            if z is None or abs(z - o['sill']) > 0.06: continue
            by_z[z].append(rect(o['rect']))
            strips.append({'z': z, 'rect': o['rect']})
        floors_full = []
        for z, ps in by_z.items():
            g_ = unary_union(ps).buffer(0.01, join_style=2).buffer(-0.01, join_style=2)
            floors_full.append({'z': z, 'polys': [poly_json(pp) for pp in parts(g_) if pp.area > 0.01]})

        out['levels'].append({'id': lv['id'], 'name': lv['name'], 'floorZ': lv['floorZ'], 'wallZ': lv['wallZ'],
                              'floors': floors_full, 'doorStrips': strips,
                              'walls': wall_items, 'rooms': rooms, 'footprint': poly_json(footprint),
                              'overlay': {'img': f"plans/{name}", 'rect': [x0, y0, x1, y1]}})
        print(f"[{lv['id']}] {len(wall_items)} wall pieces, {len(rooms)} spaces, {len(ops)} openings")

    # slab overhangs: parts of the attic floor that are not above the ground floor (covered terrace, entrance
    # canopy). They get a slab 2.93..3.34 with a plastered underside so you see a ceiling from below.
    g0 = Polygon(out['levels'][0]['footprint']['outer'])
    a1 = Polygon(out['levels'][1]['footprint']['outer'])
    over = a1.difference(g0).buffer(-0.005, join_style=2).buffer(0.005, join_style=2)
    out['soffits'] = [poly_json(pp) for pp in parts(over.buffer(-0.005, join_style=2)) if pp.area > 0.2]  # 5 mm inside the wall faces
    print(f"[slab] {len(out['soffits'])} overhanging slab areas (terrace / entrance canopy)")

    out['roof'] = build_roof(cfg['roof'])
    # keep only collar ties inside the attic (overhang rafters have none)
    fp = out['levels'][1]['footprint']
    inner = Polygon(fp['outer']).buffer(-0.30)
    out['roof']['ties'] = [t for t in out['roof']['ties']
                           if inner.contains(Point((t['p'][0] + t['p'][2]) / 2, (t['p'][1] + t['p'][3]) / 2))]
    print(f"[roof] {len(out['roof']['ties'])} collar ties inside the attic")
    # close roof slots only above the inside of the house (bay side walls); outside the walls they stay open
    shell = Polygon(fp['outer']).buffer(-0.03, join_style=2)  # strictly inside the outer walls
    kept = []
    for st in out['roof']['steps']:
        x0, y0, x1, y1 = st['p']
        L = math.dist((x0, y0), (x1, y1))
        seg = LineString([(x0, y0), (x1, y1)]).intersection(shell)
        for gg in getattr(seg, 'geoms', [seg]):
            if not isinstance(gg, LineString) or gg.length < 0.03: continue
            (a0, b0), (a1, b1) = gg.coords[0], gg.coords[-1]
            lerp = lambda v, t: v[0] + (v[1] - v[0]) * t
            t0 = math.dist((x0, y0), (a0, b0)) / L; t1 = math.dist((x0, y0), (a1, b1)) / L
            kept.append({'p': [round(a0, 3), round(b0, 3), round(a1, 3), round(b1, 3)],
                         'lo': [round(lerp(st['lo'], t0), 3), round(lerp(st['lo'], t1), 3)],
                         'hi': [round(lerp(st['hi'], t0), 3), round(lerp(st['hi'], t1), 3)]})
    out['roof']['steps'] = kept
    print(f"[roof] {len(kept)} slot fillers kept inside the walls")
    # flashing only on true roof edges: drop parts of a face edge that touch another face edge which is at the
    # same height or higher (internal seams, or edges tucked under a higher roof)
    faces = out['roof']['faces']
    def Hp(pl, x, y): return pl[0] * x + pl[1] * y + pl[2]
    edges = []
    for fi, f in enumerate(faces):
        r = f['outer']
        for a, b in zip(r, r[1:] + r[:1]):
            if math.dist(a, b) > 0.01: edges.append((fi, LineString([a, b])))
    flash = []
    for fi, e in edges:
        pl = faces[fi]['plane']
        cover = []
        for fj, o in edges:
            if fj == fi or e.distance(o) > 0.004: continue
            ov = o.intersection(e.buffer(0.004, cap_style=2))
            if ov.is_empty or ov.length < 0.01: continue
            mx, my = ov.interpolate(0.5, normalized=True).coords[0]
            if Hp(faces[fj]['plane'], mx, my) >= Hp(pl, mx, my) - 0.01:
                cover.append(ov.buffer(0.006, cap_style=2))
        free = e.difference(unary_union(cover)) if cover else e
        for g in getattr(free, 'geoms', [free]):
            if isinstance(g, LineString) and g.length > 0.03:
                (x0, y0), (x1, y1) = g.coords[0], g.coords[-1]
                flash.append({'p': [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)], 'plane': pl})
    out['roof']['flashing'] = flash
    print(f"[roof] {len(flash)} flashing segments on outer roof edges")
    # planned attic finish: per attic room, split the ceiling into sloped parts (under the roof) and the flat part
    af = cfg.get('atticFinish')
    if af:
        k = cfg['roof']['k']; sfac = math.sqrt(1 + k * k)
        drop = (af['woolUnder'] + af['board']) * sfac            # vertical: rafter underside -> plasterboard face
        core = [f for f in out['roof']['faces'] if not f.get('overhang')]
        fin = []
        # main-roof plane regions (parts without a separate wall zone), used where a room's bay lining is narrowed
        main_regions = []
        for p_ in cfg['roof']['parts']:
            if 'wallRect' in p_: continue
            pls = roof_planes(p_, k)
            for pl in pls:
                reg = rect(p_['rect'])
                for q in pls:
                    if q is not pl: reg = reg.intersection(halfplane_le(pl, q))
                if reg.area > 1e-6: main_regions.append((pl, reg))
        overrides = {o['room']: o for o in af.get('bayLining', [])}
        flatten = set(af.get('flattenBays', []))
        chamfer = af.get('chamferSteps', {})            # room id -> width (m) of the inclined plane that replaces a vertical roof step
      # rooms where the main-slope lining runs unbroken (no bay niche / vertical step)
        extra_steps = []
        for rm in out['levels'][1]['rooms']:
            room = Polygon(rm['outer'], rm['holes']).buffer(0)
            ceil = round(rm['floorZ'] + af['ceilingHeight'], 3)
            slopes, flats = [], []
            ov = next((overrides[i] for i in rm['ids'] if i in overrides), None)
            pieces = []
            if any(i in flatten for i in rm['ids']):
                pieces = [(pl, room.intersection(reg)) for pl, reg in main_regions]
            elif ov:
                zx0, zx1 = ov['x']
                zone = box(zx0, -50, zx1, 50)
                for f in core:
                    pieces.append((f['plane'], room.intersection(zone).intersection(Polygon(f['outer'], f['holes']).buffer(0))))
                for pl, reg in main_regions:
                    pieces.append((pl, room.difference(zone).intersection(reg)))
                # vertical steps at the zone edges (main lining -> bay lining), drawn like the bay side triangles
                b0, b1 = room.bounds[1], room.bounds[3]
                for zx in (zx0, zx1):
                    def Hcore(x, y):
                        hs = [Hp(f['plane'], x, y) for f in core if Polygon(f['outer'], f['holes']).buffer(0.001).contains(Point(x, y))]
                        return max(hs) if hs else None
                    def Hmain(x, y):
                        hs = [Hp(pl, x, y) for pl, reg in main_regions if reg.buffer(0.001).contains(Point(x, y))]
                        return min(hs) if hs else None
                    ys = [b0 + (b1 - b0) * i / 40 for i in range(41)]
                    seg = [(y, Hmain(zx, y), Hcore(zx + (0.01 if zx == zx0 else -0.01), y)) for y in ys]
                    seg = [(y, lo, hi) for y, lo, hi in seg if lo is not None and hi is not None and hi - lo > 0.01 and room.contains(Point(zx, y))]
                    if len(seg) >= 2:
                        (ya, la, ha), (yb, lb, hb) = seg[0], seg[-1]
                        extra_steps.append({'p': [zx, round(ya, 3), zx, round(yb, 3)], 'lo': [round(la, 3), round(lb, 3)], 'hi': [round(ha, 3), round(hb, 3)]})
            else:
                pieces = [(f['plane'], room.intersection(Polygon(f['outer'], f['holes']).buffer(0))) for f in core]
            cw = next((chamfer[i] for i in rm['ids'] if i in chamfer), None)
            if cw:
                # replace each vertical step in this room by ONE inclined plane joining the lower and the higher lining:
                # it contains the step's bottom edge (so it meets the lower lining exactly there) and meets the higher
                # lining along a crease at distance cw from the step; no vertical panel is left
                import numpy as np
                for st in out['roof']['steps']:
                    sx0, sy0, sx1, sy1 = st['p']
                    if abs(sx1 - sx0) > 1e-6: continue
                    ln = LineString([(sx0, min(sy0, sy1)), (sx0, max(sy0, sy1))])
                    inside = room.intersection(ln)
                    if inside.is_empty or inside.length < 0.2: continue
                    ya, yb = inside.bounds[1], inside.bounds[3]
                    def lohi(y):
                        t = (y - sy0) / (sy1 - sy0)
                        return st['lo'][0] + (st['lo'][1] - st['lo'][0]) * t, st['hi'][0] + (st['hi'][1] - st['hi'][0]) * t
                    (la, ha), (lb, hb) = lohi(ya), lohi(yb)
                    yv, yw = (ya, yb) if (ha - la) < (hb - lb) else (yb, ya)       # valley end (no step) / tall end
                    lv, lw = (la, lb) if yv == ya else (lb, la)
                    ymid = (ya + yb) / 2
                    def Hc(x, y):
                        c = [(Hp(f['plane'], x, y), f['plane']) for f in core if Polygon(f['outer'], f['holes']).buffer(0.001).contains(Point(x, y))]
                        return max(c, key=lambda t_: t_[0]) if c else (None, None)
                    side = 1 if (Hc(sx0 + 0.02, ymid)[0] or -9) > (Hc(sx0 - 0.02, ymid)[0] or -9) else -1
                    x3 = sx0 + side * cw
                    z3, hpl = Hc(sx0 + side * 0.02, ymid)
                    if z3 is None: continue
                    z3 = Hp(hpl, x3, yw)
                    Q = np.linalg.solve(np.array([[sx0, yw, 1], [sx0, yv, 1], [x3, yw, 1]], float), np.array([lw, lv, z3], float))
                    tri = Polygon([(x3, yw), (sx0, yw), (sx0, yv)]).intersection(room)
                    if tri.is_empty or tri.area < 0.005: continue
                    newp = []
                    for pl, piece in pieces:
                        newp.append((pl, piece.difference(tri) if list(pl) == list(hpl) else piece))
                    newp.append(([float(Q[0]), float(Q[1]), float(Q[2])], tri))
                    pieces = newp
            for pl, piece in pieces:
                if piece.is_empty or piece.area < 0.01: continue
                low = piece.intersection(halfplane_le(pl, (0, 0, ceil + drop)))     # plasterboard below 2.80
                high = piece.difference(low)
                slopes += [{'plane': pl, **poly_json(pp)} for pp in parts(low) if pp.area > 0.005]
                flats += [poly_json(pp) for pp in parts(high) if pp.area > 0.005]
            # roof openings (hatch, roof windows) are holes in the roof faces; where such a hole lies over the flat ceiling,
            # the ceiling is still closed (the opening is far above it), so put the hole's flat part back
            for f in core:
                for hole in f.get('holes', []):
                    H = Polygon(hole).buffer(0).intersection(room)
                    if H.is_empty: continue
                    high = H.difference(halfplane_le(f['plane'], (0, 0, ceil + drop)))
                    flats += [poly_json(pp) for pp in parts(high) if pp.area > 0.005]
            # rising ceiling (owner: 2/8 near the door as high as possible): the flat ceiling piece under the main slope
            # (the one containing 'seed') is not flat but follows the slope lining like the rest of the slope, so the lining
            # runs as ONE plane from the north wall down to the flat part (the slope already carries 15 + 15 cm wool)
            rc = next((af['risingCeiling'][i] for i in rm['ids'] if i in af.get('risingCeiling', {})), None)
            if rc and flats:
                seed = Point(*rc['seed'])
                keep = []
                for f in flats:
                    pg = Polygon(f['outer'], f['holes']).buffer(0)
                    if pg.contains(seed): slopes.append({'plane': rc['plane'], **poly_json(pg)})
                    else: keep.append(f)
                flats = keep
            fin.append({'ids': rm['ids'], 'ceil': ceil, 'slopes': slopes, 'flats': flats})
        # drop roof-slot triangles inside overridden rooms (replaced by the zone-edge steps)
        ov_rooms = [Polygon(rm['outer'], rm['holes']) for rm in out['levels'][1]['rooms'] if any(i in overrides or i in flatten or i in chamfer for i in rm['ids'])]
        keep_steps = [st for st in out['roof']['steps'] if not any(r_.buffer(0.3).intersects(LineString([st['p'][:2], st['p'][2:]])) and r_.buffer(0.3).intersection(LineString([st['p'][:2], st['p'][2:]])).length > 0.2 for r_ in ov_rooms)]
        out['atticFinish'] = {**af, 'rooms': fin, 'steps': keep_steps + extra_steps}
        print(f"[finish] attic ceiling: {sum(len(r['slopes']) for r in fin)} sloped + {sum(len(r['flats']) for r in fin)} flat pieces")
    # lighting: downlight grids / batten lines per room label, cove lines in the attic
    lc = cfg.get('lighting')
    if lc:
        sp, ins = lc['spacing'], lc['inset']
        af_rooms = {tuple(r['ids']): r for r in out.get('atticFinish', {}).get('rooms', [])}
        labels_out = []
        for li, L in enumerate(out['levels']):
            for rm in L['rooms']:
                space = Polygon(rm['outer'], rm['holes']).buffer(0)
                # split an open-plan space between its labels (nearest label wins)
                for lab in rm['labels']:
                    others = [o for o in rm['labels'] if o['id'] != lab['id']]
                    region = space
                    for o in others:
                        ax, ay = lab['at']; bx, by = o['at']
                        mx, my = (ax + bx) / 2, (ay + by) / 2
                        a_, b_ = bx - ax, by - ay                       # keep the half closer to lab
                        region = region.intersection(halfplane_le((a_, b_, -(a_ * mx + b_ * my)), (0, 0, 0)))
                    rc = lc['rooms'].get(lab['id'], {'style': 'downlights'})
                    if li == 0:   # ground floor: no fixtures over the open stair well (no ceiling there)
                        region = region.difference(rect(cfg['stairs']['void']['rect']).buffer(0.35, join_style=2))
                    inner = region.buffer(-ins, join_style=2)
                    if inner.is_empty: inner = region.buffer(-0.25, join_style=2)
                    pts = []
                    x0, y0, x1, y1 = (inner if not inner.is_empty else region).bounds
                    if rc.get('lampsAt'):
                        rc_out = {'lamps': rc['lampsAt']}
                    elif rc['style'] == 'ceiling':
                        # n lamps: centre of the room, or spread along the longer axis
                        n = rc.get('lamps', 1)
                        base = inner if not inner.is_empty else region
                        c = base.centroid if base.contains(base.centroid) else base.representative_point()
                        if n == 1:
                            lamps = [[round(c.x, 3), round(c.y, 3)]]
                        else:
                            w, hgt = x1 - x0, y1 - y0
                            lamps = []
                            for i in range(n):
                                t = (i + 0.5) / n
                                q = Point(x0 + w * t, c.y) if w >= hgt else Point(c.x, y0 + hgt * t)
                                if not base.contains(q): q = base.exterior.interpolate(base.exterior.project(q))
                                lamps.append([round(q.x, 3), round(q.y, 3)])
                        rc_out = {'lamps': lamps}
                    elif rc['style'] == 'battens':
                        # 1-2 long battens along the longer side
                        w, hgt = x1 - x0, y1 - y0
                        n = 2 if min(w, hgt) > 2.5 else 1
                        lines = []
                        for i in range(n):
                            t = (i + 1) / (n + 1)
                            if w >= hgt: lines.append([round(x0 + 0.3, 3), round(y0 + (y1 - y0) * t, 3), round(min(x1 - 0.3, x0 + 0.3 + 1.5), 3), round(y0 + (y1 - y0) * t, 3)])
                            else: lines.append([round(x0 + (x1 - x0) * t, 3), round(y0 + 0.3, 3), round(x0 + (x1 - x0) * t, 3), round(min(y1 - 0.3, y0 + 0.3 + 1.5), 3)])
                        rc_out = {'battens': lines}
                    else:
                        nx = max(1, round((x1 - x0) / sp) + 1); ny = max(1, round((y1 - y0) / sp) + 1)
                        for i in range(nx):
                            for j in range(ny):
                                px_ = x0 + (x1 - x0) * (i / (nx - 1) if nx > 1 else 0.5)
                                py_ = y0 + (y1 - y0) * (j / (ny - 1) if ny > 1 else 0.5)
                                if (inner if not inner.is_empty else region).buffer(0.01).contains(Point(px_, py_)):
                                    pts.append([round(px_, 3), round(py_, 3)])
                        if not pts:
                            c = region.representative_point(); pts = [[round(c.x, 3), round(c.y, 3)]]
                        rc_out = {'downlights': pts}
                    # designed fixtures override the automatic layout: explicit downlights (+ the lamps above), or none
                    if rc['style'] == 'none' and not rc.get('lampsAt'): rc_out = {}
                    if rc.get('downlightsAt'): rc_out = {k_: v_ for k_, v_ in rc_out.items() if k_ != 'downlights'} | {'downlights': rc['downlightsAt']}
                    # attic cove: edges of the flat ceiling that are not along walls
                    cove = []
                    if rc.get('cove') and li == 1:
                        r_af = af_rooms.get(tuple(rm['ids']))
                        if r_af and r_af['flats']:
                            flat = unary_union([Polygon(f['outer'], f['holes']).buffer(0) for f in r_af['flats']]).intersection(region)
                            walls_near = space.exterior.buffer(0.08)
                            for g in parts(flat):
                                edge = g.exterior.difference(walls_near)
                                for e in getattr(edge, 'geoms', [edge]):
                                    if isinstance(e, LineString) and e.length > 0.4:
                                        cs = list(e.simplify(0.02).coords)
                                        cove.append([[round(a, 3), round(b, 3)] for a, b in cs])
                    if 'wallStrip' in rc:
                        # snap the strip onto the nearest wall face of this room (1 cm off the plaster)
                        x0_, y0_, x1_, y1_, zs = rc['wallStrip']
                        mid = Point((x0_ + x1_) / 2, (y0_ + y1_) / 2)
                        ring = list(space.exterior.coords)
                        best = None
                        for a_, b_ in zip(ring, ring[1:]):
                            e = LineString([a_, b_])
                            if e.length < 0.5: continue
                            d_ = e.distance(mid)
                            if best is None or d_ < best[0]: best = (d_, a_, b_)
                        _, a_, b_ = best
                        ex, ey = b_[0] - a_[0], b_[1] - a_[1]; el = math.hypot(ex, ey); ux, uy = ex / el, ey / el
                        nx_, ny_ = -uy, ux                                     # pick the normal pointing into the room
                        if not space.contains(Point((a_[0] + b_[0]) / 2 + nx_ * 0.1, (a_[1] + b_[1]) / 2 + ny_ * 0.1)): nx_, ny_ = -nx_, -ny_
                        half = math.dist((x0_, y0_), (x1_, y1_)) / 2
                        t = (mid.x - a_[0]) * ux + (mid.y - a_[1]) * uy
                        t = min(max(t, half + 0.05), el - half - 0.05)
                        cx_, cy_ = a_[0] + ux * t + nx_ * 0.012, a_[1] + uy * t + ny_ * 0.012
                        rc = {**rc, 'wallStrip': [round(cx_ - ux * half, 3), round(cy_ - uy * half, 3), round(cx_ + ux * half, 3), round(cy_ + uy * half, 3), zs]}
                    labels_out.append({'id': lab['id'], 'level': L['id'], 'floorZ': rm['floorZ'], 'ceilZ': rm['ceilZ'],
                                       'area': lab['area'], 'center': [round(region.centroid.x, 3), round(region.centroid.y, 3)],
                                       **rc_out, 'cove': cove,
                                       **{k_: rc[k_] for k_ in ('surfaceSpots', 'pendants', 'pendantDrop', 'pendantBottom', 'pendantTopZ', 'tableLamps', 'wallLamps', 'floorLamps', 'lowLights', 'linearPendant', 'beamStrip', 'stairLights', 'wallStrip', 'strips', 'cct', 'gain', 'pendantStyle') if k_ in rc}})
        out['lighting'] = labels_out
        print(f"[light] {sum(len(l.get('lamps', [])) for l in labels_out)} ceiling lamps, {sum(len(l.get('downlights', [])) for l in labels_out)} downlights, {sum(len(l.get('battens', [])) for l in labels_out)} battens, {sum(len(l['cove']) for l in labels_out)} cove lines")
    print(f"[roof] {len(out['roof']['faces'])} faces")
    json.dump(out, open(os.path.join(ROOT, 'public', 'house.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print('wrote public/house.json')


if __name__ == '__main__':
    main()
