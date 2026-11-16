import * as THREE from 'three';
import type { HouseJ } from './types';
import type { World } from './physics';
import { solidFromRect } from './physics';
import { makeRoofHeight } from './roof';

/**
 * Interior design v1: simple, clean furniture models built from boxes/cylinders (toggle with F).
 * Palette: light oak, warm white fronts, anthracite accents, grey fabric — matches the Winchester windows.
 */
export function buildFurniture(h: HouseJ, world: World): Record<string, THREE.Group> {
  const groups: Record<string, THREE.Group> = { parter: new THREE.Group(), poddasze: new THREE.Group() };
  for (const k in groups) groups[k].name = 'furniture';
  let g = groups.parter;      // current item group (positioned at the floor height of its level)
  let z0 = 0;
  const M = (color: number, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const oak = M(0xc49a6c, 0.55), white = M(0xf2efe8, 0.45), anth = M(0x2f3236, 0.5, 0.2), worktop = M(0x3a3a3c, 0.35);
  const fabric = M(0x8e8a84, 0.95), fabricDark = M(0x6d6a66, 0.95), steel = M(0xb9bcc0, 0.3, 0.8), glassBlack = M(0x111214, 0.15, 0.3);
  const rugMat = M(0xd9d2c4, 1);
  const plasterboard = M(0xeceae5, 0.9);
  const roofH = makeRoofHeight(h.roof, true);              // underside of the rafters (bay roofs only over their walls)

  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: THREE.Material) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0), Math.abs(y1 - y0)), m);
    b.position.set((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2);
    b.castShadow = true; b.receiveShadow = true;
    g.add(b);
    return b;
  };
  /** local helper for rotated items: build in a sub-group around (x, y) facing `rot` (0 = +y). */
  const sub = (x: number, y: number, rot = 0) => {
    const s = new THREE.Group();
    s.position.set(x, 0, y);
    s.rotation.y = THREE.MathUtils.degToRad(rot);
    g.add(s);
    const b = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0), Math.abs(y1 - y0)), m);
      mesh.position.set((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2);
      mesh.castShadow = true; mesh.receiveShadow = true;
      s.add(mesh);
      return mesh;
    };
    return { s, b };
  };
  const block = (r: [number, number, number, number], z1: number) => world.solids.push(solidFromRect(r, z0 - 0.05, z0 + z1, 'furniture'));
  const white2 = M(0xfbfbf9, 0.25), chrome = M(0xd8dadc, 0.2, 0.9), glassClear = new THREE.MeshStandardMaterial({ color: 0xcfe3ea, roughness: 0.05, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const linen = M(0xe9e4da, 0.95), duvet = M(0xd8d0c2, 0.9), rubber = M(0x2b2b2b, 0.95), wood2 = M(0xa77b52, 0.6);
  const cyl = (x: number, y: number, za: number, zb: number, r: number, m: THREE.Material, seg = 20) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, zb - za, seg), m); c.position.set(x, (za + zb) / 2, y); c.castShadow = true; g.add(c); return c;
  };

  // oiled oak with vertical flutes (canvas texture + bump), one material per front so the flute pitch stays ~2 cm
  const fluteCanvas = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 4;
    const x = c.getContext('2d')!;
    for (let i = 0; i < 64; i++) { const t = Math.sin((i / 64) * Math.PI); const v = Math.round(150 + 105 * t); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i, 0, 1, 4); }
    return c;
  })();
  const fluted = (w: number, _h: number) => {
    const bump = new THREE.CanvasTexture(fluteCanvas);
    bump.wrapS = THREE.RepeatWrapping; bump.repeat.set(Math.max(1, Math.round(w / 0.02)), 1);
    const shade = bump.clone(); shade.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ color: 0xd2a676, map: shade, bumpMap: bump, bumpScale: 3, roughness: 0.6 });
  };

  for (const f of h.furniture ?? []) {
    const r = f.rect;
    z0 = f.z ?? 0;
    g = new THREE.Group();
    g.position.y = z0;
    groups[z0 > 2 ? 'poddasze' : 'parter'].add(g);
    switch (f.type) {
      case 'counter': {               // base cabinets: plinth, white fronts, dark worktop
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 0.9;
        box(x0 + 0.05, y0 + 0.05, 0, x1 - 0.05, y1 - 0.05, 0.1, anth);
        box(x0, y0, 0.1, x1, y1, H - 0.04, white);
        box(x0 - 0.01, y0 - 0.01, H - 0.04, x1 + 0.01, y1 + 0.01, H, worktop);
        if (f.sink) { const [sx, sy] = f.sink; box(sx - 0.4, sy - 0.22, H - 0.002, sx + 0.4, sy + 0.22, H + 0.004, steel);
          box(sx + 0.3, sy + 0.12, H, sx + 0.33, sy + 0.15, H + 0.3, steel); }
        if (f.hob) {
          // induction cooktop: black glass, 4 zones, oriented along the counter
          const [hx, hy] = f.hob; const alongY = y1 - y0 > x1 - x0;
          const hw = alongY ? 0.26 : 0.3, hd = alongY ? 0.3 : 0.26;
          box(hx - hw, hy - hd, H, hx + hw, hy + hd, H + 0.006, glassBlack);
          for (const [ax, ay] of [[-0.13, -0.15], [0.13, -0.15], [-0.13, 0.15], [0.13, 0.15]]) {
            const zx = alongY ? ax : ay, zy = alongY ? ay : ax;
            const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.004, 4, 32), M(0x55585c, 0.4));
            ring.rotation.x = Math.PI / 2; ring.position.set(hx + zx, H + 0.007, hy + zy); g.add(ring);
          }
          if (f.hood) {   // slim anthracite chimney hood on the wall above
            const wx = x0, hw2 = alongY ? 0.0 : 0.0; void hw2;
            if (alongY) { box(wx, hy - 0.45, 1.55, wx + 0.5, hy + 0.45, 1.62, anth); box(wx, hy - 0.15, 1.62, wx + 0.25, hy + 0.15, 2.93, anth); }
            else { box(hx - 0.45, y1 - 0.5, 1.55, hx + 0.45, y1, 1.62, anth); box(hx - 0.15, y1 - 0.25, 1.62, hx + 0.15, y1, 2.93, anth); }
          }
        }
        block(r!, H);
        break;
      }
      case 'tall': {                  // tall units (fridge / oven column)
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 2.2;
        box(x0, y0, 0, x1, y1, H, white);
        for (let y = y0 + 0.6; y < y1 - 0.05; y += 0.6) box(x0 - 0.003, y - 0.004, 0.12, x0, y + 0.004, H - 0.02, anth); // door gaps
        block(r!, H);
        break;
      }
      case 'bar': {                   // bar counter between kitchen and dining: oak top on a white body
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 1.05;
        box(x0, y0 + 0.05, 0, x1, y1, H - 0.04, white);
        box(x0 - 0.03, y0 - 0.12, H - 0.04, x1 + 0.03, y1 + 0.02, H, oak);
        block(r!, H);
        break;
      }
      case 'stool': {
        const [x, y] = f.at!;
        const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 24), oak); seat.position.set(x, 0.75, y);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 10), anth); pole.position.set(x, 0.36, y);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 24), anth); foot.position.set(x, 0.01, y);
        for (const m of [seat, pole, foot]) { m.castShadow = true; g.add(m); }
        break;
      }
      case 'table': {                 // dining table: oak top, slim dark legs
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 0.75;
        box(x0, y0, H - 0.04, x1, y1, H, oak);
        for (const [lx, ly] of [[x0 + 0.06, y0 + 0.06], [x1 - 0.06, y0 + 0.06], [x0 + 0.06, y1 - 0.06], [x1 - 0.06, y1 - 0.06]])
          box(lx - 0.025, ly - 0.025, 0, lx + 0.025, ly + 0.025, H - 0.04, anth);
        block(r!, H);
        break;
      }
      case 'chair': {
        const [x, y] = f.at!; const { b } = sub(x, y, f.rot);
        b(-0.22, -0.22, 0.44, 0.22, 0.22, 0.48, fabric);           // seat
        b(-0.22, -0.26, 0.48, 0.22, -0.22, 0.88, fabric);          // back (behind = -y local)
        for (const [lx, ly] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) b(lx - 0.015, ly - 0.015, 0, lx + 0.015, ly + 0.015, 0.44, anth);
        break;
      }
      case 'sofa': {                  // rect = footprint; rot = facing direction
        const [x0, y0, x1, y1] = r!;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const across = Math.abs(f.rot ?? 0) === 90 ? y1 - y0 : x1 - x0;     // length of the sofa
        const depth = Math.abs(f.rot ?? 0) === 90 ? x1 - x0 : y1 - y0;
        const { b } = sub(cx, cy, f.rot);
        const L = across / 2, D = depth / 2;
        b(-L, -D, 0.08, L, D, 0.42, fabric);                       // base + seat
        b(-L, -D, 0.42, L, -D + 0.2, 0.82, fabricDark);           // backrest
        b(-L, -D, 0.42, -L + 0.18, D, 0.62, fabricDark);          // arms
        b(L - 0.18, -D, 0.42, L, D, 0.62, fabricDark);
        const n = Math.max(1, Math.round((across - 0.36) / 0.75));
        const cw = (across - 0.36) / n;
        for (let i = 0; i < n; i++) b(-L + 0.18 + i * cw + 0.01, -D + 0.2, 0.42, -L + 0.18 + (i + 1) * cw - 0.01, D - 0.02, 0.5, fabric); // cushions
        for (const [lx, ly] of [[-L + 0.05, -D + 0.05], [L - 0.05, -D + 0.05], [-L + 0.05, D - 0.05], [L - 0.05, D - 0.05]]) b(lx - 0.02, ly - 0.02, 0, lx + 0.02, ly + 0.02, 0.08, anth);
        block(r!, 0.82);
        break;
      }
      case 'coffee': {
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 0.4;
        box(x0, y0, H - 0.03, x1, y1, H, oak);
        box(x0 + 0.05, y0 + 0.05, 0, x1 - 0.05, y1 - 0.05, 0.06, anth);
        box(x0 + 0.08, y0 + 0.08, 0.06, x1 - 0.08, y1 - 0.08, H - 0.03, anth);
        block(r!, H);
        break;
      }
      case 'tvunit': {                // low oak cabinet + wall-mounted TV
        const [x0, y0, x1, y1] = r!;
        box(x0, y0, 0.12, x1, y1, 0.5, oak);
        const cy = (y0 + y1) / 2, wx = Math.max(x0, x1) - 0.03;
        box(wx - 0.03, cy - 0.73, 1.0, wx, cy + 0.73, 1.83, glassBlack);   // 65" TV on the wall
        block(r!, 0.5);
        break;
      }
      case 'rtv': {                   // fluted oak TV cabinet, modelled on "Bruno 48" (200 x 48 x 42 cm): door | niche + 2 drawers | door
        const [x0, y0, x1, y1] = r!;
        const side = Math.abs(f.rot ?? 0) === 90;
        const W = side ? y1 - y0 : x1 - x0, D = side ? x1 - x0 : y1 - y0, H = f.h ?? 0.48;
        const { b } = sub((x0 + x1) / 2, (y0 + y1) / 2, f.rot ?? 0);        // local: width along x, front at +y
        const L = W / 2, F = D / 2, T = 0.025, P = 0.05;                    // board thickness, plinth height
        const fronts = (u0: number, u1: number, v0: number, v1: number) => b(u0 + 0.002, F - 0.02, v0 + 0.002, u1 - 0.002, F, v1 - 0.002, fluted(u1 - u0, v1 - v0));
        b(-L + 0.04, -F + 0.04, 0, L - 0.04, F - 0.05, P, anth);               // recessed plinth
        b(-L, -F, H - T, L, F, H, oak);                                        // top
        b(-L, -F, P, -L + T, F - 0.02, H - T, oak);  b(L - T, -F, P, L, F - 0.02, H - T, oak);  // sides
        b(-L, -F, P, L, -F + 0.01, H - T, oak);                                // back
        b(-L + T, -F, P, L - T, F - 0.02, P + T, oak);                         // bottom
        const dw = 0.5;                                                        // side doors 50 cm, drawers in the middle
        const m0 = -L + T + dw, m1 = L - T - dw;
        b(m0 - 0.01, -F, P, m0 + 0.01, F - 0.02, H - T, oak); b(m1 - 0.01, -F, P, m1 + 0.01, F - 0.02, H - T, oak);   // partitions
        const nicheBot = H - T - 0.2;                                          // 20 cm open niche for a decoder / console
        b(m0, -F, nicheBot - T, m1, F - 0.02, nicheBot, oak);
        b(m0 + 0.01, -F + 0.012, nicheBot, m1 - 0.01, -F + 0.02, H - T, M(0x6e5038, 0.7));   // dark back of the niche
        fronts(-L + T, m0, P + T, H - T);  fronts(m1, L - T, P + T, H - T);  // doors
        fronts(m0, 0, P + T, nicheBot - T);  fronts(0, m1, P + T, nicheBot - T);   // 2 drawers side by side
        const grip = M(0x4a3524, 0.8);                                         // grips routed into the top edge of each front
        for (const [u, top] of [[(-L + T + m0) / 2, H - T], [(m1 + L - T) / 2, H - T], [m0 / 2, nicheBot - T], [m1 / 2, nicheBot - T]])
          b(u - 0.06, F - 0.004, top - 0.025, u + 0.06, F + 0.001, top - 0.004, grip);
        block(r!, H);
        if (f.tv) b(-0.62, -F + 0.02, H + 0.45, 0.62, -F + 0.05, H + 0.45 + 0.71, glassBlack);   // 55" TV on the wall above
        break;
      }
      case 'bed': {                   // bed: oak frame, mattress, headboard on the `head` side, pillows, duvet
        const [x0, y0, x1, y1] = r!;
        const head = f.head ?? ((f.rot ?? 0) === -90 ? 'x1' : 'x0');
        const alongX = head[0] === 'x';                     // bed length runs along x
        const hs = head[1] === '1' ? 1 : -1;               // headboard at the max (+1) or min (-1) end
        const [a0, a1, b0, b1] = alongX ? [x0, x1, y0, y1] : [y0, y1, x0, x1];   // a = length axis, b = width axis
        const B = (p0: number, p1: number, q0: number, q1: number, zA: number, zB: number, m: THREE.Material) =>
          alongX ? box(p0, q0, zA, p1, q1, zB, m) : box(q0, p0, zA, q1, p1, zB, m);
        B(a0, a1, b0, b1, 0.08, 0.3, oak);
        B(a0 + 0.04, a1 - 0.04, b0 + 0.04, b1 - 0.04, 0.3, 0.52, linen);
        const ha = hs > 0 ? a1 : a0;
        B(Math.min(ha, ha - hs * 0.08), Math.max(ha, ha - hs * 0.08), b0 - 0.03, b1 + 0.03, 0.08, 1.0, fabricDark);
        const pa0 = Math.min(ha - hs * 0.12, ha - hs * 0.5), pa1 = Math.max(ha - hs * 0.12, ha - hs * 0.5);
        const wide = b1 - b0 > 1.2;
        if (wide) { B(pa0, pa1, b0 + 0.1, (b0 + b1) / 2 - 0.04, 0.52, 0.64, white); B(pa0, pa1, (b0 + b1) / 2 + 0.04, b1 - 0.1, 0.52, 0.64, white); }
        else B(pa0, pa1, b0 + 0.1, b1 - 0.1, 0.52, 0.64, white);
        const fa = hs > 0 ? a0 : a1;
        B(Math.min(fa, fa + hs * 1.3), Math.max(fa, fa + hs * 1.3), b0 + 0.02, b1 - 0.02, 0.52, 0.58, duvet);
        block(r!, 0.6);
        break;
      }
      case 'nightstand': {
        const [x, y] = f.at!;
        box(x - 0.22, y - 0.2, 0.12, x + 0.22, y + 0.2, 0.5, oak);
        box(x - 0.22, y - 0.2, 0.5, x + 0.22, y + 0.2, 0.55, wood2);
        for (const [lx, ly] of [[-0.18, -0.16], [0.18, -0.16], [-0.18, 0.16], [0.18, 0.16]]) box(x + lx - 0.015, y + ly - 0.015, 0, x + lx + 0.015, y + ly + 0.015, 0.12, anth);
        break;
      }
      case 'wardrobe': {              // wardrobe; door gaps on the `front` side (default: x1 for axis y, else y0)
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 2.2;
        box(x0, y0, 0, x1, y1, H, f.open ? oak : white);
        const front = f.front ?? (f.axis === 'y' ? 'x1' : 'y0');
        const alongY = front[0] === 'x';
        const fp = { x0, x1, y0, y1 }[front], out = front[1] === '1' ? 1 : -1;   // front plane and its outward direction
        const s0 = alongY ? y0 : x0, len = alongY ? y1 - y0 : x1 - x0;
        const n = Math.max(2, Math.round(len / (f.builtin ? 0.55 : 0.5)));
        // thin anthracite strip on the front face, spanning [a0,a1] along the front and [za,zb] in height
        const strip = (a0: number, a1: number, za: number, zb: number, m = anth) => alongY
          ? box(fp - 0.002 * out, a0, za, fp + 0.004 * out, a1, zb, m)
          : box(a0, fp - 0.002 * out, za, a1, fp + 0.004 * out, zb, m);
        const top = f.builtin ? H - 0.55 : H;                // built-in: separate top cabinets up to the ceiling
        if (!f.open) {
          for (let i = 1; i < n; i++) { const t = s0 + (len * i) / n; strip(t - 0.003, t + 0.003, 0.05, H - (f.builtin ? 0 : 0.05)); }
          if (f.builtin) {
            strip(s0, s0 + len, top - 0.003, top + 0.003);                        // gap between tall doors and top cabinets
            strip(s0, s0 + len, 0, 0.06, M(0xe4e0d8, 0.5));                       // recessed plinth line
            for (let i = 0; i < n; i++) {                                          // slim vertical bar handles next to the meeting gaps
              const a = s0 + (len * (i + (i % 2 ? 0.1 : 0.9))) / n;
              strip(a - 0.008, a + 0.008, 0.95, 1.35, steel);
            }
          }
        }
        else for (let zz = 0.35; zz < H; zz += 0.4) box(x0 + 0.02, y0 + 0.02, zz, x1 - 0.02, y1 - 0.02, zz + 0.02, white);  // open shelves
        block(r!, H);
        break;
      }
      case 'bookcase': {              // open oak bookcase: sides, back, shelves, rows of books; open on the `front` side
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 2.0, t = 0.02;
        const front = f.front ?? 'x0', alongY = front[0] === 'x', out = front[1] === '1' ? 1 : -1;
        const s0 = alongY ? y0 : x0, s1 = alongY ? y1 : x1;                       // along the shelf
        const d0 = alongY ? x0 : y0, d1 = alongY ? x1 : y1;                       // depth (front at d0 if out = -1)
        const bk = out < 0 ? d1 : d0;                                             // back plane
        // b(a0, a1, e0, e1, z0, z1): a = along the shelf, e = depth
        const b = (a0: number, a1: number, e0: number, e1: number, za: number, zb: number, m: THREE.Material) =>
          alongY ? box(e0, a0, za, e1, a1, zb, m) : box(a0, e0, za, a1, e1, zb, m);
        b(s0, s0 + t, d0, d1, 0, H, oak); b(s1 - t, s1, d0, d1, 0, H, oak);      // sides
        b(s0 + t, s1 - t, Math.min(bk, bk + out * 0.008), Math.max(bk, bk + out * 0.008), 0.06, H, white);                  // back panel
        b(s0 + t, s1 - t, d0 + 0.01, d1 - 0.01, 0, 0.06, oak);                    // plinth
        const nSh = Math.max(3, Math.round(H / 0.36)), pitch = (H - 0.06) / nSh;
        const bookCols = [0x7a2e2a, 0x2f4a6b, 0x3d5c3a, 0xc9b28a, 0x5a4636, 0x8c8c88, 0x2b2b2b, 0xa0522d];
        const bookMats = bookCols.map((c) => M(c, 0.85));
        const clothMats = [0xe8e4dc, 0xb9b3a8, 0x6f7782, 0x34404f, 0x8a9a8c, 0xc7b8a0, 0x4a4a4c, 0xd8c8c8].map((c) => M(c, 0.95));
        let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
        const depth = Math.abs(d1 - d0);
        for (let i = 0; i <= nSh; i++) {
          const z = 0.06 + i * pitch;
          b(s0 + t, s1 - t, d0, d1, z - t, z, oak);                                 // shelf (top board on the last one)
          if (i === nSh) break;
          if (f.fill === 'none') continue;
          if (f.fill === 'clothes') {                                                // stacks of folded clothes
            let a = s0 + t + 0.03;
            while (a + 0.28 < s1 - t - 0.02) {
              if (rnd() > 0.15) {
                const n2 = 2 + Math.floor(rnd() * 4), dp = Math.min(depth - 0.06, 0.3);
                const e0 = bk + out * 0.03, e1 = e0 + out * dp; let zz = z;
                for (let k = 0; k < n2 && zz + 0.06 < z + pitch - 0.08; k++) {
                  const th = 0.04 + rnd() * 0.03;
                  b(a, a + 0.28, Math.min(e0, e1), Math.max(e0, e1), zz, zz + th, clothMats[Math.floor(rnd() * clothMats.length)]);
                  zz += th;
                }
              }
              a += 0.32;
            }
            continue;
          }
          let a = s0 + t + 0.02; const end = s1 - t - (i % 2 ? 0.25 : 0.05);       // leave some gaps
          while (a < end - 0.02) {
            const w = 0.02 + rnd() * 0.03, hb = Math.min(pitch - 0.04, 0.2 + rnd() * 0.1), dp = Math.min(depth - 0.04, 0.16 + rnd() * 0.08);
            const e0 = bk + out * 0.01, e1 = e0 + out * dp;                            // from the back towards the front
            b(a, Math.min(a + w, end), Math.min(e0, e1), Math.max(e0, e1), z, z + hb, bookMats[Math.floor(rnd() * bookMats.length)]);
            a += w + 0.002;
          }
        }
        block(r!, H);
        break;
      }
      case 'partition': {             // plasterboard stud wall; top follows the underside of the roof (capped at f.h above the floor)
        const [x0, y0, x1, y1] = r!; const cap = f.h ?? 2.8;
        const alongX = x1 - x0 >= y1 - y0, len = alongX ? x1 - x0 : y1 - y0;
        const n = Math.max(1, Math.ceil(len / 0.1));
        const topAt = (x: number, y: number) => { const z = roofH(x, y) - z0; return Number.isFinite(z) ? Math.min(cap, z) : cap; };
        let lowest = cap;
        for (let i = 0; i < n; i++) {                                  // short segments so the top can follow roof breaks
          const a = (alongX ? x0 : y0) + (len * i) / n, b = (alongX ? x0 : y0) + (len * (i + 1)) / n;
          const [sx0, sy0, sx1, sy1] = alongX ? [a, y0, b, y1] : [x0, a, x1, b];
          const seg = box(sx0, sy0, 0, sx1, sy1, 1, plasterboard);
          const pos = seg.geometry.attributes.position as THREE.BufferAttribute;
          for (let k = 0; k < pos.count; k++) {                        // box local coords: centred; move the vertices to world-sized heights
            const wx = seg.position.x + pos.getX(k), wy = seg.position.z + pos.getZ(k);
            const top = topAt(wx, wy); lowest = Math.min(lowest, top);
            pos.setY(k, (pos.getY(k) > 0 ? top : 0) - seg.position.y);
          }
          pos.needsUpdate = true; seg.geometry.computeVertexNormals(); seg.geometry.computeBoundingSphere();
        }
        block(r!, lowest);
        break;
      }
      case 'dresser': {               // low chest of drawers (fits under the slope)
        const [x0, y0, x1, y1] = r!; const H = f.h ?? 0.8;
        box(x0, y0, 0.08, x1, y1, H, white);
        box(x0 - 0.01, y0 - 0.01, H, x1 + 0.01, y1 + 0.01, H + 0.03, oak);
        block(r!, H);
        break;
      }
      case 'desk': {
        const [x0, y0, x1, y1] = r!;
        if (f.monitor) {             // 27" monitor on a stand near the wall, keyboard in front
          const w = f.wall ?? 'x0', cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const alongY = w[0] === 'x';                     // wall is x = const -> screen spans y
          const off = w[1] === '1' ? -1 : 1;               // direction from the wall into the room
          const wx = w === 'x0' ? x0 : w === 'x1' ? x1 : cx, wy = w === 'y0' ? y0 : w === 'y1' ? y1 : cy;
          const sx = alongY ? wx + off * 0.15 : cx, sy = alongY ? cy : wy + off * 0.15;
          if (alongY) { box(sx - 0.015, sy - 0.31, 0.88, sx + 0.015, sy + 0.31, 1.25, glassBlack); box(sx - 0.07, sy - 0.1, 0.75, sx + 0.07, sy + 0.1, 0.76, anth); box(sx - 0.015, sy - 0.02, 0.76, sx + 0.015, sy + 0.02, 0.9, anth);
            box(sx + off * 0.3 - 0.07, sy - 0.22, 0.75, sx + off * 0.3 + 0.07, sy + 0.22, 0.77, anth); }
          else { box(sx - 0.31, sy - 0.015, 0.88, sx + 0.31, sy + 0.015, 1.25, glassBlack); box(sx - 0.1, sy - 0.07, 0.75, sx + 0.1, sy + 0.07, 0.76, anth); box(sx - 0.02, sy - 0.015, 0.76, sx + 0.02, sy + 0.015, 0.9, anth);
            box(sx - 0.22, sy + off * 0.3 - 0.07, 0.75, sx + 0.22, sy + off * 0.3 + 0.07, 0.77, anth); }
        }
        box(x0, y0, 0.72, x1, y1, 0.75, oak);
        box(x0 + 0.02, y0, 0, x0 + 0.05, y1, 0.72, anth);
        box(x1 - 0.06, y0 + 0.02, 0, x1 - 0.03, y0 + 0.05, 0.72, anth); box(x1 - 0.06, y1 - 0.05, 0, x1 - 0.03, y1 - 0.02, 0.72, anth);
        block(r!, 0.75);
        break;
      }
      case 'armchair': {
        const [x, y] = f.at!; const { b } = sub(x, y, f.rot);
        b(-0.4, -0.38, 0.12, 0.4, 0.38, 0.42, fabric);
        b(-0.4, -0.38, 0.42, 0.4, -0.22, 0.85, fabricDark);
        b(-0.4, -0.38, 0.42, -0.28, 0.38, 0.62, fabricDark); b(0.28, -0.38, 0.42, 0.4, 0.38, 0.62, fabricDark);
        break;
      }
      case 'tub': {                   // freestanding bathtub under the roof windows
        const [x0, y0, x1, y1] = r!;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const tub = new THREE.Mesh(new THREE.CapsuleGeometry((y1 - y0) / 2, x1 - x0 - (y1 - y0), 8, 24), white2);
        tub.rotation.z = Math.PI / 2; tub.scale.set(0.75, 1, 1); tub.position.set(cx, 0.32, cy); tub.castShadow = true; g.add(tub);
        box(x0 + 0.1, y0 + 0.08, 0.5, x1 - 0.1, y1 - 0.08, 0.52, M(0x9fc4d4, 0.1));                    // water
        cyl(x1 + 0.08, cy, 0, 0.95, 0.015, chrome);                                                       // floor tap
        block(r!, 0.6);
        break;
      }
      case 'cornertub': {             // corner bathtub: two sides on the walls, curved front
        const [x0, y0, x1, y1] = r!; const S = Math.min(x1 - x0, y1 - y0), H = 0.58;
        const c = f.corner ?? 'x0y0';
        const outline = (inset: number) => {        // local frame: corner at (0,0), walls along +u and +v
          const sh = new THREE.Shape(), a = 0.42, e = S - inset;
          sh.moveTo(inset, inset); sh.lineTo(e, inset); sh.lineTo(e, a);
          sh.bezierCurveTo(e, a + (e - a) * 0.55, a + (e - a) * 0.55, e, a, e);
          sh.lineTo(inset, e); sh.closePath();
          return sh;
        };
        const s = new THREE.Group();
        s.position.set(c[1] === '0' ? x0 : x1, 0, c[3] === '0' ? y0 : y1);
        s.scale.set(c[1] === '0' ? 1 : -1, 1, c[3] === '0' ? 1 : -1);
        g.add(s);
        const flat = (sh: THREE.Shape, z: number, depth: number, m: THREE.Material) => {
          const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 24 });
          const mesh = new THREE.Mesh(geo, m);
          mesh.rotation.x = Math.PI / 2; mesh.position.y = z;        // shape (u, v) -> world (x, z); extrudes downward
          mesh.castShadow = true; mesh.receiveShadow = true; s.add(mesh); return mesh;
        };
        const rim = outline(0); rim.holes.push(outline(0.11));
        flat(rim, H, H, white2);                                      // apron + rim
        flat(outline(0.11), 0.2, 0.2, white2);                        // basin bottom
        flat(outline(0.11), 0.48, 0.005, M(0x9fc4d4, 0.1));           // water
        const tx = 0.06, ty = S * 0.5;                                // deck tap on the wall-side rim
        const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 12), chrome);
        tap.position.set(tx, H + 0.09, ty); s.add(tap);
        const spout = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.025), chrome);
        spout.position.set(tx + 0.06, H + 0.17, ty); s.add(spout);
        block(r!, H);
        break;
      }
      case 'shower': {                // walk-in shower (corner or built into a niche): tray, glass panel, wall-mounted rain head + riser
        const [x0, y0, x1, y1] = r!; const w = f.wall ?? 'x1';
        box(x0, y0, 0, x1, y1, 0.02, M(0x9a9a98, 0.6));
        box(x0 + 0.04, y1 - 0.12, 0.021, x1 - 0.04, y1 - 0.09, 0.023, steel);           // linear drain
        // fixed glass panel on the open side opposite the head wall (none for a shower built into a niche)
        if (f.builtin) { /* walled on three sides */ }
        else if (w[0] === 'x') { const gx = w === 'x1' ? x0 : x1; box(gx, y0, 0.02, gx + (w === 'x1' ? 0.008 : -0.008), y1, 2.0, glassClear); }
        else { const gy = w === 'y1' ? y0 : y1; box(x0, gy, 0.02, x1, gy + (w === 'y1' ? 0.008 : -0.008), 2.0, glassClear); }
        const alongY = w[0] === 'x', off = w[1] === '1' ? -1 : 1;                       // direction from the wall into the shower
        const wx = w === 'x0' ? x0 : x1, wy = w === 'y0' ? y0 : y1;
        const hp = f.builtin ? 0.5 : 0.7, H = 2.05, arm = 0.42;                                            // head along the wall (fraction), height, arm length
        const [px, py] = alongY ? [wx, y0 + (y1 - y0) * hp] : [x0 + (x1 - x0) * hp, wy];
        const ox = alongY ? off : 0, oy = alongY ? 0 : off;
        cyl(px + ox * 0.03, py + oy * 0.03, 0.95, H, 0.012, chrome);                    // riser on the wall
        box(px + ox * 0.01 - 0.04 * oy, py + oy * 0.01 - 0.04 * ox, 1.05, px + ox * 0.06 + 0.04 * oy, py + oy * 0.06 + 0.04 * ox, 1.17, chrome); // mixer
        const a0x = px + ox * 0.03, a0y = py + oy * 0.03, a1x = px + ox * arm, a1y = py + oy * arm;
        box(Math.min(a0x, a1x) - 0.01, Math.min(a0y, a1y) - 0.01, H - 0.02, Math.max(a0x, a1x) + 0.01, Math.max(a0y, a1y) + 0.01, H, chrome); // arm
        cyl(a1x, a1y, H - 0.03, H - 0.01, 0.15, chrome, 32);                            // rain head
        break;
      }
      case 'vanity': {                // wall-hung double vanity, 2 basins
        const [x0, y0, x1, y1] = r!; const n = f.sinks ?? 1;
        box(x0, y0, 0.45, x1, y1, 0.82, oak);
        box(x0, y0, 0.82, x1, y1, 0.85, white2);
        for (let i = 0; i < n; i++) {
          const cx = x0 + ((x1 - x0) * (i + 0.5)) / n;
          box(cx - 0.22, y0 + 0.05, 0.85, cx + 0.22, y1 - 0.08, 0.97, white2);
          cyl(cx, y1 - 0.04, 0.97, 1.15, 0.012, chrome);
        }
        box(x0 + 0.05, y1 - 0.01, 1.2, x1 - 0.05, y1, 2.05, M(0xc8d4d8, 0.05, 0.6));   // mirror
        block(r!, 0.97);
        break;
      }
      case 'wc': {                    // wall-hung WC
        const [x, y] = f.at!; const { b } = sub(x, y, f.rot);
        b(-0.18, -0.3, 0.32, 0.18, 0.25, 0.42, white2);
        b(-0.2, -0.33, 0.42, 0.2, 0.25, 0.44, white2);
        b(-0.25, -0.38, 0, 0.25, -0.33, 1.15, white2);         // concealed cistern box
        b(-0.1, -0.33, 0.95, 0.1, -0.32, 1.1, chrome);
        break;
      }
      case 'laundry': {               // washer with dryer stacked on top
        const [x0, y0, x1, y1] = r!;
        for (const zb of [0.02, 0.88]) {
          box(x0, y0, zb, x1, y1, zb + 0.85, white2);
          const d = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 8, 28), chrome);
          d.position.set((x0 + x1) / 2, zb + 0.45, y0 - 0.005); g.add(d);
          const gl = new THREE.Mesh(new THREE.CircleGeometry(0.15, 28), M(0x23272b, 0.1));
          gl.position.set((x0 + x1) / 2, zb + 0.45, y0 - 0.006); gl.rotation.y = Math.PI; g.add(gl);
        }
        block(r!, 1.75);
        break;
      }
      case 'mat': {
        const [x0, y0, x1, y1] = r!;
        const m = box(x0, y0, 0.0015, x1, y1, 0.012, rubber); m.castShadow = false;
        break;
      }
      case 'treadmill': {
        const [x0, y0, x1, y1] = r!;
        box(x0, y0, 0.05, x1, y1, 0.2, anth);
        box(x0 + 0.12, y0 + 0.05, 0.2, x1 - 0.12, y1 - 0.25, 0.21, rubber);
        box(x0 + 0.02, y1 - 0.2, 0.2, x0 + 0.06, y1 - 0.15, 1.3, anth); box(x1 - 0.06, y1 - 0.2, 0.2, x1 - 0.02, y1 - 0.15, 1.3, anth);
        box(x0 + 0.02, y1 - 0.35, 1.25, x1 - 0.02, y1 - 0.12, 1.35, anth);
        block(r!, 1.35);
        break;
      }
      case 'bench': {                 // weight bench with a barbell rack
        const [x, y] = f.at!;
        box(x - 0.15, y - 0.6, 0.38, x + 0.15, y + 0.6, 0.46, rubber);
        box(x - 0.04, y - 0.5, 0, x + 0.04, y + 0.5, 0.38, anth);
        for (const sx of [-0.45, 0.45]) box(x + sx - 0.025, y - 0.65, 0, x + sx + 0.025, y - 0.6, 1.15, anth);
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.8, 10), chrome); bar.rotation.z = Math.PI / 2; bar.position.set(x, 1.12, y - 0.62); g.add(bar);
        for (const sx of [-0.75, 0.75]) { const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 28), rubber); pl.rotation.z = Math.PI / 2; pl.position.set(x + sx, 1.12, y - 0.62); g.add(pl); }
        block([x - 0.5, y - 0.7, x + 0.5, y + 0.6], 1.15);
        break;
      }
      case 'rack': {                  // dumbbell rack
        const [x0, y0, x1, y1] = r!;
        box(x0, y0, 0, x0 + 0.04, y1, 0.8, anth); box(x1 - 0.04, y0, 0, x1, y1, 0.8, anth);
        for (const zz of [0.35, 0.7]) {
          box(x0, y0, zz - 0.02, x1, y1, zz, anth);
          for (let yy = y0 + 0.12; yy < y1 - 0.08; yy += 0.18) { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.32, 14), rubber); d.rotation.z = Math.PI / 2; d.position.set((x0 + x1) / 2, zz + 0.06, yy); g.add(d); }
        }
        block(r!, 0.8);
        break;
      }
      case 'rug': {
        const [x0, y0, x1, y1] = r!;
        const m = box(x0, y0, 0.001, x1, y1, 0.012, rugMat); m.castShadow = false;
        break;
      }
    }
  }
  return groups;
}
