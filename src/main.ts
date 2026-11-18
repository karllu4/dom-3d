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
import { buildLighting, setLight, setScene, nextScene, SCENE_NAMES, setAtticMount, updateLightPool } from './lighting';
import { buildFurniture } from './furniture';
import { TapeMeasure } from './measure';
import { isTouch, initTouch } from './touch';

const compass = (b: number) => ['N','NE','E','SE','S','SW','W','NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- loading screen (the markup is in index.html, so it shows before this script has even downloaded)
function progress(frac: number, text: string) {
  const l = document.getElementById('loader'); if (!l) return;
  l.classList.remove('indeterminate');
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
  $('loader-fill').style.width = `${pct}%`;
  $('loader-pct').textContent = `${pct}%`;
  $('loader-text').textContent = text;
}
/** Let the browser paint between the heavy synchronous build steps (rAF stalls in background tabs, hence the timeout race). */
const nextFrame = () => new Promise<void>((r) => { const t = setTimeout(r, 60); requestAnimationFrame(() => { clearTimeout(t); setTimeout(r, 0); }); });
const stage = async (frac: number, text: string) => { progress(frac, text); await nextFrame(); };
function hideLoader() {
  const l = document.getElementById('loader'); if (!l) return;
  l.classList.add('done');
  setTimeout(() => l.remove(), 600);
}

async function main() {
  // textures stream in while the house is built: count them for the progress bar
  const tex = { loaded: 0, total: 0 };
  THREE.DefaultLoadingManager.onProgress = (_u, loaded, total) => { tex.loaded = loaded; tex.total = total; };
  await stage(0.02, 'Loading plan data…');
  const res = await fetch('house.json');
  if (!res.ok) throw new Error(`house.json: HTTP ${res.status}`);
  const house: HouseJ = await res.json();
  await stage(0.08, 'Setting up the renderer…');

  // ---------- renderer / scene
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.25 : 1.5));   // AO + MSAA at full retina resolution costs too many frames
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
  const quality = { high: !isTouch };   // phones: no ambient occlusion by default (battery / frame rate)
  const sceneRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: isTouch ? 0 : 4 });
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
  // fair-weather cumulus, static (animating them only cost frame time)
  su.cloudCoverage.value = 0.5;
  su.cloudDensity.value = 0.55;
  su.cloudScale.value = 0.00022;
  su.cloudSpeed.value = 0;
  su.cloudElevation.value = 0.55;
  su.sunPosition.value.copy(sunDir);
  scene.add(sky);

  const center = new THREE.Vector3(7, 3, 6.5);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.copy(center).addScaledVector(sunDir, 30);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isTouch ? 2048 : 4096, isTouch ? 2048 : 4096);
  const sc = sun.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 5; sc.far = 70;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 6;            // soft penumbra: sunlight through a hazy, partly cloudy sky
  sun.shadow.blurSamples = 16;
  scene.add(sun, sun.target);
  let sunBase = 1.7;
  const sunState = { month: new Date().getMonth() + 1, hour: 13 };
  const applySun = () => {
    const sp = sunPosition(site.lat, site.lon, sunState.month, 15, sunState.hour);
    sunDir.copy(bearingToWorld(sp.azimuth, Math.max(sp.elevation, -4), site.planDownBearingDeg));
    su.sunPosition.value.copy(sunDir);
    sun.position.copy(center).addScaledVector(sunDir, 30);
    const up = THREE.MathUtils.clamp(sp.elevation / 12, 0, 1);       // fade in after sunrise
    sunBase = 1.25 * up;               // softened (hazy Polish sky)
    sun.intensity = sunBase;
    const day = THREE.MathUtils.clamp((sp.elevation + 6) / 18, 0, 1);
    hemi.intensity = 0.04 + 0.35 * day;                 // small fill; most of the daylight comes from the sky env map
    ambient.intensity = 0.02 + 0.08 * day;
    scene.environmentIntensity = 0.01 + 0.12 * day;
    if (envTimer) clearTimeout(envTimer);
    envTimer = setTimeout(() => updateEnv(), envRT ? 120 : 0);   // re-filter the sky once the slider settles
    const when = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][sunState.month - 1]} 15, ${String(Math.floor(sunState.hour)).padStart(2, '0')}:${String(Math.round((sunState.hour % 1) * 60)).padStart(2, '0')}`;
    const where = `sun ${sp.elevation.toFixed(0)}° high, from ${compass(sp.azimuth)}`;
    const lbl = document.getElementById('sun-label');
    if (lbl) lbl.textContent = `${when} · ${where}`;
    document.getElementById('sim-when')!.textContent = when;       // always-visible simulation clock
    document.getElementById('sim-where')!.textContent = where;
  };
  /** + / - : move the simulated time half an hour later / earlier (the slider's range is 05:00-23:30) */
  const stepTime = (d: number) => {
    sunState.hour = Math.min(23.5, Math.max(5, sunState.hour + d));
    (document.getElementById('sun-hour') as HTMLInputElement).value = String(sunState.hour);
    applySun();
  };
  $('sim-later').onclick = () => stepTime(0.5);
  $('sim-earlier').onclick = () => stepTime(-0.5);
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
  await stage(0.16, 'Building walls, floors and roof…');
  const mats = makeMaterials();
  const hs = buildHouse(house, mats);
  scene.add(hs.root);
  await stage(0.46, 'Furnishing the rooms…');
  const furnitureGroups = buildFurniture(house, hs.world);
  for (const [lv, grp] of Object.entries(furnitureGroups)) hs.levels[lv].add(grp);
  const furniture = { get visible() { return furnitureGroups.parter.visible; }, set visible(v: boolean) { for (const grp of Object.values(furnitureGroups)) grp.visible = v; } };

  await stage(0.58, 'Placing the player…');
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
  // on phones there is no pointer lock: walking starts with the menu closing, and the Menu button reopens it
  const walkIn = () => {
    if (!isTouch) { player.controls.lock(); return; }
    menu.classList.add('hidden'); player.touch.active = true;
    try { void document.documentElement.requestFullscreen?.(); } catch { /* iOS Safari has none */ }
  };
  new MutationObserver(() => document.body.classList.toggle('menu-open', !menu.classList.contains('hidden'))).observe(menu, { attributes: true, attributeFilter: ['class'] });
  document.body.classList.add('menu-open');
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
        walkIn();
      };
      wrap.appendChild(b);
    }
    roomList.appendChild(wrap);
  }
  const state = { plan: false, roof: true, upper: true };
  // attic ceiling layer: 0 = off (as built today), 1 = insulation only, 2 = finished plasterboard
  let finishMode = 0;
  const baseRoofH = hs.world.roofH;
  const setFinish = (m: number, quiet = false) => {
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
    if (!quiet) showToast(['Attic ceiling layer off (current state)', 'Attic: 15 cm wool between rafters + 15 cm under, 30 cm on the ceiling', 'Attic: double plasterboard, flat ceiling 2.80 m (2/8: rising towards the door, 30 cm wool)'][m], 3000);
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
  await stage(0.62, 'Installing the lighting…');
  const roomLights = buildLighting(house, hs.levels);
  if (hs.finish) setFinish(2, true); else setAtticMount(0);   // attic starts with the insulation + plasterboard ceiling (I cycles: off / insulation / finished)
  const toast = showToast;
  // ---------- tape measure: T on/off, click = point, Z undo, X clear, N vertex snap
  const tape = new TapeMeasure(scene, camera, hs.root, $('hud'));
  let snap = true;
  const tapeStatus = () => {
    $('measure-status').textContent = tape.active ? `Measure · click 2 points · 1 floor · 2 nearest wall · 3 second wall · snap ${snap ? 'on' : 'off'} (N) · Z undo · X clear · T exit` : '';
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
  // K: cycle the scene of the room you stand in: all lights -> evening (ambient dimmed, task halved) -> night lights only -> off
  const cycleRoomScene = () => {
    const { label } = roomAt(house, player.pos.x, player.pos.y, player.feet);
    const ls = label ? roomLights.filter((r) => r.id === label.id) : [];
    if (!label || !ls.length) { toast('Not inside a lit room'); return; }
    const next = nextScene(ls[0].scene);
    ls.forEach((r) => setScene(r, next));
    toast(`${label.id} ${label.name}: ${SCENE_NAMES[next]}`);
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
  // overview: roof / attic buttons and "strip to base level" (roof + attic + ground-floor ceilings off, looking straight into the ground floor)
  const syncOverviewTools = () => {
    $('ov-roof').classList.toggle('on', state.roof);
    $('ov-attic').classList.toggle('on', state.upper);
    const stripped = !state.roof && !state.upper;
    $('ov-base').classList.toggle('on', stripped);
    $('ov-base').innerHTML = stripped ? 'Build back up <kbd>B</kbd>' : 'Strip to base level <kbd>B</kbd>';
  };
  const stripToBase = () => {
    const stripped = !state.roof && !state.upper;
    setRoof(stripped); setUpper(stripped);
    // restored: the roof stays off in overview (it hides the attic), only the attic comes back
    if (stripped && overview) setRoof(false);
    syncToggles();
  };
  const syncToggles = () => {
    syncOverviewTools();
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
    if (isTouch) { menu.classList.add('hidden'); player.touch.active = !overview; }
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
  $('ov-roof').onclick = () => { setRoof(!state.roof); syncToggles(); };
  $('ov-attic').onclick = () => { setUpper(!state.upper); syncToggles(); };
  $('ov-base').onclick = stripToBase;
  for (const k of Object.keys(actions)) $(`t-${k}`).onclick = () => { actions[k](); syncToggles(); };
  addEventListener('keydown', (e) => {
    const map: Record<string, string> = { KeyP: 'plan', KeyR: 'roof', KeyU: 'upper', KeyO: 'overview', KeyI: 'finish', KeyF: 'furniture' };
    const a = map[e.code];
    if (a) { actions[a](); syncToggles(); }
    if (e.code === 'KeyM') $('minimap').classList.toggle('hidden');
    if (e.code === 'KeyB' && overview) stripToBase();
    if ((e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') && !e.repeat) stepTime(0.5);
    if ((e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') && !e.repeat) stepTime(-0.5);
    if (e.code === 'KeyL' && !e.repeat) pressL();
    if (e.code === 'KeyK' && !e.repeat) cycleRoomScene();
    if (e.code === 'KeyQ' && !e.repeat) {
      quality.high = !quality.high;
      showToast(quality.high ? 'Quality: photo (ambient occlusion, AgX)' : 'Quality: fast', 2000);
    }
    if (e.code === 'KeyT' && !e.repeat) toggleTape();
    if (tape.active && e.code === 'KeyN') { snap = !snap; tapeStatus(); }
    if (tape.active && !e.repeat && /^(Digit|Numpad)[123]$/.test(e.code)) {
      // from the selected point (first click, else the crosshair): 1 = floor, 2 = nearest wall, 3 = second nearest wall
      const n = e.code.slice(-1);
      const d = n === '1' ? tape.toFloor(hs.world) : n === '2' ? tape.toWall(hs.world) : tape.toSecondWall(hs.world);
      const what = n === '1' ? 'floor' : n === '2' ? 'nearest wall' : 'second nearest wall';
      toast(d === null ? `No ${what} found` : `To ${what}: ${(d * 100).toFixed(1)} cm`);
    }
    if (tape.active && (e.code === 'KeyZ' || e.code === 'Backspace')) tape.undo();
    if (e.code === 'KeyX' && tape.count) { tape.clear(); toast('Measurements cleared'); }
    if (e.code === 'KeyE' && !overview) nearestDoor()?.toggle();
    if (e.code === 'KeyG' && hs.garage) {
      hs.garage.setVariant(hs.garage.variant + 1);
      showToast(`Garage door: ${hs.garage.label}`, 3500);
    }
  });
  syncToggles();

  $('start').onclick = () => {
    if (overview) toggleOverview();
    walkIn();
  };
  player.controls.addEventListener('lock', () => { menu.classList.add('hidden'); });
  player.controls.addEventListener('unlock', () => { if (!overview) menu.classList.remove('hidden'); });
  renderer.domElement.addEventListener('click', () => { if (!isTouch && !overview && !player.controls.isLocked) player.controls.lock(); });
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

  if (isTouch) {
    $('start').textContent = 'Tap to walk in';
    $('t-measure').style.display = 'none';
    document.querySelector('.help')!.innerHTML = '<span>Left stick — walk (push to the rim to run)</span><span>Drag the view — look around</span><span>Buttons: Door · Light (double tap = whole floor) · Scene · Crouch · Menu</span>';
    initTouch(player, renderer.domElement, {
      door: () => nearestDoor()?.toggle(),
      light: pressL,
      scene: cycleRoomScene,
      menu: () => { player.touch.active = false; player.touch.x = player.touch.y = 0; menu.classList.remove('hidden'); },
    }, () => player.touch.active && !overview);
  }

  // ---------- wait for textures, compile shaders, draw one hidden frame, then reveal
  await stage(0.68, 'Loading textures…');
  while (tex.total > tex.loaded) {
    progress(0.68 + 0.22 * (tex.loaded / Math.max(1, tex.total)), `Loading textures ${tex.loaded}/${tex.total}…`);
    await new Promise((r) => setTimeout(r, 80));
  }
  updateLightPool(camera.position);
  await stage(0.92, 'Compiling shaders…');
  try { await renderer.compileAsync(scene, camera); } catch { /* the first real frame compiles them anyway */ }
  await stage(0.97, 'Preparing the first frame…');
  renderer.setRenderTarget(sceneRT); renderer.render(scene, camera); renderer.setRenderTarget(null); composer.render(0);
  progress(1, 'Ready');
  hideLoader();

  // ---------- loop
  const timer = new THREE.Timer();
  timer.connect(document);
  let lastRoom = '';
  let lastLevel = '';
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = timer.getDelta();
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
      hint.textContent = near ? `${isTouch ? 'Door button' : 'E'} — ${near.open ? 'close' : 'open'} door · ${near.label}${near === hs.garage ? '  ·  G — next design' : ''}` : '';
      hint.classList.toggle('hidden', !near);
      minimap.draw(level, player.pos.x, player.pos.y, player.yaw(), label?.id ?? null, site.planDownBearingDeg);
      $('coords').textContent = `x ${player.pos.x.toFixed(2)}  y ${player.pos.y.toFixed(2)}  level ${player.feet >= 0 ? '+' : ''}${player.feet.toFixed(2)} m${player.crouch ? '  · crouching' : ''}`;
    }
    tape.update(innerWidth, innerHeight, snap);
    updateLightPool(overview ? orbit.target : camera.position);
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
