import * as THREE from 'three';

/**
 * Facade design options. The wall material (materials.ts `facadeMaterial`) reads one set of shared uniforms,
 * so switching a style just rewrites those values: no rebuild, every wall / gable / roof-step fill follows.
 * Spans are plan x ranges, zones are heights (m). `front` = plan +y side (garage + entrance), `back` = garden side.
 */
export type CladKind = 'plaster' | 'vboards' | 'hboards' | 'brick' | 'stone' | 'seam' | 'clinker';
/** `box` (plan x0,y0,x1,y1) limits a layer to one place on any wall face inside it (returns and reveals included); `z` overrides the zone height range. */
export interface Layer { span: 'all' | 'left' | 'bay' | 'right'; zone: 'ground' | 'upper' | 'all'; kind: CladKind; a: string; b?: string; box?: [number, number, number, number]; z?: [number, number] }
export interface FacadeStyle {
  id: string; name: string; tag: string;
  wall: string; plinth: string;
  gate: { color: string; wood: boolean };
  door: string;   // entrance door
  door2: string;  // back (terrace) door, anthracite like the roof by default
  layers: Layer[];
  clinker?: boolean;   // Cerrad Piatto Sand slips at the entrance and under the kitchen window (clinkerLayers)
  dark?: boolean;
}

export const FACADE_STYLES: FacadeStyle[] = [
  { id: 'raw', name: 'Current: raw blocks', tag: 'As built now: bare aerated-concrete blocks, Braas Turmalin anthracite roof.', wall: '#e2e3e0', plinth: '#e2e3e0', gate: { color: '#383e42', wood: false }, door: '#2f4a68', door2: '#3b3e42', layers: [] },
  { id: 's1', name: '1 · Classic white', tag: 'White plaster, wood-decor garage door.', wall: '#f1eee7', plinth: '#55585b', gate: { color: '#8a5a2b', wood: true }, door: '#2f4a68', door2: '#3b3e42', layers: [] },
  { id: 's3', name: '2 · Warm sand', tag: 'Sand plaster with a brown plinth.', wall: '#e2d3b5', plinth: '#7a6e60', gate: { color: '#8a5a2b', wood: true }, door: '#2f4a68', door2: '#3b3e42', layers: [] },
  { id: 's9', name: '3 · Greige with stone', tag: 'Greige plaster, stone cladding on the garage block and entrance bay.', wall: '#d9cdbd', plinth: '#6d655b', gate: { color: '#8a5a2b', wood: true }, door: '#2f4a68', door2: '#3b3e42', layers: [{ span: 'right', zone: 'ground', kind: 'stone', a: '#7d7a74', b: '#908c84' }, { span: 'bay', zone: 'ground', kind: 'stone', a: '#7d7a74', b: '#908c84' }] },
  { id: 's4', name: '4 · White with sand clinker', tag: 'Classic white with Cerrad Piatto Sand clinker slips around the entrance and under the kitchen window.', wall: '#f1eee7', plinth: '#55585b', gate: { color: '#8a5a2b', wood: true }, door: '#2f4a68', door2: '#3b3e42', layers: [], clinker: true },
];

const SPANS: Record<'front' | 'back', Record<Layer['span'], [number, number]>> = {
  front: { all: [-100, 100], left: [0, 3.761], bay: [3.761, 7.0], right: [7.0, 14.0] },
  back: { all: [-100, 100], left: [0, 3.761], bay: [3.761, 8.341], right: [8.341, 14.0] },
};
const ZONES: Record<Layer['zone'], [number, number]> = { ground: [-1, 2.93], upper: [2.93, 20], all: [-1, 20] };
const KIND_ID: Record<CladKind, number> = { plaster: 6, vboards: 1, hboards: 2, brick: 3, stone: 4, seam: 5, clinker: 7 };
export const MAX_LAYERS = 6;
export const PLINTH_TOP = 0.0;

/** Uniforms shared by every facade material. mode 0 = the old raw-block texture, 1 = styled. */
export const facadeUniforms = {
  uFacMode: { value: 0 },
  uWall: { value: new THREE.Color('#f0ede6') },
  uPlinth: { value: new THREE.Color('#55585b') },
  uPlinthTop: { value: PLINTH_TOP },
  uLayZ: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4(0, 0, 0, 0)) },   // zMin, zMax, kind, active
  uLayX: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4(0, 0, 0, 0)) },   // front x0,x1, back x0,x1
  uLayBox: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4(0, 0, 0, 0)) },  // plan box x0,y0,x1,y1 (x1 > x0 = use the box)
  uLayA: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Color()) },
  uLayB: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Color()) },
};

export function applyFacadeUniforms(s: Pick<FacadeStyle, 'id' | 'wall' | 'plinth' | 'layers'>) {
  const u = facadeUniforms;
  u.uFacMode.value = s.id === 'raw' ? 0 : 1;
  u.uWall.value.set(s.wall);
  u.uPlinth.value.set(s.plinth);
  for (let i = 0; i < MAX_LAYERS; i++) {
    const l = s.layers[i];
    if (!l) { u.uLayZ.value[i].set(0, 0, 0, 0); continue; }
    const [z0, z1] = l.z ?? ZONES[l.zone];
    u.uLayZ.value[i].set(z0, z1, KIND_ID[l.kind], 1);
    if (l.box) u.uLayBox.value[i].set(...l.box); else u.uLayBox.value[i].set(0, 0, 0, 0);
    u.uLayX.value[i].set(...SPANS.front[l.span], ...SPANS.back[l.span]);
    u.uLayA.value[i].set(l.a);
    u.uLayB.value[i].set(l.b ?? l.a);
  }
}

/** GLSL injected into MeshStandardMaterial (after map_fragment). Needs vFacWP (world pos) and vFacN (world normal). */
export const FACADE_GLSL_DECL = /* glsl */ `
varying vec3 vFacWP;
varying vec3 vFacN;
uniform float uFacMode;
uniform vec3 uWall;
uniform vec3 uPlinth;
uniform float uPlinthTop;
uniform vec4 uLayZ[${MAX_LAYERS}];
uniform vec4 uLayX[${MAX_LAYERS}];
uniform vec4 uLayBox[${MAX_LAYERS}];
uniform vec3 uLayA[${MAX_LAYERS}];
uniform vec3 uLayB[${MAX_LAYERS}];
float fh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 facadeCladdingRaw(int kind, float s, float h, vec3 a, vec3 b) {
  if (kind == 1) { // vertical boards, 18 cm
    float id = floor(s / 0.18), u = fract(s / 0.18);
    vec3 c = a * (0.9 + 0.2 * fh(vec2(id, 1.0)));
    c *= 1.0 - 0.45 * smoothstep(0.90, 0.99, u) - 0.15 * (1.0 - smoothstep(0.0, 0.06, u));
    return c;
  }
  if (kind == 2) { // horizontal boards, 20 cm
    float id = floor(h / 0.2), v = fract(h / 0.2);
    vec3 c = a * (0.9 + 0.2 * fh(vec2(id, floor(s / 1.7))));
    c *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.07, v));
    return c;
  }
  if (kind == 3) { // brick 25 x 7.5 cm
    float row = floor(h / 0.075);
    float bx = (s + mod(row, 2.0) * 0.125) / 0.25;
    float id = floor(bx);
    float fx = fract(bx), fy = fract(h / 0.075);
    vec3 c = mix(a, b, fh(vec2(id, row)));
    if (fx < 0.05 || fy < 0.12) c = vec3(0.62, 0.59, 0.53);
    return c;
  }
  if (kind == 4) { // stone courses, random lengths
    float row = floor(h / 0.2);
    float w = 0.35 + 0.35 * fh(vec2(row, 3.0));
    float bx = (s + 3.0 * fh(vec2(row, 7.0))) / w;
    float id = floor(bx);
    float fx = fract(bx), fy = fract(h / 0.2);
    vec3 c = mix(a, b, fh(vec2(id, row)));
    if (fx < 0.04 || fy < 0.07) c *= 0.55;
    return c;
  }
  if (kind == 5) { // standing seam, 46 cm
    float u = fract(s / 0.46);
    vec3 c = a;
    if (u < 0.05) c = a * 1.45;
    else if (u < 0.09) c = a * 0.6;
    return c;
  }
  if (kind == 7) { // Cerrad Piatto Sand clinker slips 30.5 x 7.4 cm, 10 mm joints, running bond
    float pw = 0.315, ph = 0.084;
    float row = floor(h / ph);
    float bx = (s + mod(row, 2.0) * pw * 0.5) / pw;
    float id = floor(bx);
    float fx = fract(bx) * pw, fy = fract(h / ph) * ph;
    if (fx > 0.305 || fy > 0.074) return vec3(0.46, 0.43, 0.38);                         // joint mortar
    vec3 c = mix(a, b, fh(vec2(id, row)));
    c *= 0.94 + 0.12 * fh(floor(vec2(s, h) * 120.0));                                      // hand-moulded surface
    float edge = min(min(fx, 0.305 - fx), min(fy, 0.074 - fy));
    return c * (0.9 + 0.1 * smoothstep(0.0, 0.012, edge));
  }
  return a;
}
vec3 facadeCladding(int kind, float s, float h, vec3 a, vec3 b) {
  vec3 c = facadeCladdingRaw(kind, s, h, a, b);
  // fade the fine pattern to its average colour when a texel covers several bricks/boards (no moire at distance)
  float fw = fwidth(s) + fwidth(h);
  float k = kind == 3 ? 0.9 : kind == 4 ? 0.8 : kind == 7 ? 0.9 : 0.88;
  vec3 avg = (kind == 3 || kind == 4 || kind == 7) ? mix(a, b, 0.5) * k : a * k;
  return mix(c, avg, smoothstep(0.015, 0.06, fw));
}`;

export const FACADE_GLSL_BODY = /* glsl */ `
  {
    bool styled = uFacMode > 0.5;
    vec3 col = uWall;
    float h = vFacWP.y;
    bool sideFace = abs(vFacN.z) < 0.5;
    float s = sideFace ? vFacWP.z : vFacWP.x;
    bool front = vFacN.z > 0.0;
    bool hit = false;
    for (int i = 0; i < ${MAX_LAYERS}; i++) {
      if (uLayZ[i].w > 0.5 && h >= uLayZ[i].x && h <= uLayZ[i].y) {
        bool inX;
        if (uLayBox[i].z > uLayBox[i].x) {
          inX = vFacWP.x >= uLayBox[i].x && vFacWP.x <= uLayBox[i].z && vFacWP.z >= uLayBox[i].y && vFacWP.z <= uLayBox[i].w;
        } else {
          vec2 sp = front ? uLayX[i].xy : uLayX[i].zw;
          bool wide = sp.y > 50.0;
          inX = (wide || !sideFace) && s >= sp.x && s <= sp.y;
        }
        if (inX) { col = facadeCladding(int(uLayZ[i].z + 0.5), s, h, uLayA[i], uLayB[i]); hit = true; }
      }
    }
    if (styled) {
      if (h < uPlinthTop && !hit) col = uPlinth;
      float n = fh(floor(vec2(s, h) * 40.0));
      col *= 0.97 + 0.06 * n;
      diffuseColor.rgb = col;
    } else if (hit) {
      diffuseColor.rgb = col;
    } else if (vFacWP.y > 2.86 && vFacWP.y < 3.34) {
      diffuseColor.rgb = vec3(0.56, 0.56, 0.54) * (0.9 + 0.2 * diffuseColor.r);
    }
  }
`;

/**
 * Cerrad Piatto Sand clinker facing (item 11306, 30 x 7.4 x 0.9 cm, sand/beige, hand-moulded look):
 * in the entrance recess round the door (back wall only; the returns and piers either side keep the facade colour) and below the kitchen corner window (sill +0.88).
 */
/** Clinker colours of the Cerrad Piatto range (a = main tone, b = second tone mixed in per slip) plus the free picker. */
export const PAL_CLINKER: { n: string; a: string; b: string }[] = [
  { n: 'Sand', a: '#d6bf94', b: '#c3a677' }, { n: 'Honey', a: '#d9a94f', b: '#c4923a' }, { n: 'Terra', a: '#b5694a', b: '#9e553a' },
  { n: 'Red', a: '#a8423a', b: '#8f3330' }, { n: 'Grey', a: '#a9a8a2', b: '#92918b' }, { n: 'Anthracite', a: '#4c4e52', b: '#3d3f43' },
];
export const CLINKER_DEFAULT = PAL_CLINKER[0].a;
/** second tone for a picked colour: the preset's own pair if it is one, else 12 % darker */
export function clinkerPair(a: string): { a: string; b: string } {
  const p = PAL_CLINKER.find((c) => c.a.toLowerCase() === a.toLowerCase());
  if (p) return { a: p.a, b: p.b };
  const c = new THREE.Color(a).multiplyScalar(0.88);
  return { a, b: '#' + c.getHexString() };
}
export function clinkerLayers(a: string): Layer[] {
  const col = clinkerPair(a);
  return [
    { span: 'all', zone: 'ground', kind: 'clinker', ...col, box: [4.42, 9.5, 6.68, 9.7], z: [-1, 2.72] },   // only the back wall of the recess; the piers and their returns (sides of the recess) keep the facade colour
    { span: 'all', zone: 'ground', kind: 'clinker', ...col, box: [-0.05, 9.5, 2.14, 9.66], z: [-1, 0.88] },
    { span: 'all', zone: 'ground', kind: 'clinker', ...col, box: [-0.05, 8.15, 0.5, 9.66], z: [-1, 0.88] },
  ];
}

// ---- colour pickers (menu): name, hex. Garage door also offers oak-grain decors.
export type Swatch = { n: string; c: string; wood?: boolean };
export const PAL_WALL: Swatch[] = [
  { n: 'White', c: '#f1eee7' }, { n: 'Light grey', c: '#cdcfcf' }, { n: 'Greige', c: '#d6cfc2' }, { n: 'Sand', c: '#e2d3b5' },
  { n: 'Sage', c: '#aebba5' }, { n: 'Mid grey', c: '#8d9092' }, { n: 'Graphite', c: '#5d6063' }, { n: 'Black', c: '#26282b' },
];
export const PAL_DOOR: Swatch[] = [
  { n: 'White RAL 9016', c: '#f1f0ea' }, { n: 'Light grey RAL 7035', c: '#cbd0cc' }, { n: 'Grey RAL 7037', c: '#7b7f82' }, { n: 'Anthracite RAL 7016', c: '#383e42' },
  { n: 'Black RAL 9005', c: '#1d1d1f' }, { n: 'Brown RAL 8014', c: '#5a3a24' }, { n: 'Larch', c: '#a9743f' }, { n: 'Burgundy RAL 3005', c: '#5b1f26' },
  { n: 'Steel blue RAL 5011', c: '#2f4a68' }, { n: 'Dark green RAL 6009', c: '#27352a' }, { n: 'Sage', c: '#7c8b72' },
];
export const PAL_GATE: Swatch[] = [
  ...PAL_DOOR,
  { n: 'Golden oak decor', c: '#8a5a2b', wood: true }, { n: 'Light oak decor', c: '#b58a55', wood: true }, { n: 'Walnut decor', c: '#5a3a24', wood: true },
];
