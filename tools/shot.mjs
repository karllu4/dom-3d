// Headless screenshots of the running dev server.
// Usage: node tools/shot.mjs <outDir> '<json list of views>'
// view: { name, x, y, feet, yaw (deg, 0 = looking plan-up), pitch (deg), night?: true (23:00, all lights on), overview?: true, actions?: ['plan', ...], walk?: {keys, ms} }
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [outDir, viewsJson, url = 'http://localhost:5173/'] = process.argv.slice(2);
const views = JSON.parse(viewsJson);
const exe = path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.dom3d, null, { timeout: 30000 });
fs.mkdirSync(outDir, { recursive: true });
for (const v of views) {
  await page.evaluate((v) => {
    const d = window.dom3d;
    d.menu.classList.add('hidden');
    if (v.night) {                       // night + every room light on (for lighting design checks)
      const hr = document.getElementById('sun-hour'); hr.value = '23'; hr.dispatchEvent(new Event('input'));
      for (const r of d.roomLights) d.setLight(r, true);
    }
    for (const a of v.actions ?? []) d.actions[a]();
    if (v.overview) {
      d.actions.overview();
      if (v.cam) { d.camera.position.set(...v.cam); }
      for (const a of v.after ?? []) d.actions[a]();
    } else {
      d.player.teleport(v.x, v.y, v.feet ?? 0, v.yaw ?? 0);
      d.camera.rotation.set(((v.pitch ?? 0) * Math.PI) / 180, (-(v.yaw ?? 0) * Math.PI) / 180, 0, 'YXZ');
    }
  }, v);
  await page.waitForTimeout(v.wait ?? 1500);
  await page.screenshot({ path: path.join(outDir, `${v.name}.png`) });
  await page.evaluate((v) => {
    const d = window.dom3d;
    for (const a of v.actions ?? []) d.actions[a]();
    if (v.overview) d.actions.overview();
  }, v);
}
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
