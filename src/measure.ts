import * as THREE from 'three';
import type { World } from './physics';
import { pointInRing } from './geometry';

// Tape measure: press T, then click two points at the crosshair. Distance is shown in cm.
// Points land on the surface hit by the crosshair ray; with snap on (N) they jump to a nearby mesh vertex (corners).

const COLOR = 0xff5a1f;
const SNAP_PX = 14;

type Measurement = { a: THREE.Vector3; b: THREE.Vector3; group: THREE.Group; label: HTMLDivElement };

const visibleChain = (o: THREE.Object3D | null) => {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
};

export class TapeMeasure {
  active = false;
  private ray = new THREE.Raycaster();
  private group = new THREE.Group();
  private list: Measurement[] = [];
  private start: THREE.Vector3 | null = null;
  private startDot: THREE.Mesh;
  private cursorDot: THREE.Mesh;
  private preview: THREE.Line;
  private previewLabel: HTMLDivElement;
  private hit: THREE.Vector3 | null = null;
  private lineMat = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  private dotMat = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  private dotGeo = new THREE.SphereGeometry(0.018, 12, 8);

  constructor(scene: THREE.Scene, private camera: THREE.Camera, private targets: THREE.Object3D, private hud: HTMLElement) {
    this.group.name = 'tape-measure';
    this.group.renderOrder = 999;
    scene.add(this.group);
    this.startDot = this.dot();
    this.cursorDot = this.dot();
    this.preview = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), this.lineMat);
    this.preview.renderOrder = 999;
    this.preview.frustumCulled = false;
    this.group.add(this.startDot, this.cursorDot, this.preview);
    this.previewLabel = this.makeLabel('preview');
    this.syncVisibility();
  }

  private dot() {
    const m = new THREE.Mesh(this.dotGeo, this.dotMat);
    m.renderOrder = 1000;
    return m;
  }

  private makeLabel(cls = '') {
    const d = document.createElement('div');
    d.className = `measure-label ${cls}`;
    this.hud.appendChild(d);
    return d;
  }

  toggle(v = !this.active) {
    this.active = v;
    if (!v) this.start = null;
    document.body.classList.toggle('measuring', v);
    this.syncVisibility();
    return v;
  }

  clear() {
    for (const m of this.list) { this.group.remove(m.group); m.label.remove(); m.group.traverse((o) => (o as THREE.Line).geometry?.dispose()); }
    this.list = [];
    this.start = null;
    this.syncVisibility();
  }

  /** Undo: drop the pending start point, else the last measurement. */
  undo() {
    if (this.start) { this.start = null; }
    else { const m = this.list.pop(); if (m) { this.group.remove(m.group); m.label.remove(); } }
    this.syncVisibility();
  }

  get count() { return this.list.length; }

  /** Place a point at the current crosshair hit. Returns the finished distance (m) when a measurement completes. */
  click(): number | null {
    if (!this.active || !this.hit) return null;
    const p = this.hit.clone();
    if (!this.start) { this.start = p; this.startDot.position.copy(p); this.syncVisibility(); return null; }
    const a = this.start;
    this.start = null;
    return this.commit(a, p);
  }

  /** Store a finished measurement a -> b and return its length (m). */
  private commit(a: THREE.Vector3, p: THREE.Vector3): number {
    const g = new THREE.Group();
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, p]), this.lineMat);
    line.renderOrder = 999; line.frustumCulled = false;
    const da = this.dot(); da.position.copy(a);
    const db = this.dot(); db.position.copy(p);
    g.add(line, da, db);
    this.group.add(g);
    const label = this.makeLabel();
    label.innerHTML = this.text(a, p);
    this.list.push({ a, b: p, group: g, label });
    this.syncVisibility();
    return a.distanceTo(p);
  }

  /** The selected point: the pending start point, else the point under the crosshair. */
  private selected() { return this.start ?? this.hit; }

  /** Distance from the selected point to the nearest wall (horizontal, at the point's height). Returns metres or null. */
  toWall(world: World): number | null {
    const p = this.selected();
    if (!this.active || !p) return null;
    let best = Infinity, bx = 0, by = 0;
    for (const s of world.solids) {
      if (s.tag !== 'wall' || s.off || p.y < s.z0 - 0.02 || p.y > s.z1 + 0.02) continue;
      const [x0, y0, x1, y1] = s.bbox;
      if (p.x < x0 - best || p.x > x1 + best || p.z < y0 - best || p.z > y1 + best) continue;   // cannot beat the best so far
      if (pointInRing(p.x, p.z, s.ring)) continue;                      // standing inside a wall piece: not a wall face to measure to
      const r = s.ring;
      for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [cx, cy] = r[(i + 1) % r.length];
        const ex = cx - ax, ey = cy - ay;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - ay) * ey) / (ex * ex + ey * ey || 1)));
        const qx = ax + ex * t, qy = ay + ey * t, d = Math.hypot(p.x - qx, p.z - qy);
        if (d < best) { best = d; bx = qx; by = qy; }
      }
    }
    if (!Number.isFinite(best)) return null;
    return this.commit(p.clone(), new THREE.Vector3(bx, p.y, by));
  }

  /** Distance from the selected point straight down to the floor (or whatever surface is below). Returns metres or null. */
  toFloor(): number | null {
    const p = this.selected();
    if (!this.active || !p) return null;
    this.ray.set(p.clone().add(new THREE.Vector3(0, 0.002, 0)), new THREE.Vector3(0, -1, 0));
    this.ray.far = 30;
    const hits = this.ray.intersectObject(this.targets, true);
    const h = hits.find((x) => (x.object as THREE.Mesh).isMesh && visibleChain(x.object) && !this.group.getObjectById(x.object.id) && ((x.object as THREE.Mesh).material as THREE.Material | undefined)?.visible !== false);
    if (!h) return null;
    return this.commit(p.clone(), new THREE.Vector3(p.x, h.point.y, p.z));
  }

  private text(a: THREE.Vector3, b: THREE.Vector3) {
    const d = a.distanceTo(b) * 100;
    const h = Math.hypot(b.x - a.x, b.z - a.z) * 100;
    const v = Math.abs(b.y - a.y) * 100;
    const parts = [`<b>${d.toFixed(1)} cm</b>`];
    if (v > 0.5 && h > 0.5) parts.push(`<span>↔ ${h.toFixed(1)} · ↕ ${v.toFixed(1)}</span>`);
    return parts.join(' ');
  }

  private syncVisibility() {
    this.startDot.visible = this.active && !!this.start;
    this.cursorDot.visible = this.active && !!this.hit;
    this.preview.visible = this.active && !!this.start && !!this.hit;
    this.previewLabel.style.display = this.preview.visible ? '' : 'none';
  }

  /** Call every frame (after camera moved). `snap` = snap to nearest vertex. */
  update(width: number, height: number, snap: boolean) {
    if (this.active) {
      this.ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      this.ray.far = 60;
      const hits = this.ray.intersectObject(this.targets, true);
      const h = hits.find((x) => (x.object as THREE.Mesh).isMesh && visibleChain(x.object) && !this.group.getObjectById(x.object.id) && ((x.object as THREE.Mesh).material as THREE.Material | undefined)?.visible !== false);
      this.hit = h ? h.point.clone() : null;
      if (h && snap) this.hit = this.snapToVertex(h, width, height) ?? this.hit;
      if (this.hit) this.cursorDot.position.copy(this.hit);
      this.syncVisibility();
      if (this.start && this.hit) {
        const pos = this.preview.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, this.start.x, this.start.y, this.start.z);
        pos.setXYZ(1, this.hit.x, this.hit.y, this.hit.z);
        pos.needsUpdate = true;
        this.preview.geometry.computeBoundingSphere();
        this.previewLabel.innerHTML = this.text(this.start, this.hit);
        this.place(this.previewLabel, this.start, this.hit, width, height);
      }
      // keep dots a constant on-screen size
      for (const d of [this.startDot, this.cursorDot]) d.scale.setScalar(Math.max(0.3, d.position.distanceTo(this.camera.position) / 2.5));
    } else this.syncVisibility();
    for (const m of this.list) {
      this.place(m.label, m.a, m.b, width, height);
      m.group.children.forEach((c) => { if ((c as THREE.Mesh).isMesh) c.scale.setScalar(Math.max(0.3, c.position.distanceTo(this.camera.position) / 2.5)); });
    }
  }

  private snapToVertex(h: THREE.Intersection, width: number, height: number) {
    const mesh = h.object as THREE.Mesh;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos || !h.face) return null;
    const idx = geo.index;
    const tri = h.faceIndex ?? 0;
    // candidate vertices: the hit triangle + every vertex within 25 cm of the hit (catches neighbouring box corners)
    let best: THREE.Vector3 | null = null, bd = SNAP_PX;
    const v = new THREE.Vector3(), s = new THREE.Vector3();
    const tryV = (i: number) => {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.distanceTo(h.point) > 0.25) return;
      s.copy(v).project(this.camera);
      const d = Math.hypot(s.x * width / 2, s.y * height / 2);
      if (d < bd) { bd = d; best = v.clone(); }
    };
    if (pos.count < 20000) for (let i = 0; i < pos.count; i++) tryV(i);
    else for (let k = 0; k < 3; k++) tryV(idx ? idx.getX(tri * 3 + k) : tri * 3 + k);
    return best;
  }

  private place(el: HTMLDivElement, a: THREE.Vector3, b: THREE.Vector3, width: number, height: number) {
    const m = a.clone().add(b).multiplyScalar(0.5).project(this.camera);
    if (m.z > 1 || m.z < -1) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.transform = `translate(${(m.x + 1) / 2 * width}px, ${(1 - m.y) / 2 * height}px) translate(-50%, -130%)`;
  }
}
