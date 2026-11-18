import type { Pt, PolyJ, Rect } from './types';
import { pointInRing } from './geometry';

/**
 * Everything you can stand on or bump into is a "solid": a vertical prism (plan polygon, z0..z1).
 * - It supports you if your feet are within STEP_UP of its top.
 * - It blocks you if its top is higher than that and its bottom is below your head.
 */
export interface Solid { ring: Pt[]; z0: number; z1: number; bbox: Rect; tag?: string; off?: boolean }

export const STEP_UP = 0.4;

export function solidFromPoly(p: PolyJ | Pt[], z0: number, z1: number, tag?: string): Solid {
  const ring = Array.isArray(p) ? p : p.outer;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { ring, z0, z1, bbox: [x0, y0, x1, y1], tag };
}

export function solidFromRect(r: Rect, z0: number, z1: number, tag?: string): Solid {
  const [x0, y0, x1, y1] = r;
  return solidFromPoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1, tag);
}

/** Thin solid along a line segment (railings). */
export function solidFromSegment(a: Pt, b: Pt, thick: number, z0: number, z1: number): Solid {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  const nx = (-dy / L) * thick / 2, ny = (dx / L) * thick / 2;
  return solidFromPoly([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], z0, z1, 'railing');
}

export class World {
  solids: Solid[] = [];
  roofH: (x: number, y: number) => number = () => -Infinity;

  /** Highest support under (x, y) reachable from `feet`; -Infinity if none. */
  groundAt(x: number, y: number, feet: number): number {
    let best = -Infinity;
    for (const s of this.solids) {
      if (s.off || s.z1 > feet + STEP_UP || s.z1 <= best) continue;
      const [x0, y0, x1, y1] = s.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (pointInRing(x, y, s.ring)) best = s.z1;
    }
    return best;
  }

  /** Height of the floor surface right below a point (x, y, z): the highest floor / ground / stair top at or below z. */
  floorBelow(x: number, y: number, z: number, withGround = false): number | null {
    let best = -Infinity;
    for (const s of this.solids) {
      if (s.off || s.z1 > z + 0.01 || s.z1 <= best) continue;
      if (s.tag !== 'floor' && s.tag !== 'terrace' && s.tag !== 'stair' && !(withGround && s.tag === 'ground')) continue;
      const [x0, y0, x1, y1] = s.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (pointInRing(x, y, s.ring)) best = s.z1;
    }
    return Number.isFinite(best) ? best : null;
  }

  /** Push a circle (x, y, r) out of blocking solids for a body spanning feet..feet+height. */
  resolve(pos: { x: number; y: number }, r: number, feet: number, height: number): void {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const s of this.solids) {
        if (s.off || s.z1 <= feet + STEP_UP || s.z0 >= feet + height) continue;
        const [x0, y0, x1, y1] = s.bbox;
        if (pos.x < x0 - r || pos.x > x1 + r || pos.y < y0 - r || pos.y > y1 + r) continue;
        const inside = pointInRing(pos.x, pos.y, s.ring);
        let best = Infinity, bx = 0, by = 0;
        const ring = s.ring;
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i], [cx, cy] = ring[(i + 1) % ring.length];
          const ex = cx - ax, ey = cy - ay;
          const t = Math.max(0, Math.min(1, ((pos.x - ax) * ex + (pos.y - ay) * ey) / (ex * ex + ey * ey || 1)));
          const px = ax + ex * t, py = ay + ey * t;
          const d = Math.hypot(pos.x - px, pos.y - py);
          if (d < best) { best = d; bx = px; by = py; }
        }
        if (inside) {
          const d = best || 1e-6;
          pos.x = bx + ((bx - pos.x) / d) * r;
          pos.y = by + ((by - pos.y) / d) * r;
          moved = true;
        } else if (best < r) {
          const d = best || 1e-6;
          pos.x = bx + ((pos.x - bx) / d) * r;
          pos.y = by + ((pos.y - by) / d) * r;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /** True if the sloped roof is too low for a body standing at (x, y). */
  headBlocked(x: number, y: number, feet: number, height: number): boolean {
    const h = this.roofH(x, y);
    return h > feet && h < feet + height;
  }
}
