// Finds holes in the envelope: sky = magenta, glass opaque, ground hidden; renders 6 views per attic room.
import { chromium } from 'playwright-core'; import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'), args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } }); await p.goto('http://localhost:5173/'); await p.waitForFunction(() => window.dom3d);
await p.evaluate(async () => {
  const d = window.dom3d; const THREE = await import('/node_modules/.vite/deps/three.js');
  d.menu.classList.add('hidden'); document.getElementById('hud').style.display = 'none';
  d.scene.background = new THREE.Color(1, 0, 1);
  d.scene.traverse(o => {
    if (o.material && o.material.uniforms && o.material.uniforms.sunPosition) o.visible = false;      // sky
    if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.5) { o.material = new THREE.MeshBasicMaterial({ color: 0x00ff00 }); } // glass
  });
  d.scene.traverse(o => { if (o.isMesh && o.geometry && o.geometry.parameters === undefined && o.parent === d.scene.children.find(c => c.type === 'Group')) {} });
});
const rooms = await p.evaluate(() => window.dom3d.house.levels[1].rooms.flatMap(r => r.labels.map(l => ({ id: l.id, at: l.at, z: r.floorZ }))));
const res = [];
for (const r of rooms) {
  for (const [name, yaw, pitch] of [['N',0,25],['E',90,25],['S',180,25],['W',-90,25],['U',0,80],['N2',45,10],['E2',135,10],['S2',-135,10],['W2',-45,10]]) {
    await p.evaluate(([r, yaw, pitch]) => { const d = window.dom3d; d.player.teleport(r.at[0], r.at[1], r.z, yaw); d.camera.rotation.set(pitch*Math.PI/180, -yaw*Math.PI/180, 0, 'YXZ'); d.player.update = () => {}; }, [r, yaw, pitch]);
    await p.waitForTimeout(250);
    const buf = await p.screenshot();
    const n = await p.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let m = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i+1] < 40 && d[i+2] > 230) m++;
      return m;
    }, buf.toString('base64'));
    if (n > 30) { const f = `${out}/${r.id.replace('/','_')}_${name}.png`; fs.writeFileSync(f, buf); res.push(`${r.id} ${name} magenta=${n}`); }
  }
}
console.log(res.join('\n') || 'no gaps');
await b.close();
