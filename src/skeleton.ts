import * as THREE from 'three';
import type { World } from './physics';
import { ZOMBIE_ROUTE } from './zombie';

/**
 * Minecraft-style skeleton: rises at night with the zombies and walks the loop round the house with a bow in hand.
 * Harmless (no arrows) – the Jack Russell terrier hunts it: 3 bites and it collapses into a pile of bones.
 */
export class Skeleton {
  readonly group = new THREE.Group();
  hp = 3;
  dead = false;
  private presence = 0;
  private mode: 'patrol' | 'scared' | 'dying' = 'patrol';
  private modeT = 0;
  private t = Math.random() * 10;
  private wp: number;
  private heading = 0;
  private scareFrom: THREE.Vector3 | null = null;
  private legL: THREE.Group; private legR: THREE.Group; private armL: THREE.Group; private armR: THREE.Group;
  private dieT = 0;

  constructor(private groundZ: number, private world: World, startAt = 0) {
    this.group.name = 'skeleton';
    this.wp = startAt % ZOMBIE_ROUTE.length;
    const [sx, sz] = ZOMBIE_ROUTE[(this.wp + ZOMBIE_ROUTE.length - 1) % ZOMBIE_ROUTE.length];
    this.group.position.set(sx + (Math.random() - 0.5) * 2, groundZ - 2, sz + (Math.random() - 0.5) * 2);
    this.group.visible = false;
    const bone = new THREE.MeshStandardMaterial({ color: 0xdcdcd2, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x8f8f88, roughness: 0.85 });
    const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5530, roughness: 0.8 });
    const box = (p: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; p.add(o); return o;
    };
    const limb = (x: number, y: number, w: number, h: number) => { const p = new THREE.Group(); p.position.set(x, y, 0); this.group.add(p); box(p, w, h, w, bone, 0, -h / 2, 0); return p; };
    this.legL = limb(-0.1, 0.78, 0.11, 0.78); this.legR = limb(0.1, 0.78, 0.11, 0.78);
    this.armL = limb(-0.29, 1.5, 0.1, 0.7); this.armR = limb(0.29, 1.5, 0.1, 0.7);
    box(this.group, 0.4, 0.66, 0.2, dark, 0, 1.15, 0);                          // chest
    for (let i = 0; i < 4; i++) box(this.group, 0.42, 0.04, 0.22, bone, 0, 1.36 - i * 0.14, 0);   // ribs
    box(this.group, 0.13, 0.62, 0.14, dark, 0, 1.12, -0.01);                    // spine
    const head = box(this.group, 0.42, 0.42, 0.42, bone, 0, 1.72, 0);
    for (const sx of [-1, 1]) box(head, 0.1, 0.1, 0.02, black, sx * 0.1, 0.04, 0.215);   // eye sockets
    box(head, 0.2, 0.05, 0.02, black, 0, -0.1, 0.215);                           // mouth
    // bow in the right hand
    const bow = new THREE.Group(); bow.position.set(0, -0.62, 0.05); this.armR.add(bow);
    box(bow, 0.03, 0.62, 0.03, wood, 0, 0, 0.12); box(bow, 0.015, 0.62, 0.015, black, 0, 0, 0.03);
    this.group.scale.setScalar(0.93);
  }

  get risen() { return this.presence > 0.9 && this.mode !== 'dying'; }
  get alive() { return this.mode !== 'dying'; }

  /** The dog bites it: it runs from the dog for a moment; after 3 bites it falls apart. Returns bites left. */
  bite(from: THREE.Vector3) {
    if (this.mode === 'dying') return 0;
    this.hp--;
    if (this.hp <= 0) { this.mode = 'dying'; this.dieT = 0; return 0; }
    this.mode = 'scared'; this.modeT = 2.4; this.scareFrom = from.clone();
    return this.hp;
  }

  /** Close enough to hit the player? */
  touches(p: THREE.Vector3) { return this.mode === 'patrol' && this.presence > 0.9 && Math.hypot(p.x - this.group.position.x, p.z - this.group.position.z) < 0.85 && Math.abs(p.y - 1.4 - this.group.position.y) < 1.6; }
  /** After hitting the player: back off for a moment. */
  repel(from: THREE.Vector3) { if (this.mode === 'dying') return; this.mode = 'scared'; this.modeT = 2.5; this.scareFrom = from.clone(); }

  update(dt: number, dark: boolean) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const gr = this.group;
    if (this.mode === 'dying') {
      this.dieT += dt;
      this.presence = 1;
      gr.rotation.x = -Math.min(1, this.dieT / 0.6) * (Math.PI / 2);            // topples over
      gr.position.y = this.groundZ + Math.min(1, this.dieT / 0.6) * 0.08;
      if (this.dieT > 2.2) { gr.position.y -= (this.dieT - 2.2) * 1.2; if (this.dieT > 3.2) this.dead = true; }
      return;
    }
    const goal = dark ? 1 : 0;
    this.presence += Math.sign(goal - this.presence) * Math.min(Math.abs(goal - this.presence), dt * 0.5);
    gr.visible = this.presence > 0.01;
    let want: number, speed = 1.9;
    if (this.mode === 'scared') {
      this.modeT -= dt; if (this.modeT <= 0) this.mode = 'patrol';
      const f = this.scareFrom!; want = Math.atan2(gr.position.x - f.x, gr.position.z - f.z); speed = 3.4;
    } else {
      const [tx, tz] = ZOMBIE_ROUTE[this.wp];
      if (Math.hypot(tx - gr.position.x, tz - gr.position.z) < 1.2) this.wp = (this.wp + 1) % ZOMBIE_ROUTE.length;
      want = Math.atan2(tx - gr.position.x, tz - gr.position.z);
    }
    let d = want - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * 4);
    speed *= Math.min(1, this.presence * 1.5);
    const pos = { x: gr.position.x + Math.sin(this.heading) * speed * dt, y: gr.position.z + Math.cos(this.heading) * speed * dt };
    this.world.resolve(pos, 0.25, this.groundZ, 1.8);
    gr.position.x = pos.x; gr.position.z = pos.y;
    gr.position.y = this.groundZ - (1 - this.presence) * 2.0;
    gr.rotation.y = this.heading;
    const w = this.t * (this.mode === 'scared' ? 9 : 5);
    this.legL.rotation.x = Math.sin(w) * 0.55; this.legR.rotation.x = -Math.sin(w) * 0.55;
    this.armL.rotation.x = -Math.PI / 2 + Math.sin(w) * 0.05;                   // arms stretched forward, holding the bow
    this.armR.rotation.x = -Math.PI / 2 + 0.15 - Math.sin(w) * 0.05;
  }
}
