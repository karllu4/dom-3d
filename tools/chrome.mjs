// Resolves the Chromium used by the headless tools: $CHROME_PATH, else the newest Playwright-installed chromium.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9))) : [];
  for (const d of dirs) { for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const p = path.join(root, d, sub); if (fs.existsSync(p)) return p; } }
  throw new Error('No Chromium found: run `npx playwright-core install chromium` or set CHROME_PATH');
}
