import type { Player } from './player';

/** Phones / tablets: no keyboard, no pointer lock. */
export const isTouch = typeof window !== 'undefined' && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches));

export interface TouchActions { door(): void; light(): void; scene(): void; menu(): void }

/**
 * On-screen controls: left stick = walk (push to the rim = run), drag anywhere else = look,
 * buttons = open door / light (double tap = whole floor) / light scene / crouch / menu.
 */
export function initTouch(player: Player, canvas: HTMLElement, a: TouchActions, walking: () => boolean) {
  document.body.classList.add('touch');
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `<div id="joy"><div id="joy-knob"></div></div>
    <div id="tbtns"><button data-a="door">Door</button><button data-a="light">Light</button><button data-a="scene">Scene</button><button data-a="crouch">Crouch</button><button data-a="menu">Menu</button></div>`;
  document.body.appendChild(root);
  const joy = root.querySelector('#joy') as HTMLElement, knob = root.querySelector('#joy-knob') as HTMLElement;
  const R = 46;
  let jid = -1;
  const stick = (e: PointerEvent) => {
    const r = joy.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / R);
    player.touch.x = (dx / len) * k; player.touch.y = (dy / len) * k;
    knob.style.transform = `translate(${player.touch.x * R}px, ${player.touch.y * R}px)`;
  };
  const release = (e: PointerEvent) => {
    if (e.pointerId !== jid) return;
    jid = -1; player.touch.x = 0; player.touch.y = 0; knob.style.transform = '';
  };
  joy.addEventListener('pointerdown', (e) => { jid = e.pointerId; joy.setPointerCapture(jid); stick(e); e.preventDefault(); });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === jid) stick(e); });
  joy.addEventListener('pointerup', release); joy.addEventListener('pointercancel', release);

  // look: drag a finger over the 3D view
  let lid = -1, lx = 0, ly = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || lid !== -1) return;
    lid = e.pointerId; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(lid);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lid) return;
    if (walking()) player.look(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
  });
  const lookEnd = (e: PointerEvent) => { if (e.pointerId === lid) lid = -1; };
  canvas.addEventListener('pointerup', lookEnd); canvas.addEventListener('pointercancel', lookEnd);

  root.querySelector('#tbtns')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const k = b.dataset.a;
    if (k === 'door') a.door(); else if (k === 'light') a.light(); else if (k === 'scene') a.scene();
    else if (k === 'crouch') { player.toggleCrouch(); b.classList.toggle('on', player.crouch); } else if (k === 'menu') a.menu();
  });
}
