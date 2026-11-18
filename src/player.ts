import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import type { World } from './physics';

const RADIUS = 0.22;
const EYE = 1.72, HEIGHT = 1.85; // eye level 172 cm (owner), body ~185 cm
const EYE_CROUCH = 1.0, HEIGHT_CROUCH = 1.15;
const WALK = 2.6, RUN = 5.5;   // m/s: brisk walk, Shift = run
const GRAVITY = 9.81;

export class Player {
  controls: PointerLockControls;
  pos = { x: 0, y: 0 };   // plan position
  feet = 0;
  private vz = 0;
  private eyeSmooth = 0;
  private keys = new Set<string>();
  crouch = false;
  /** on-screen joystick (phones): x right, y down, -1..1; `active` = walking without pointer lock */
  touch = { x: 0, y: 0, active: false };

  constructor(public camera: THREE.PerspectiveCamera, dom: HTMLElement, private world: World) {
    this.controls = new PointerLockControls(camera, dom);
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyC') this.toggleCrouch();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  toggleCrouch() {
    // don't stand up into a sloped ceiling
    if (this.crouch && this.world.headBlocked(this.pos.x, this.pos.y, this.feet, HEIGHT)) return;
    this.crouch = !this.crouch;
  }

  /** drag-to-look (touch): dx, dy in screen pixels */
  look(dx: number, dy: number) {
    const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(this.camera.quaternion);
    e.y -= dx * 0.005;
    e.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, e.x - dy * 0.005));
    this.camera.quaternion.setFromEuler(e);
  }

  get height() { return this.crouch ? HEIGHT_CROUCH : HEIGHT; }

  teleport(x: number, y: number, feet: number, yawDeg?: number) {
    this.pos = { x, y };
    const g = this.world.groundAt(x, y, feet + 0.1);
    this.feet = Number.isFinite(g) ? g : feet;
    this.vz = 0;
    this.eyeSmooth = this.feet + (this.crouch ? EYE_CROUCH : EYE);
    if (yawDeg !== undefined) this.camera.rotation.set(0, (-yawDeg * Math.PI) / 180, 0, 'YXZ');
    this.syncCamera();
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    const k = this.keys;
    let f = 0, s = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;

    // joystick: analog walk, pushed to the rim = run
    let analog = 1, runStick = false;
    if (this.touch.active && (this.touch.x || this.touch.y)) {
      f -= this.touch.y; s += this.touch.x;
      analog = Math.min(1, Math.hypot(this.touch.x, this.touch.y)); runStick = analog > 0.97;
    }

    if ((this.controls.isLocked || this.touch.active) && (f || s)) {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      const mv = dir.multiplyScalar(f).add(right.multiplyScalar(s));
      if (mv.lengthSq() > 0) mv.normalize();
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') || runStick ? RUN : WALK) * (this.crouch ? 0.5 : 1) * analog;
      // sub-steps so we never tunnel through 12 cm partitions
      const total = speed * dt;
      const steps = Math.max(1, Math.ceil(total / 0.04));
      for (let i = 0; i < steps; i++) this.step((mv.x * total) / steps, (mv.z * total) / steps);
    }

    // vertical: snap up small steps, fall otherwise
    const ground = this.world.groundAt(this.pos.x, this.pos.y, this.feet);
    if (ground >= this.feet - 0.001) {
      this.feet = ground;
      this.vz = 0;
    } else {
      this.vz -= GRAVITY * dt;
      this.feet = Math.max(ground, this.feet + this.vz * dt);
      if (this.feet === ground) this.vz = 0;
    }
    if (!Number.isFinite(this.feet)) this.feet = 0;
    this.syncCamera(dt);
  }

  private step(dx: number, dy: number) {
    const w = this.world;
    const h = this.height;
    // try full move, then each axis (lets you slide along walls and under sloped ceilings)
    for (const [mx, my] of [[dx, dy], [dx, 0], [0, dy]] as const) {
      if (!mx && !my) continue;
      const p = { x: this.pos.x + mx, y: this.pos.y + my };
      const support = w.groundAt(p.x, p.y, this.feet);
      const feet = Math.max(support, this.feet - 0.05);
      w.resolve(p, RADIUS, feet, h);
      if (w.headBlocked(p.x, p.y, feet, h)) continue;
      this.pos = p;
      return;
    }
  }

  private syncCamera(dt = 1) {
    const target = this.feet + (this.crouch ? EYE_CROUCH : EYE);
    // smooth only upward steps (stairs); falling follows directly
    this.eyeSmooth = target > this.eyeSmooth ? this.eyeSmooth + (target - this.eyeSmooth) * Math.min(1, dt * 14) : target;
    this.camera.position.set(this.pos.x, this.eyeSmooth, this.pos.y);
  }

  yaw(): number {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return Math.atan2(d.z, d.x); // plan angle
  }
}
