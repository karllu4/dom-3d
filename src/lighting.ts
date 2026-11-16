import * as THREE from 'three';
import type { HouseJ } from './types';
import { makeRoofHeight } from './roof';

/**
 * Lighting design per room label (data from build_house.py `lighting`):
 *  - recessed LED downlights (white trim, glowing lens), drawn as one InstancedMesh per room, lit by downward spot cones
 *  - linear LED battens (garage, utility), LED strips (under the kitchen beam, bathroom wall, attic coves)
 *  - pendants over the dining table, LED step lights along the stairs
 * Each room gets 1-3 real point lights (shadowless) at the centres of its fixture groups; the fixtures glow.
 */
export interface RoomLight { id: string; level: string; lights: THREE.Light[]; glows: THREE.MeshStandardMaterial[]; on: boolean }

const WARM = 0xffdcb0;
const POWER = 0.32;
const SPOT = 3.6;   // light output of one recessed LED spot (same units as the other fixtures' power) // overall dimmer (tuned so a fully lit floor is not overexposed)

function glowMat() {
  return new THREE.MeshStandardMaterial({ color: 0xe8e4dc, emissive: WARM, emissiveIntensity: 0, roughness: 0.35 });
}

function strip(a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material, w = 0.025, h = 0.012): THREE.Mesh {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  return m;
}

/** Attic fixtures re-mount to whatever ceiling exists in the current attic view (bare rafters / wool / boards). */
interface Mover { obj: THREE.Object3D; x: number; y: number; off: number; inst?: { mesh: THREE.InstancedMesh; i: number } }
const movers: Mover[] = [];
let mountAt: (x: number, y: number, mode: number) => number = () => 0;

export function setAtticMount(mode: number) {
  const m = new THREE.Matrix4();
  const touched = new Set<THREE.InstancedMesh>();
  for (const mv of movers) {
    const z = mountAt(mv.x, mv.y, mode) + mv.off;
    if (mv.inst) { m.makeTranslation(mv.x, z, mv.y); mv.inst.mesh.setMatrixAt(mv.inst.i, m); touched.add(mv.inst.mesh); }
    else mv.obj.position.y = z;
  }
  touched.forEach((t) => { t.instanceMatrix.needsUpdate = true; t.computeBoundingSphere(); });
}

export function buildLighting(h: HouseJ, levels: Record<string, THREE.Group>): RoomLight[] {
  const roofH = makeRoofHeight(h.roof, true);
  const af = h.atticFinish;
  const dropV = af ? (af.woolUnder + af.board) * Math.sqrt(1 + h.roof.k * h.roof.k) : 0;
  const trim = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.4, metalness: 0.4 });
  const ringGeo = new THREE.CylinderGeometry(0.048, 0.048, 0.008, 24);
  const lensGeo = new THREE.CylinderGeometry(0.032, 0.026, 0.012, 20);
  const out: RoomLight[] = [];
  const s3 = Math.sqrt(1 + h.roof.k * h.roof.k);
  // ceiling surface in the attic for each view: 0 = bare (rafter underside), 1 = wool face, 2 = plasterboard
  mountAt = (x, y, mode) => {
    const r = roofH(x, y);
    if (mode === 0) return r;
    const flatCeil = (af ? af.ceilingHeight : 2.8);
    const floor = atticFloorAt(x, y);
    const fin = Math.min(floor + flatCeil, r - dropV);
    return mode === 1 ? fin + (af?.board ?? 0.025) * (fin < floor + flatCeil - 1e-3 ? s3 : 1) : fin;
  };
  const atticFloors = (h.lighting ?? []).filter((l) => l.level !== 'parter');
  const atticFloorAt = (x: number, y: number) => {
    let best = atticFloors[0]?.floorZ ?? 3.34, bd = Infinity;
    for (const l of atticFloors) { const d = Math.hypot(l.center[0] - x, l.center[1] - y); if (d < bd) { bd = d; best = l.floorZ; } }
    return best;
  };

  for (const L of h.lighting ?? []) {
    const g = levels[L.level];
    const attic = L.level !== 'parter';
    const track = (obj: THREE.Object3D, x: number, y: number) => { if (attic) movers.push({ obj, x, y, off: obj.position.y - ceilAt(x, y) }); };
    const glow = glowMat();
    const lights: THREE.Light[] = [];
    // ceiling height at a plan point: ground floor ceiling; attic = finished ceiling (flat 2.80 or lined slope)
    const ceilAt = (x: number, y: number) => {
      if (L.ceilZ != null) return L.ceilZ;
      const flat = L.floorZ + (af?.ceilingHeight ?? 2.8);
      return Math.min(flat, roofH(x, y) - dropV);
    };
    const addLight = (x: number, y: number, z: number, power: number) => {
      const pl = new THREE.PointLight(WARM, 0, 0, 2);
      pl.position.set(x, z, y);
      pl.userData.power = power;
      g.add(pl);
      lights.push(pl);
      track(pl, x, y);
    };
    // recessed downlights shine down only: a wide cone from just under the ceiling, so the ceiling itself stays unlit
    const addSpot = (x: number, y: number, z: number, power: number) => {
      const sl = new THREE.SpotLight(WARM, 0, 0, THREE.MathUtils.degToRad(62), 0.75, 2);
      sl.position.set(x, z, y);
      sl.target.position.set(x, z - 3, y);
      sl.userData.power = power;
      g.add(sl, sl.target);
      lights.push(sl);
      track(sl, x, y);
    };

    // --- recessed downlights (only where the ceiling is at least 2.2 m above the floor)
    const dl = (L.downlights ?? []).filter(([x, y]) => ceilAt(x, y) - L.floorZ > 2.2);
    if (dl.length) {
      const rings = new THREE.InstancedMesh(ringGeo, trim, dl.length);
      const lenses = new THREE.InstancedMesh(lensGeo, glow, dl.length);
      const m = new THREE.Matrix4();
      dl.forEach(([x, y], i) => {
        const z = ceilAt(x, y);
        m.makeTranslation(x, z - 0.004, y); rings.setMatrixAt(i, m);
        m.makeTranslation(x, z - 0.008, y); lenses.setMatrixAt(i, m);
        if (attic) {
          movers.push({ obj: rings, x, y, off: -0.004, inst: { mesh: rings, i } });
          movers.push({ obj: lenses, x, y, off: -0.008, inst: { mesh: lenses, i } });
        }
      });
      g.add(rings, lenses);
      // light sources: downward cones among the fixtures (up to 3 per room, split along the longer axis)
      const xs = dl.map((p) => p[0]), ys = dl.map((p) => p[1]);
      const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      const groups = Math.min(3, dl.length);
      const sorted = [...dl].sort((a, b) => (wide ? a[0] - b[0] : a[1] - b[1]));
      for (let k = 0; k < groups; k++) {
        const part = sorted.slice(Math.floor((k * sorted.length) / groups), Math.floor(((k + 1) * sorted.length) / groups));
        const cx = part.reduce((s, p) => s + p[0], 0) / part.length, cy = part.reduce((s, p) => s + p[1], 0) / part.length;
        addSpot(cx, cy, ceilAt(cx, cy) - 0.02, (SPOT * dl.length) / groups);   // every spot adds the same light, whatever the room size
      }
    }

    // --- surface-mounted ceiling lamps: white opal drum with a thin black rim
    for (const [x, y] of L.lamps ?? []) {
      const z = ceilAt(x, y);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.21, 0.09, 40), trim);
      body.position.set(x, z - 0.045, y);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.228, 0.228, 0.012, 40), black);
      rim.position.set(x, z - 0.006, y);
      const diffuser = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.01, 40), glow);
      diffuser.position.set(x, z - 0.092, y);
      g.add(body, rim, diffuser);
      for (const o of [body, rim, diffuser]) track(o, x, y);
      addLight(x, y, z - 0.3, (6 + 0.6 * L.area) / (L.lamps?.length ?? 1));
    }

    // --- linear LED battens (garage / utility)
    for (const [x0, y0, x1, y1] of L.battens ?? []) {
      const z = ceilAt((x0 + x1) / 2, (y0 + y1) / 2);
      const bt = strip(new THREE.Vector3(x0, z - 0.03, y0), new THREE.Vector3(x1, z - 0.03, y1), trim, 0.08, 0.05);
      const bg = strip(new THREE.Vector3(x0, z - 0.056, y0), new THREE.Vector3(x1, z - 0.056, y1), glow, 0.06, 0.004);
      g.add(bt, bg);
      track(bt, (x0 + x1) / 2, (y0 + y1) / 2); track(bg, (x0 + x1) / 2, (y0 + y1) / 2);
      addLight((x0 + x1) / 2, (y0 + y1) / 2, z - 0.25, 4 + 0.35 * L.area);
    }

    // --- pendants over the dining table: black shade on a thin cable
    if (L.pendants?.length) {
      for (const [x, y] of L.pendants) {
        const z = L.pendantTopZ ?? ceilAt(x, y);   // e.g. hung from the underside of a beam
        const drop = L.pendantBottom != null ? z - L.floorZ - L.pendantBottom - 0.14 : (L.pendantDrop ?? 0.8);
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, drop, 6), black);
        cable.position.set(x, z - drop / 2, y);
        const shade = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.2, 32, 1, true), black);
        shade.material.side = THREE.DoubleSide;
        shade.position.set(x, z - drop - 0.06, y);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), glow);
        bulb.position.set(x, z - drop - 0.12, y);
        const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), black);
        rose.position.set(x, z - 0.01, y);
        g.add(cable, shade, bulb, rose);
      }
      const cx = L.pendants.reduce((s, p) => s + p[0], 0) / L.pendants.length, cy = L.pendants.reduce((s, p) => s + p[1], 0) / L.pendants.length;
      addLight(cx, cy, L.floorZ + (L.pendantBottom ?? ceilAt(cx, cy) - L.floorZ - (L.pendantDrop ?? 0.8)) - 0.15, 7);
    }

    // --- table / bedside lamps standing on furniture: linen drum shade on a slim base
    for (const [x, y, z] of L.tableLamps ?? []) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.04, 20), black);
      base.position.set(x, z + 0.02, y);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 8), black);
      stem.position.set(x, z + 0.18, y);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.18, 28, 1, true), glow);
      shade.material.side = THREE.DoubleSide;
      shade.position.set(x, z + 0.36, y);
      g.add(base, stem, shade);
      addLight(x, y, z + 0.36, 1.2);
    }

    // --- floor lamps (reading corner by the sofa): black round base, slim pole, linen drum shade at 1.5 m
    for (const [x, y] of L.floorLamps ?? []) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 28), black);
      base.position.set(x, L.floorZ + 0.01, y);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.42, 10), black);
      pole.position.set(x, L.floorZ + 0.73, y);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.3, 32, 1, true), glow);
      shade.material.side = THREE.DoubleSide;
      shade.position.set(x, L.floorZ + 1.55, y);
      g.add(base, pole, shade);
      addLight(x, y, L.floorZ + 1.5, 2);
    }

    // --- wall sconces (e.g. above a bed headboard): wall plate, short arm, linen cylinder shade.
    //     [x, y, z, dir]: point on the wall face, absolute height, dir = degrees of the outward normal (0 = +y, 90 = +x)
    for (const [x, y, z, dir] of L.wallLamps ?? []) {
      const nx = Math.sin(THREE.MathUtils.degToRad(dir)), ny = Math.cos(THREE.MathUtils.degToRad(dir));
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.015, 20), black);
      plate.rotation.x = Math.PI / 2; plate.rotation.y = THREE.MathUtils.degToRad(dir);   // disc flat against the wall
      plate.position.set(x + nx * 0.008, z, y + ny * 0.008);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.015, 0.12), black);
      arm.rotation.y = THREE.MathUtils.degToRad(dir);
      arm.position.set(x + nx * 0.07, z, y + ny * 0.07);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.16, 24, 1, true), glow);
      shade.material.side = THREE.DoubleSide;
      shade.position.set(x + nx * 0.16, z, y + ny * 0.16);
      g.add(plate, arm, shade);
      addLight(x + nx * 0.16, y + ny * 0.16, z, 1.2);
    }

    // --- linear pendant over the dining table: black bar with opal underside on two cables
    if (L.linearPendant) {
      const lp = L.linearPendant;
      const [x0, y0] = lp.from, [x1, y1] = lp.to;
      const z = ceilAt((x0 + x1) / 2, (y0 + y1) / 2);
      const zb = L.floorZ + lp.bottom;
      const bar = strip(new THREE.Vector3(x0, zb + 0.04, y0), new THREE.Vector3(x1, zb + 0.04, y1), black, 0.09, 0.06);
      const lit = strip(new THREE.Vector3(x0, zb + 0.008, y0), new THREE.Vector3(x1, zb + 0.008, y1), glow, 0.07, 0.006);
      g.add(bar, lit);
      for (const t of [0.08, 0.92]) {
        const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
        g.add(strip(new THREE.Vector3(cx, zb + 0.07, cy), new THREE.Vector3(cx, z, cy), black, 0.004, 0.004));
      }
      addLight((x0 + x1) / 2, (y0 + y1) / 2, zb - 0.1, 6);
    }

    // --- LED strip on both long sides of a ceiling beam (kitchen / dining)
    if (L.beamStrip) {
      const b = h.beams?.find((x) => x.id === L.beamStrip);
      if (b) {
        const [x0, y0, x1, y1] = b.rect;
        for (const yy of [y0 - 0.005, y1 + 0.005]) g.add(strip(new THREE.Vector3(x0 + 0.05, b.bottom + 0.02, yy), new THREE.Vector3(x1 - 0.05, b.bottom + 0.02, yy), glow, 0.012, 0.012));
        addLight((x0 + x1) / 2, (y0 + y1) / 2, b.bottom - 0.05, 3);
      }
    }

    // --- LED wall strip (bathroom mirror line)
    if (L.wallStrip) {
      const [x0, y0, x1, y1, z] = L.wallStrip;
      g.add(strip(new THREE.Vector3(x0, z, y0), new THREE.Vector3(x1, z, y1), glow, 0.03, 0.02));
    }

    // --- low orientation lights: small recessed LED bricks in the wall 30 cm above the floor, light aimed down at the floor
    //     [x, y, dir]: point on the wall face, dir = outward normal in degrees (0 = +y, 90 = +x)
    for (const [x, y, dir] of L.lowLights ?? []) {
      const nx = Math.sin(THREE.MathUtils.degToRad(dir)), ny = Math.cos(THREE.MathUtils.degToRad(dir));
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.01), black);
      frame.rotation.y = THREE.MathUtils.degToRad(dir);
      frame.position.set(x + nx * 0.004, L.floorZ + 0.3, y + ny * 0.004);
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.025, 0.012), glow);
      lens.rotation.y = THREE.MathUtils.degToRad(dir);
      lens.position.set(x + nx * 0.005, L.floorZ + 0.29, y + ny * 0.005);
      g.add(frame, lens);
      addLight(x + nx * 0.15, y + ny * 0.15, L.floorZ + 0.25, 0.9);
    }

    // --- stair step lights: small LED bricks in the wall beside every 2nd tread
    if (L.stairLights) {
      const st = h.stairs;
      for (let i = 1; i < st.treads; i += 2) {
        const x = st.x0 + (i + 0.5) * st.tread, z = (i + 1) * st.rise + 0.25;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.012), glow);
        m.position.set(x, z, st.y1 - 0.006);
        g.add(m);
      }
      addLight(st.x0 + st.tread * st.treads * 0.5, (st.y0 + st.y1) / 2, 1.6, 3);
    }

    // --- attic cove: hidden LED line along the edge of the flat ceiling (indirect glow)
    for (const line of L.cove) {
      const z = L.floorZ + (af?.ceilingHeight ?? 2.8) - 0.02;
      for (let i = 0; i < line.length - 1; i++) {
        g.add(strip(new THREE.Vector3(line[i][0], z, line[i][1]), new THREE.Vector3(line[i + 1][0], z, line[i + 1][1]), glow, 0.02, 0.01));
      }
    }
    if (L.cove.length) addLight(L.center[0], L.center[1], L.floorZ + (af?.ceilingHeight ?? 2.8) - 0.3, 2 + 0.15 * L.area);

    out.push({ id: L.id, level: L.level, lights, glows: [glow], on: false });
  }
  // ceiling cassette air conditioners: white panel with 4 outlet slots + corner outlets and a central intake grille,
  // the unit body sits above the ceiling (visible only while the attic ceiling is open)
  const white = new THREE.MeshStandardMaterial({ color: 0xf3f3f1, roughness: 0.45 });
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x3a3c3f, roughness: 0.6 });
  const grilleMat = new THREE.MeshStandardMaterial({ color: 0xe2e2df, roughness: 0.7 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xa9adb1, roughness: 0.5, metalness: 0.4 });
  for (const u of h.hvac ?? []) {
    const [x, y] = u.at, P = u.panel, [B, BH] = u.body;
    const attic = u.level !== 'parter';
    const ceil = attic ? mountAt(x, y, 2) : 2.93;
    const parts: THREE.Mesh[] = [];
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, dx: number, dz: number, dy: number) => {
      const mesh = new THREE.Mesh(geo, m); mesh.position.set(x + dx, ceil + dz, y + dy); parts.push(mesh); levels[u.level].add(mesh);
    };
    add(new THREE.BoxGeometry(B, BH, B), bodyMat, 0, BH / 2, 0);                                     // unit above the ceiling
    add(new THREE.BoxGeometry(P, 0.05, P), white, 0, -0.025, 0);                                     // decorative panel
    const g = P * 0.55;                                                                              // central intake grille
    add(new THREE.BoxGeometry(g, 0.004, g), grilleMat, 0, -0.051, 0);
    for (let i = -6; i <= 6; i++) add(new THREE.BoxGeometry(g * 0.96, 0.004, 0.006), slotMat, 0, -0.0515, (i * g) / 14);
    const so = P / 2 - 0.1, sl = P * 0.55, sw = 0.065;                                               // 4 outlet slots
    for (const [dx, dy, rot] of [[0, -so, 0], [0, so, 0], [-so, 0, 1], [so, 0, 1]] as const)
      add(new THREE.BoxGeometry(rot ? sw : sl, 0.004, rot ? sl : sw), slotMat, dx, -0.051, dy);
    const co = P / 2 - 0.1;                                                                          // corner outlets
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const c = new THREE.BoxGeometry(0.12, 0.004, 0.035); c.rotateY(sx * sy > 0 ? -Math.PI / 4 : Math.PI / 4);
      add(c, slotMat, sx * co, -0.051, sy * co);
    }
    if (attic) for (const m of parts) movers.push({ obj: m, x, y, off: m.position.y - ceil });
  }
  return out;
}

export function setLight(r: RoomLight, on: boolean) {
  r.on = on;
  for (const l of r.lights) l.intensity = on ? l.userData.power * POWER : 0;
  for (const m of r.glows) m.emissiveIntensity = on ? 3 : 0;
}
