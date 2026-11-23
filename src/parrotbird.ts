import * as THREE from 'three';
import { buildMacaw } from './parrot';
import type { Zombie } from './zombie';
import type { PolyJ } from './types';
import { pointInPoly } from './geometry';

/**
 * The macaw alive. It sits in the cage until you open it (E next to the cage). Then it flies out through the back window,
 * chases the nearest zombie outside, and pecks it: 4 pecks and the zombie dies. Close the cage (E) and it flies back in
 * through the window and lands on its perch.
 */
const SPEED = 7.5, IDLE_SPEED = 3.2;
// back window of the cage room (OB3, x 5.05..7.05, wall y 0..0.44) at flying height
const WIN_IN = new THREE.Vector3(6.05, 4.85, 1.2), WIN_MID = new THREE.Vector3(6.05, 4.85, 0.2), WIN_OUT = new THREE.Vector3(6.05, 4.85, -1.0);

export class LiveParrot {
  readonly group = new THREE.Group();
  open = false;
  private bird = buildMacaw();
  private pivot = new THREE.Group();
  private pos: THREE.Vector3;
  private home: THREE.Vector3;
  private yaw = Math.PI;
  private tilt = 0;
  private state: 'cage' | 'free' | 'return' = 'cage';
  private t = 0;
  private peckT = 0;
  private peckAnim = 0;
  private portal = 0;
  private target: Zombie | null = null;
  private wings: { g: THREE.Group; sx: number }[];
  private wingRest: number[];
  info = '';
  private downT = 0;
  /** Knocked out of the air by the boss: tumbles to the ground and lies stunned for a few seconds. */
  knockDown(t = 4) { if (this.state === 'cage' || this.downT > 0) return; this.downT = t; this.onMessage('The boss knocks the macaw out of the air!'); }
  get isDown() { return this.downT > 0; }
  get position() { return this.pos; }

  constructor(home: THREE.Vector3, private footprint: PolyJ, private groundZ: number, private onMessage: (m: string) => void) {
    this.home = home.clone(); this.pos = home.clone();
    this.pivot.add(this.bird); this.group.add(this.pivot);
    this.group.name = 'live-parrot';
    this.wings = this.bird.userData.wings;
    this.wingRest = this.wings.map((w) => w.g.rotation.z);
    this.place();
  }

  get free() { return this.state !== 'cage'; }
  release() { this.open = true; if (this.state === 'cage' || this.state === 'return') this.state = 'free'; }
  recall() { this.open = false; if (this.state === 'free') this.state = 'return'; }

  /** In the house = within the footprint and below the attic ceiling (above the roof counts as outside). */
  private inside(p: THREE.Vector3) { return p.y > 2.8 && p.y < 6.0 && pointInPoly(p.x, p.z, this.footprint); }

  private crossesHouse(a: THREE.Vector3, b: THREE.Vector3) {
    for (let i = 0; i <= 12; i++) if (pointInPoly(a.x + (b.x - a.x) * i / 12, a.z + (b.z - a.z) * i / 12, this.footprint)) return true;
    return false;
  }

  private place() {
    this.group.position.copy(this.pos);
    this.pivot.rotation.set(0, this.yaw, 0);
    this.bird.rotation.x = this.tilt;
  }

  /** Next point to fly to when heading for `goal`: through the window when going in or out of the house. */
  private waypoint(goal: THREE.Vector3): THREE.Vector3 {
    const a = this.inside(this.pos), b = this.inside(goal);
    if (a === b) { this.portal = 0; return goal; }
    const seq = a ? [WIN_IN, WIN_MID, WIN_OUT] : [WIN_OUT, WIN_MID, WIN_IN];
    while (this.portal < seq.length && this.pos.distanceTo(seq[this.portal]) < 0.35) this.portal++;
    // flew past the window on the wrong side: start the sequence again
    return this.portal < seq.length ? seq[Math.min(this.portal, seq.length - 1)] : goal;
  }

  private nearestZombie(zs: Zombie[]): Zombie | null {
    let best: Zombie | null = null, bd = 30;
    for (const z of zs) {
      if (!z.alive || z.dead || !z.risen || z.isBoss) continue;
      const zp = z.group.position;
      if (pointInPoly(zp.x, zp.z, this.footprint)) continue;               // only zombies outside the house
      const d = Math.hypot(zp.x - this.pos.x, zp.z - this.pos.z);
      if (d < bd) { bd = d; best = z; }
    }
    return best;
  }

  /** Over-the-roof detour when the straight line to a point outside would cut through the house: climb straight up, then fly level over the roof. */
  private avoidHouse(to: THREE.Vector3): THREE.Vector3 {
    if (this.inside(this.pos) || this.inside(to)) return to;
    const high = this.pos.y > 10.2;
    if (!high && !this.crossesHouse(this.pos, to)) return to;
    if (!this.crossesHouse(this.pos, to)) return to;                 // clear of the house: go straight down to the target
    if (!high) return new THREE.Vector3(this.pos.x, 10.8, this.pos.z);
    return new THREE.Vector3(to.x, 10.8, to.z);
  }

  update(dt: number, zombies: Zombie[], player: THREE.Vector3) {
    this.t += dt;
    let speed = 0;
    if (this.downT > 0) {
      this.downT -= dt; this.info = 'Macaw: stunned';
      this.pos.y = Math.max(this.groundZ + 0.12, this.pos.y - 9 * dt);
      this.tilt += (Math.PI / 2 - this.tilt) * Math.min(1, dt * 6);
      this.bird.rotation.x = this.tilt; this.wings.forEach((w, i) => { w.g.rotation.z = this.wingRest[i]; }); this.place();
      return;
    }
    if (this.state === 'cage') {
      this.pos.copy(this.home); this.yaw = Math.PI;
    } else {
      let goal: THREE.Vector3; let sp = SPEED;
      if (this.state === 'return') {
        // in the cage room: via the point in front of the bars, then onto the perch; from outside the window route handles it
        const front = new THREE.Vector3(this.home.x, this.home.y + 0.1, this.home.z - 0.9);
        goal = this.inside(this.pos) && (this.pos.z > this.home.z - 0.95 || this.pos.distanceTo(front) < 0.4) ? this.home : this.inside(this.pos) ? front : this.home;
        sp = SPEED;
        if (this.pos.distanceTo(this.home) < 0.06) { this.state = 'cage'; this.target = null; this.info = 'Macaw: back in its cage'; this.onMessage('The macaw flies back into its cage'); }
      } else {
        if (!this.target || !this.target.alive || this.target.dead || !this.target.risen) this.target = this.nearestZombie(zombies);
        if (this.target) {
          const zp = this.target.group.position;
          const dir = new THREE.Vector3(this.pos.x - zp.x, 0, this.pos.z - zp.z); if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
          dir.normalize();
          goal = new THREE.Vector3(zp.x + dir.x * 0.38, Math.max(zp.y + 1.55, this.groundZ + 0.6), zp.z + dir.z * 0.38);
          this.info = 'Macaw: attacking';
          const close = this.pos.distanceTo(goal) < 0.25;
          if (close) {
            this.peckT -= dt;
            if (this.peckT <= 0) {
              this.peckT = 1.0; this.peckAnim = 0.25;
              const left = this.target.peck(this.pos);
              this.onMessage(left > 0 ? `Peck! ${left} more peck${left > 1 ? 's' : ''}` : 'The macaw finishes the zombie!');
              if (left === 0) this.target = null;
            }
          }
        } else {
          // no zombie to chase: loiter in the cage room above the player's side of the room
          const a = this.t * 0.8;
          goal = new THREE.Vector3(6.9 + Math.cos(a) * 1.3, 4.7 + Math.sin(this.t * 1.3) * 0.15, 2.2 + Math.sin(a) * 0.9);
          sp = IDLE_SPEED; this.info = 'Macaw: free, no zombie in sight'; this.portal = 0;
          void player;
        }
      }
      const wp = this.avoidHouse(this.waypoint(goal));
      const d = wp.clone().sub(this.pos), len = d.length();
      if (len > 0.001) {
        const step = Math.min(len, sp * dt);
        this.pos.addScaledVector(d, step / len);
        speed = step / dt;
        if (Math.hypot(d.x, d.z) > 0.05) this.yaw = this.lerpAngle(this.yaw, Math.atan2(d.x, d.z), Math.min(1, dt * 8));
      }
      if (!this.inside(this.pos)) this.pos.y = Math.max(this.pos.y, this.groundZ + 0.4);
    }
    // pose: perched upright, in flight pitched forward with flapping wings
    const flying = this.state !== 'cage';
    const targetTilt = flying ? 1.15 : 0;
    this.tilt += (targetTilt - this.tilt) * Math.min(1, dt * 6);
    if (this.peckAnim > 0) { this.peckAnim -= dt; }
    this.bird.rotation.x = this.tilt + (this.peckAnim > 0 ? Math.sin((this.peckAnim / 0.25) * Math.PI) * 0.45 : 0);
    const flap = flying ? 1.0 + 0.75 * Math.sin(this.t * (speed > 1 ? 22 : 12)) : 0;
    this.wings.forEach((w, i) => { w.g.rotation.z = flying ? w.sx * flap : this.wingRest[i]; });
    this.place();
  }

  private lerpAngle(a: number, b: number, t: number) {
    let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return a + d * t;
  }
}
