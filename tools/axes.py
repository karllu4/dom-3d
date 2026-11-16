# Find long dash-dot grid axes: positions with large total length of short collinear segments.
import pymupdf, sys, collections
p = pymupdf.open(sys.argv[1])[0]
H, V = collections.Counter(), collections.Counter()
for d in p.get_drawings():
    if d.get('type') != 's': continue
    for it in d['items']:
        if it[0] != 'l': continue
        a, b = it[1], it[2]
        if abs(a.y-b.y) < 0.01: H[round(a.y, 1)] += abs(a.x-b.x)
        elif abs(a.x-b.x) < 0.01: V[round(a.x, 1)] += abs(a.y-b.y)
print("H", sorted([k for k, v in H.items() if v > 300]))
print("V", sorted([k for k, v in V.items() if v > 300]))
