import * as THREE from 'three';

/**
 * Scarlet macaw (Ara macao), perched. Local frame: feet on the perch at y = 0, x across, +z = the side the bird faces.
 * Real proportions: ~85 cm from beak to tail tip, the tail about half of that; red body, yellow and blue wing,
 * bare white face patch with fine feather lines, ivory upper and black lower mandible, grey zygodactyl feet.
 * Built from lathe / capsule / sphere primitives with canvas feather textures (no external assets).
 */
function rng(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

/** Overlapping rounded feather scales: base colour, with each scale darker at its lower edge and a light shaft line. */
function featherTexture(base: string, shade: string, light: string, rep: [number, number], scale = 22): THREE.CanvasTexture {
  const px = 256, c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d')!, r = rng(97);
  g.fillStyle = base; g.fillRect(0, 0, px, px);
  const rows = Math.round(px / (scale * 0.55));
  for (let row = rows; row >= -1; row--) {
    const y = row * scale * 0.55;
    for (let x = -scale; x < px + scale; x += scale) {
      const cx = x + (row % 2 ? scale / 2 : 0) + (r() - 0.5) * 3;
      const grd = g.createLinearGradient(0, y - scale * 0.6, 0, y + scale * 0.5);
      grd.addColorStop(0, base); grd.addColorStop(1, shade);
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(cx - scale / 2, y - scale * 0.6); g.lineTo(cx - scale / 2, y); g.quadraticCurveTo(cx, y + scale * 0.62, cx + scale / 2, y); g.lineTo(cx + scale / 2, y - scale * 0.6); g.closePath(); g.fill();
      g.strokeStyle = light; g.globalAlpha = 0.28; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, y - scale * 0.5); g.lineTo(cx, y + scale * 0.3); g.stroke(); g.globalAlpha = 1;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...rep); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Bare facial skin: pale cream, rows of tiny dark-red feather dots (the macaw's "make-up"). */
function faceTexture(): THREE.CanvasTexture {
  const px = 256, c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d')!, r = rng(11);
  g.fillStyle = '#f0e8dc'; g.fillRect(0, 0, px, px);
  const blush = g.createRadialGradient(px * 0.5, px * 0.5, 10, px * 0.5, px * 0.5, px * 0.6);
  blush.addColorStop(0, 'rgba(240,190,170,0.35)'); blush.addColorStop(1, 'rgba(240,190,170,0)');
  g.fillStyle = blush; g.fillRect(0, 0, px, px);
  for (let row = 0; row < 7; row++) {
    const y = 46 + row * 24;
    g.strokeStyle = 'rgba(70,35,30,0.85)'; g.lineWidth = 1.6;
    for (let x = 24 + (row % 2) * 6; x < px - 20; x += 11 + r() * 3) {
      const a = 0.5 + r() * 0.5;
      g.globalAlpha = a; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 4, y + 5, x + 9, y + 1); g.stroke();
    }
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function buildMacaw(): THREE.Group {
  const bird = new THREE.Group();
  bird.name = 'macaw';
  const mat = (map: THREE.Texture | null, color: number, rough = 0.78) => new THREE.MeshStandardMaterial({ map, color, roughness: rough, metalness: 0 });
  const redM = mat(featherTexture('#c8201b', '#7e0f0d', '#ff8a78', [5, 6]), 0xffffff);
  const redDeep = mat(featherTexture('#b01a16', '#6a0b0a', '#ff7a68', [3, 3]), 0xffffff);
  const yellowM = mat(featherTexture('#efc021', '#b3830a', '#fff0a0', [2, 2], 18), 0xffffff);
  const blueM = mat(featherTexture('#1f55b3', '#0e2c6e', '#6fa0ff', [2, 3], 18), 0xffffff);
  const greenM = mat(featherTexture('#2f9a58', '#16613a', '#9fe0b0', [2, 2], 18), 0xffffff);
  const faceM = mat(faceTexture(), 0xffffff, 0.6);
  const hornM = new THREE.MeshStandardMaterial({ color: 0xece3d0, roughness: 0.35 });
  const blackM = new THREE.MeshStandardMaterial({ color: 0x1d1c1e, roughness: 0.35 });
  const footM = new THREE.MeshStandardMaterial({ color: 0x77726b, roughness: 0.85 });
  const irisM = new THREE.MeshStandardMaterial({ color: 0xf1e3a0, roughness: 0.3 });
  const pupilM = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.15 });
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o;
  };
  const sph = (rx: number, ry: number, rz: number) => { const gg = new THREE.SphereGeometry(1, 24, 18); gg.scale(rx, ry, rz); return gg; };
  /** flat feather: capsule squashed in z, long axis along y (pointing down when rotated by the caller) */
  const feather = (len: number, w: number) => { const gg = new THREE.CapsuleGeometry(w / 2, Math.max(0.001, len - w), 4, 10); gg.scale(1, 1, 0.22); return gg; };

  bird.userData.wings = [];   // live parrot (parrotbird.ts) flaps these
  // ---- body (leaning forward a little)
  const body = new THREE.Group(); body.rotation.x = 0.16; body.position.set(0, 0.02, -0.02); bird.add(body);
  const prof: [number, number][] = [[0.0, 0.06], [0.036, 0.075], [0.062, 0.12], [0.074, 0.19], [0.071, 0.26], [0.058, 0.33], [0.043, 0.39], [0.037, 0.435], [0, 0.45]];
  const lathe = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 36);
  lathe.scale(1, 1, 0.88);
  add(body, lathe, redM, 0, 0, 0);
  // thighs ("trousers") and a slightly paler belly patch
  for (const sx of [-1, 1]) add(body, sph(0.03, 0.055, 0.04), redDeep, sx * 0.045, 0.12, 0.03);

  // ---- head
  const head = new THREE.Group(); head.position.set(0, 0.47, 0.012); head.rotation.set(0.12, 0.0, 0.1); body.add(head);
  add(head, sph(0.053, 0.056, 0.055), redM, 0, 0, 0);
  // bare face patch (a thin shell on the front of the head, wraps round to the eyes)
  const patch = add(head, sph(0.048, 0.04, 0.03), faceM, 0, -0.004, 0.036);
  patch.scale.set(1, 1, 1);
  for (const sx of [-1, 1]) {
    add(head, sph(0.0105, 0.0105, 0.006), irisM, sx * 0.041, 0.012, 0.034).rotation.y = sx * 0.9;
    const pu = add(head, sph(0.0058, 0.0058, 0.004), pupilM, sx * 0.0455, 0.012, 0.0365); pu.rotation.y = sx * 0.9;
    add(head, sph(0.011, 0.011, 0.011), faceM, sx * 0.04, 0.012, 0.03).scale.set(1.3, 1.3, 0.35);   // eyelid ring
  }
  // beak: upper mandible = tapering row of spheres along a hooked arc (ivory), lower = shorter black arc
  const arc = (from: [number, number], to: [number, number], bend: number, n: number, r0: number, r1: number, m: THREE.Material, w: number) => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = from[0] + (to[0] - from[0]) * t - bend * Math.sin(t * Math.PI * 0.5) * t;
      const z = from[1] + (to[1] - from[1]) * t;
      const rr = r0 + (r1 - r0) * Math.pow(t, 0.8);
      add(head, sph(rr * w, rr, rr * 1.05), m, 0, y, z);
    }
  };
  arc([0.02, 0.05], [-0.075, 0.112], 0.0, 12, 0.03, 0.006, hornM, 0.82);          // upper mandible curving down into the hook
  arc([-0.022, 0.05], [-0.043, 0.088], 0.0, 6, 0.024, 0.011, blackM, 0.8);        // lower mandible
  add(head, sph(0.03, 0.016, 0.02), hornM, 0, -0.005, 0.07);                      // cere / base of the beak
  for (const sx of [-1, 1]) add(head, sph(0.004, 0.003, 0.004), blackM, sx * 0.01, 0.0, 0.082);   // nostrils

  // ---- wings, folded along the body: red coverts, yellow band, green-blue greater coverts, blue flight feathers
  for (const sx of [-1, 1]) {
    const w = new THREE.Group(); w.position.set(sx * 0.071, 0.345, -0.012); w.rotation.set(0.05, 0, sx * -0.05); body.add(w); bird.userData.wings.push({ g: w, sx });
    add(w, sph(0.021, 0.1, 0.06), redM, 0, -0.09, 0).rotation.z = sx * 0.02;                // shoulder / lesser coverts
    add(w, sph(0.02, 0.05, 0.05), yellowM, sx * 0.004, -0.17, -0.004);                       // median coverts: yellow
    add(w, sph(0.019, 0.045, 0.048), greenM, sx * 0.005, -0.225, -0.006);                    // greater coverts: green
    for (let i = 0; i < 7; i++) {                                                            // primaries and secondaries
      const f = add(w, feather(0.3 - Math.abs(i - 3) * 0.012, 0.03), blueM, sx * (0.006 + 0.0012 * i), -0.2 - 0.145, -0.012 - i * 0.004);
      f.rotation.z = sx * (-0.035 + i * 0.01); f.position.x += sx * 0.0;
    }
  }

  // ---- tail: long graduated feathers, red with blue tips, hanging behind the perch
  const tail = new THREE.Group(); tail.position.set(0, 0.075, -0.072); tail.rotation.x = 0.16; bird.add(tail);
  const tailSpec: [number, number, number, THREE.Material][] = [[0, 0.48, 0.05, redDeep], [-0.025, 0.44, 0.045, redDeep], [0.025, 0.44, 0.045, redDeep], [-0.05, 0.36, 0.04, redM], [0.05, 0.36, 0.04, redM]];
  tailSpec.forEach(([x, len, w, m], i) => {
    const f = add(tail, feather(len, w), m, x, -len / 2, -0.004 * i);
    f.rotation.z = x * 0.7;
    const tip = add(tail, feather(len * 0.3, w * 0.92), blueM, x + Math.sin(x * 0.7) * len * 0.35, -len * 0.86, -0.004 * i - 0.001);   // blue tip
    tip.rotation.z = x * 0.7;
  });

  // ---- legs and zygodactyl feet gripping the perch (2 toes forward, 2 back)
  for (const sx of [-1, 1]) {
    const leg = add(bird, new THREE.CylinderGeometry(0.011, 0.013, 0.075, 8), footM, sx * 0.034, 0.045, -0.012);
    leg.rotation.x = 0.1;
    for (const dz of [1, -1]) for (const dx of [-0.011, 0.011]) {
      const toe = add(bird, new THREE.CapsuleGeometry(0.0065, 0.034, 3, 6), footM, sx * 0.034 + dx, 0.005, dz * 0.022);
      toe.rotation.x = Math.PI / 2 + dz * 0.25;
      add(bird, sph(0.005, 0.005, 0.007), blackM, sx * 0.034 + dx, 0.0, dz * 0.043);   // claw
    }
  }
  return bird;
}
