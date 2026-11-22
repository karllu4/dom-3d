import type { RoofJ } from './types';

/** Height of the roof's plane (top of wall plate / underside of rafters) at plan point (x, y), or -Infinity. */
export function makeRoofHeight(roof: RoofJ, forWalls = false) {
  return (x: number, y: number): number => {
    let H = -Infinity;
    for (const p of roof.parts) {
      const [x0, y0, x1, y1] = forWalls ? (p.wallClip ?? p.wallRect ?? p.rect) : p.rect;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      let h = Infinity;
      for (const [a, b, c] of p.planes) h = Math.min(h, a * x + b * y + c);
      H = Math.max(H, h);
    }
    return H;
  };
}

/** Same function as GLSL: `float roofH(vec2 p)` where p = world (x, z). Returns 1e5 where there is no roof. */
/** Wall-clipping version: gable parts only count over their bay walls (wallRect); wallClip narrows it further for walls only (e.g. the main roof's front overhang must not lift the garage wall). */
export function roofGLSL(roof: RoofJ): string {
  const f = (v: number) => v.toFixed(5);
  const body = roof.parts
    .map((p) => {
      const [x0, y0, x1, y1] = p.wallClip ?? p.wallRect ?? p.rect;
      const mins = p.planes.map(([a, b, c]) => `h = min(h, ${f(a)} * p.x + ${f(b)} * p.y + ${f(c)});`).join(' ');
      return `  if (p.x >= ${f(x0)} && p.x <= ${f(x1)} && p.y >= ${f(y0)} && p.y <= ${f(y1)}) { h = 1e5; ${mins} H = max(H, h); }`;
    })
    .join('\n');
  return `float roofH(vec2 p) {\n  float H = -1e5; float h;\n${body}\n  return H < -1e4 ? 1e5 : H;\n}`;
}
