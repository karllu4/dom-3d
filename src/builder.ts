import * as THREE from 'three';
import { solidFromRect, type Solid, type World } from './physics';

/**
 * Live build tool: draw boxes (walls, boards, foam, ...) straight into the model.
 * Click two opposite corners at the crosshair. A flat selection (both corners on one plane) becomes a board of the chosen
 * thickness, extruded away from you so its front face lies exactly on the plane you clicked. Corners snap to the nearest existing
 * plane (wall faces, floors, other pieces) so new pieces line up with the building.
 * Coordinates in the UI and the export are plan x, plan y, height z (m); three.js uses (x, z, y) internally.
 */
export interface Piece { kind: number; min: [number, number, number]; max: [number, number, number] }   // plan x, plan y, height

export const BUILD_KINDS = [
  { id: 'wall', label: 'wall (facade finish)' },
  { id: 'osb', label: 'OSB board' },
  { id: 'foam', label: 'graphite foam' },
  { id: 'concrete', label: 'raw concrete' },
  { id: 'timber', label: 'timber' },
  { id: 'demolish', label: 'DEMOLISH (cuts existing walls / slabs)' },
] as const;
const CUT = 5;
const MAX_CUTS = 16;

const SNAP_DIST = 0.15;
const STORE = 'buildPieces-v1';

export class BuildTool {
  active = false;
  kind = 1;
  thick = 0.02;
  snap = true;
  pieces: Piece[] = [];
  private start: THREE.Vector3 | null = null;
  private group = new THREE.Group();
  private built: { mesh: THREE.Mesh | null; solid: Solid | null }[] = [];
  cutDepth = 0.5;                                   // flat demolish selections cut this deep (m), away from you
  private cutMin = { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector3(1e9, 1e9, 1e9)) };
  private cutMax = { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector3(-1e9, -1e9, -1e9)) };
  private origSolids: Solid[];
  private cursor: THREE.Mesh;
  private preview: THREE.LineSegments;
  private ray = new THREE.Raycaster();
  private cand: [number[], number[], number[]] | null = null;   // snap planes along x, y(up), z(plan y)
  /** what the last cursor update saw, for the HUD */
  info = '';
  private mats: THREE.Material[];

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, private world: World, mats: { facade: THREE.Material; osb: THREE.Material; epsGraphite: THREE.Material; concrete: THREE.Material; timber: THREE.Material }) {
    this.mats = [mats.facade, mats.osb, mats.epsGraphite, mats.concrete, mats.timber];
    this.origSolids = world.solids.slice();
    this.patchMaterials(scene);
    this.group.name = 'built';
    scene.add(this.group);
    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: 0x35d07f, depthTest: false }));
    this.cursor.renderOrder = 1000; this.cursor.visible = false; scene.add(this.cursor);
    this.preview = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x35d07f, depthTest: false }));
    this.preview.renderOrder = 1000; this.preview.visible = false; scene.add(this.preview);
    this.cursorColor();
    try { for (const p of JSON.parse(localStorage.getItem(STORE) ?? '[]') as Piece[]) this.add(p, false); } catch { /* ignore */ }
  }

  /** Every material in the house discards fragments inside a demolish box (shared uniforms). */
  private patchMaterials(root: THREE.Object3D) {
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.name === 'built' || o.parent?.name === 'built') return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (seen.has(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
        seen.add(mat);
        const prev = mat.onBeforeCompile, key = mat.customProgramCacheKey();
        mat.onBeforeCompile = (sh, r) => {
          prev.call(mat, sh, r);
          sh.uniforms.uCutMin = this.cutMin; sh.uniforms.uCutMax = this.cutMax;
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCutWP;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvCutWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vCutWP;\nuniform vec3 uCutMin[${MAX_CUTS}];\nuniform vec3 uCutMax[${MAX_CUTS}];`)
            .replace('void main() {', `void main() {\n  for (int ci = 0; ci < ${MAX_CUTS}; ci++) if (all(greaterThan(vCutWP, uCutMin[ci])) && all(lessThan(vCutWP, uCutMax[ci]))) discard;`);
        };
        mat.customProgramCacheKey = () => key + '|cut';
        mat.needsUpdate = true;
      }
    });
  }

  private cursorColor() { /* cursor stays green; the preview turns red for demolish in update() */ }

  /** Recompute the collision solids: originals minus every demolish box, plus the built pieces. */
  private rebuildSolids() {
    const cuts = this.pieces.filter((p) => p.kind === CUT);
    const out: Solid[] = [];
    for (const sd of this.origSolids) {
      let parts: Solid[] = [sd];
      if (!['door', 'garage-door', 'furniture', 'railing', 'ground'].includes(sd.tag ?? '')) {
        for (const c of cuts) parts = parts.flatMap((q) => this.carve(q, c));
      }
      out.push(...parts);
    }
    for (const b of this.built) if (b.solid) out.push(b.solid);
    this.world.solids.length = 0;
    this.world.solids.push(...out);
    this.cand = null;
    this.cutMin.value.forEach((v) => v.set(1e9, 1e9, 1e9)); this.cutMax.value.forEach((v) => v.set(-1e9, -1e9, -1e9));
    cuts.slice(0, MAX_CUTS).forEach((c, i) => { this.cutMin.value[i].set(c.min[0], c.min[2], c.min[1]); this.cutMax.value[i].set(c.max[0], c.max[2], c.max[1]); });
  }

  /** A solid minus a box: the z-slices outside the box stay whole, the slice inside loses the box's plan rectangle. */
  private carve(sd: Solid, c: Piece): Solid[] {
    const [bx0, by0, bx1, by1] = sd.bbox;
    if (bx1 <= c.min[0] || bx0 >= c.max[0] || by1 <= c.min[1] || by0 >= c.max[1] || sd.z1 <= c.min[2] || sd.z0 >= c.max[2]) return [sd];
    const mk = (ring: [number, number][], z0: number, z1: number): Solid | null => ring.length >= 3 && z1 - z0 > 0.002 ? { ...solidFromRect([0, 0, 1, 1], z0, z1, sd.tag), ring: ring as Solid['ring'], bbox: this.ringBox(ring) } : null;
    const res: Solid[] = [];
    const lo = Math.max(sd.z0, c.min[2]), hi = Math.min(sd.z1, c.max[2]);
    const a = mk(sd.ring as [number, number][], sd.z0, lo); if (a) res.push(a);
    const b = mk(sd.ring as [number, number][], hi, sd.z1); if (b) res.push(b);
    const halves: [number, number, number, number][] = [
      [-1e9, -1e9, c.min[0], 1e9], [c.max[0], -1e9, 1e9, 1e9],
      [c.min[0], -1e9, c.max[0], c.min[1]], [c.min[0], c.max[1], c.max[0], 1e9]];
    for (const h of halves) { const r = this.clipRect(sd.ring as [number, number][], h); const m = mk(r, lo, hi); if (m) res.push(m); }
    return res;
  }

  private ringBox(r: [number, number][]): [number, number, number, number] {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }

  /** Sutherland–Hodgman: polygon clipped to an axis-aligned rectangle. */
  private clipRect(poly: [number, number][], [x0, y0, x1, y1]: [number, number, number, number]): [number, number][] {
    const edges: [(p: [number, number]) => number][] = [[(p) => p[0] - x0], [(p) => x1 - p[0]], [(p) => p[1] - y0], [(p) => y1 - p[1]]];
    let pts = poly;
    for (const [f] of edges) {
      const next: [number, number][] = [];
      for (let i = 0; i < pts.length; i++) {
        const P = pts[i], Q = pts[(i + 1) % pts.length], fp = f(P), fq = f(Q);
        if (fp >= 0) next.push(P);
        if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); next.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
      }
      pts = next; if (!pts.length) break;
    }
    return pts;
  }

  toggle(v = !this.active) {
    this.active = v;
    this.start = null;
    this.cand = null;
    this.cursor.visible = this.preview.visible = false;
    return v;
  }

  private shown(o: THREE.Object3D | null) { for (; o; o = o.parent) if (!o.visible) return false; return true; }

  /** Surface under the crosshair. */
  private hit(): { p: THREE.Vector3; n: THREE.Vector3 } | null {
    this.ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const h = this.ray.intersectObjects(this.scene.children, true).find((x) => (x.object as THREE.Mesh).isMesh && this.shown(x.object)
      && x.object !== this.cursor && x.object !== this.preview && !(x.object as THREE.Mesh).geometry.type.startsWith('Sphere'));
    if (!h) return null;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { p: h.point.clone(), n };
  }

  private candidates() {
    if (this.cand) return this.cand;
    const xs = new Set<number>(), ys = new Set<number>(), zs = new Set<number>();
    const r = (v: number) => Math.round(v * 1000) / 1000;
    for (const s of this.world.solids) {
      if (s.off || s.tag === 'ground' || s.tag === 'furniture' || s.tag === 'railing') continue;
      zs.add(r(s.z0)); zs.add(r(s.z1));
      for (const [x, y] of s.ring) { xs.add(r(x)); ys.add(r(y)); }
    }
    this.cand = [[...xs], [...zs], [...ys]];   // index order: three.js x, y (up), z (plan y)
    return this.cand;
  }

  private snapped(p: THREE.Vector3): THREE.Vector3 {
    if (!this.snap) return p;
    const c = this.candidates(), q = p.clone(), a = [q.x, q.y, q.z];
    const out: number[] = [];
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      let best = a[i], bd = SNAP_DIST;
      for (const v of c[i]) { const d = Math.abs(v - a[i]); if (d < bd) { bd = d; best = v; } }
      if (best !== a[i]) names.push('xzy'[i === 0 ? 0 : i === 1 ? 2 : 1]);
      out.push(best);
    }
    this.info = names.length ? `snapped to plane ${names.join(', ')}` : 'no plane near';
    return new THREE.Vector3(out[0], out[1], out[2]);
  }

  /** Per-frame: move the cursor dot and the preview box. */
  update() {
    if (!this.active) return;
    const h = this.hit();
    if (!h) { this.cursor.visible = this.preview.visible = false; this.info = 'no surface'; return; }
    const p = this.snapped(h.p);
    this.cursor.position.copy(p); this.cursor.visible = true;
    if (this.start) {
      const [mn, mx] = this.box(this.start, p);
      this.preview.visible = true;
      (this.preview.material as THREE.LineBasicMaterial).color.set(this.kind === CUT ? 0xff3b30 : 0x35d07f);
      this.preview.position.copy(mn).add(mx).multiplyScalar(0.5);
      this.preview.scale.copy(mx.clone().sub(mn));
    } else this.preview.visible = false;
  }

  /** Box between two corners; any flat dimension becomes `thick`, extruded away from the camera. */
  private box(a: THREE.Vector3, b: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const mn = new THREE.Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
    const mx = new THREE.Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
    const cam = this.camera.position;
    for (const k of ['x', 'y', 'z'] as const) {
      if (mx[k] - mn[k] < 0.01) {
        const t = this.kind === CUT ? this.cutDepth : this.thick;
        if (cam[k] > mn[k]) mn[k] -= t; else mx[k] += t;
      }
    }
    return [mn, mx];
  }

  /** Click: first corner, then second corner creates the piece. Returns a message for the toast. */
  click(): string {
    const h = this.hit();
    if (!h) return 'No surface at the crosshair';
    const p = this.snapped(h.p);
    if (!this.start) { this.start = p; return `Corner 1: x ${p.x.toFixed(2)} y ${p.z.toFixed(2)} z ${p.y.toFixed(2)} — aim at the opposite corner and click`; }
    const [mn, mx] = this.box(this.start, p);
    this.start = null; this.preview.visible = false;
    const piece: Piece = { kind: this.kind, min: [mn.x, mn.z, mn.y], max: [mx.x, mx.z, mx.y] };
    this.add(piece);
    return `${BUILD_KINDS[this.kind].label} added: ${this.fmt(piece)}`;
  }

  fmt(p: Piece) { const f = (v: number) => v.toFixed(3); return `x ${f(p.min[0])}–${f(p.max[0])}, y ${f(p.min[1])}–${f(p.max[1])}, z ${f(p.min[2])}–${f(p.max[2])}`; }

  private add(p: Piece, save = true) {
    if (p.kind === CUT) { this.pieces.push(p); this.built.push({ mesh: null, solid: null }); this.rebuildSolids(); if (save) this.save(); return; }
    const sz = new THREE.Vector3(p.max[0] - p.min[0], p.max[2] - p.min[2], p.max[1] - p.min[1]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sz.x, sz.y, sz.z), this.mats[p.kind] ?? this.mats[1]);
    mesh.position.set((p.min[0] + p.max[0]) / 2, (p.min[2] + p.max[2]) / 2, (p.min[1] + p.max[1]) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
    const solid = solidFromRect([p.min[0], p.min[1], p.max[0], p.max[1]], p.min[2], p.max[2], 'built');
    this.world.solids.push(solid);
    this.pieces.push(p); this.built.push({ mesh, solid });
    this.cand = null;
    if (save) this.save();
  }

  /** Cancel a half-drawn piece, else remove the last one. */
  undo(): string {
    if (this.start) { this.start = null; this.preview.visible = false; return 'Corner cancelled'; }
    const b = this.built.pop(); this.pieces.pop();
    if (!b) return 'Nothing to undo';
    if (b.mesh) { this.group.remove(b.mesh); b.mesh.geometry.dispose(); }
    if (b.solid) { const i = this.world.solids.indexOf(b.solid); if (i >= 0) this.world.solids.splice(i, 1); }
    else this.rebuildSolids();
    this.cand = null; this.save();
    return 'Last piece removed';
  }

  clear() { while (this.built.length) this.undo(); this.start = null; }

  setKind(k: number) { this.kind = k; }
  nudgeThickness(d: number) {
    if (this.kind === CUT) this.cutDepth = Math.max(0.02, Math.round((this.cutDepth + d * 10) * 1000) / 1000);
    else this.thick = Math.max(0.005, Math.round((this.thick + d) * 1000) / 1000);
  }

  private save() { try { localStorage.setItem(STORE, JSON.stringify(this.pieces)); } catch { /* private mode */ } }

  /** All pieces as text to paste back to the author. */
  exportText(): string {
    return this.pieces.map((p, i) => `B${i + 1} ${BUILD_KINDS[p.kind].id}: ${this.fmt(p)}`).join('\n');
  }

  status(): string {
    const kinds = BUILD_KINDS.map((k, i) => `${i + 1}${k.id === 'demolish' ? '' : ''} ${k.id}${i === this.kind ? ' ◄' : ''}`).join(' · ');
    return `BUILD  ${this.start ? 'click the opposite corner' : 'click the first corner'} · ${this.info}\n${kinds}\n`
      + `${this.kind === CUT ? 'cut depth ' + (this.cutDepth * 100).toFixed(0) : 'thickness ' + (this.thick * 100).toFixed(1)} cm (, .) · snap ${this.snap ? 'on' : 'off'} (H) · Z undo · Shift+X delete all · \\ copy list · right-click cancel · J exit\n`
      + `${this.pieces.length} piece(s)${this.pieces.length ? ' · last: ' + this.fmt(this.pieces[this.pieces.length - 1]) : ''}`;
  }
}
