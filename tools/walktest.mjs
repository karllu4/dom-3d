// Simulated walking with fixed time steps (independent of render speed). Reports where the player ends up.
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
const exe = path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.argv[2] ?? 'http://localhost:5173/');
await page.waitForFunction(() => window.dom3d);
// [name, start x, y, feet, yaw, seconds walking forward, open front door first]
const tests = [
  ['front door CLOSED blocks', 5.45, 11.0, -0.02, 0, 3, false],
  ['front door open -> into hall', 5.45, 11.0, -0.02, 0, 3, true],
  ['hall -> garage via D4', 6.6, 7.26, 0, 90, 2, false],
  ['corridor -> up the stairs', 5.6, 5.85, 0, 90, 4, false],
  ['landing -> 2 steps up into 2/1', 10.9, 4.8, 3.0, -90, 1.5, false],
  ['landing -> into 2/8 gym', 11.07, 5.6, 3.0, 180, 2, false],
  ['landing -> into 2/7 laundry', 11.0, 5.25, 3.0, 90, 2, false],
  ['2/1 -> into 2/5 (door D2-2/5)', 6.05, 4.8, 3.34, 0, 2, false],
  ['2/5 -> balcony OB3 stops at glass', 6.05, 1.5, 3.34, 0, 2, false],
  ['1/2 -> into 1/5 (door D2-1/5)', 9.18, 4.8, 0, 0, 2, false],
];
const res = await page.evaluate((tests) => {
  const d = window.dom3d; d.menu.classList.add('hidden');
  const p = d.player; p.controls.isLocked = true;
  const out = [];
  for (const [name, x, y, feet, yaw, secs, openDoor] of tests) {
    if (d.doors[0].open !== openDoor) { d.doors[0].toggle(); }
    for (let i = 0; i < 60; i++) for (const dd of d.doors) dd.update(0.05);
    p.teleport(x, y, feet, yaw);
    const ev = (t, code) => window.dispatchEvent(new KeyboardEvent(t, { code }));
    ev('keydown', 'KeyW');
    for (let i = 0; i < secs / 0.05; i++) p.update(0.05);
    ev('keyup', 'KeyW');
    for (let i = 0; i < 10; i++) p.update(0.05);
    const room = (() => { const lv = p.feet > 2.3 ? d.house.levels[1] : d.house.levels[0]; for (const r of lv.rooms) { const ring = r.outer; let ins = false; for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) { const [xi, yi] = ring[a], [xj, yj] = ring[b]; if ((yi > p.pos.y) !== (yj > p.pos.y) && p.pos.x < ((xj - xi) * (p.pos.y - yi)) / (yj - yi) + xi) ins = !ins; } if (ins) return r.ids.join('+'); } return 'outside'; })();
    out.push(`${name}\n   start (${x}, ${y}, ${feet})  ->  end x=${p.pos.x.toFixed(2)} y=${p.pos.y.toFixed(2)} feet=${p.feet.toFixed(2)} in ${room}`);
  }
  return out.join('\n');
}, tests);
console.log(res);
await browser.close();
