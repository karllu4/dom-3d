// Data produced by tools/build_house.py (public/house.json).
// Plan coordinates: x → right, y → down the page. In three.js: X = x, Z = y, Y = height.

export type Pt = [number, number];
export type Rect = [number, number, number, number]; // x0, y0, x1, y1
export type Plane = [number, number, number]; // h = a*x + b*y + c

export interface PolyJ { outer: Pt[]; holes: Pt[][] }
export interface WallJ extends PolyJ { z0: number; z1: number }

export interface RoomLabel { id: string; name: string; area: number; at: Pt }
export interface RoomJ extends PolyJ {
  ids: string[];
  labels: RoomLabel[];
  floorZ: number;
  ceilZ: number | null;
  slabBottomZ: number | null;
  floor: PolyJ[];
  ceil: PolyJ[];
}

export interface LevelJ {
  id: string;
  name: string;
  floorZ: number;
  wallZ: [number, number];
  walls: WallJ[];
  rooms: RoomJ[];
  footprint: PolyJ;
  overlay: { img: string; rect: Rect };
  floors?: { z: number; polys: PolyJ[] }[];
  doorStrips?: { z: number; rect: Rect }[];
}

export type OpeningKind = 'window' | 'hs' | 'balcony' | 'door' | 'extdoor' | 'entrance' | 'gate';
export interface OpeningJ {
  id: string;
  level: string;
  kind: OpeningKind;
  rect: Rect;
  sill: number;
  head: number;
  frame?: 'caramel' | 'black' | 'cherry';
  panes?: number;
  span?: [number, number];
  catalog?: string;
  juliet?: { opening: number; extend: number; dxf?: string };
  garage?: { sections: number; variants: { name: string; color: string; ribs: number; wood: boolean }[] };
  door?: { model?: string; design?: string; color: string; colorName?: string; leaf: [number, number]; hinge: 'start' | 'end'; swing?: 'in' | 'out'; sidelight?: [number, number] };
}

export interface StairsJ {
  x0: number; y0: number; y1: number;
  tread: number; rise: number; treads: number;
  landing: { rect: Rect; z: number };
  topStep: { rect: Rect; z: number };
  void: { rect: Rect };
  railings: [Pt, Pt][];
}

export interface RoofJ {
  k: number;
  thickness: number;
  parts: { name: string; rect: Rect; wallRect?: Rect; planes: Plane[] }[];
  faces: (PolyJ & { plane: Plane })[];
  items: { id: string; kind: 'window' | 'hatch'; center: Pt; w: number; l: number; rect: Rect; plane: Plane }[];
  rafter: { width: number; depth: number; spacing: number };
  rafters: { p: [number, number, number, number]; plane: Plane }[];
  hips: { p: [number, number, number, number]; planes: Plane[] }[];
  ties: { p: [number, number, number, number]; z: number; name: string }[];
  steps: { p: [number, number, number, number]; lo: [number, number]; hi: [number, number] }[];
  flashing?: { p: [number, number, number, number]; plane: Plane }[];
  tie: { board?: number; depth?: number };
}

export interface HouseJ {
  levels: LevelJ[];
  openings: OpeningJ[];
  stairs: StairsJ;
  roof: RoofJ;
  outside: { groundZ: number; terraces: { name: string; rect: Rect; z: number }[] };
  spawn: { x: number; y: number; yawDeg: number };
  chimney?: { rect: Rect; top: number; walkway?: Rect };
  beams?: { id: string; level: string; rect: Rect; bottom: number; top: number }[];
  julietColor?: string;
  soffits?: PolyJ[];
  site?: { lat: number; lon: number; planDownBearingDeg: number };
  furniture?: { type: string; rect?: Rect; at?: Pt; rot?: number; h?: number; z?: number; axis?: 'x' | 'y'; open?: boolean; head?: 'x0' | 'x1' | 'y0' | 'y1'; wall?: 'x0' | 'x1' | 'y0' | 'y1'; monitor?: boolean; sinks?: number; sink?: Pt; hob?: Pt; hood?: boolean; fridge?: boolean; tv?: boolean; front?: 'x0' | 'x1' | 'y0' | 'y1'; builtin?: boolean; corner?: 'x0y0' | 'x1y0' | 'x0y1' | 'x1y1'; fill?: 'books' | 'clothes' | 'none' }[];
  hvac?: { type: 'cassette'; level: string; at: Pt; panel: number; body: [number, number]; model?: string }[];
  lighting?: { id: string; level: string; floorZ: number; ceilZ: number | null; area: number; center: Pt;
    lamps?: Pt[]; downlights?: Pt[]; battens?: [number, number, number, number][]; cove: Pt[][];
    pendants?: Pt[]; pendantDrop?: number; pendantBottom?: number; pendantTopZ?: number; tableLamps?: [number, number, number][]; wallLamps?: [number, number, number, number][]; floorLamps?: Pt[]; lowLights?: [number, number, number][]; linearPendant?: { from: Pt; to: Pt; bottom: number }; beamStrip?: string; stairLights?: boolean; wallStrip?: [number, number, number, number, number] }[];
  atticFinish?: { flattenBays?: string[]; ceilingHeight: number; woolBetween: number; woolUnder: number; board: number; woolFlat: number;
    rooms: { ids: string[]; ceil: number; slopes: (PolyJ & { plane: Plane })[]; flats: PolyJ[] }[];
    steps?: { p: [number, number, number, number]; lo: [number, number]; hi: [number, number] }[] };
  steel?: { color: string; posts: { id: string; at: Pt; size: number; base: number }[]; beams: { id: string; from: [number, number, number]; to: [number, number, number]; w: number; h: number }[];
    roofBeams?: { id: string; p: [number, number, number, number]; planes: Plane[]; width: number; rise: number }[] };
  timberPosts?: { posts: { id: string; at: Pt; size: number; base: number; head?: { length: number; w: number; h: number; axis: 'x' | 'y' } }[] };
}
