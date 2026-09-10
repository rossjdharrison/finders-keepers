// Shared pan / zoom / drag for the Loom's SVG graph canvases — the field-dependency Grafiek (graph.ts) and
// the journey Compositie (journey-graph.ts). Panning is the scroller's native overflow scroll; zoom scales
// the SVG element's box (its viewBox is untouched, so the vector stays crisp and the scroll area grows to
// match) via a small toolbar + ctrl/⌘-wheel; nodes are draggable so a cluttered layout can be spread out to
// read the wires and the values they carry. Layout is session-only — a reload re-lays-out (a "nudge to
// read", not a saved layout). Renderer-specific wire/label redraw is delegated to the caller's setPos.

export interface CanvasNode { key: string; el: SVGGraphicsElement }

export interface CanvasOpts {
  baseWidth: number; // the SVG's intrinsic viewBox width (zoom 1.0)
  baseHeight: number;
  nodes: CanvasNode[];
  getPos: (key: string) => { x: number; y: number }; // a node's current position, SVG user units
  setPos: (key: string, x: number, y: number) => void; // commit: update the pos store + node transform + redraw incident wires/labels
}

export interface CanvasController { reset: () => void }

const MIN = 0.4;
const MAX = 2.6;
const clamp = (k: number): number => Math.min(MAX, Math.max(MIN, k));

/** Make an already-rendered SVG canvas pan/zoom/draggable. Returns a controller (reset zoom). */
export function mountCanvas(scroller: HTMLElement, svg: SVGSVGElement, opts: CanvasOpts): CanvasController {
  scroller.classList.add('lm-canvas');
  let scale = 1;
  const applyScale = (): void => {
    svg.style.width = `${opts.baseWidth * scale}px`;
    svg.style.height = `${opts.baseHeight * scale}px`;
  };
  applyScale();

  // --- zoom toolbar ------------------------------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'lm-canvas-zoom';
  const pct = document.createElement('button');
  pct.type = 'button';
  pct.className = 'lm-canvas-zpct';
  pct.textContent = '100%';
  pct.setAttribute('aria-label', 'Zoom terugzetten naar 100%');
  const setPct = (): void => { pct.textContent = `${Math.round(scale * 100)}%`; };
  const zoomTo = (k: number, pivot?: { x: number; y: number }): void => {
    const before = scale;
    scale = clamp(k);
    applyScale();
    setPct();
    if (pivot && scale !== before) {
      // keep the point under `pivot` (scroller-content coords) roughly fixed while zooming
      const r = scale / before;
      scroller.scrollLeft += pivot.x * (r - 1);
      scroller.scrollTop += pivot.y * (r - 1);
    }
  };
  const btn = (label: string, aria: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lm-canvas-zbtn';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    btn('−', 'Uitzoomen', () => zoomTo(scale / 1.2)),
    pct,
    btn('+', 'Inzoomen', () => zoomTo(scale * 1.2)),
  );
  pct.addEventListener('click', () => zoomTo(1));
  scroller.append(bar);

  // ctrl/⌘ + wheel to zoom around the cursor (plain wheel keeps its normal scroll/pan)
  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = scroller.getBoundingClientRect();
    const pivot = { x: e.clientX - rect.left + scroller.scrollLeft, y: e.clientY - rect.top + scroller.scrollTop };
    zoomTo(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), pivot);
  }, { passive: false });

  // --- node dragging -----------------------------------------------------------------------------
  for (const node of opts.nodes) {
    node.el.classList.add('lm-drag');
    node.el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = opts.getPos(node.key);
      let moved = false;
      try { node.el.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      const move = (ev: PointerEvent): void => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 3) return; // click threshold
        moved = true;
        node.el.classList.add('is-dragging');
        opts.setPos(node.key, Math.max(0, origin.x + (ev.clientX - startX) / scale), Math.max(0, origin.y + (ev.clientY - startY) / scale));
      };
      const up = (): void => {
        try { node.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        node.el.removeEventListener('pointermove', move);
        node.el.removeEventListener('pointerup', up);
        node.el.classList.remove('is-dragging');
        if (moved) {
          // swallow the click that fires right after a drag, so dragging a box/node does not also
          // trigger its click (drill into a product / open the formula inspector)
          const swallow = (ce: Event): void => { ce.preventDefault(); ce.stopPropagation(); node.el.removeEventListener('click', swallow, true); };
          node.el.addEventListener('click', swallow, true);
        }
      };
      node.el.addEventListener('pointermove', move);
      node.el.addEventListener('pointerup', up);
    });
  }

  return { reset: () => zoomTo(1) };
}
