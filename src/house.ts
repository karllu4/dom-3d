import * as THREE from 'three';
import type { HouseJ, LevelJ, OpeningJ, Pt, Rect } from './types';
import { flatGeometry, pointInPoly, prismGeometry, rectPoly, slopedGeometry, slopedSkirt } from './geometry';
import { clipAboveRoof, roofClipDepthMaterial, TILE_GAUGE, TILE_GAUGE_RANGE, type Materials } from './materials';
import { makeRoofHeight, roofGLSL } from './roof';
import { World, solidFromPoly, solidFromRect, solidFromSegment, type Solid } from './physics';

export interface HouseScene {
  root: THREE.Group;
  levels: Record<string, THREE.Group>;
  roof: THREE.Group;
  overlays: Record<string, THREE.Mesh>;
  world: World;
  doors: Openable[];
  garage?: GarageDoor;
  /** entrance recess as built: raw-concrete pieces (hidden once a facade design plasters them) and the foam under the slab */
  /** slab-edge prisms (entrance canopy, covered terrace): bare concrete as built, plastered like the walls once a facade design is picked */
  soffits: THREE.Mesh[];
  entrance?: { raw: THREE.Group; foam: THREE.MeshStandardMaterial; foamGroup: THREE.Group };
  finish?: { wool: THREE.Group; board: THREE.Group; drop: number };
}


function mesh(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadows;
  m.receiveShadow = true;
  return m;
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0), Math.abs(y1 - y0));
  const m = mesh(g, mat);
  m.position.set((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2);
  return m;
}

export function buildHouse(h: HouseJ, mats: Materials): HouseScene {
  const root = new THREE.Group();
  const world = new World();
  const roofH = makeRoofHeight(h.roof, true); // inside the walls: gable roofs count only over their bays
  world.roofH = roofH;
  const glsl = roofGLSL(h.roof);
  const levels: Record<string, THREE.Group> = {};
  const overlays: Record<string, THREE.Mesh> = {};
  const doors: Openable[] = [];
  let garage: GarageDoor | undefined;
  const julietMat = new THREE.MeshStandardMaterial({ color: h.julietColor ?? '#3e4145', roughness: 0.55, metalness: 0.3 }); // anthracite powder coat, same as the Braas Turmalin roof

  const footprints = Object.fromEntries(h.levels.map((l) => [l.id, l.footprint]));
  const insideLevel = (lv: string) => (x: number, y: number) => pointInPoly(x, y, footprints[lv]);

  // Attic walls are extruded tall and trimmed by the roof shape on the GPU.
  const clip = h.roof.thickness;
  const atticMats = [clipAboveRoof(mats.plaster, glsl, clip), clipAboveRoof(mats.facade, glsl, clip), clipAboveRoof(mats.wallTop, glsl, clip)];
  const atticDepth = roofClipDepthMaterial(glsl, clip);
  const groundMats = [mats.plaster, mats.facade, mats.wallTop];

  for (const lv of h.levels) {
    const g = new THREE.Group();
    g.name = lv.id;
    levels[lv.id] = g;
    root.add(g);
    const isAttic = lv.id !== 'parter';
    const wallMats = isAttic ? atticMats : groundMats;
    const outside = (x: number, y: number) => !insideLevel(lv.id)(x, y);

    const addWall = (poly: Parameters<typeof prismGeometry>[0], z0: number, z1: number, collide = true) => {
      const m = mesh(prismGeometry(poly, z0, z1, outside), wallMats);
      if (isAttic) m.customDepthMaterial = atticDepth;
      g.add(m);
      if (collide) world.solids.push(solidFromPoly(poly, z0, z1, 'wall'));
    };

    // walls
    for (const w of lv.walls) addWall(w, w.z0, w.z1); // per-piece base heights come from build_house.py
    // beam over the entrance recess: its front is a strip of the facade wall itself (same mesh type and plane as the piers and the wall above), not a separate slab face
    if (!isAttic) {
      const eo = h.openings.find((o) => o.kind === 'entrance' && o.level === lv.id);
      const sp = eo && h.soffits?.find((q) => {
        const xs = q.outer.map((v) => v[0]), cx = (eo.rect[0] + eo.rect[2]) / 2;
        return Math.min(...xs) < cx && Math.max(...xs) > cx && Math.max(...q.outer.map((v) => v[1])) > eo.rect[3];
      });
      if (eo && sp) {
        const xs = sp.outer.map((v) => v[0]);
        addWall(rectPoly([Math.min(...xs) - 0.1, 10.087, Math.max(...xs) + 0.1, 10.097] as Rect), 2.925, 3.335);   // overlaps the walls either side and above, so no edge of its own shows   // 10.097 = facade plane of the piers
        // finished facade: the lowered recess ceiling (20 cm foam, rendered over) is a strip of the same wall mesh family below the beam front plus a flat underside, so there is no front face of its own to show seams
        const ys = sp.outer.map((v) => v[1]), x0 = Math.min(...xs), x1 = Math.max(...xs);
        const ceil = new THREE.Group();
        ceil.name = 'entrance-ceiling'; ceil.visible = false;
        ceil.add(mesh(prismGeometry(rectPoly([x0 - 0.1, 10.087, x1 + 0.1, 10.097] as Rect), 2.725, 2.925, outside), wallMats));
        ceil.add(mesh(flatGeometry(rectPoly([x0, Math.min(...ys), x1, 10.097] as Rect), 2.725, false), mats.facade));
        g.add(ceil);
      }
    }

    // openings: sill + lintel blocks, frames, glass, railings
    for (const o of h.openings.filter((o) => o.level === lv.id)) {
      const [z0, z1] = lv.wallZ;
      const r = rectPoly(o.rect);
      // interior doors have no sill block (it would hang below the ceiling of the room underneath)
      // doorways: the floor runs through them, so no sill block (only windows get a parapet below the sill)
      const passable = ['door', 'extdoor', 'entrance', 'hs', 'balcony', 'gate'].includes(o.kind);
      if (!passable && o.sill > z0 + 0.01) addWall(r, z0, o.sill);
      else if (passable && !isAttic && o.sill > z0 + 0.01) addWall(r, z0, o.sill - 0.005, false); // hidden support below the floor
      // attic balcony doors sit on the outer face of a 44 cm wall: the wall must run up to the threshold (the floor slab does not reach through it)
      else if (passable && isAttic && o.kind === 'balcony' && o.sill > z0 + 0.01) addWall(r, z0, o.sill - 0.005, false);
      if (o.head < z1 - 0.01) addWall(r, o.head, z1, true);
      if (o.door) {
        const sub = () => { const grp = new THREE.Group(); g.add(grp); return grp; };
        const pg = sub();
        const planned = buildDoor(pg, o, mats, insideLevel(lv.id), world);
        planned.group = pg; planned.variant = 'planned';
        doors.push(planned);
        if (o.door.temporary) {
          const tg = sub();
          const temp = buildTempDoor(tg, o, mats, insideLevel(lv.id), world);
          temp.group = tg; temp.variant = 'temporary';
          doors.push(temp);
          temp.setActive(false);           // planned door is the default; the OSB door (site state) is switchable
        }
      }
      else if (o.garage) { frameOnly(g, o, true, mats); garage = new GarageDoor(g, o, world); doors.push(garage); }
      else buildOpeningFill(g, o, lv, mats, insideLevel(lv.id), world, julietMat);
    }

    // floors, ceilings, slabs
    for (const room of lv.rooms) {
      for (const f of room.floor) {
        const bottom = room.slabBottomZ ?? room.floorZ - 0.3;
        world.solids.push(solidFromPoly(f, bottom, room.floorZ, 'floor'));
      }
      if (room.ceilZ != null) for (const c of room.ceil) {
        let cg = g.getObjectByName('ceilings') as THREE.Group | undefined;
        if (!cg) { cg = new THREE.Group(); cg.name = 'ceilings'; g.add(cg); }
        cg.add(mesh(flatGeometry(c, room.ceilZ, false), mats.ceiling, true));
      }
    }

    // continuous concrete floor per floor height (runs through doorways)
    for (const fl of lv.floors ?? []) for (const p of fl.polys) g.add(mesh(flatGeometry(p, fl.z, true), mats.concrete, true));
    for (const ds of lv.doorStrips ?? []) world.solids.push(solidFromRect(ds.rect, ds.z - 0.3, ds.z, 'threshold'));
    // ground floor: concrete base just under the floor so no gap can ever show the grass below
    if (!isAttic) g.add(mesh(flatGeometry(lv.footprint, lv.floorZ - 0.02, true), mats.concrete, false));

    // plan overlay (toggle with P)
    const [x0, y0, x1, y1] = lv.overlay.rect;
    // the architect's plan images are not part of the public copy: when missing, the overlay stays empty
    const tex = new THREE.TextureLoader().load(lv.overlay.img, undefined, undefined, () => { ov.userData.missing = true; ov.material.visible = false; });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const ov = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, y1 - y0).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    ov.position.set((x0 + x1) / 2, lv.floorZ + 0.015, (y0 + y1) / 2);
    ov.renderOrder = 2;
    ov.visible = false;
    overlays[lv.id] = ov;
    g.add(ov);
  }

  // downstand beams (podciągi) below the ground-floor ceiling
  for (const b of h.beams ?? []) {
    levels[b.level].add(mesh(prismGeometry(rectPoly(b.rect), b.bottom, b.top), [mats.plaster, mats.plaster, mats.plaster]));
    world.solids.push(solidFromRect(b.rect, b.bottom, b.top, 'beam'));
  }

  // steel frame (2/8): posts up to the underside of the rafters, beams between given 3D points
  if (h.steel) {
    const steel = new THREE.MeshStandardMaterial({ color: h.steel.color, roughness: 0.45, metalness: 0.5 });
    for (const p of h.steel.posts) {
      const [x, y] = p.at, s2 = p.size / 2;
      const top = roofH(x, y);
      levels['poddasze'].add(box(x - s2, y - s2, p.base, x + s2, y + s2, top, steel));
      world.solids.push(solidFromRect([x - s2, y - s2, x + s2, y + s2], p.base, top, 'steel'));
    }
    for (const b of h.steel.beams) {
      const A = new THREE.Vector3(b.from[0], b.from[2], b.from[1]), B = new THREE.Vector3(b.to[0], b.to[2], b.to[1]);
      const m = mesh(new THREE.BoxGeometry(b.w, b.h, A.distanceTo(B)), steel);
      m.position.copy(A).add(B).multiplyScalar(0.5);
      m.lookAt(B);
      levels['poddasze'].add(m);
    }
    // steel members lying in the roof slopes (like rafters), e.g. between the roof windows in 2/8
    // the steel must never poke through the roof covering: clip it at the top of the roof build-up (tiles, battens)
    const steelClip = clipAboveRoof(steel, glsl, clip - 0.015);
    const steelDepth = roofClipDepthMaterial(glsl, clip - 0.015);
    for (const b of h.steel.roofBeams ?? []) {
      const m = timberOnPlane(b.p, b.planes, b.width, b.rise, steelClip);
      m.customDepthMaterial = steelDepth;
      levels['poddasze'].add(m);
    }
  }
  // timber posts with head pieces (S2/S3 in 2/8)
  for (const p of h.timberPosts?.posts ?? []) {
    const [x, y] = p.at, s2 = p.size / 2;
    const hd = p.head;
    const top = roofH(x, y) - (hd ? hd.h : 0);
    levels['poddasze'].add(box(x - s2, y - s2, p.base, x + s2, y + s2, top, mats.timber));
    world.solids.push(solidFromRect([x - s2, y - s2, x + s2, y + s2], p.base, top, 'post'));
    if (hd) {
      const l2 = hd.length / 2, w2 = hd.w / 2;
      levels['poddasze'].add(hd.axis === 'x'
        ? box(x - l2, y - w2, top, x + l2, y + w2, top + hd.h, mats.timber)
        : box(x - w2, y - l2, top, x + w2, y + l2, top + hd.h, mats.timber));
    }
  }

  // overhanging slab (covered terrace / entrance canopy): bare concrete, as built
  const soffitMeshes: THREE.Mesh[] = [];
  for (const sp of h.soffits ?? []) {
    // kept just inside the attic floor (top 3.33) and just below the attic walls (bottom 2.925) so no surface
    // is coplanar with them (coplanar faces flicker)
    const sm = mesh(prismGeometry(sp, 2.925, 3.33), [mats.slabConcrete, mats.slabConcrete, mats.slabConcrete]);
    const eo2 = h.openings.find((o) => o.kind === 'entrance');
    if (eo2) {
      const xs2 = sp.outer.map((v) => v[0]), cx2 = (eo2.rect[0] + eo2.rect[2]) / 2;
      if (Math.min(...xs2) < cx2 && Math.max(...xs2) > cx2 && Math.max(...sp.outer.map((v) => v[1])) > eo2.rect[3]) sm.name = 'entrance-slab';
    }
    soffitMeshes.push(sm);
    levels['parter'].add(sm);
  }

  let entrance: HouseScene['entrance'];
  // entrance recess as built (site photos 2026-11-21): raw concrete piers and ring beam, concrete lintel over the door opening
  const entr = h.openings.find((o) => o.kind === 'entrance' && o.door?.temporary);
  const entrSoffit = entr && h.soffits?.find((sp) => {
    const xs = sp.outer.map((p) => p[0]), ys = sp.outer.map((p) => p[1]);
    const cx = (entr.rect[0] + entr.rect[2]) / 2, y1 = entr.rect[3];
    return Math.min(...xs) < cx && Math.max(...xs) > cx && Math.min(...ys) < y1 + 0.1 && Math.max(...ys) > y1;
  });
  if (entr && entrSoffit) {
    const xs = entrSoffit.outer.map((p) => p[0]), ys = entrSoffit.outer.map((p) => p[1]);
    const nx0 = Math.min(...xs), nx1 = Math.max(...xs), back = entr.rect[3], front = Math.max(...ys) + 0.005;
    const e = 0.012, zb = h.outside.groundZ + 0.12, zt = 2.925;
    const pierL = 3.761, pierR = 6.999;       // outer edges of the piers (ground-floor wall outline)
    const pg = new THREE.Group();   // raw concrete pieces
    const foamG = new THREE.Group();
    pg.add(box(pierL, front, zb, nx0, front + e, zt, mats.rawConcrete));       // left pier, front face
    pg.add(box(nx0, back, zb, nx0 + e, front + e, zt, mats.rawConcrete));      // left pier, face towards the recess
    pg.add(box(nx1, front, zb, pierR, front + e, zt, mats.rawConcrete));       // right pier, front face
    pg.add(box(nx1 - e, back, zb, nx1, front + e, zt, mats.rawConcrete));      // right pier, face towards the recess
    // lintel over the opening (bearing ~10 cm each side), flush with the back wall
    pg.add(box(entr.rect[0] - 0.1, back, entr.head, entr.rect[2] + 0.1, back + 0.012, entr.head + 0.2, mats.rawConcrete));
    // 20 cm graphite EPS under the slab over the recess (between the piers, back wall to front edge)
    foamG.add(box(nx0 + e, back, 2.925 - 0.2, nx1 - e, front, 2.925, mats.epsGraphite));
    world.solids.push(solidFromRect([nx0 + e, back, nx1 - e, front], 2.925 - 0.2, 2.925, 'eps'));
    levels['parter'].add(pg, foamG);
    entrance = { raw: pg, foam: mats.epsGraphite, foamGroup: foamG };
  }

  buildStairs(h, mats, levels, world);
  const roof = buildRoof(h, mats);
  root.add(roof);
  buildOutside(h, mats, root, world);

  // planned attic ceiling & insulation (toggle I): wool group and plasterboard group, both hidden at start
  let finish: HouseScene['finish'];
  if (h.atticFinish) {
    const af = h.atticFinish;
    const s = Math.sqrt(1 + h.roof.k * h.roof.k);
    const wool = new THREE.Group(), board = new THREE.Group();
    wool.name = 'attic-wool'; board.name = 'attic-board';
    for (const r of af.rooms) {
      for (const sp of r.slopes) {
        // layer 1 between the rafters: up to 5 cm under the boarding; layer 2 under the rafters
        const top = af.woolBetween * s, under = -af.woolUnder * s;
        wool.add(mesh(slopedGeometry(sp, sp.plane, top, false), mats.wool, false));
        wool.add(mesh(slopedGeometry(sp, sp.plane, under, false), mats.wool, false));
        board.add(mesh(slopedGeometry(sp, sp.plane, under - af.board * s, false), mats.plasterboard));
      }
      for (const fp of r.flats) {
        // 30 cm wool lying on the ceiling (top and bottom only: its sides are against the walls)
        wool.add(mesh(flatGeometry(fp, r.ceil + af.woolFlat, true), mats.wool, false));
        wool.add(mesh(flatGeometry(fp, r.ceil + af.board, false), mats.wool, false));
        board.add(mesh(flatGeometry(fp, r.ceil, false), mats.plasterboard));
      }
    }
    // insulation tunnel round the steel ridge beam where it hangs below the rising ceiling (north end of 2/8)
    const bt = af.beamTunnel, rcPlane = Object.values(af.risingCeiling ?? {})[0]?.plane;
    const tb = bt ? h.steel?.roofBeams?.[bt.beam] : undefined;
    if (bt && tb && rcPlane) {
      const rp: [number, number, number] = [rcPlane[0], rcPlane[1], rcPlane[2] - (af.woolUnder + af.board) * s];   // slope lining face
      const xc = tb.p[0], [pa, pb, pc] = tb.planes[0];
      const cover = af.woolUnder + af.board;
      const zBeam = pa * xc + pb * tb.p[1] + pc;                  // underside of the steel beam (horizontal along the ridge)
      // the tunnel's underside is the flat ceiling level of its room, so the tunnel hangs from the rising lining down to the flat ceiling
      // and then continues in the same plane: one block, no end face or step along the beam
      const tRoom = af.rooms.find((r) => r.ids.includes(Object.keys(af.risingCeiling ?? {})[0]));
      const zb = (tRoom ? tRoom.ceil : zBeam - cover) + 0.003;
      const [xL, xR] = bt.xRange ?? [xc - (tb.width / 2 + cover), xc + (tb.width / 2 + cover)];   // block width: by default just the beam, or the given span
      const ceilAt = (y: number) => rp[0] * xc + rp[1] * y + rp[2];
      // the tunnel is a true cuboid: it runs from the wall to where the lining face has risen to the beam's underside, i.e. until the
      // beam no longer hangs below the lining, and ends in a vertical rectangular end face (not a tapering point where steel could peek out)
      // ONE block: a cuboid-like box as wide as the notch in the lining (so it also swallows the step walls there), hanging from the
      // rising lining down to the flat ceiling level; it ends exactly where the lining face comes down to that level (no end face, no step)
      const y0 = bt.yWall;
      const yE = (rp[0] * xc + rp[2] - zb) / -rp[1];
      const capTop = zb;
      if (yE > y0 && ceilAt(y0) > zb) {
        const V = (x: number, z: number, y: number) => new THREE.Vector3(x, z, y);
        const mid = V((xL + xR) / 2, (zb + ceilAt(y0)) / 2, (y0 + yE) / 2);
        const build = (inset: number, zbot: number, yEnd: number, grp: THREE.Group, mat: THREE.Material, shadow: boolean, extra = 0) => {
          const pos: number[] = [], uv: number[] = [];
          const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
            const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
            const cen = a.clone().add(b).add(c).divideScalar(3);
            if (n.dot(cen.sub(mid)) < 0) [b, c] = [c, b];
            for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); uv.push(v.x + v.z, v.y); }
          };
          const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => { tri(a, b, c); tri(a, c, d); };
          const xl = xL + inset, xr = xR - inset;
          const top0 = ceilAt(y0) + extra, topE = capTop + extra;       // extra: the wool reaches up into the lining layers (no sliver at the join)
          for (const sx of [xl, xr]) quad(V(sx, zbot, y0), V(sx, zbot, yEnd), V(sx, topE, yEnd), V(sx, top0, y0));   // sides
          quad(V(xl, zbot, y0), V(xr, zbot, y0), V(xr, zbot, yEnd), V(xl, zbot, yEnd));                                  // underside
          quad(V(xl, zbot, yEnd), V(xr, zbot, yEnd), V(xr, topE, yEnd), V(xl, topE, yEnd));                              // end face
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
          g.computeVertexNormals();
          grp.add(mesh(g, mat, shadow));
        };
        build(0, zb, yE, board, mats.plasterboard, true);
        build(af.board, zb + af.board, yE - af.board, wool, mats.wool, false, 0.08);
      }
    }
    // step walls: where the rising lining (2/8) meets the flat ceiling beside it, the lining stands higher than the flat ceiling, so a
    // vertical wool + plasterboard wall closes the step (otherwise the room is open into the roof void and the steel beam shows through)
    for (const [rid, rc] of Object.entries(af.risingCeiling ?? {})) {
      const room = af.rooms.find((r) => r.ids.includes(rid));
      if (!room) continue;
      const dropS = (af.woolUnder + af.board) * s;
      const hFace = (x: number, y: number) => rc.plane[0] * x + rc.plane[1] * y + rc.plane[2] - dropS;
      for (const sp of room.slopes) {
        if (sp.plane.some((c, i) => Math.abs(c - rc.plane[i]) > 1e-6) || !pointInPoly(rc.seed[0], rc.seed[1], sp)) continue;
        const ring = sp.outer;
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
          const L = Math.hypot(bx - ax, by - ay);
          if (L < 0.05) continue;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          let nx = -(by - ay) / L, ny = (bx - ax) / L;
          if (pointInPoly(mx + nx * 0.03, my + ny * 0.03, sp)) { nx = -nx; ny = -ny; }   // outward from the lining piece
          if (!room.flats.some((fp) => pointInPoly(mx + nx * 0.03, my + ny * 0.03, fp))) continue;   // only edges that meet the flat ceiling
          const za = Math.max(room.ceil, hFace(ax, ay)), zb2 = Math.max(room.ceil, hFace(bx, by));
          if (Math.max(za, zb2) - room.ceil < 0.01) continue;
          const wall = (off: number, z0: number, up: number, grp: THREE.Group, mat: THREE.Material, shadow: boolean) => {
            const A = new THREE.Vector3(ax - nx * off, z0, ay - ny * off), B = new THREE.Vector3(bx - nx * off, z0, by - ny * off);
            const At = new THREE.Vector3(A.x, za + up, A.z), Bt = new THREE.Vector3(B.x, zb2 + up, B.z);
            const ref = new THREE.Vector3(nx, 0, ny);
            const pos: number[] = [];
            const tri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) => {
              const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
              if (n.dot(ref) < 0) [p1, p2] = [p2, p1];
              for (const v of [p0, p1, p2]) pos.push(v.x, v.y, v.z);
            };
            tri(A, B, Bt); tri(A, Bt, At);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: pos.length / 3 }, (_, k) => [pos[k * 3] + pos[k * 3 + 2], pos[k * 3 + 1]]).flat(), 2));
            g.computeVertexNormals();
            grp.add(mesh(g, mat, shadow));
          };
          wall(0, room.ceil, 0.01, board, mats.plasterboard, true);                       // room side: board down to the flat ceiling
          wall(af.board, room.ceil + af.board, 0.14, wool, mats.wool, false);              // wool behind it, reaching up into the lining layers
        }
      }
    }
    // bare wall triangles left beside the lining: fill with wool + plasterboard panels flush on the wall (config atticFinish.wallFills)
    for (const wf of af.wallFills ?? []) {
      const panel = (off: number, mat: THREE.Material, grp: THREE.Group, shadow: boolean) => {
        const c = wf.c + wf.n * off;
        const pts = wf.poly.map(([u, z]) => (wf.axis === 'x' ? new THREE.Vector3(c, z, u) : new THREE.Vector3(u, z, c)));
        const pos: number[] = [], ref = wf.axis === 'x' ? new THREE.Vector3(wf.n, 0, 0) : new THREE.Vector3(0, 0, wf.n);
        for (let i = 1; i + 1 < pts.length; i++) {
          let [a, b, c] = [pts[0], pts[i], pts[i + 1]];
          if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).dot(ref) < 0) [b, c] = [c, b];
          for (const v of [a, b, c]) pos.push(v.x, v.y, v.z);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: pos.length / 3 }, (_, k) => [pos[k * 3], pos[k * 3 + 1]]).flat(), 2));
        g.computeVertexNormals();
        grp.add(mesh(g, mat, shadow));
      };
      panel(0.005, mats.wool, wool, false);
      panel(af.board + 0.005, mats.plasterboard, board, true);
    }
    // roof windows / hatch: plasterboard reveal through the extra lining depth (down to the board face)
    for (const it of h.roof.items) {
      const reveal = mats.plasterboard;
      board.add(mesh(slopedSkirt(rectPoly(it.rect), it.plane, -(af.woolUnder + af.board) * s, 0), reveal));
      wool.add(mesh(slopedSkirt(rectPoly(it.rect), it.plane, -af.woolUnder * s, af.woolBetween * s), mats.wool, false));
    }
    // triangular wall pieces between the main roof and the bay roofs (2/2, 2/5): wool + plasterboard on the
    // room side, from the main slope lining up to the bay roof, so the insulation is continuous
    const wallRoof = makeRoofHeight(h.roof, true);
    // height of the finished sloped ceiling (board face) at a plan point: lowest lined slope containing it
    const allSlopes = af.rooms.flatMap((r) => r.slopes);
    const liningAt = (x: number, y: number, fallback: number, highest = false) => {
      let z = highest ? -Infinity : Infinity;
      for (const sp of allSlopes) if (pointInPoly(x, y, sp)) {
        const v = sp.plane[0] * x + sp.plane[1] * y + sp.plane[2] - (af.woolUnder + af.board) * s;
        z = highest ? Math.max(z, v) : Math.min(z, v);
      }
      return Number.isFinite(z) ? z : fallback;
    };
    const dropV = (af.woolUnder + af.board) * s;
    // collar ties hanging below the slope lining (e.g. the ends over the rising ceiling of 2/8): boxed in a wool + plasterboard cuboid.
    // Neighbouring ties with the same overhang are joined into ONE continuous bulkhead along the wall.
    {
      const cover = af.woolUnder + af.board, ttb = h.roof.tie.board ?? 0.04, ttd = h.roof.tie.depth ?? 0.2;
      const off = h.roof.rafter.width / 2 + ttb / 2, halfW = off + ttb / 2 + cover;
      type Run = { alongX: boolean; c: number; lo: number; hi: number; zb: number; zt: number; ri: number };   // c = tie axis position across, [lo, hi] = overhang along the tie
      const runs: Run[] = [];
      // lining face under a point and the room it belongs to (a box must stay inside its own room: no slivers through the walls)
      const faceAt = (x: number, y: number): { face: number; ri: number } => {
        let face = Infinity, ri = -1;
        af.rooms.forEach((r, i) => { for (const sp of r.slopes) if (pointInPoly(x, y, sp)) {
          const v = sp.plane[0] * x + sp.plane[1] * y + sp.plane[2] - dropV;
          if (v < face) { face = v; ri = i; }
        } });
        return { face, ri };
      };
      const roomBox = af.rooms.map((r) => {
        const pts = [...r.slopes, ...r.flats].flatMap((q) => q.outer);
        return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
      });
      for (const tie of h.roof.ties) {
        const [ax, ay, bx, by] = tie.p;
        const L = Math.hypot(bx - ax, by - ay), alongX = Math.abs(bx - ax) > Math.abs(by - ay);
        const zb = tie.z - cover;
        let run: [number, number] | null = null, runRi = -1;
        const flush = () => {
          if (!run) return;
          const [t0, t1] = run; run = null;
          const u0 = alongX ? ax + (bx - ax) * t0 / L : ay + (by - ay) * t0 / L, u1 = alongX ? ax + (bx - ax) * t1 / L : ay + (by - ay) * t1 / L;
          runs.push({ alongX, c: alongX ? ay : ax, lo: Math.min(u0, u1), hi: Math.max(u0, u1), zb, zt: tie.z + ttd, ri: runRi });
        };
        for (let t = 0; t <= L + 1e-6; t += 0.02) {
          const [x, y] = [ax + (bx - ax) * t / L, ay + (by - ay) * t / L];
          const { face, ri } = faceAt(x, y);
          if (Number.isFinite(face) && zb < face - 0.015) { if (run && ri !== runRi) flush(); run = run ? [run[0], t] : [t, t]; runRi = ri; } else flush();
        }
        flush();
      }
      // cluster: same direction, same bottom, same far end (±3 cm), neighbours at most 1.2 m apart
      runs.sort((p, q) => Number(p.alongX) - Number(q.alongX) || p.zb - q.zb || p.lo - q.lo || p.c - q.c);
      const used = new Set<Run>();
      for (const r0 of runs) {
        if (used.has(r0)) continue;
        const cl = [r0]; used.add(r0);
        for (let grow = true; grow;) {
          grow = false;
          for (const r of runs) {
            if (used.has(r) || r.alongX !== r0.alongX || r.ri !== r0.ri || Math.abs(r.zb - r0.zb) > 1e-6 || Math.abs(r.hi - r0.hi) > 0.03) continue;   // 'lo' may differ (wall niches): the box starts at the lowest
            if (cl.some((m) => Math.abs(m.c - r.c) <= 1.2)) { cl.push(r); used.add(r); grow = true; }
          }
        }
        const rb = roomBox[r0.ri];
        let c0 = Math.max(Math.min(...cl.map((m) => m.c)) - halfW, r0.alongX ? rb[1] : rb[0]), c1 = Math.min(Math.max(...cl.map((m) => m.c)) + halfW, r0.alongX ? rb[3] : rb[2]);
        const lo = Math.min(...cl.map((m) => m.lo)), hi = Math.max(...cl.map((m) => m.hi)) + 0.15;   // + 15 cm: past the point where the lining takes over, so no slit remains at the join (it is hidden above the lining there)
        // a bulkhead that stops within 60 cm of a wall runs on into it, so no end face / slit is left next to the wall
        const wLo = r0.alongX ? rb[1] : rb[0], wHi = r0.alongX ? rb[3] : rb[2];
        if (c0 - wLo < 0.6) c0 = wLo;
        if (wHi - c1 < 0.6) c1 = wHi;
        if (c1 - c0 < 2 * af.board + 0.02) continue;
        const mk = (g: number, z0: number, mat: THREE.Material, grp: THREE.Group) => grp.add(r0.alongX
          ? box(lo, c0 + g, z0, hi, c1 - g, r0.zt, mat)
          : box(c0 + g, lo, z0, c1 - g, hi, r0.zt, mat));
        mk(0, r0.zb, mats.plasterboard, board);
        mk(af.board, r0.zb + af.board, mats.wool, wool);
      }
    }
    for (const st of af.steps ?? h.roof.steps) {
      const [x0, y0, x1, y1] = st.p;
      const L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 0.05) continue;
      let nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (wallRoof(mx + nx * 0.3, my + ny * 0.3) < wallRoof(mx - nx * 0.3, my - ny * 0.3)) { nx = -nx; ny = -ny; } // point into the room
      // main (lower) slope lining height at the wall line, sampled just on the low side of the wall
      const lowAt = (t: number) => {
        const x = t ? x1 : x0, y = t ? y1 : y0;
        return liningAt(x - nx * 0.02, y - ny * 0.02, st.lo[t] - dropV);
      };
      // visible 15 cm edge of the wool slab along its lower edge (where it meets the slope lining)
      const edge = (o0: number, o1: number, grp: THREE.Group, mat: THREE.Material = mats.wool) => {
        // each corner sits on the sloped lining at its own position, so the strip lies flush with the slope
        const P = (t: number, o: number): number[] => {
          const x = (t ? x1 : x0) + nx * o, y = (t ? y1 : y0) + ny * o;
          return [x, lowAt(t) + 0.002, y];
        };
        const a0 = P(0, o0), b0 = P(1, o0), b1 = P(1, o1), a1 = P(0, o1);
        const v = [...a0, ...b0, ...b1, ...a0, ...b1, ...a1];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, L, 0, L, o1 - o0, 0, 0, L, o1 - o0, 0, o1 - o0], 2));
        geo.computeVertexNormals();
        grp.add(mesh(geo, mat, false));
      };
      const panel = (off: number, mat: THREE.Material, grp: THREE.Group) => {
        const ax = x0 + nx * off, ay = y0 + ny * off, bx = x1 + nx * off, by = y1 + ny * off;
        // exactly between the two linings: bottom = main slope lining, top = bay slope lining (no overhang into the room)
        // bottom edge sits exactly on the sloped board at this offset (sample just inside the room so the edge meets it)
        const za0 = lowAt(0) - 0.002, zb0 = lowAt(1) - 0.002; // main-slope lining at the wall line
        // top edge on the bay slope lining (+3 cm so it tucks behind it, no seam)
        const za1 = Math.max(za0, liningAt(ax + nx * 0.01, ay + ny * 0.01, st.hi[0] - dropV, true) + 0.03);
        const zb1 = Math.max(zb0, liningAt(bx + nx * 0.01, by + ny * 0.01, st.hi[1] - dropV, true) + 0.03);
        if (Math.max(za1 - za0, zb1 - zb0) < 0.02) return;
        const v = [ax, za0, ay, bx, zb0, by, bx, zb1, by, ax, za0, ay, bx, zb1, by, ax, za1, ay];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        const uv = [0, za0, L, zb0, L, zb1, 0, za0, L, zb1, 0, za1];
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.computeVertexNormals();
        grp.add(mesh(geo, mat, false));
      };
      // the step is a framed triangle: its wool sits inside the frame (flush with the wall), the double plasterboard
      // is fixed straight onto it, so the lining stays flat instead of forming a 15 cm box below the lower slope
      const tb = af.board + 0.005;
      panel(0.005, mats.wool, wool);
      panel(tb, mats.plasterboard, board);
      edge(0.005, tb, board, mats.plasterboard);   // closes the joint with the slope lining
      panel(0.003, mats.plasterboard, board);      // white backing on the wall: anything seen through a seam is board, not timber
    }
    // seams along valleys/hips between two lined slopes: a narrow plasterboard strip just behind the joint
    const fpAttic = h.levels[1].footprint;
    for (const hp of h.roof.hips) {
      if (hp.planes.length < 2) continue;
      const [x0, y0, x1, y1] = hp.p;
      const L = Math.hypot(x1 - x0, y1 - y0), N = Math.max(1, Math.ceil(L / 0.25));
      const px = -(y1 - y0) / L, py = (x1 - x0) / L;
      const v: number[] = [];
      const Hs = (x: number, y: number) => Math.max(...hp.planes.map(([a, b, c]) => a * x + b * y + c)) - dropV + 0.006;
      for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N;
        const ax = x0 + (x1 - x0) * t0, ay = y0 + (y1 - y0) * t0, bx = x0 + (x1 - x0) * t1, by = y0 + (y1 - y0) * t1;
        if (!pointInPoly((ax + bx) / 2, (ay + by) / 2, fpAttic)) continue;
        const q = (x: number, y: number, o: number) => { const X = x + px * o, Y = y + py * o; return [X, Hs(X, Y), Y]; };
        const A = q(ax, ay, -0.08), B = q(bx, by, -0.08), C = q(bx, by, 0.08), D = q(ax, ay, 0.08);
        v.push(...A, ...B, ...C, ...A, ...C, ...D);
      }
      if (!v.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      geo.computeVertexNormals();
      board.add(mesh(geo, mats.plasterboard, false));
    }
    wool.visible = board.visible = false;
    levels['poddasze'].add(wool, board);
    finish = { wool, board, drop: (af.woolUnder + af.board) * s };
  }

  return { root, levels, roof, overlays, world, doors, garage, finish, entrance, soffits: soffitMeshes };
}

function buildOpeningFill(g: THREE.Group, o: OpeningJ, lv: LevelJ, mats: Materials, inside: (x: number, y: number) => boolean, world: World, julietMat?: THREE.Material) {
  const [x0, y0, x1, y1] = o.rect;
  const alongX = x1 - x0 >= y1 - y0;
  const thick = alongX ? y1 - y0 : x1 - x0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // which face is inside the house? (sample just beyond both faces)
  const aIn = alongX ? inside(cx, y0 - 0.15) : inside(x0 - 0.15, cy);
  const bIn = alongX ? inside(cx, y1 + 0.15) : inside(x1 + 0.15, cy);
  const exterior = aIn !== bIn;
  if (!exterior || o.kind === 'door' || o.kind === 'gate' || o.kind === 'entrance' || o.kind === 'extdoor') {
    if (o.kind === 'entrance' || o.kind === 'extdoor' || o.kind === 'gate') frameOnly(g, o, alongX, mats);
    return;
  }
  // glass plane position: on the outer face of the 24 cm block (≈ 20 cm from the inside)
  const inSign = aIn ? -1 : 1; // direction (along wall normal) pointing inside
  const innerFace = alongX ? (aIn ? y0 : y1) : (aIn ? x0 : x1);
  const depth = thick > 0.3 ? 0.21 : thick / 2;
  const glassPos = innerFace - inSign * depth;
  const frameMat = o.frame === 'black' ? mats.frameBlack : o.frame === 'cherry' ? mats.frameCherry : mats.frameCaramel;
  // glazing extent along the wall: the whole opening, or `span` (corner windows meet at the glass line)
  const s0 = o.span ? o.span[0] : alongX ? x0 : y0;
  const len = o.span ? o.span[1] - o.span[0] : alongX ? x1 - x0 : y1 - y0;
  const fz0 = o.sill, fz1 = o.head;
  const F = 0.07, D = 0.08;
  const piece = (a0: number, a1: number, z0: number, z1: number, d0: number, d1: number, m: THREE.Material) =>
    alongX ? box(a0, d0, z0, a1, d1, z1, m) : box(d0, a0, z0, d1, a1, z1, m);
  const dz0 = glassPos - D / 2, dz1 = glassPos + D / 2;
  g.add(piece(s0, s0 + F, fz0, fz1, dz0, dz1, frameMat));
  g.add(piece(s0 + len - F, s0 + len, fz0, fz1, dz0, dz1, frameMat));
  g.add(piece(s0, s0 + len, fz0, fz0 + F, dz0, dz1, frameMat));
  g.add(piece(s0, s0 + len, fz1 - F, fz1, dz0, dz1, frameMat));
  const panes = o.panes ?? 1;
  for (let i = 1; i < panes; i++) {
    const a = s0 + (len * i) / panes;
    g.add(piece(a - F * 0.6, a + F * 0.6, fz0, fz1, dz0, dz1, frameMat));
  }
  const glass = piece(s0 + F, s0 + len - F, fz0 + F, fz1 - F, glassPos - 0.005, glassPos + 0.005, mats.glass);
  glass.castShadow = false;
  glass.receiveShadow = false;
  g.add(glass);

  // interior window board
  if (o.kind === 'window' && o.sill > lv.floorZ + 0.3 && !o.id.startsWith('02')) {
    const b0 = innerFace + inSign * 0.04, b1 = glassPos - inSign * 0.04;
    g.add(piece(s0 - 0.02, s0 + len + 0.02, o.sill - 0.02, o.sill + 0.01, Math.min(b0, b1), Math.max(b0, b1), mats.sillBoard));
  }

  // Juliet balcony railing on attic doors (outside the glass), plus a collision barrier
  if (o.kind === 'balcony') {
    // Juliet balcony outside the façade (from balkon_francuski/*.dxf)
    const outerFace = alongX ? (aIn ? y1 : y0) : (aIn ? x1 : x0);
    if (o.juliet) buildJuliet(g, o, alongX, outerFace, -inSign, julietMat ?? mats.railing);
    // invisible barrier at the glass line so you can't walk through the closed door
    const p0: Pt = alongX ? [x0, glassPos] : [glassPos, y0];
    const p1: Pt = alongX ? [x1, glassPos] : [glassPos, y1];
    world.solids.push(solidFromSegment(p0, p1, 0.1, o.sill - 0.5, o.sill + 2));
  }
}

function frameOnly(g: THREE.Group, o: OpeningJ, alongX: boolean, mats: Materials) {
  // simple door frame/casing on both faces of exterior doors & gate
  const [x0, y0, x1, y1] = o.rect;
  const F = 0.06;
  const m = mats.frameCaramel;
  if (alongX) {
    const ym = (y0 + y1) / 2;
    g.add(box(x0, ym - 0.04, o.sill, x0 + F, ym + 0.04, o.head, m));
    g.add(box(x1 - F, ym - 0.04, o.sill, x1, ym + 0.04, o.head, m));
    g.add(box(x0, ym - 0.04, o.head - F, x1, ym + 0.04, o.head, m));
  } else {
    const xm = (x0 + x1) / 2;
    g.add(box(xm - 0.04, y0, o.sill, xm + 0.04, y0 + F, o.head, m));
    g.add(box(xm - 0.04, y1 - F, o.sill, xm + 0.04, y1, o.head, m));
    g.add(box(xm - 0.04, y0, o.head - F, xm + 0.04, y1, o.head, m));
  }
}

function buildStairs(h: HouseJ, mats: Materials, levels: Record<string, THREE.Group>, world: World) {
  const s = h.stairs;
  const g = levels['parter'];
  for (let i = 0; i < s.treads; i++) {
    const xa = s.x0 + i * s.tread, xb = xa + s.tread, top = (i + 1) * s.rise;
    g.add(box(xa, s.y0, Math.max(0, top - 0.6 - i * 0.02), xb, s.y1, top, mats.stairs));
    world.solids.push(solidFromRect([xa, s.y0, xb, s.y1], 0, top, 'stair'));
  }
  // wall between hall (1/2) and bathroom (1/8) under the flight: the plan has the wall continue below the stair,
  // the wall generator leaves a hole where the flight crosses its line
  for (const w of s.wallsUnder ?? []) {
    const top = Math.min(s.treads, Math.max(1, Math.floor(((w.rect[0] + w.rect[2]) / 2 - s.x0) / s.tread) + 1)) * s.rise;
    g.add(box(w.rect[0], w.rect[1], 0, w.rect[2], w.rect[3], top, mats.plaster));
    world.solids.push(solidFromRect(w.rect, 0, top, 'wall'));
  }
  const a = levels['poddasze'];
  const L = s.landing, T = s.topStep;
  // The landing and the top step sit on the slab: their underside starts 1.5 cm above the ceiling plane below (2.93),
  // so the two surfaces never coincide (no flicker) ...
  const base = 2.945, lastTop = s.treads * s.rise;
  a.add(box(L.rect[0], L.rect[1], base, L.rect[2], L.rect[3], L.z, mats.concrete));
  a.add(box(T.rect[0], T.rect[1], base, T.rect[2], T.rect[3], T.z, mats.concrete));
  // ... and they are closed down to the last tread, so nothing hangs in the air with a slot under it:
  // a riser under the landing's front edge, and the same under the top step's side along the flight
  const runY0 = s.y0, runY1 = s.y1, xEnd = s.x0 + s.treads * s.tread;
  a.add(box(xEnd - 0.06, runY0, lastTop - 0.01, xEnd, runY1, base + 0.02, mats.concrete));
  a.add(box(T.rect[0], runY0, lastTop - 0.01, T.rect[2], runY0 + 0.06, base + 0.02, mats.concrete));
  world.solids.push(solidFromRect(L.rect, 2.57, L.z, 'floor'));
  world.solids.push(solidFromRect(T.rect, 2.57, T.z, 'floor'));
  // The attic floor is a flat surface and the ground-floor ceiling another, so along the rim of the stair opening there was nothing between them
  // (an empty slot 2.93 .. 3.34). Close it with the slab's edge faces: thin concrete plates set into the slab, their visible faces on the rim.
  const [vx0, vy0, , vy1] = h.stairs.void.rect;
  const slabLo = 2.935, slabHi = 3.338, tb = 0.03;
  a.add(box(vx0, vy0 - tb, slabLo, T.rect[0], vy0, slabHi, mats.concrete));                 // front edge along the flight (hall side)
  a.add(box(vx0 - tb, vy0, slabLo, vx0, vy1, slabHi, mats.concrete));                       // west edge of the opening
  a.add(box(T.rect[0] - tb, T.rect[1], T.z, T.rect[0], T.rect[3], slabHi, mats.concrete));   // riser from the hall floor down to the top step
  // balustrade around the stair void in the attic
  for (const [p, q] of s.railings) {
    const z = 3.34;
    const alongX = Math.abs(q[0] - p[0]) > Math.abs(q[1] - p[1]);
    const [x0, x1] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
    const [y0, y1] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
    if (alongX) {
      a.add(box(x0, y0 - 0.025, z + 0.88, x1, y0 + 0.025, z + 0.92, mats.railing));
      for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / Math.round((x1 - x0) / 0.12)) a.add(box(x - 0.01, y0 - 0.01, z, x + 0.01, y0 + 0.01, z + 0.9, mats.railing));
    } else {
      a.add(box(x0 - 0.025, y0, z + 0.88, x0 + 0.025, y1, z + 0.92, mats.railing));
      for (let y = y0; y <= y1 + 1e-6; y += (y1 - y0) / Math.round((y1 - y0) / 0.12)) a.add(box(x0 - 0.01, y - 0.01, z, x0 + 0.01, y + 0.01, z + 0.9, mats.railing));
    }
    world.solids.push(solidFromSegment(p, q, 0.06, z - 0.2, z + 1.5));
  }
}

/**
 * Turmalin for one roof face. Like a roofer, divide the slope into a whole number of courses (gauge 355-380 mm),
 * start the first nose at the eave and the first tile column at the verge (lowest / left-most point of the face).
 */
function tileMaterial(f: { plane: [number, number, number]; outer: Pt[] }, mats: Materials): THREE.Material {
  const [a, b] = f.plane;
  const g = Math.hypot(a, b) || 1;
  const gx = a / g, gy = b / g, slopeLen = Math.sqrt(1 + g * g);
  let vMin = Infinity, vMax = -Infinity, uMin = Infinity;
  for (const [x, y] of f.outer) {
    const v = (gx * x + gy * y) * slopeLen, u = -gy * x + gx * y;
    vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); uMin = Math.min(uMin, u);
  }
  const n = Math.max(1, Math.round((vMax - vMin) / TILE_GAUGE));
  const gauge = Math.min(TILE_GAUGE_RANGE[1], Math.max(TILE_GAUGE_RANGE[0], (vMax - vMin) / n));
  return mats.tilesFor(gauge, uMin, vMin);
}

function buildRoof(h: HouseJ, mats: Materials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'roof';
  const t = h.roof.thickness;
  // rafter depth is measured square to the slope; vertically that is depth * sqrt(1 + k^2)
  const rafterRise = h.roof.rafter.depth * Math.sqrt(1 + h.roof.k * h.roof.k);
  for (const f of h.roof.faces) {
    g.add(mesh(slopedGeometry(f, f.plane, rafterRise, false), mats.rafters)); // membrane on top of the rafters
    g.add(mesh(slopedGeometry(f, f.plane, t, true), tileMaterial(f, mats)));
    // metal flashing around all roof edges (verge flashing on rakes, eaves trim): anthracite, covers the
    // edge of the roof build-up and wraps ~3 cm over the tiles, as on the site photos

  }
  // fill the vertical slots where two roof planes meet at different heights (wall, from the lower
  // plane's underside to the upper plane's tiles), double-sided so it closes the slot from both sides
  const fill = mats.makeFacade(THREE.DoubleSide);
  for (const st of h.roof.steps) {
    const [x0, y0, x1, y1] = st.p;
    const v = [
      x0, st.lo[0], y0, x1, st.lo[1], y1, x1, st.hi[1] + t, y1,
      x0, st.lo[0], y0, x1, st.hi[1] + t, y1, x0, st.hi[0] + t, y0,
    ];
    const L = Math.hypot(x1 - x0, y1 - y0);
    const uv = [0, st.lo[0], L, st.lo[1], L, st.hi[1] + t, 0, st.lo[0], L, st.hi[1] + t, 0, st.hi[0] + t];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    g.add(mesh(geo, fill));
  }
  // metal flashing (anthracite) on the outer roof edges only: covers the build-up edge, 3 cm proud of the tiles
  for (const fl of h.roof.flashing ?? []) {
    const [x0, y0, x1, y1] = fl.p;
    const [a, b, c] = fl.plane;
    const h0 = a * x0 + b * y0 + c, h1 = a * x1 + b * y1 + c;
    const lo = rafterRise - 0.07, hi = t + 0.03;
    const v = [x0, h0 + lo, y0, x1, h1 + lo, y1, x1, h1 + hi, y1, x0, h0 + lo, y0, x1, h1 + hi, y1, x0, h0 + hi, y0];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.computeVertexNormals();
    g.add(mesh(geo, mats.fascia));
  }
  // rafters and hip/valley rafters as real timbers, bottom face on the roof plane
  const R = h.roof.rafter;
  const timbers = new THREE.Group();
  timbers.name = 'timbers'; // hidden when the attic is finished (behind the plasterboard)
  for (const r of h.roof.rafters) timbers.add(timberOnPlane(r.p, [r.plane], R.width, rafterRise, mats.timber));
  for (const hp of h.roof.hips) timbers.add(timberOnPlane(hp.p, hp.planes, R.width + 0.02, rafterRise, mats.timber));
  g.add(timbers);
  // collar ties (jętki): two boards, one each side of the rafter pair
  const tb = h.roof.tie.board ?? 0.04, td = h.roof.tie.depth ?? 0.2;
  for (const tie of h.roof.ties) {
    const [ax, ay, bx, by] = tie.p;
    const alongX = Math.abs(bx - ax) > Math.abs(by - ay);
    const off = R.width / 2 + tb / 2;
    for (const sgn of [-1, 1]) {
      g.add(alongX
        ? box(Math.min(ax, bx), ay + sgn * off - tb / 2, tie.z, Math.max(ax, bx), ay + sgn * off + tb / 2, tie.z + td, mats.timber)
        : box(ax + sgn * off - tb / 2, Math.min(ay, by), tie.z, ax + sgn * off + tb / 2, Math.max(ay, by), tie.z + td, mats.timber));
    }
  }
  for (const it of h.roof.items) buildRoofItem(g, it, t, mats);
  if (h.chimney) buildChimney(g, h, mats);
  return g;
}

/** Local frame lying in a roof plane: X across the slope (along the eave), Y = surface normal, Z = up the slope. */
function planeBasis(plane: [number, number, number], x: number, y: number, offset: number): THREE.Matrix4 {
  const [a, b, c] = plane;
  const g = Math.hypot(a, b);
  const up = new THREE.Vector3(a / g, g, b / g).normalize();
  const n = new THREE.Vector3(-a, 1, -b).normalize();
  const e = new THREE.Vector3().crossVectors(n, up).normalize();
  const m = new THREE.Matrix4().makeBasis(e, n, up);
  m.setPosition(x, a * x + b * y + c + offset, y);
  return m;
}

function slabOnPlane(group: THREE.Group, basis: THREE.Matrix4, cx: number, cz: number, w: number, l: number, y0: number, y1: number, mat: THREE.Material) {
  const m = mesh(new THREE.BoxGeometry(w, y1 - y0, l), mat);
  m.applyMatrix4(new THREE.Matrix4().makeTranslation(cx, (y0 + y1) / 2, cz).premultiply(basis));
  group.add(m);
}

function buildRoofItem(g: THREE.Group, it: HouseJ['roof']['items'][number], t: number, mats: Materials) {
  // The hole through the roof is a vertical shaft over the plan rectangle `it.rect`.
  // Lining: vertical white boards on all four sides of that shaft, from the rafter underside to the tiles.
  const lining = mats.lining.clone();
  lining.side = THREE.DoubleSide;
  g.add(mesh(slopedSkirt(rectPoly(it.rect), it.plane, -0.02, t), lining));
  // Window/hatch sits at the tile surface, centred over the shaft (basis origin = centre at tile level),
  // so frame and glass line up with the hole at the outside — no gap at the upper edge.
  const B = planeBasis(it.plane, it.center[0], it.center[1], t);
  const w = it.w, l = it.l, F = 0.07;
  // frame/sash in Winchester (same decor as the façade windows), just below the tile surface
  const sash = it.kind === 'hatch' ? mats.flashing : mats.frameCaramel;
  slabOnPlane(g, B, -w / 2 + F / 2, 0, F, l, -0.12, -0.005, sash);
  slabOnPlane(g, B, w / 2 - F / 2, 0, F, l, -0.12, -0.005, sash);
  slabOnPlane(g, B, 0, -l / 2 + F / 2, w, F, -0.12, -0.005, sash);
  slabOnPlane(g, B, 0, l / 2 - F / 2, w, F, -0.12, -0.005, sash);
  // flush flashing: thin anthracite trim level with the tiles, slightly overlapping them (covers the joint)
  slabOnPlane(g, B, -w / 2 - 0.02, 0, 0.06, l + 0.08, -0.01, 0.012, mats.flashing);
  slabOnPlane(g, B, w / 2 + 0.02, 0, 0.06, l + 0.08, -0.01, 0.012, mats.flashing);
  slabOnPlane(g, B, 0, -l / 2 - 0.02, w + 0.1, 0.06, -0.01, 0.012, mats.flashing);
  slabOnPlane(g, B, 0, l / 2 + 0.02, w + 0.1, 0.06, -0.01, 0.012, mats.flashing);
  const glass = mesh(new THREE.BoxGeometry(w - 2 * F, 0.01, l - 2 * F), mats.glass);
  glass.applyMatrix4(new THREE.Matrix4().makeTranslation(0, -0.03, 0).premultiply(B));
  glass.castShadow = false;
  glass.receiveShadow = false;
  g.add(glass);
}

function buildChimney(g: THREE.Group, h: HouseJ, mats: Materials) {
  const c = h.chimney!;
  const [x0, y0, x1, y1] = c.rect;
  const roofH = makeRoofHeight(h.roof);
  // starts at the underside of the roof (inside it continues as the masonry drawn on the floor plans)
  const base = Math.min(roofH(x0, y0), roofH(x1, y0), roofH(x0, y1), roofH(x1, y1));
  const capT = 0.08;
  g.add(mesh(prismGeometry(rectPoly(c.rect), base, c.top - capT), [mats.clinker, mats.clinker, mats.clinker]));
  g.add(box(x0 - 0.05, y0 - 0.05, c.top - capT, x1 + 0.05, y1 + 0.05, c.top, mats.chimneyCap));
  // flue outlets
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  g.add(box(cx - 0.3, cy - 0.12, c.top, cx - 0.05, cy + 0.12, c.top + 0.12, mats.chimneyCap));
  g.add(box(cx + 0.05, cy - 0.12, c.top, cx + 0.3, cy + 0.12, c.top + 0.08, mats.chimneyCap));
  if (c.walkway) {
    // chimney-sweep walkway (ława kominiarska) lying on the roof
    const [wx0, wy0, wx1, wy1] = c.walkway;
    const wx = (wx0 + wx1) / 2, wy = (wy0 + wy1) / 2;
    const plane = h.roof.items.find((i) => i.kind === 'hatch')?.plane;
    if (plane) {
      const B = planeBasis(plane, wx, wy, 0);
      slabOnPlane(g, B, 0, 0, wx1 - wx0, (wy1 - wy0) * 1.27, h.roof.thickness + 0.06, h.roof.thickness + 0.1, mats.flashing);
    }
  }
}

function buildOutside(h: HouseJ, mats: Materials, root: THREE.Group, world: World) {
  const gz = h.outside.groundZ;
  const ground = mesh(flatGeometry(rectPoly([-60, -60, 75, 75] as Rect), gz, true), mats.grass, false);
  root.add(ground);
  world.solids.push(solidFromRect([-60, -60, 75, 75], gz - 1, gz, 'ground'));
  for (const t of h.outside.terraces) {
    const m = t.material === 'sand' ? mats.sand : t.material === 'gravel' ? mats.gravel : mats.paving;
    root.add(mesh(prismGeometry(rectPoly(t.rect), gz, t.z), [m, m, m], false));
    world.solids.push(solidFromRect(t.rect, gz, t.z, 'terrace'));
  }
}

export interface Openable { open: boolean; center: Pt; floorZ: number; label: string; toggle(): void; update(dt: number): void }

/**
 * Sectional garage door (Hörmann-style): panels with horizontal ribs, closed = vertical just inside the
 * opening, open = horizontal under the garage ceiling. Variants switch colour/rib design (key G).
 */
export class GarageDoor implements Openable {
  open = false;
  center: Pt;
  floorZ: number;
  label = '';
  variant = 0;
  private t = 0;
  private panel: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  private solid: Solid;
  private H: number;
  private yIn: number;
  constructor(g: THREE.Group, private o: OpeningJ, world: World) {
    const [x0, y0, x1, y1] = o.rect;
    this.H = o.head - o.sill + 0.08;
    this.yIn = y0 - 0.04;                      // just inside the inner face of the opening
    this.center = [(x0 + x1) / 2, (y0 + y1) / 2];
    this.floorZ = o.sill;
    this.mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide });
    this.panel = mesh(new THREE.BoxGeometry(x1 - x0 + 0.16, this.H, 0.067), this.mat);
    g.add(this.panel);
    this.solid = solidFromRect([x0, this.yIn - 0.05, x1, this.yIn + 0.05], o.sill, o.head, 'garage-door');
    world.solids.push(this.solid);
    this.setVariant(0);
    this.update(0);
  }
  get variants() { return this.o.garage!.variants; }
  setVariant(i: number) {
    const vs = this.variants;
    this.variant = ((i % vs.length) + vs.length) % vs.length;
    const v = vs[this.variant];
    this.label = v.name;
    this.mat.map?.dispose();
    this.mat.map = garageTexture(v, this.o.garage!.sections);
    this.mat.color.set(0xffffff);
    this.mat.needsUpdate = true;
  }
  /** Custom look (facade design): colour + optional oak grain, keeps the rib design of the current variant. */
  setLook(color: string, wood: boolean) {
    const v = this.variants[this.variant];
    this.mat.map?.dispose();
    this.mat.map = garageTexture({ ...v, color, wood }, this.o.garage!.sections);
    this.mat.needsUpdate = true;
  }
  toggle() { this.open = !this.open; }
  update(dt: number) {
    const target = this.open ? 1 : 0;
    this.t += Math.sign(target - this.t) * Math.min(Math.abs(target - this.t), dt * 0.45);
    // closed: vertical, bottom at the sill; open: horizontal just under the head, running into the garage
    const [x0, , x1] = this.o.rect;
    const ang = this.t * Math.PI / 2;
    const top = this.o.head + 0.05;
    const cy = this.yIn + Math.sin(ang) * this.H / 2;      // moves inward (−y = into the garage)
    const cz = top - Math.cos(ang) * this.H / 2;
    this.panel.position.set((x0 + x1) / 2, cz, this.yIn - (cy - this.yIn));
    this.panel.rotation.set(-ang, 0, 0);
    this.solid.off = this.t > 0.6;
  }
}

function garageTexture(v: { color: string; ribs: number; wood: boolean }, sections: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = v.color;
  g.fillRect(0, 0, 512, 512);
  if (v.wood) {
    let seed = 7; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 160; i++) {
      const y = r() * 512;
      g.strokeStyle = `rgba(${r() > 0.5 ? '60,35,15' : '190,140,80'},${0.15 + r() * 0.2})`;
      g.lineWidth = 1 + r() * 2;
      g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(170, y + (r() - 0.5) * 10, 340, y + (r() - 0.5) * 10, 512, y); g.stroke();
    }
  }
  const sh = 512 / sections;
  for (let s = 0; s < sections; s++) {
    const y0 = s * sh;
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, y0, 512, 3);           // section joint
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(0, y0 + 3, 512, 2);
    for (let k = 1; k <= v.ribs; k++) {                                      // L-ribbed: one wide rib per section
      const y = y0 + (sh * k) / (v.ribs + 1);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, y - 4, 512, 4);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, y, 512, 3);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Hinged door leaf (swing in or out per config); press E near it (see main.ts). */
export class Door implements Openable {
  open = false;
  /** false while the other variant (temporary OSB door / planned door) is shown */
  active = true;
  group?: THREE.Group;
  variant = '';
  /** Repaint the leaf, frame and sidelight (facade design / colour picker). */
  recolor: (hex: string) => void = () => {};
  private angle = 0;
  constructor(public id: string, public label: string, public center: Pt, public floorZ: number,
              private pivot: THREE.Group, private base: number, private openAngle: number, private solid: Solid) {}
  toggle() { this.open = !this.open; }
  update(dt: number) {
    const target = this.open ? this.openAngle : 0;
    const step = Math.sign(target - this.angle) * Math.min(Math.abs(target - this.angle), dt * 2.2);
    this.angle += step;
    this.pivot.rotation.y = this.base + this.angle;
    this.solid.off = !this.active || Math.abs(this.angle) > 0.25;
  }
  setActive(a: boolean) {
    this.active = a;
    if (this.group) this.group.visible = a;
    this.solid.off = !a || Math.abs(this.angle) > 0.25;
  }
}

function buildDoor(g: THREE.Group, o: OpeningJ, mats: Materials, inside: (x: number, y: number) => boolean, world: World): Door {
  const d = o.door!;
  const [x0, y0, x1, y1] = o.rect;
  const alongX = x1 - x0 >= y1 - y0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const aIn = alongX ? inside(cx, y0 - 0.15) : inside(x0 - 0.15, cy);
  const innerFace = alongX ? (aIn ? y0 : y1) : (aIn ? x0 : x1);
  const nIn = aIn ? -1 : 1;                       // inside direction along the wall normal
  const plane = innerFace - nIn * 0.14;            // door line, ~14 cm from the inner face
  const col = new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.4 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb8924c, metalness: 0.75, roughness: 0.32 }); // patinated brass (Retro hardware)
  const P = (s: number, n: number): Pt => (alongX ? [s, n] : [n, s]);
  const part = (s0: number, s1: number, z0: number, z1: number, n0: number, n1: number, m: THREE.Material) => {
    const [ax, ay] = P(s0, n0), [bx, by] = P(s1, n1);
    return box(ax, ay, z0, bx, by, z1, m);
  };
  const sideParts: THREE.MeshStandardMaterial[] = [];
  const [l0, l1] = d.leaf;
  const top = o.head - 0.07;
  const F = 0.07, T = 0.07;
  // frame (ościeżnica) around leaf, in door colour
  g.add(part(l0 - F, l0, o.sill, o.head, plane - 0.05, plane + 0.05, col));
  g.add(part(l1, l1 + F, o.sill, o.head, plane - 0.05, plane + 0.05, col));
  g.add(part(l0 - F, l1 + F, top, o.head, plane - 0.05, plane + 0.05, col));
  // sidelight W1: fixed satin glass in the same frame colour
  if (d.sidelight) {
    const [s0, s1] = d.sidelight;
    g.add(part(s0, s0 + F, o.sill, o.head, plane - 0.05, plane + 0.05, col));
    g.add(part(s1 - F, s1, o.sill, o.head, plane - 0.05, plane + 0.05, col));
    // proportions from the DB 107 door + sidelight drawing (703 px = 213 cm): glass 16 cm below the top to 77 cm above the threshold, bottom rail 21 cm, raised panel below the glass
    const gTop = o.head - 0.16, gBot = o.sill + 0.77;
    g.add(part(s0, s1, o.sill, o.sill + 0.2, plane - 0.05, plane + 0.05, col));
    g.add(part(s0, s1, gTop, o.head, plane - 0.05, plane + 0.05, col));
    const glass = part(s0 + F, s1 - F, gBot, gTop, plane - 0.006, plane + 0.006, mats.glass);
    glass.castShadow = false;
    g.add(glass);
    g.add(part(s0 + F, s1 - F, o.sill + 0.2, gBot, plane - 0.03, plane + 0.03, col)); // lower wooden panel
    {
      const w = s1 - s0, out = -nIn;
      const gr = new THREE.MeshStandardMaterial({ color: new THREE.Color(d.color).multiplyScalar(0.45), roughness: 0.6 });
      const fr = part(s0 + 0.12 * w, s1 - 0.12 * w, o.sill + 0.25, o.sill + 0.69, plane + out * 0.031, plane + out * 0.037, gr);   // dark groove round the inset
      const ri = part(s0 + 0.24 * w, s1 - 0.24 * w, o.sill + 0.30, o.sill + 0.64, plane + out * 0.03, plane + out * 0.056, col);       // raised inset
      g.add(fr, ri);
      sideParts.push(gr);
    }
    // X glazing bars: two diagonals per cell, three cells stacked (as on the DB 107 sidelights)
    const diag = (sa: number, za: number, sb: number, zb: number) => {
      const ds = sb - sa, dz = zb - za, len = Math.hypot(ds, dz), th = 0.03;
      const sc = (sa + sb) / 2, zc = (za + zb) / 2;
      const m = alongX ? mesh(new THREE.BoxGeometry(len, th, 0.03), col) : mesh(new THREE.BoxGeometry(0.03, th, len), col);
      if (alongX) { m.rotation.z = Math.atan2(dz, ds); m.position.set(sc, zc, plane); }
      else { m.rotation.x = Math.atan2(-dz, ds); m.position.set(plane, zc, sc); }
      g.add(m);
    };
    const zlo = gBot, zhi = gTop, rows = 3, rh = (zhi - zlo) / rows;
    const sa = s0 + F, sb = s1 - F;
    for (let r = 0; r < rows; r++) { const za = zlo + r * rh, zb = za + rh; diag(sa, za, sb, zb); diag(sa, zb, sb, za); }
    for (let r = 1; r < rows; r++) { const zr = zlo + r * rh; g.add(part(sa, sb, zr - 0.015, zr + 0.015, plane - 0.015, plane + 0.015, col)); }   // horizontal bar between the X cells
    const [ax, ay] = P(s0, plane - 0.05), [bx, by] = P(s1, plane + 0.05);
    world.solids.push(solidFromRect([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], o.sill, o.head, 'sidelight'));
  }
  // piers between leaf frame / sidelight / opening edges, so the opening is closed off
  const sMin = alongX ? x0 : y0, sMax = alongX ? x1 : y1;
  const pieces: [number, number][] = [[sMin, l0 - F], [l1 + F, d.sidelight ? d.sidelight[0] : sMax]];
  if (d.sidelight) pieces.push([d.sidelight[1], sMax]);
  for (const [a, b] of pieces) if (b - a > 0.005) g.add(part(a, b, o.sill, o.head, plane - 0.05, plane + 0.05, col));

  // leaf on a pivot at the hinge edge
  const hingeS = d.hinge === 'start' ? l0 : l1;
  const along = d.hinge === 'start' ? 1 : -1;      // from hinge towards the lock edge
  const L = l1 - l0, H = top - o.sill;
  const pivot = new THREE.Group();
  const [hx, hy] = P(hingeS, plane);
  pivot.position.set(hx, o.sill, hy);
  g.add(pivot);
  const leaf = new THREE.Group();
  pivot.add(leaf);
  const slab = mesh(new THREE.BoxGeometry(L, H - 0.01, T), col);
  slab.position.set(L / 2, H / 2, 0);
  leaf.add(slab);
  // DB 107: three raised panels on the outside face (proportions taken from the product photo, top to bottom)
  const outZ = -nIn * (T / 2 + 0.03), inZ = nIn * (T / 2 + 0.03);
  const groove = new THREE.MeshStandardMaterial({ color: new THREE.Color(d.color).multiplyScalar(0.45), roughness: 0.6 });
  const lineMats: THREE.MeshStandardMaterial[] = [];
  const panel = (fx0: number, fx1: number, fy0: number, fy1: number) => {
    const w = L * (fx1 - fx0), hh = H * (fy1 - fy0), cx = L * (fx0 + fx1) / 2, cy = H * (fy0 + fy1) / 2;
    const out = -nIn;
    const frame = mesh(new THREE.BoxGeometry(w + 0.04, hh + 0.04, 0.006), groove);   // dark groove around the panel
    frame.position.set(cx, cy, out * (T / 2 + 0.002));
    leaf.add(frame);
    const m = mesh(new THREE.BoxGeometry(w, hh, 0.022), col);                         // raised panel
    m.position.set(cx, cy, out * (T / 2 + 0.011));
    leaf.add(m);
  };
  const grooved = d.design === 'grooves';
  if (grooved) {
    // Wikęd BASIC 3.0 "26c": flat pressed steel leaf with 5 full-width horizontal grooves
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const lm = new THREE.MeshStandardMaterial({ color: new THREE.Color(d.color).multiplyScalar(1.9), roughness: 0.35, metalness: 0.2 });
      lineMats.push(lm);
      const gr = mesh(new THREE.BoxGeometry(L - 0.06, 0.008, 0.004), lm);
      gr.position.set(L / 2, H * (1 - f), -nIn * (T / 2 + 0.001));
      leaf.add(gr);
    }
  } else {
    panel(0.19, 0.84, 0.605, 0.903); // top, large
    panel(0.19, 0.84, 0.41, 0.495);  // middle, small
    panel(0.19, 0.84, 0.14, 0.31);   // bottom, large
  }
  if (grooved) brass.color.set(0x1a1a1b), brass.metalness = 0.3, brass.roughness = 0.45;   // black hardware
  if (grooved) for (const side of [-1, 1]) {                 // separate top-lock escutcheon
    const tl = mesh(new THREE.BoxGeometry(0.035, 0.09, 0.01), brass);
    tl.position.set(L - 0.065, 1.48, side * nIn * (T / 2 + 0.006));
    leaf.add(tl);
  }
  if (!grooved) {   // small key escutcheon above the handle (DB 107 drawing)
    const key = mesh(new THREE.BoxGeometry(0.03, 0.07, 0.01), brass);
    key.position.set(L - 0.065, 1.59, -nIn * (T / 2 + 0.006));
    leaf.add(key);
  }
  // lock side (lock edge = local +L): escutcheon + lever outside and inside
  const handY = 1.10;
  const esc = mesh(new THREE.BoxGeometry(0.035, grooved ? 0.27 : 0.24, 0.01), brass);
  esc.position.set(L - 0.065, handY - (grooved ? 0.05 : 0), -nIn * (T / 2 + 0.006));
  leaf.add(esc);
  const lever = mesh(new THREE.BoxGeometry(0.14, 0.022, 0.022), brass);
  lever.position.set(L - 0.065 - 0.07, handY, outZ);
  leaf.add(lever);
  const leverIn = mesh(new THREE.BoxGeometry(0.14, 0.022, 0.022), brass);
  leverIn.position.set(L - 0.065 - 0.07, handY, inZ);
  leaf.add(leverIn);
  const escIn = mesh(new THREE.BoxGeometry(0.035, grooved ? 0.27 : 0.24, 0.01), brass);
  escIn.position.set(L - 0.065, handY - (grooved ? 0.05 : 0), nIn * (T / 2 + 0.006));
  leaf.add(escIn);
  // four hinges on the hinge edge, at 32 / 83 / 134 / 184 cm (local x = 0 is the pivot)
  for (const yy of [0.32, 0.83, 1.34, 1.84]) {
    const hinge = mesh(new THREE.BoxGeometry(0.03, 0.1, 0.03), brass);
    hinge.position.set(0.012, yy, -nIn * (T / 2 + 0.012));
    leaf.add(hinge);
  }
  // leaf local +X must point along the wall from the hinge; local +Z must be the plan normal axis
  // world (x, z) of local x-axis after rotation β: (cosβ, -sinβ)
  const a: Pt = alongX ? [along, 0] : [0, along];
  const base = Math.atan2(-a[1], a[0]);
  // leaf local z: after base rotation, local +Z maps to (sinβ, cosβ); make sure it is the plan normal (+n axis)
  const zAxis: Pt = [Math.sin(base), Math.cos(base)];
  const nAxis: Pt = alongX ? [0, 1] : [1, 0];
  // flip parts to the other face by moving them (a negative scale would turn the faces inside out)
  if (zAxis[0] * nAxis[0] + zAxis[1] * nAxis[1] < 0) for (const ch of leaf.children) ch.position.z = -ch.position.z;
  // open inward: tip after +90° = (a.y, -a.x) in plan; pick sign so it points inside
  const tip: Pt = [a[1], -a[0]];
  const inVec: Pt = alongX ? [0, nIn] : [nIn, 0];
  const towardsInside = tip[0] * inVec[0] + tip[1] * inVec[1] > 0 ? 1 : -1;
  const openAngle = (d.swing === 'out' ? -towardsInside : towardsInside) * Math.PI * 0.5;
  pivot.rotation.y = base;

  const [ax, ay] = P(l0, plane - T / 2), [bx, by] = P(l1, plane + T / 2);
  const solid = solidFromRect([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], o.sill, o.head, 'door');
  world.solids.push(solid);
  const [mx, my] = P((l0 + l1) / 2, plane);
  const door = new Door(o.id, `${d.model ?? 'door'} · ${d.colorName ?? ''}`, [mx, my], o.sill, pivot, base, openAngle, solid);
  door.recolor = (hex) => {
    col.color.set(hex);
    groove.color.set(hex).multiplyScalar(0.45);
    for (const m of sideParts) m.color.set(hex).multiplyScalar(0.45);
    for (const m of lineMats) m.color.set(hex).multiplyScalar(1.9);
  };
  return door;
}

/**
 * Temporary entrance door as it stands on site (photos 2026-11-21): a leaf of OSB on a pine frame hung on zinc hinges in an
 * OSB lining that sits on the outer face of the opening, plus a fixed OSB panel where the sidelight will go. Opens outward.
 */
function buildTempDoor(g: THREE.Group, o: OpeningJ, mats: Materials, inside: (x: number, y: number) => boolean, world: World): Door {
  const t = o.door!.temporary!;
  const [x0, y0, x1, y1] = o.rect;                // entrance wall runs along x, the outer face is the side away from the house
  const cx = (x0 + x1) / 2;
  const aIn = inside(cx, y0 - 0.15);
  const out = aIn ? 1 : -1;                        // plan direction pointing outside
  const outerFace = aIn ? y1 : y0;
  const T = 0.05, plane = outerFace - out * 0.035;  // leaf centre line, nearly flush with the outer face
  const [l0, l1] = t.leaf;
  const top = o.head, z0 = o.sill + 0.02;
  const pine = mats.timber;
  const sheet = (a: number, b: number, za: number, zb: number, thick: number, m: THREE.Material, c = plane) => box(a, c - thick / 2, za, b, c + thick / 2, zb, m);
  // OSB lining inside the opening: jambs, head (reveal 25 cm deep)
  const rev = 0.25, jt = 0.025;
  const d0 = Math.min(outerFace, outerFace - out * rev), d1 = Math.max(outerFace, outerFace - out * rev);
  g.add(box(x0, d0, z0, x0 + jt, d1, top, mats.osb));
  g.add(box(x1 - jt, d0, z0, x1, d1, top, mats.osb));
  g.add(box(x0, d0, top - jt, x1, d1, top, mats.osb));
  // fixed OSB panel(s) beside the leaf
  const fixed: [number, number][] = [];
  if (l0 - x0 > 0.03) fixed.push([x0, l0]);
  if (x1 - l1 > 0.03) fixed.push([l1, x1]);
  for (const [a, b] of fixed) {
    g.add(sheet(a, b, z0, top, T, mats.osb, plane - out * 0.005));
    world.solids.push(solidFromRect([a, plane - 0.03, b, plane + 0.03], z0, top, 'osb'));
  }
  // leaf on a pivot at the hinge edge; hinge at the end (+x) means the leaf extends towards -x
  const hingeEnd = t.hinge === 'end';
  const hx = hingeEnd ? l1 : l0, along = hingeEnd ? -1 : 1;
  const L = l1 - l0, H = top - z0 - 0.01;
  const pivot = new THREE.Group();
  pivot.position.set(hx, z0, plane);
  g.add(pivot);
  const leaf = new THREE.Group();
  pivot.add(leaf);
  const lx = (a: number, b: number) => (along > 0 ? [a, b] : [-b, -a]) as [number, number];   // leaf-local x range measured from the hinge
  const part = (a: number, b: number, za: number, zb: number, zn0: number, zn1: number, m: THREE.Material) => {
    const [p, q] = lx(a, b);
    const mm = mesh(new THREE.BoxGeometry(q - p, zb - za, zn1 - zn0), m);
    mm.position.set((p + q) / 2, (za + zb) / 2, (zn0 + zn1) / 2);
    return mm;
  };
  leaf.add(part(0, L, 0, H, -T / 2, T / 2, mats.osb));
  leaf.add(part(L - 0.06, L, 0, H, -T / 2 - 0.012, T / 2 + 0.012, pine));    // pine batten along the lock edge
  leaf.add(part(0, 0.06, 0, H, -T / 2 - 0.012, T / 2 + 0.012, pine));         // ... and the hinge edge
  leaf.add(part(0, L, 0, 0.06, -T / 2 - 0.012, T / 2 + 0.012, pine));         // bottom
  leaf.add(part(0, L, H - 0.06, H, -T / 2 - 0.012, T / 2 + 0.012, pine));     // top
  const outZ = out * (T / 2 + 0.012);
  for (const zz of [0.3, 0.85, 1.4, 1.85]) leaf.add(part(0, 0.13, zz, zz + 0.045, outZ - 0.004, outZ + 0.004, mats.zincHinge));   // flat zinc hinge leaves
  leaf.add(part(L - 0.1, L - 0.07, 0.98, 1.01, -outZ, outZ, mats.zincHinge));                                                  // through-bolt knob
  // pivot rotation: local -x (leaf extends that way for a hinge at the end) swings to +plan-y for positive angles
  const outward = t.swing !== 'in';
  const sign = (hingeEnd ? 1 : -1) * out * (outward ? 1 : -1);
  const openAngle = sign * Math.PI * 0.46;
  const solid = solidFromRect([Math.min(l0, l1), plane - 0.03, Math.max(l0, l1), plane + 0.03], z0, top, 'door');
  world.solids.push(solid);
  return new Door(o.id, 'Temporary OSB door (site state)', [(l0 + l1) / 2, plane], o.sill, pivot, 0, openAngle, solid);
}

/**
 * Juliet balcony per the owner's DXF drawings (all in metres here):
 * posts 0.05x0.05 from +0.05 to +1.10; rails 0.04x0.04 at 0.05-0.09, 0.90-0.94, 1.06-1.10;
 * balusters 0.012x0.012 from 0.09 to 1.06 alternating with rings (OD 0.12) centred at 1.00,
 * starting and ending with a ring; post back face 0.06 off the façade on arms at 0.25 and 0.90.
 */
function buildJuliet(g: THREE.Group, o: OpeningJ, alongX: boolean, outerFace: number, outSign: number, mat: THREE.Material) {
  const j = o.juliet!;
  const [x0, y0, x1, y1] = o.rect;
  const c = alongX ? (x0 + x1) / 2 : (y0 + y1) / 2;      // centred on the opening
  const W = j.opening + 2 * j.extend;                     // outer face to outer face of posts
  const f = o.sill;                                       // finished floor
  const n0 = outerFace + outSign * 0.06, n1 = n0 + outSign * 0.05;   // post depth band (away from wall)
  const nc = (n0 + n1) / 2;
  const P = (s0: number, s1: number, z0: number, z1: number, d0: number, d1: number) =>
    alongX ? box(s0, Math.min(d0, d1), z0, s1, Math.max(d0, d1), z1, mat) : box(Math.min(d0, d1), s0, z0, Math.max(d0, d1), s1, z1, mat);
  const a = c - W / 2, b = c + W / 2;
  // posts
  g.add(P(a, a + 0.05, f + 0.05, f + 1.10, n0, n1));
  g.add(P(b - 0.05, b, f + 0.05, f + 1.10, n0, n1));
  // rails (centred on post centreline, 40 deep)
  for (const [r0, r1] of [[0.05, 0.09], [0.90, 0.94], [1.06, 1.10]])
    g.add(P(a + 0.05, b - 0.05, f + r0, f + r1, nc - 0.02, nc + 0.02));
  // rings and balusters: ring, baluster, ring, ... ring  (rings*0.12 + balusters*0.012 = span)
  const span = W - 0.10;
  const nb = Math.round((span - 0.12) / 0.132);
  let s = a + 0.05;
  for (let i = 0; i <= nb; i++) {
    const ring = mesh(new THREE.TorusGeometry(0.054, 0.006, 6, 28), mat);
    ring.position.set(alongX ? s + 0.06 : nc, f + 1.0, alongX ? nc : s + 0.06);
    if (!alongX) ring.rotation.y = Math.PI / 2;
    g.add(ring);
    s += 0.12;
    if (i < nb) {
      g.add(P(s, s + 0.012, f + 0.09, f + 1.06, nc - 0.006, nc + 0.006));
      s += 0.012;
    }
  }
  // wall arms (4): from the façade to the back of each post, at 0.25 and 0.90
  for (const sp of [a + 0.025, b - 0.025])
    for (const h of [0.25, 0.90])
      g.add(P(sp - 0.02, sp + 0.02, f + h - 0.03, f + h + 0.03, outerFace, n0));
}

/**
 * A rafter lying on a roof plane (or along the meeting line of two planes for hips/valleys).
 * Sides are vertical and the ends are cut plumb (like real rafter tails); the top is `rise` above the
 * bottom, measured vertically, so it meets the membrane exactly.
 */
function timberOnPlane(p: [number, number, number, number], planes: [number, number, number][], width: number, rise: number, mat: THREE.Material): THREE.Mesh {
  const [ax, ay, bx, by] = p;
  const [a, b, c] = planes[0];
  const hA = a * ax + b * ay + c, hB = a * bx + b * by + c;
  const L = Math.hypot(bx - ax, by - ay);
  const ex = -(by - ay) / L * width / 2, ey = (bx - ax) / L * width / 2; // horizontal, across the timber
  // corners: bottom (on the plane line) and top (+rise), at both ends, both sides
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, z, y);
  const b0 = V(ax + ex, ay + ey, hA), b1 = V(ax - ex, ay - ey, hA), b2 = V(bx - ex, by - ey, hB), b3 = V(bx + ex, by + ey, hB);
  const t0 = b0.clone().setY(hA + rise), t1 = b1.clone().setY(hA + rise), t2 = b2.clone().setY(hB + rise), t3 = b3.clone().setY(hB + rise);
  const len3 = Math.hypot(L, hB - hA);
  const quads: [THREE.Vector3[], number, number][] = [
    [[b0, b3, b2, b1], len3, width], [[t0, t1, t2, t3], len3, width],   // bottom, top
    [[b0, t0, t3, b3], len3, rise], [[b1, b2, t2, t1], len3, rise],     // sides
    [[b0, b1, t1, t0], width, rise], [[b3, t3, t2, b2], width, rise],   // plumb ends
  ];
  const pos: number[] = [], uv: number[] = [];
  const centre = new THREE.Vector3().add(b0).add(b2).add(t0).add(t2).multiplyScalar(0.25);
  for (const [q, u, v] of quads) {
    // orient each quad outward
    const n = new THREE.Vector3().subVectors(q[1], q[0]).cross(new THREE.Vector3().subVectors(q[2], q[0]));
    const mid = q[0].clone().add(q[2]).multiplyScalar(0.5);
    if (n.dot(mid.sub(centre)) < 0) q.reverse();
    const qu = [[0, 0], [u, 0], [u, v], [0, v]];
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) for (const idx of [i, j, k]) { pos.push(q[idx].x, q[idx].y, q[idx].z); uv.push(qu[idx][0], qu[idx][1]); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  void planes.length;
  return mesh(geo, mat);
}
