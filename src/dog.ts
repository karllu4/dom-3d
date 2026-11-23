import * as THREE from 'three';
import type { World } from './physics';
import type { PolyJ } from './types';
import { pointInPoly } from './geometry';
import { ZOMBIE_ROUTE } from './zombie';
import type { Skeleton } from './skeleton';

/**
 * Jack Russell terrier (white with a brown-black head and saddle patch), blocky like the skeletons.
 * Stays near you outside, runs down skeletons and bites them (3 bites). Goes round the house on the loop path when the house is in the way.
 */
export class Dog {
  readonly group = new THREE.Group();
  private heading = 0;
  private t = 0;
  private legs: THREE.Group[] = [];
  private tail: THREE.Group;
  private biteT = 0;
  private biteAnim = 0;
  private path: [number, number][] = [];
  private target: Skeleton | null = null;
  private stuckT = 0;
  private last = new THREE.Vector2();
  info = '';
  private downT = 0;
  private stallT = 0;
  private detourT = 0;
  private detourSide = 1;
  /** Knocked over by the boss: lies on its side for a few seconds. */
  knockDown(t = 4) { if (this.downT <= 0) this.onMessage('The boss knocks the terrier down!'); this.downT = t; }
  get isDown() { return this.downT > 0; }

  constructor(private groundZ: number, private world: World, private footprint: PolyJ, private onMessage: (m: string) => void, x = 5.7, z = 12.6) {
    this.group.name = 'dog';
    this.group.position.set(x, groundZ, z);
    const white = new THREE.MeshStandardMaterial({ color: 0xf1ede4, roughness: 0.9 });
    const tan = new THREE.MeshStandardMaterial({ color: 0x9a5a2a, roughness: 0.9 });
    const black = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.6 });
    const box = (p: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; p.add(o); return o;
    };
    box(this.group, 0.2, 0.2, 0.5, white, 0, 0.3, 0);                          // body
    box(this.group, 0.205, 0.1, 0.22, tan, 0, 0.37, -0.08);                    // saddle patch
    const head = new THREE.Group(); head.position.set(0, 0.42, 0.28); this.group.add(head);
    box(head, 0.17, 0.16, 0.17, white, 0, 0, 0); box(head, 0.172, 0.08, 0.175, tan, 0, 0.045, 0);
    box(head, 0.09, 0.08, 0.11, white, 0, -0.03, 0.12); box(head, 0.05, 0.04, 0.03, black, 0, -0.005, 0.18);   // snout + nose
    for (const sx of [-1, 1]) { box(head, 0.04, 0.1, 0.07, tan, sx * 0.095, 0.07, -0.02).rotation.z = sx * 0.4; box(head, 0.03, 0.03, 0.02, black, sx * 0.045, 0.03, 0.088); }   // folded ears, eyes
    this.tail = new THREE.Group(); this.tail.position.set(0, 0.36, -0.26); this.group.add(this.tail);
    box(this.tail, 0.04, 0.2, 0.04, white, 0, 0.1, 0); this.tail.rotation.x = -0.5;
    for (const [lx, lz] of [[-0.07, 0.19], [0.07, 0.19], [-0.07, -0.19], [0.07, -0.19]]) {
      const l = new THREE.Group(); l.position.set(lx, 0.22, lz); this.group.add(l); box(l, 0.055, 0.22, 0.055, white, 0, -0.11, 0); this.legs.push(l);
    }
    this.last.set(x, z);
  }

  private crosses(ax: number, az: number, bx: number, bz: number) {
    for (let i = 0; i <= 14; i++) if (pointInPoly(ax + (bx - ax) * i / 14, az + (bz - az) * i / 14, this.footprint)) return true;
    return false;
  }

  /** Waypoints to (tx, tz): straight if the house is not in the way, otherwise round the loop path by the shorter way. */
  private plan(tx: number, tz: number): [number, number][] {
    const p = this.group.position;
    if (!this.crosses(p.x, p.z, tx, tz)) return [[tx, tz]];
    const R = ZOMBIE_ROUTE, n = R.length;
    const near = (x: number, z: number) => { let bi = 0, bd = 1e9; R.forEach(([rx, rz], i) => { const d = Math.hypot(rx - x, rz - z) + (this.crosses(x, z, rx, rz) ? 100 : 0); if (d < bd) { bd = d; bi = i; } }); return bi; };
    const a = near(p.x, p.z), b = near(tx, tz);
    const fwd = (b - a + n) % n, back = (a - b + n) % n, step = fwd <= back ? 1 : -1;
    const out: [number, number][] = [];
    for (let i = a; ; i = (i + step + n) % n) { out.push(R[i]); if (i === b) break; }
    out.push([tx, tz]);
    // never turn back for a loop point that is behind us
    while (out.length > 2 && Math.hypot(out[1][0] - p.x, out[1][1] - p.z) < Math.hypot(out[1][0] - out[0][0], out[1][1] - out[0][1]) && !this.crosses(p.x, p.z, out[1][0], out[1][1])) out.shift();
    return out;
  }

  private nearestSkeleton(sk: Skeleton[]): Skeleton | null {
    let best: Skeleton | null = null, bd = 32;
    const p = this.group.position;
    for (const s of sk) { if (!s.risen || s.dead || pointInPoly(s.group.position.x, s.group.position.z, this.footprint)) continue; const d = Math.hypot(s.group.position.x - p.x, s.group.position.z - p.z); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  update(dt: number, skeletons: Skeleton[], player: THREE.Vector3) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const g = this.group, p = g.position;
    if (this.downT > 0) {
      this.downT -= dt; this.info = 'Dog: knocked down';
      g.rotation.set(0, this.heading, Math.PI / 2 * Math.min(1, (1 - this.downT / 4 + 0.25) * 4)); g.position.y = this.groundZ + 0.1;
      if (this.downT <= 0) g.rotation.z = 0;
      return;
    }
    if (!this.target || !this.target.risen || this.target.dead) this.target = this.nearestSkeleton(skeletons);
    let tx: number, tz: number, speed: number, hunting = false;
    if (this.target) {
      tx = this.target.group.position.x; tz = this.target.group.position.z; speed = 6.2; hunting = true; this.info = 'Dog: chasing a skeleton';
    } else {
      // stay near the player when outside, wait at the entrance when the player is in the house
      const inside = pointInPoly(player.x, player.z, this.footprint) && player.y < 6;
      if (inside) { tx = 5.7; tz = 12.2; } else { tx = player.x; tz = player.z; }
      const d = Math.hypot(tx - p.x, tz - p.z);
      speed = d > 10 ? 6 : d > 3 ? 3.4 : 0;
      this.info = 'Dog: with you';
    }
    // re-plan a few times per second
    this.stuckT += dt;
    const last = this.path[this.path.length - 1];
    const targetMoved = !last || Math.hypot(last[0] - tx, last[1] - tz) > (hunting ? 1.5 : 2.5);
    if (!this.path.length || targetMoved || this.stuckT > 1.5) { this.path = this.plan(tx, tz); this.stuckT = 0; }
    if (this.path.length) this.path[this.path.length - 1] = [tx, tz];       // the last point follows the target
    while (this.path.length > 1 && Math.hypot(this.path[0][0] - p.x, this.path[0][1] - p.z) < 0.7) this.path.shift();
    let [wx, wz] = this.path[0] ?? [tx, tz];
    if (this.detourT > 0) {                           // stuck on a corner: sidestep for a moment
      this.detourT -= dt;
      const a = Math.atan2(wx - p.x, wz - p.z) + this.detourSide * 1.3;
      wx = p.x + Math.sin(a) * 2; wz = p.z + Math.cos(a) * 2;
    }
    const dist = Math.hypot(wx - p.x, wz - p.z);
    let moving = false;
    const dTarget = () => Math.hypot(tx - p.x, tz - p.z);
    if (speed > 0 && dist > 0.05 && !(hunting && dTarget() < 0.5)) {
      this.heading = this.lerp(this.heading, Math.atan2(wx - p.x, wz - p.z), Math.min(1, dt * 9));
      const step = Math.min(dist, speed * dt);
      const pos = { x: p.x + Math.sin(this.heading) * step, y: p.z + Math.cos(this.heading) * step };
      this.world.resolve(pos, 0.2, this.groundZ, 0.4);
      p.x = pos.x; p.z = pos.y; moving = step > 0.001;
    }
    if (hunting && dTarget() < 0.6) {                    // checked after moving, so a fast dog on a slow frame still bites
      this.biteT -= dt;
      if (this.biteT <= 0) {
        this.biteT = 0.9; this.biteAnim = 0.25;
        const left = this.target!.bite(p);
        this.onMessage(left > 0 ? `Woof! ${left} more bite${left > 1 ? 's' : ''}` : 'The terrier finishes the skeleton!');
        if (left === 0) this.target = null;
      }
      this.heading = this.lerp(this.heading, Math.atan2(tx - p.x, tz - p.z), Math.min(1, dt * 12));
    }
    // stuck detection: wants to move but does not get anywhere
    if (speed > 0 && !(hunting && dTarget() < 0.6)) {
      if (this.last.distanceTo(new THREE.Vector2(p.x, p.z)) < speed * dt * 0.25) this.stallT += dt; else { this.stallT = 0; this.last.set(p.x, p.z); }
      if (this.stallT > 0.4) { this.stallT = 0; this.detourT = 0.8; this.detourSide = -this.detourSide; this.last.set(p.x, p.z); }
    }
    const gnd = this.world.groundAt(p.x, p.z, this.groundZ + 0.05);
    p.y = Number.isFinite(gnd) ? Math.max(gnd, this.groundZ) : this.groundZ;
    g.rotation.y = this.heading;
    const w = this.t * (hunting ? 22 : 13);
    this.legs.forEach((l, i) => { l.rotation.x = moving ? Math.sin(w + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI / 2 : 0)) * 0.7 : 0; });
    this.tail.rotation.z = Math.sin(this.t * (moving ? 18 : 9)) * 0.5;
    if (this.biteAnim > 0) { this.biteAnim -= dt; g.rotation.x = Math.sin((this.biteAnim / 0.25) * Math.PI) * 0.35; } else g.rotation.x = 0;
    g.position.y += moving ? Math.abs(Math.sin(w)) * 0.03 : 0;
  }

  private lerp(a: number, b: number, t: number) { const d = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + d * t; }
}
