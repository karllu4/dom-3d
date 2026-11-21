import * as THREE from 'three';
import type { World } from './physics';

/**
 * A shambling blocky zombie (original design: dusty-teal ragged shirt, bandaged forehead, mismatched glowing eyes,
 * one bare rib patch, bare feet). It patrols a loop round the house after dark, rises out of the ground at dusk and
 * sinks back into it at dawn. It never leaves the loop, so it cannot walk through walls.
 */
export class Zombie {
  readonly group = new THREE.Group();
  private presence = 0;           // 0 = underground, 1 = fully risen
  private t = 0;
  private wp = 0;
  private heading = 0;
  private legL: THREE.Group; private legR: THREE.Group; private armL: THREE.Group; private armR: THREE.Group;
  private head: THREE.Group; private body: THREE.Group;
  private groundZ: number;
  private route: [number, number][];
  private world: World;
  private mode: 'patrol' | 'chase' | 'flee' = 'patrol';
  private modeT = 0;          // time left in flee / time since the player was last seen while chasing
  private lost = 0;
  private flames: { m: THREE.Mesh; life: number; max: number }[] = [];
  private fire: THREE.PointLight;
  private fireMat = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private fireMat2 = new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  /** set while the zombie is close enough to grab the player */
  caught = false;
  private groundNow = 0;

  constructor(groundZ: number, route: [number, number][], world: World) {
    this.groundZ = groundZ;
    this.world = world;
    this.route = route;
    this.group.name = 'zombie';
    const M = (c: number, rough = 0.85, emissive = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, emissive, emissiveIntensity: emissive ? 1.6 : 0 });
    const skin = M(0x8fa67c), skinDark = M(0x6f8760), shirt = M(0x3f6f73), shirtDark = M(0x2f5558), trousers = M(0x4a463f), bone = M(0xe4dcc8, 0.6), hair = M(0x2a2420), mouth = M(0x1c1210), bandage = M(0xd9d2bf, 0.9);
    const eyeA = M(0x111111, 0.4, 0xd8ff6a), eyeB = M(0x111111, 0.4, 0xd8ff6a);
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o;
    };
    const root = new THREE.Group(); this.group.add(root);
    // legs (pivot at the hip, y = 0.74)
    const leg = (x: number) => {
      const p = new THREE.Group(); p.position.set(x, 0.74, 0); root.add(p);
      box(p, 0.22, 0.52, 0.22, trousers, 0, -0.26, 0);
      box(p, 0.23, 0.13, 0.23, skinDark, 0, -0.585, 0);            // torn trouser leg: bare shin
      box(p, 0.22, 0.07, 0.3, skin, 0, -0.705, 0.04);              // bare foot
      box(p, 0.24, 0.05, 0.05, trousers, 0, -0.5, 0.1);            // ragged hem flap
      return p;
    };
    this.legL = leg(-0.13); this.legR = leg(0.13);
    // torso + head + arms lean forward a little
    const body = new THREE.Group(); body.position.set(0, 0.74, 0); body.rotation.x = 0.12; root.add(body); this.body = body;
    box(body, 0.5, 0.68, 0.27, shirt, 0, 0.34, 0);
    box(body, 0.52, 0.1, 0.29, shirtDark, 0, 0.02, 0);                   // ragged hem
    for (const x of [-0.18, -0.06, 0.07, 0.19]) box(body, 0.07, 0.1 + (x * 7 % 0.1 + 0.1), 0.29, shirtDark, x, -0.06, 0);   // torn strips
    box(body, 0.2, 0.26, 0.012, mouth, 0.1, 0.36, 0.141);                // tear showing the ribs on the chest
    for (let i = 0; i < 4; i++) box(body, 0.19, 0.022, 0.016, bone, 0.1, 0.27 + i * 0.065, 0.146);
    // head
    const head = new THREE.Group(); head.position.set(0, 0.7, 0.02); head.rotation.set(0.18, 0, 0.17); body.add(head); this.head = head;
    box(head, 0.34, 0.34, 0.34, skin, 0, 0.17, 0);
    box(head, 0.35, 0.07, 0.35, bandage, 0, 0.27, 0.002);                // bandage across the forehead
    box(head, 0.35, 0.05, 0.1, bandage, 0.0, 0.31, -0.12).rotation.x = 0.5;
    box(head, 0.36, 0.08, 0.2, hair, 0, 0.35, -0.08);                    // patchy hair, back and top
    box(head, 0.1, 0.07, 0.12, hair, 0.12, 0.35, 0.08);
    box(head, 0.075, 0.095, 0.02, eyeA, -0.085, 0.2, 0.172);             // mismatched glowing eyes
    box(head, 0.05, 0.05, 0.02, eyeB, 0.09, 0.185, 0.172);
    box(head, 0.19, 0.06, 0.02, mouth, 0, 0.065, 0.172);                  // gaping mouth with a few teeth
    for (const x of [-0.06, 0.0, 0.06]) box(head, 0.025, 0.03, 0.02, bone, x, 0.09, 0.176);
    box(head, 0.06, 0.12, 0.02, skinDark, 0.1, 0.1, 0.172);              // sunken cheek patch
    // arms stretched out in front (pivot at the shoulder)
    const arm = (x: number, tilt: number) => {
      const p = new THREE.Group(); p.position.set(x, 0.6, 0.0); p.rotation.x = -Math.PI / 2 + tilt; body.add(p);
      box(p, 0.17, 0.3, 0.17, shirt, 0, -0.15, 0);                       // ragged sleeve
      box(p, 0.17, 0.32, 0.17, skin, 0, -0.46, 0);                       // bare forearm
      box(p, 0.19, 0.09, 0.15, skinDark, 0, -0.66, 0);                   // hand
      return p;
    };
    this.armL = arm(-0.34, 0.1); this.armR = arm(0.34, -0.05);
    this.body = body;
    // eerie green glow, so it can be seen on a dark night
    const glow = new THREE.PointLight(0x9cff7a, 3.2, 7, 1.6); glow.position.set(0, 1.3, 0.5); this.group.add(glow);
    this.fire = new THREE.PointLight(0xff7a1a, 0, 9, 1.6); this.fire.position.set(0, 1.1, 0); this.group.add(this.fire);
    const fg = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    for (let i = 0; i < 26; i++) { const m = new THREE.Mesh(fg, i % 3 ? this.fireMat : this.fireMat2); m.visible = false; this.group.add(m); this.flames.push({ m, life: 0, max: 1 }); }
    this.group.visible = false;
    // start somewhere on the loop
    this.wp = 0; this.group.position.set(route[0][0], groundZ, route[0][1]); this.groundNow = groundZ;
  }

  /** Is the point (plan x,z; world y) within the zombie's body? Used by the light beam. */
  hit(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, cone: number): boolean {
    if (!this.group.visible || this.presence < 0.9) return false;
    const c = new THREE.Vector3(this.group.position.x, this.group.position.y + 1.0, this.group.position.z).sub(origin);
    const dist = c.length();
    if (dist > maxDist || dist < 0.01) return false;
    if (c.normalize().angleTo(dir) > cone + 0.5 / dist) return false;
    return this.world.lineClear(origin.x, origin.z, this.group.position.x, this.group.position.z, this.group.position.y, 1.6);
  }

  /** The light burns it: it sets alight and runs away for a few seconds. */
  ignite() { this.mode = 'flee'; this.modeT = 5; }
  get burning() { return this.mode === 'flee'; }

  /** Back onto the lawn, as far from `from` as the route allows (after it caught the player). */
  reset(from: THREE.Vector3) {
    let best = 0, bd = -1;
    this.route.forEach((r, i) => { const d = Math.hypot(r[0] - from.x, r[1] - from.z); if (d > bd) { bd = d; best = i; } });
    this.wp = best; this.mode = 'patrol'; this.groundNow = this.groundZ;
    this.group.position.set(this.route[best][0], this.groundZ, this.route[best][1]);
  }

  private animateFlames(dt: number) {
    const on = this.mode === 'flee';
    this.fire.intensity = on ? 5 + Math.random() * 3 : 0;
    for (const f of this.flames) {
      f.life -= dt;
      if (f.life <= 0) {
        if (!on) { f.m.visible = false; continue; }
        f.life = f.max = 0.4 + Math.random() * 0.5;
        f.m.position.set((Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 1.3, (Math.random() - 0.5) * 0.35);
        f.m.visible = true;
      }
      const k = 1 - f.life / f.max;
      f.m.position.y += dt * 1.4;
      f.m.scale.setScalar(Math.max(0.05, 1.2 - k * 1.1));
      f.m.rotation.set(k * 3, k * 4, 0);
    }
  }

  /** dark = it is night (sun well below the horizon); player = camera position for the head turn. */
  update(dt: number, dark: boolean, player: THREE.Vector3) {
    const goal = dark ? 1 : 0;
    this.presence += Math.sign(goal - this.presence) * Math.min(Math.abs(goal - this.presence), dt * 0.5);   // 2 s to rise / sink
    const gr = this.group;
    gr.visible = this.presence > 0.01;
    if (!gr.visible) return;
    this.t += dt;
    const px = player.x, pz = player.z;
    const toPx = px - gr.position.x, toPz = pz - gr.position.z;
    const pd = Math.hypot(toPx, toPz);
    const sameLevel = Math.abs(player.y - 1.7 - gr.position.y) < 1.8;
    const sees = dark && this.presence > 0.9 && pd < 11 && sameLevel
      && this.world.lineClear(gr.position.x, gr.position.z, px, pz, gr.position.y, 1.6);
    if (this.mode === 'flee') {
      this.modeT -= dt;
      if (this.modeT <= 0) this.mode = 'patrol';
    } else if (this.mode === 'patrol' && sees) { this.mode = 'chase'; this.lost = 0; }
    else if (this.mode === 'chase') {
      this.lost = sees || (pd < 3.5 && sameLevel) ? 0 : this.lost + dt;
      if (this.lost > 4 || !dark || pd > 16) this.mode = 'patrol';
    }
    this.caught = this.mode === 'chase' && pd < 0.95 && sameLevel;

    let want: number, speed: number;
    if (this.mode === 'chase') { want = Math.atan2(toPx, toPz); speed = 2.1; }
    else if (this.mode === 'flee') { want = Math.atan2(-toPx, -toPz); speed = 3.6; }
    else {
      const target = this.route[this.wp];
      const dx = target[0] - gr.position.x, dz = target[1] - gr.position.z;
      if (Math.hypot(dx, dz) < 0.4) this.wp = (this.wp + 1) % this.route.length;
      want = Math.atan2(dx, dz); speed = 0.85;
    }
    let d = want - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * (this.mode === 'patrol' ? 2.5 : 6));
    speed *= Math.min(1, this.presence * 1.5);
    const nx = gr.position.x + Math.sin(this.heading) * speed * dt;
    const nz = gr.position.z + Math.cos(this.heading) * speed * dt;
    const pos = { x: nx, y: nz };
    this.world.resolve(pos, 0.3, this.groundNow, 1.7);
    gr.position.x = pos.x; gr.position.z = pos.y;
    // follow stairs / floors while hunting, back to the lawn otherwise
    const g = this.world.groundAt(pos.x, pos.y, this.groundNow + 0.1);
    this.groundNow = Number.isFinite(g) ? Math.max(g, this.groundZ) : this.groundZ;
    gr.position.y = this.groundNow - (1 - this.presence) * 2.0;
    gr.rotation.y = this.heading;
    this.animateFlames(dt);
    // limbs: slow shamble, one leg drags
    const w = this.t * (this.mode === 'patrol' ? 4.2 : 7.5);
    this.legL.rotation.x = Math.sin(w) * 0.5;
    this.legR.rotation.x = -Math.sin(w) * 0.42 - 0.08;
    this.armL.rotation.x = -Math.PI / 2 + 0.1 + Math.sin(w * 0.5) * 0.07;
    this.armR.rotation.x = -Math.PI / 2 - 0.05 + Math.cos(w * 0.5) * 0.07;
    this.body.rotation.z = Math.sin(w) * 0.05;
    this.body.position.y = 0.74 + Math.abs(Math.sin(w)) * 0.025;
    // look at the player when near
    const toP = new THREE.Vector3().subVectors(player, gr.position);
    const near = toP.length() < 9;
    let yaw = 0;
    if (near) { yaw = Math.atan2(Math.sin(Math.atan2(toP.x, toP.z) - this.heading), Math.cos(Math.atan2(toP.x, toP.z) - this.heading)); yaw = THREE.MathUtils.clamp(yaw, -1.0, 1.0); }
    this.head.rotation.y += (yaw - this.head.rotation.y) * Math.min(1, dt * 3);
    this.head.rotation.z = 0.17 + Math.sin(this.t * 1.3) * 0.05;
  }
}

/** Loop round the house, ~3 m clear of the roof overhangs (house spans x -0.7..14.7, y -1.1..13.7). */
export const ZOMBIE_ROUTE: [number, number][] = [
  [-3.2, -4.2], [7, -4.6], [17.6, -4.2], [18.0, 7], [17.6, 16.6], [7, 17.2], [-3.2, 16.6], [-3.6, 7],
];
