// CI smoke test: load the built site headless, fail on any page error or when the scene doesn't come up.
// Usage: node tools/smoke.mjs [url]
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
const browser = await chromium.launch({ executablePath: chromePath(), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(process.argv[2] ?? 'http://localhost:4173/');
try { await page.waitForFunction(() => window.dom3d, null, { timeout: 60000 }); }
catch { errors.push('scene did not initialise (window.dom3d missing)'); }
await browser.close();
if (errors.length) { console.error('SMOKE FAILED:\n' + errors.join('\n')); process.exit(1); }
console.log('smoke ok');
