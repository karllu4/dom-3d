import type { HouseJ, LevelJ, RoomLabel } from './types';
import { pointInPoly } from './geometry';

export function levelForFeet(h: HouseJ, feet: number): LevelJ {
  return feet > 2.3 ? h.levels[1] : h.levels[0];
}

export function roomAt(h: HouseJ, x: number, y: number, feet: number): { level: LevelJ; label: RoomLabel | null } {
  const level = levelForFeet(h, feet);
  for (const r of level.rooms) {
    if (!pointInPoly(x, y, r)) continue;
    // open-plan spaces hold several labels: pick the nearest one
    let best = r.labels[0], bd = Infinity;
    for (const l of r.labels) {
      const d = Math.hypot(l.at[0] - x, l.at[1] - y);
      if (d < bd) { bd = d; best = l; }
    }
    return { level, label: best };
  }
  return { level, label: null };
}

/**
 * Top-down minimap in plan orientation (same as the paper plans).
 * The view fits the house and zooms out smoothly when you walk away from it, so your marker always stays visible.
 */
export class Minimap {
  canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private W = 240;
  private H = 230;
  private view = { cx: 7, cy: 6.6, s: 13 }; // centre (plan m) and px per metre, smoothed
  private static HOUSE = [-0.8, -1.2, 14.8, 13.8] as const; // plan bounds of the house incl. overhangs

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    const dpr = devicePixelRatio || 1;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.g = this.canvas.getContext('2d')!;
    this.g.scale(dpr, dpr);
    parent.appendChild(this.canvas);
  }

  private T = (x: number, y: number): [number, number] =>
    [this.W / 2 + (x - this.view.cx) * this.view.s, this.H / 2 + (y - this.view.cy) * this.view.s];

  draw(level: LevelJ, px: number, py: number, angle: number, current: string | null, planDownBearing = 90) {
    const g = this.g, T = this.T;
    // target view: house bounds + player (with margin), fitted into the canvas
    const [hx0, hy0, hx1, hy1] = Minimap.HOUSE;
    const m = 1.5;
    const x0 = Math.min(hx0, px - m), x1 = Math.max(hx1, px + m), y0 = Math.min(hy0, py - m), y1 = Math.max(hy1, py + m);
    const pad = 14;
    const ts = Math.min((this.W - 2 * pad) / (x1 - x0), (this.H - 2 * pad - 10) / (y1 - y0));
    const k = 0.3; // smoothing
    this.view.cx += ((x0 + x1) / 2 - this.view.cx) * k;
    this.view.cy += ((y0 + y1) / 2 + 0.4 - this.view.cy) * k;
    this.view.s += (ts - this.view.s) * k;

    g.clearRect(0, 0, this.W, this.H);
    const css = getComputedStyle(document.documentElement);
    const wallC = css.getPropertyValue('--map-wall').trim() || '#333';
    const roomC = css.getPropertyValue('--map-room').trim() || '#eee';
    const roomHi = css.getPropertyValue('--map-room-hi').trim() || '#cde';
    const textC = css.getPropertyValue('--map-text-strong').trim() || '#222';
    const pillC = css.getPropertyValue('--map-pill').trim() || 'rgba(255,255,255,0.9)';
    const path = (r: [number, number][]) => {
      g.beginPath();
      r.forEach(([x, y], i) => (i ? g.lineTo(...T(x, y)) : g.moveTo(...T(x, y))));
      g.closePath();
    };
    for (const r of level.rooms) {
      path(r.outer);
      g.fillStyle = r.ids.includes(current ?? '') ? roomHi : roomC;
      g.fill();
    }
    g.fillStyle = wallC;
    for (const w of level.walls) { path(w.outer); g.fill(); }

    // room numbers on a small rounded label so they stay readable over wall lines
    const fs = Math.round(Math.max(9, Math.min(12, this.view.s * 0.8)));
    g.font = `600 ${fs}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // current room first, then the rest; skip a label that would overlap one already drawn
    const all = level.rooms.flatMap((r) => r.labels).sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
    const placed: [number, number, number, number][] = [];
    for (const l of all) {
      const [lx, ly] = T(l.at[0], l.at[1]);
      const w = g.measureText(l.id).width + 8, h = fs + 5;
      const box: [number, number, number, number] = [lx - w / 2, ly - h / 2, lx + w / 2, ly + h / 2];
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      const hi = l.id === current;
      g.fillStyle = hi ? '#e4572e' : pillC;
      g.beginPath(); g.roundRect(lx - w / 2, ly - h / 2, w, h, h / 2); g.fill();
      g.fillStyle = hi ? '#fff' : textC;
      g.fillText(l.id, lx, ly + 0.5);
    }

    // north arrow (top-left corner) on its own badge: north in plan coords = (sin B, cos B), B = bearing of plan +y
    {
      const B = (planDownBearing * Math.PI) / 180;
      const nx = Math.sin(B), ny = Math.cos(B);
      const ox = 22, oy = 22;
      g.fillStyle = pillC;
      g.beginPath(); g.arc(ox, oy, 17, 0, Math.PI * 2); g.fill();
      g.strokeStyle = textC; g.fillStyle = textC; g.lineWidth = 2;
      // arrow from the back of the badge to just short of the letter
      g.beginPath(); g.moveTo(ox - nx * 11, oy - ny * 11); g.lineTo(ox + nx * 2, oy + ny * 2); g.stroke();
      g.beginPath(); g.moveTo(ox + nx * 5, oy + ny * 5);
      g.lineTo(ox - ny * 4, oy + nx * 4); g.lineTo(ox + ny * 4, oy - nx * 4); g.closePath(); g.fill();
      g.font = 'bold 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('N', ox + nx * 11, oy + ny * 11);
    }

    // player: arrow with a white outline and a soft halo so it is visible on any background
    let [cx, cy] = T(px, py);
    cx = Math.min(this.W - 14, Math.max(14, cx)); cy = Math.min(this.H - 14, Math.max(14, cy)); // never off the map
    g.save();
    g.translate(cx, cy);
    g.fillStyle = 'rgba(228,87,46,0.22)';
    g.beginPath(); g.arc(0, 0, 13, 0, Math.PI * 2); g.fill();
    g.rotate(angle);
    g.fillStyle = '#e4572e';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(10, 0); g.lineTo(-7, 7); g.lineTo(-3, 0); g.lineTo(-7, -7);
    g.closePath();
    g.stroke();
    g.fill();
    g.restore();

    // scale bar
    const meters = this.view.s > 10 ? 5 : this.view.s > 4 ? 10 : 20;
    const bl = meters * this.view.s;
    g.strokeStyle = textC; g.fillStyle = textC; g.lineWidth = 2;
    g.beginPath(); g.moveTo(this.W - 12 - bl, this.H - 12); g.lineTo(this.W - 12, this.H - 12); g.stroke();
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    g.fillText(`${meters} m`, this.W - 12, this.H - 17);
  }
}
