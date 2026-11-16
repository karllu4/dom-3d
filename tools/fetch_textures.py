"""Download photo-scanned PBR textures (Poly Haven, CC0) into public/textures and prepare them.

Run:  .venv/bin/python -I tools/fetch_textures.py
Each texture gets <name>_diff.jpg (colour, sRGB), <name>_nor.jpg (OpenGL normal) and <name>_rough.jpg.
Some colour maps are re-graded to match the house (white interior plaster, raw pine, neutral linen).
"""
import io
import json
import pathlib
import urllib.request

from PIL import Image, ImageEnhance, ImageOps

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'textures'
API = 'https://api.polyhaven.com/files/'
UA = {'User-Agent': 'dom-3d texture fetch'}

# local name: (poly haven asset, real-world size of one tile in metres, colour grade)
TEXTURES = {
    'screed': ('concrete_floor_worn_001', 3.0, None),
    'plaster': ('grey_plaster', 1.0, 'white'),
    'oak': ('oak_veneer_01', 1.83, None),
    'wool': ('poly_wool_herringbone', 0.5, 'grey'),
    'linen': ('rough_linen', 0.5, 'white'),
    'jute': ('hessian_230', 0.5, None),
    'grass': ('leafy_grass', 2.0, None),
    'pine': ('coated_pine', 0.74, 'raw'),
    'paving': ('concrete_pavement', 1.8, None),
}
MAPS = {'diff': 'Diffuse', 'nor': 'nor_gl', 'rough': 'Rough'}


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def grade(im: Image.Image, how: str | None) -> Image.Image:
    if how == 'white':   # keep only the fine tonal variation, lifted to an off-white
        g = ImageOps.grayscale(im)
        g = ImageOps.autocontrast(g, cutoff=1)
        g = g.point(lambda v: 222 + v * 30 // 255)
        return Image.merge('RGB', (g, g.point(lambda v: v - 2), g.point(lambda v: v - 6)))
    if how == 'grey':    # neutral grey fabric (tinted by the material colour)
        g = ImageOps.autocontrast(ImageOps.grayscale(im), cutoff=1).point(lambda v: 150 + v * 90 // 255)
        return Image.merge('RGB', (g, g, g))
    if how == 'raw':     # coated (orange) pine -> raw, paler pine boarding
        im = ImageEnhance.Color(im).enhance(0.5)
        im = ImageEnhance.Brightness(im).enhance(1.75)
        return ImageEnhance.Contrast(im).enhance(0.8)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {}
    for name, (asset, size, how) in TEXTURES.items():
        files = json.loads(get(API + asset))
        for short, key in MAPS.items():
            data = get(files[key]['1k']['jpg']['url'])
            im = Image.open(io.BytesIO(data)).convert('RGB')
            if short == 'diff':
                im = grade(im, how)
            if short == 'rough':
                im = ImageOps.grayscale(im)
            im.save(OUT / f'{name}_{short}.jpg', quality=84, optimize=True)
        meta[name] = {'asset': asset, 'size': size, 'source': f'https://polyhaven.com/a/{asset}', 'license': 'CC0'}
        print(f'[tex] {name:7s} <- {asset}')
    (OUT / 'textures.json').write_text(json.dumps(meta, indent=2))


if __name__ == '__main__':
    main()
