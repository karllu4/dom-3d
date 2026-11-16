import * as THREE from 'three';
import type { PolyJ, Pt, Rect } from './types';

export function signedArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInRing(x: number, y: number, r: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x: number, y: number, p: PolyJ): boolean {
  return pointInRing(x, y, p.outer) && !p.holes.some((h) => pointInRing(x, y, h));
}

export function rectPoly(r: Rect): PolyJ {
  const [x0, y0, x1, y1] = r;
  return { outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: [] };
}

/** Normalise orientation: outer CCW (positive area), holes CW. */
function oriented(p: PolyJ): PolyJ {
  const outer = signedArea(p.outer) < 0 ? [...p.outer].reverse() : p.outer;
  const holes = p.holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h));
  return { outer, holes };
}

/** Collects triangles with automatic winding so the face normal agrees with a hint direction. */
class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  groups: { start: number; count: number; mat: number }[] = [];
  private cur = -1;

  group(mat: number) {
    if (this.cur === mat) return;
    this.cur = mat;
    this.groups.push({ start: this.pos.length / 3, count: 0, mat });
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, ua: Pt, ub: Pt, uc: Pt) {
    const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (cr.dot(n) < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; }
    for (const [v, u] of [[a, ua], [b, ub], [c, uc]] as const) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(u[0], u[1]);
    }
    this.groups[this.groups.length - 1].count += 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const gr of this.groups) if (gr.count) g.addGroup(gr.start, gr.count, gr.mat);
    return g;
  }
}

function capTriangles(p: PolyJ): { pts: Pt[]; idx: number[][] } {
  const contour = p.outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holes = p.holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
  const idx = THREE.ShapeUtils.triangulateShape(contour, holes);
  return { pts: [...p.outer, ...p.holes.flat()], idx };
}

/**
 * Vertical prism from a plan polygon. Material groups: 0 = interior side, 1 = exterior side, 2 = caps.
 * `isExterior(x, y)` decides for each side face (tested just outside the face) whether it is a facade.
 */
export function prismGeometry(poly: PolyJ, z0: number, z1: number, isExterior?: (x: number, y: number) => boolean): THREE.BufferGeometry {
  const p = oriented(poly);
  const b = new Builder();
  const rings = [p.outer, ...p.holes];
  for (const r of rings) {
    let run = 0;
    for (let i = 0; i < r.length; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1e-4) continue;
      const nx = (y2 - y1) / len, ny = -(x2 - x1) / len; // outward (plan)
      const ext = isExterior ? isExterior((x1 + x2) / 2 + nx * 0.06, (y1 + y2) / 2 + ny * 0.06) : false;
      b.group(ext ? 1 : 0);
      const n = new THREE.Vector3(nx, 0, ny);
      const A = new THREE.Vector3(x1, z0, y1), B = new THREE.Vector3(x2, z0, y2);
      const C = new THREE.Vector3(x2, z1, y2), D = new THREE.Vector3(x1, z1, y1);
      const u0 = run, u1 = run + len;
      b.tri(A, B, C, n, [u0, z0], [u1, z0], [u1, z1]);
      b.tri(A, C, D, n, [u0, z0], [u1, z1], [u0, z1]);
      run += len;
    }
  }
  b.group(2);
  const { pts, idx } = capTriangles(p);
  const up = new THREE.Vector3(0, 1, 0), down = new THREE.Vector3(0, -1, 0);
  for (const [i, j, k] of idx) {
    const [a, c, e] = [pts[i], pts[j], pts[k]];
    b.tri(new THREE.Vector3(a[0], z1, a[1]), new THREE.Vector3(c[0], z1, c[1]), new THREE.Vector3(e[0], z1, e[1]), up, a, c, e);
    b.tri(new THREE.Vector3(a[0], z0, a[1]), new THREE.Vector3(c[0], z0, c[1]), new THREE.Vector3(e[0], z0, e[1]), down, a, c, e);
  }
  return b.build();
}

/** Horizontal polygon at height z, facing up or down. UV = plan metres. */
export function flatGeometry(poly: PolyJ, z: number, faceUp: boolean): THREE.BufferGeometry {
  const p = oriented(poly);
  const b = new Builder();
  b.group(0);
  const n = new THREE.Vector3(0, faceUp ? 1 : -1, 0);
  const { pts, idx } = capTriangles(p);
  for (const [i, j, k] of idx) {
    const [a, c, e] = [pts[i], pts[j], pts[k]];
    b.tri(new THREE.Vector3(a[0], z, a[1]), new THREE.Vector3(c[0], z, c[1]), new THREE.Vector3(e[0], z, e[1]), n, a, c, e);
  }
  return b.build();
}

/** Polygon lifted onto a plane h = a*x + b*y + c (+offset), with slope-aligned UVs (u across, v up-slope). */
export function slopedGeometry(poly: PolyJ, plane: [number, number, number], offset: number, faceUp: boolean): THREE.BufferGeometry {
  const p = oriented(poly);
  const [a, bb, c] = plane;
  const g = Math.hypot(a, bb) || 1;
  const gx = a / g, gy = bb / g; // up-slope direction in plan
  const slopeLen = Math.sqrt(1 + g * g);
  const nrm = new THREE.Vector3(-a, 1, -bb).normalize();
  if (!faceUp) nrm.negate();
  const b = new Builder();
  b.group(0);
  const { pts, idx } = capTriangles(p);
  const h = (x: number, y: number) => a * x + bb * y + c + offset;
  const uv = (x: number, y: number): Pt => [-gy * x + gx * y, (gx * x + gy * y) * slopeLen];
  for (const [i, j, k] of idx) {
    const [A, C, E] = [pts[i], pts[j], pts[k]];
    b.tri(new THREE.Vector3(A[0], h(...A), A[1]), new THREE.Vector3(C[0], h(...C), C[1]), new THREE.Vector3(E[0], h(...E), E[1]), nrm, uv(...A), uv(...C), uv(...E));
  }
  return b.build();
}

/** Vertical band under every edge of a sloped polygon (closes the roof slab edges). */
export function slopedSkirt(poly: PolyJ, plane: [number, number, number], z0off: number, z1off: number, holes = true): THREE.BufferGeometry {
  const p = oriented(poly);
  const [a, bb, c] = plane;
  const b = new Builder();
  b.group(0);
  for (const r of holes ? [p.outer, ...p.holes] : [p.outer]) {
    for (let i = 0; i < r.length; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1e-4) continue;
      const n = new THREE.Vector3((y2 - y1) / len, 0, -(x2 - x1) / len);
      const h1 = a * x1 + bb * y1 + c, h2 = a * x2 + bb * y2 + c;
      const A = new THREE.Vector3(x1, h1 + z0off, y1), B = new THREE.Vector3(x2, h2 + z0off, y2);
      const C = new THREE.Vector3(x2, h2 + z1off, y2), D = new THREE.Vector3(x1, h1 + z1off, y1);
      b.tri(A, B, C, n, [0, 0], [len, 0], [len, 1]);
      b.tri(A, C, D, n, [0, 0], [len, 1], [0, 1]);
    }
  }
  return b.build();
}
