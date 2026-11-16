import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';
import type { HouseJ } from './types';
import { makeMaterials } from './materials';
import { buildHouse } from './house';
import { Player } from './player';
import { Minimap, roomAt, levelForFeet } from './hud';
import { sunPosition, bearingToWorld } from './sun';
import { buildLighting, setLight, setAtticMount } from './lighting';
import { buildFurniture } from './furniture';
import { TapeMeasure } from './measure';

const compass = (b: number) => ['N','NE','E','SE','S','SW','W','NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main() {
  const house: HouseJ = await (await fetch('house.json')).json();

  // ---------- renderer / scene
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // AO + MSAA at full retina resolution costs too many frames
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.AgXToneMapping;      // film-like highlight roll-off (photo look, no clipped whites)
  renderer.toneMappingExposure = 0.92;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 400);

  // ---------- post-processing ("photo" quality, Q toggles): scene -> ambient occlusion -> AgX + sRGB.
  // The scene is rendered into its own MSAA target so the AO uses the real depth (incl. roof-clipped attic walls).
  const quality = { high: true };
  const sceneRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
  sceneRT.depthTexture = new THREE.DepthTexture(innerWidth, innerHeight);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType }));
  composer.addPass(new TexturePass(sceneRT.texture));
  const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight, { depthTexture: sceneRT.depthTexture });
  gtao.blendIntensity = 1.0;
  gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 8, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 8 });
  composer.addPass(gtao);
  composer.addPass(new OutputPass());

  // Plan orientation: plan up = west (-Z), plan left = south (-X). Afternoon sun from the south-west.
  const site = house.site ?? { lat: 53.19, lon: 18.08, planDownBearingDeg: 90 };
  const sunDir = new THREE.Vector3(0, 1, 0);
  const sky = new Sky();
  sky.scale.setScalar(1000);
  const su = sky.material.uniforms;
  su.turbidity.value = 4;
  su.rayleigh.value = 1.4;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.8;
  // fair-weather cumulus drifting across the sky (the same clouds dim the sun when they pass in front of it)
  su.cloudCoverage.value = 0.5;
  su.cloudDensity.value = 0.55;
  su.cloudScale.value = 0.00022;
  su.cloudSpeed.value = 0.00000007; // barely perceptible drift: clouds change over minutes (shader time advances 1000 units per second)
  su.cloudElevation.value = 0.55;
  su.sunPosition.value.copy(sunDir);
  scene.add(sky);

  const center = new THREE.Vector3(7, 3, 6.5);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.copy(center).addScaledVector(sunDir, 30);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 5; sc.far = 70;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 6;            // soft penumbra: sunlight through a hazy, partly cloudy sky
  sun.shadow.blurSamples = 16;
  scene.add(sun, sun.target);
  let sunBase = 1.7, cloudLight = 1;
  const sunState = { month: new Date().getMonth() + 1, hour: 13 };
  const applySun = () => {
    const sp = sunPosition(site.lat, site.lon, sunState.month, 15, sunState.hour);
    sunDir.copy(bearingToWorld(sp.azimuth, Math.max(sp.elevation, -4), site.planDownBearingDeg));
    su.sunPosition.value.copy(sunDir);
    sun.position.copy(center).addScaledVector(sunDir, 30);
    const up = THREE.MathUtils.clamp(sp.elevation / 12, 0, 1);       // fade in after sunrise
    sunBase = 1.25 * up;               // softened (hazy Polish sky); clouds modulate it in the frame loop
    sun.intensity = sunBase * cloudLight;
    const day = THREE.MathUtils.clamp((sp.elevation + 6) / 18, 0, 1);
    hemi.intensity = 0.04 + 0.35 * day;                 // small fill; most of the daylight comes from the sky env map
    ambient.intensity = 0.02 + 0.08 * day;
    scene.environmentIntensity = 0.01 + 0.12 * day;
    if (envTimer) clearTimeout(envTimer);
    envTimer = setTimeout(() => updateEnv(), envRT ? 120 : 0);   // re-filter the sky once the slider settles
    const lbl = document.getElementById('sun-label');
    if (lbl) lbl.textContent = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][sunState.month - 1]} 15, ${String(Math.floor(sunState.hour)).padStart(2, '0')}:${String(Math.round((sunState.hour % 1) * 60)).padStart(2, '0')} · sun ${sp.elevation.toFixed(0)}° high, from ${compass(sp.azimuth)}`;
  };
  // Sunlight does not bounce in a rasterizer, so interiors get a soft, nearly neutral fill:
  // hemisphere (sky above, warm floor bounce below) + a little ambient for down-facing ceilings.
  const hemi = new THREE.HemisphereLight(0xf2f5ff, 0xd9cfbf, 1.25);
  const ambient = new THREE.AmbientLight(0xfff8f0, 0.55);
  scene.add(hemi, ambient);
  // image-based light: the same sky (without the sun disc) pre-filtered into an environment map, so every surface
  // gets sky-coloured fill and soft reflections instead of a flat ambient term
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky(); envSky.scale.setScalar(1000); envScene.add(envSky);
  let envRT: THREE.WebGLRenderTarget | null = null, envTimer: ReturnType<typeof setTimeout> | null = null;
  const updateEnv = () => {
    const eu = envSky.material.uniforms;
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity', 'cloudScale', 'cloudSpeed', 'cloudElevation', 'time']) eu[k].value = su[k].value;
    eu.sunPosition.value.copy(sunDir); eu.showSunDisc.value = 0;
    envRT?.dispose();
    envRT = pmrem.fromScene(envScene, 0, 0.1, 2000);
    scene.environment = envRT.texture;
  };
  applySun();
  (document.getElementById('sun-month') as HTMLInputElement).value = String(sunState.month);
  (document.getElementById('sun-hour') as HTMLInputElement).value = String(sunState.hour);
  document.getElementById('sun-month')!.addEventListener('input', (e) => { sunState.month = +(e.target as HTMLInputElement).value; applySun(); });
  document.getElementById('sun-hour')!.addEventListener('input', (e) => { sunState.hour = +(e.target as HTMLInputElement).value; applySun(); });
  scene.add(camera);

  // ---------- house
  const mats = makeMaterials();
  const hs = buildHouse(house, mats);
  scene.add(hs.root);
  const furnitureGroups = buildFurniture(house, hs.world);
  for (const [lv, grp] of Object.entries(furnitureGroups)) hs.levels[lv].add(grp);
  const furniture = { get visible() { return furnitureGroups.parter.visible; }, set visible(v: boolean) { for (const grp of Object.values(furnitureGroups)) grp.visible = v; } };

  // ---------- player & overview
  const player = new Player(camera, renderer.domElement, hs.world);
  player.teleport(house.spawn.x, house.spawn.y, house.outside.groundZ, house.spawn.yawDeg);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(7, 2, 6.5);
  orbit.enabled = false;
  orbit.maxPolarAngle = Math.PI * 0.49;
  let overview = false;
  let saved: { pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;

  // ---------- UI
  const minimap = new Minimap($('hud'));
  const menu = $('menu');
  const roomList = $('rooms');
  for (const lv of house.levels) {
    const h = document.createElement('h3');
    h.textContent = lv.name;
    roomList.appendChild(h);
    const wrap = document.createElement('div');
    wrap.className = 'room-buttons';
    for (const r of lv.rooms) for (const l of r.labels) {
      const b = document.createElement('button');
      b.innerHTML = `<b>${l.id}</b> ${l.name} <span>${l.area.toFixed(2)} m²</span>`;
      b.onclick = () => {
        if (overview) toggleOverview();
        player.teleport(l.at[0], l.at[1], r.floorZ + 0.05);
        player.controls.lock();
      };
      wrap.appendChild(b);
    }
    roomList.appendChild(wrap);
  }
  const state = { plan: false, roof: true, upper: true };
  // attic ceiling layer: 0 = off (as built today), 1 = insulation only, 2 = finished plasterboard
  let finishMode = 0;
  const baseRoofH = hs.world.roofH;
  const setFinish = (m: number) => {
    finishMode = m;
    if (hs.finish) {
      hs.finish.wool.visible = m === 1; // finished: wool is behind the boards
      hs.finish.board.visible = m === 2;
      const tb = hs.roof.getObjectByName('timbers'); if (tb) tb.visible = m !== 2; // rafters are behind the boards
      setAtticMount(m);
      const drop = hs.finish.drop;
      hs.world.roofH = m >= 1 ? (x: number, y: number) => baseRoofH(x, y) - drop : baseRoofH; // headroom under the lining
    }
    const b = $('t-finish');
    b.innerHTML = `Attic ceiling: ${['off', 'insulation', 'finished'][m]} <kbd>I</kbd>`;
    b.classList.toggle('on', m > 0);
    const t = $('toast');
    t.textContent = ['Attic ceiling layer off (current state)', 'Attic: 15 cm wool between rafters + 15 cm under, 30 cm on the ceiling', 'Attic: double plasterboard, flat ceiling 2.80 m'][m];
    t.classList.remove('hidden');
    clearTimeout((t as any)._h);
    (t as any)._h = setTimeout(() => t.classList.add('hidden'), 3000);
  };
  const setPlan = (v: boolean) => {
    state.plan = v;
    const lv = levelForFeet(house, player.feet).id;
    for (const [id, m] of Object.entries(hs.overlays)) m.visible = v && (overview || id === lv);
  };
  const setRoof = (v: boolean) => { state.roof = v; hs.roof.visible = v; };
  const setUpper = (v: boolean) => {
    state.upper = v;
    hs.levels['poddasze'].visible = v;
    const c = hs.levels['parter'].getObjectByName('ceilings'); if (c) c.visible = v;   // look into the ground floor from above
  };
  // ---------- room lighting: L = room you stand in, double L = whole floor
  const roomLights = buildLighting(house, hs.levels);
  setAtticMount(0); // attic starts bare: fixtures hang from the rafters
  const toast = (msg: string) => {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout((t as any)._h); (t as any)._h = setTimeout(() => t.classList.add('hidden'), 2500);
  };
  // ---------- tape measure: T on/off, click = point, Z undo, X clear, N vertex snap
  const tape = new TapeMeasure(scene, camera, hs.root, $('hud'));
  let snap = true;
  const tapeStatus = () => {
    $('measure-status').textContent = tape.active ? `Measure · click 2 points · snap ${snap ? 'on' : 'off'} (N) · Z undo · X clear · T exit` : '';
    $('measure-status').classList.toggle('hidden', !tape.active);
  };
  const toggleTape = () => { tape.toggle(); $('t-measure').classList.toggle('on', tape.active); tapeStatus(); };
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && tape.active && player.controls.isLocked && !overview) {
      const d = tape.click();
      if (d !== null) toast(`Distance: ${(d * 100).toFixed(1)} cm`);
    }
  });
  const toggleRoomLight = () => {
    const { label } = roomAt(house, player.pos.x, player.pos.y, player.feet);
    if (!label) { toast('Not inside a room'); return; }
    const ls = roomLights.filter((r) => r.id === label.id);
    const on = !ls.some((r) => r.on);
    ls.forEach((r) => setLight(r, on));
    toast(`${label.id} ${label.name}: light ${on ? 'on' : 'off'}`);
  };
  const toggleFloorLights = () => {
    const level = levelForFeet(house, overview ? 0 : player.feet);
    const ls = roomLights.filter((r) => r.level === level.id);
    const on = !ls.every((r) => r.on); // some off -> all on; all on -> all off
    ls.forEach((r) => setLight(r, on));
    toast(`${level.name}: all lights ${on ? 'on' : 'off'}`);
  };
  let lTimer: ReturnType<typeof setTimeout> | null = null;
  const pressL = () => {
    if (lTimer) { clearTimeout(lTimer); lTimer = null; toggleFloorLights(); return; }   // second press = double L
    lTimer = setTimeout(() => { lTimer = null; toggleRoomLight(); }, 320);
  };
  const syncToggles = () => {
    for (const [k, v] of Object.entries(state)) $(`t-${k}`)?.classList.toggle('on', v);
    $('t-overview').classList.toggle('on', overview);
  };

  function toggleOverview() {
    overview = !overview;
    if (overview) {
      saved = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
      player.controls.unlock();
      camera.position.set(-5, 13, 21);
      orbit.enabled = true;
      orbit.update();
      setRoof(false);
    } else {
      orbit.enabled = false;
      setRoof(true);
      setUpper(true);
      if (saved) { camera.position.copy(saved.pos); camera.quaternion.copy(saved.quat); }
    }
    setPlan(state.plan);
    document.body.classList.toggle('overview', overview);
    syncToggles();
  }

  const actions: Record<string, () => void> = {
    plan: () => setPlan(!state.plan),
    roof: () => setRoof(!state.roof),
    upper: () => setUpper(!state.upper),
    lights: () => toggleFloorLights(),
    overview: toggleOverview,
    finish: () => setFinish((finishMode + 1) % 3),
    furniture: () => { furniture.visible = !furniture.visible; for (const s of hs.world.solids) if (s.tag === 'furniture') s.off = !furniture.visible; $('t-furniture').classList.toggle('on', furniture.visible); },
  };
  $('t-measure').onclick = () => toggleTape();
  for (const k of Object.keys(actions)) $(`t-${k}`).onclick = () => { actions[k](); syncToggles(); };
  addEventListener('keydown', (e) => {
    const map: Record<string, string> = { KeyP: 'plan', KeyR: 'roof', KeyU: 'upper', KeyO: 'overview', KeyI: 'finish', KeyF: 'furniture' };
    const a = map[e.code];
    if (a) { actions[a](); syncToggles(); }
    if (e.code === 'KeyM') $('minimap').classList.toggle('hidden');
    if (e.code === 'KeyL' && !e.repeat) pressL();
    if (e.code === 'KeyQ' && !e.repeat) {
      quality.high = !quality.high;
      const t = $('toast'); if (t) { t.textContent = quality.high ? 'Quality: photo (ambient occlusion, AgX)' : 'Quality: fast'; t.classList.remove('hidden'); clearTimeout((t as any)._h); (t as any)._h = setTimeout(() => t.classList.add('hidden'), 2000); }
    }
    if (e.code === 'KeyT' && !e.repeat) toggleTape();
    if (tape.active && e.code === 'KeyN') { snap = !snap; tapeStatus(); }
    if (tape.active && (e.code === 'KeyZ' || e.code === 'Backspace')) tape.undo();
    if (e.code === 'KeyX' && tape.count) { tape.clear(); toast('Measurements cleared'); }
    if (e.code === 'KeyE' && !overview) nearestDoor()?.toggle();
    if (e.code === 'KeyG' && hs.garage) {
      hs.garage.setVariant(hs.garage.variant + 1);
      const t = $('toast');
      t.textContent = `Garage door: ${hs.garage.label}`;
      t.classList.remove('hidden');
      clearTimeout((t as any)._h);
      (t as any)._h = setTimeout(() => t.classList.add('hidden'), 3500);
    }
  });
  syncToggles();

  $('start').onclick = () => {
    if (overview) toggleOverview();
    player.controls.lock();
  };
  player.controls.addEventListener('lock', () => { menu.classList.add('hidden'); });
  player.controls.addEventListener('unlock', () => { if (!overview) menu.classList.remove('hidden'); });
  renderer.domElement.addEventListener('click', () => { if (!overview && !player.controls.isLocked) player.controls.lock(); });
  $('back').onclick = () => toggleOverview();

  // handle for automated screenshots / debugging from the console
  Object.assign(window, { dom3d: { player, camera, actions, house, world: hs.world, scene, renderer, menu, doors: hs.doors, roomLights, setLight, pressL, tape, quality } });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    sceneRT.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });

  const nearestDoor = () => {
    let best = null as (typeof hs.doors)[number] | null, bd = 3.0;
    for (const d of hs.doors) {
      const dist = Math.hypot(d.center[0] - player.pos.x, d.center[1] - player.pos.y);
      if (dist < bd && Math.abs(player.feet - d.floorZ) < 1.2) { bd = dist; best = d; }
    }
    return best;
  };

  // ---------- loop
  let envClock = 0;
  const timer = new THREE.Timer();
  timer.connect(document);
  let lastRoom = '';
  let lastLevel = '';
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = timer.getDelta();
    // clouds: drift the sky, and dim the sun smoothly when a cloud passes (two slow incommensurate waves ~ 1.5-4 min)
    su.time.value += dt * 1000;
    const tt = su.time.value / 1000;
    const cover = 0.5 + 0.32 * Math.sin(tt * 0.028) + 0.18 * Math.sin(tt * 0.065 + 1.7);   // 0..1, >0.6 = sun behind a cloud (every few minutes)
    const target = 1 - 0.62 * THREE.MathUtils.smoothstep(cover, 0.55, 0.8);
    cloudLight += (target - cloudLight) * Math.min(1, dt * 0.4);
    sun.intensity = sunBase * cloudLight;
    envClock += dt;
    if (envClock > 12) { envClock = 0; updateEnv(); }                                        // refresh the sky reflections now and then
    for (const d of hs.doors) d.update(dt);
    if (overview) {
      orbit.update();
    } else {
      player.update(dt);
      const { level, label } = roomAt(house, player.pos.x, player.pos.y, player.feet);
      const key = `${level.id}|${label?.id ?? ''}`;
      if (key !== lastRoom) {
        lastRoom = key;
        $('room-name').textContent = label ? `${label.id} · ${label.name}` : 'Outside';
        $('room-meta').textContent = label ? `${level.name} · ${label.area.toFixed(2)} m² (per plan)` : level.name;
      }
      if (level.id !== lastLevel) { lastLevel = level.id; setPlan(state.plan); }
      const near = nearestDoor();
      const hint = $('hint');
      hint.textContent = near ? `E — ${near.open ? 'close' : 'open'} door · ${near.label}${near === hs.garage ? '  ·  G — next design' : ''}` : '';
      hint.classList.toggle('hidden', !near);
      minimap.draw(level, player.pos.x, player.pos.y, player.yaw(), label?.id ?? null, site.planDownBearingDeg);
      $('coords').textContent = `x ${player.pos.x.toFixed(2)}  y ${player.pos.y.toFixed(2)}  level ${player.feet >= 0 ? '+' : ''}${player.feet.toFixed(2)} m${player.crouch ? '  · crouching' : ''}`;
    }
    tape.update(innerWidth, innerHeight, snap);
    if (quality.high) {
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      composer.render(dt);
    } else renderer.render(scene, camera);
  });
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="padding:16px;color:#b00">${String(e?.stack ?? e)}</pre>`;
});
