# Render plan PDFs to PNG. Usage: python tools_render.py <pdf> <out.png> <zoom> [x0 y0 x1 y1 in pt]
import pymupdf, sys
d = pymupdf.open(sys.argv[1]); p = d[0]
z = float(sys.argv[3])
clip = pymupdf.Rect(*map(float, sys.argv[4:8])) if len(sys.argv) > 4 else None
p.get_pixmap(matrix=pymupdf.Matrix(z, z), clip=clip, alpha=False).save(sys.argv[2])
