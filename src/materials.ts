import * as THREE from 'three';

// Procedural textures (no external assets). UVs are in metres, so `size` = metres covered by one tile.

function canvasTex(px: number, size: number | [number, number], draw: (g: CanvasRenderingContext2D, px: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  draw(g, px);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const [su, sv] = Array.isArray(size) ? size : [size, size];
  t.repeat.set(1 / su, 1 / sv);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function noise(g: CanvasRenderingContext2D, px: number, base: [number, number, number], amp: number, seed: number, blotches = 0) {
  const r = rng(seed);
  const img = g.createImageData(px, px);
  for (let i = 0; i < px * px; i++) {
    const n = (r() - 0.5) * amp;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < blotches; i++) {
    const x = r() * px, y = r() * px, rad = 10 + r() * px * 0.12;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const d = r() > 0.5 ? 255 : 0;
    grd.addColorStop(0, `rgba(${d},${d},${d},0.05)`);
    grd.addColorStop(1, `rgba(${d},${d},${d},0)`);
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

const loader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
/** Photo-scanned PBR set from public/textures (tools/fetch_textures.py). `size` = metres covered by one tile. */
export function pbr(name: string, size: number | [number, number], extra: THREE.MeshStandardMaterialParameters = {}, normal = 1): THREE.MeshStandardMaterial {
  const [su, sv] = Array.isArray(size) ? size : [size, size];
  const load = (kind: string, srgb: boolean) => {
    const key = `${name}_${kind}`;
    let base = texCache.get(key);
    if (!base) {
      base = loader.load(`textures/${key}.jpg`);
      base.wrapS = base.wrapT = THREE.RepeatWrapping;
      base.anisotropy = 8;
      if (srgb) base.colorSpace = THREE.SRGBColorSpace;
      texCache.set(key, base);
    }
    const t = base.clone();          // shares the image; own repeat per material
    t.repeat.set(1 / su, 1 / sv);
    return t;
  };
  return new THREE.MeshStandardMaterial({
    map: load('diff', true), normalMap: load('nor', false), roughnessMap: load('rough', false),
    normalScale: new THREE.Vector2(normal, normal), roughness: 1, ...extra,
  });
}

export function makeMaterials() {
  // current state outside: raw aerated-concrete blocks 59 x 24 cm (texture = 2 blocks x 2 courses)
  const facade = canvasTex(512, [1.2, 0.48], (g, px) => {
    noise(g, px, [226, 227, 224], 10, 13, 20);
    const r = rng(53);
    g.fillStyle = 'rgba(120,120,115,0.55)';
    const rowH = px / 2, bw = px / 2;
    for (let row = 0; row < 2; row++) {
      g.fillRect(0, row * rowH, px, 3);                                       // bed joint
      const off = row % 2 ? bw / 2 : 0;
      for (let i = -1; i < 3; i++) g.fillRect(i * bw + off, row * rowH, 3, rowH); // head joints
    }
    for (let i = 0; i < 60; i++) {                                          // mortar smudges / chips
      g.fillStyle = `rgba(150,150,145,${0.08 + r() * 0.12})`;
      g.beginPath(); g.arc(r() * px, r() * px, 2 + r() * 10, 0, 7); g.fill();
    }
  });
  // Braas Turmalin, anthracite, matt engobe: flat ceramic tile laid in straight columns.
  // Texture = 2 tiles across (~0.30 m cover width each) x 2 rows (~0.33 m gauge). v runs up the slope.
  const tiles = canvasTex(512, [0.6, 0.66], (g, px) => {
    noise(g, px, [62, 65, 69], 9, 31, 30);
    const cw = px / 2, rh = px / 2;
    for (let row = 0; row < 2; row++) {
      const y0 = row * rh, y1 = y0 + rh; // canvas top = up-slope; tile's lower (visible) edge at y1
      for (let col = 0; col < 2; col++) {
        const x0 = col * cw;
        // gentle shading across the face (slightly raised centre)
        const face = g.createLinearGradient(x0, 0, x0 + cw, 0);
        face.addColorStop(0, 'rgba(0,0,0,0.10)');
        face.addColorStop(0.5, 'rgba(255,255,255,0.03)');
        face.addColorStop(1, 'rgba(0,0,0,0.06)');
        g.fillStyle = face;
        g.fillRect(x0, y0, cw, rh);
        // side interlock: dark groove + light lip
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(x0, y0, 3, rh);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(x0 + 3, y0, 3, rh);
      }
      // nose of the tile (lit edge) and the shadow it casts on the row below
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(0, y1 - 8, px, 5);
      const ys = y1 % px; // shadow starts at the top of the next row (wraps for the last row)
      const sh = g.createLinearGradient(0, ys, 0, ys + 22);
      sh.addColorStop(0, 'rgba(0,0,0,0.7)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh;
      g.fillRect(0, ys, px, 22);
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(0, y1 - 3, px, 3);
    }
  });

  // grey clinker brick (chimney): 25 x 6.5 cm bricks, 1 cm joints; texture = 0.52 x 0.30 m
  const clinker = canvasTex(256, [0.52, 0.3], (g, px) => {
    g.fillStyle = '#9a9a98';
    g.fillRect(0, 0, px, px);
    const r = rng(41);
    const rows = 4, rh = px / rows, bw = px / 2;
    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let i = -1; i < 3; i++) {
        const v = 95 + r() * 45;
        g.fillStyle = `rgb(${v},${v},${v + 4})`;
        g.fillRect(i * bw + off + 3, row * rh + 3, bw - 6, rh - 6);
      }
    }
  });

  // Winchester XA 49240: warm golden-brown oak decor with visible grain (window foil)
  const winchester = canvasTex(256, 0.25, (g, px) => {
    noise(g, px, [150, 98, 50], 10, 61);
    const r = rng(67);
    for (let i = 0; i < 70; i++) {
      const y = r() * px;
      g.strokeStyle = r() > 0.5 ? `rgba(95,55,22,${0.25 + r() * 0.3})` : `rgba(200,145,85,${0.15 + r() * 0.2})`;
      g.lineWidth = 1 + r() * 2.5;
      g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(px * 0.33, y + (r() - 0.5) * 12, px * 0.66, y + (r() - 0.5) * 12, px, y + (r() - 0.5) * 6); g.stroke();
    }
  });

  // mineral wool: yellow, fibrous
  const wool = canvasTex(256, 0.6, (g, px) => {
    noise(g, px, [214, 178, 72], 40, 71, 60);
    const r = rng(73);
    for (let i = 0; i < 400; i++) {
      g.strokeStyle = `rgba(${r() > 0.5 ? '255,230,140' : '150,110,30'},${0.15 + r() * 0.25})`;
      g.lineWidth = 0.5 + r();
      const x = r() * px, y = r() * px, a = r() * 6.28, l = 4 + r() * 14;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  });

  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  return {
    concrete: pbr('screed', 3.0, { roughness: 0.95 }),            // raw concrete screed (photo scan)
    slabConcrete: pbr('screed', 3.0, { emissive: 0x2a2a28, roughness: 0.95, side: THREE.DoubleSide }), // bare concrete slab soffit (terrace)
    plaster: pbr('plaster', 1.0, { roughness: 0.95 }, 0.35),      // white interior plaster: scanned relief, re-graded white
    ceiling: pbr('plaster', 1.0, { roughness: 0.95, side: THREE.DoubleSide }, 0.3),
    facade: ringBeamBand(std({ map: facade, roughness: 0.95 })),
    wallTop: pbr('plaster', 1.0, { roughness: 0.95 }, 0.35), // caps: door/window soffits and wall tops
    grass: pbr('grass', 2.0, { roughness: 1 }),
    paving: pbr('paving', 1.8, { roughness: 0.9 }),
    rafters: pbr('pine', 0.74, { roughness: 0.85, side: THREE.DoubleSide }), // pine roof boarding between the rafters (photo scan)
    timber: pbr('pine', [0.74, 0.74], { roughness: 0.8 }),
    wool: std({ map: wool, roughness: 1, side: THREE.DoubleSide }),
    plasterboard: pbr('plaster', 1.2, { roughness: 0.92, color: 0xfbfaf6, side: THREE.DoubleSide }, 0.12),
    tiles: std({ map: tiles, roughness: 0.82, side: THREE.DoubleSide }), // matt engobe
    fascia: std({ color: 0x33363a, roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide }), // anthracite roof flashing (verge / eaves)
    frameCaramel: std({ map: winchester, roughness: 0.5 }), // Winchester XA 49240 wood decor (all WIKĘD windows and HS doors)
    frameBlack: std({ color: 0x1d1d1f, roughness: 0.5 }),
    frameCherry: std({ color: 0x6e2b1b, roughness: 0.5 }), // cherry wood decor (HS doors)
    flashing: std({ color: 0x3a3c40, roughness: 0.5, metalness: 0.3 }),
    lining: std({ color: 0xf1efe9, roughness: 0.85 }),
    clinker: std({ map: clinker, roughness: 0.8 }),
    chimneyCap: std({ color: 0x5d5e60, roughness: 0.6, metalness: 0.2 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xa8cde0, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    sillBoard: std({ color: 0xf2f0ea, roughness: 0.4 }),
    railing: std({ color: 0x2a2a2c, roughness: 0.4, metalness: 0.6 }),
    stairs: pbr('screed', 3.0, { roughness: 0.92 }),
  };
}
export type Materials = ReturnType<typeof makeMaterials>;

/**
 * Make a material discard fragments above the roof (used for attic walls, which are extruded tall and
 * trimmed to the exact roof shape on the GPU). Also returns a matching depth material for shadows.
 */
export function clipAboveRoof<T extends THREE.Material>(mat: T, glslRoofH: string, offset: number): T {
  const m = mat.clone() as T;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => { prev.call(m, sh, r); inject(sh, glslRoofH, offset); };
  m.customProgramCacheKey = () => `roofclip|${prevKey}`;
  return m;
}

/** Grey concrete band on the façade where the ring beams / floor slab are (as on the site photos). */
function ringBeamBand<T extends THREE.Material>(m: T, z0 = 2.86, z1 = 3.34): T {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBandWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvBandWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBandWP;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  if (vBandWP.y > ${z0.toFixed(3)} && vBandWP.y < ${z1.toFixed(3)}) diffuseColor.rgb = vec3(0.56, 0.56, 0.54) * (0.9 + 0.2 * diffuseColor.r);`);
  };
  m.customProgramCacheKey = () => 'ringbeam';
  return m;
}

export function roofClipDepthMaterial(glslRoofH: string, offset: number): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => inject(sh, glslRoofH, offset);
  m.customProgramCacheKey = () => 'roofclip-depth';
  return m;
}

function inject(sh: { vertexShader: string; fragmentShader: string }, glslRoofH: string, offset: number) {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRoofWP;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvRoofWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vRoofWP;\n${glslRoofH}`)
    .replace('void main() {', `void main() {\n  if (vRoofWP.y > roofH(vRoofWP.xz) + ${offset.toFixed(4)}) discard;`);
}
