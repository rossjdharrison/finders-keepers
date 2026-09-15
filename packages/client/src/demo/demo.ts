// The demo layer — an in-site guided tour + an "Explain" annotation mode that make the site narrate
// itself, for business and technical viewers alike. Faithful to the thesis: the tour's CONTENT is DATA
// (tour.json) and this module is only its CHANNEL — the presentation/anchoring/navigation that, by our own
// layering, sits OUTSIDE the sealed @core (a tour has no typed value-computation, so running it through the
// engine would earn nothing). Every note carries a plain-language line PLUS an optional "onder de motorkap"
// technical detail, so one annotation serves both audiences. The tour has multiple TRACKS (e.g. the
// insurance journey and the SME-lending journey); the launcher lets the viewer pick which one to walk.

import guide from './tour.json';

type Surface = 'catalogue' | 'play' | 'loom';
interface Anchor { selector?: string; contains?: string }
interface Stop {
  id: string; surface: Surface; path: string; hash?: string; anchor?: Anchor;
  concept: string; title: string; plain: string; tech?: string; action?: string;
}
interface Track { id: string; label: string; subject?: string; stops: Stop[] }

const TRACKS = guide.tracks as unknown as Track[];
const CONCEPTS = guide.concepts as Record<string, string>;
const trackById = (id: string): Track | undefined => TRACKS.find((t) => t.id === id);
const EXPLAIN_KEY = 'fk-demo-explain';
const SEEN_KEY = 'fk-demo-seen'; // set once the viewer has engaged the tour/Explain, so the first-run invite stops

const seen = (): boolean => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const markSeen = (): void => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } };

const el = (tag: string, cls?: string, txt?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

// a brief toast — used to confirm the Explain toggle did something and say what to do next
let toastTimer: number | undefined;
function showToast(msg: string): void {
  document.querySelector('.demo-toast')?.remove();
  const t = el('div', 'demo-toast', msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 2800);
}

/** Resolve an anchor to a live element: a CSS selector, optionally the first match whose text contains a
 * marker (so we can target "the Individu section" without depending on renderer-internal ids). */
function resolveEl(a?: Anchor): HTMLElement | null {
  if (!a?.selector) return null;
  const els = Array.from(document.querySelectorAll<HTMLElement>(a.selector));
  if (a.contains) return els.find((e) => (e.textContent ?? '').includes(a.contains!)) ?? null;
  return els[0] ?? null;
}

/** Is this stop anchored to the page we are on NOW? Match by SURFACE (each page tells initDemo its own
 * surface) plus, for play/loom where several pages share a surface, the identifying query (cassette/journey).
 * Deliberately IGNORES the pathname spelling: the deployed host rewrites '/'→/catalogue.html (a 200 rewrite,
 * so the URL stays '/'), and may drop '.html' — an exact `location.path === stop.path` check silently failed
 * there, so a tour launched from the catalogue navigated away and never resumed. Surface+query is stable. */
function onThisPage(s: Stop, surface: Surface): boolean {
  if (s.surface !== surface) return false;
  const cur = new URL(location.href).searchParams;
  const st = new URL(s.path, location.origin).searchParams;
  return (['cassette', 'journey'] as const).every((k) => (st.get(k) ?? '') === (cur.get(k) ?? ''));
}

/** The shareable/resumable URL for a stop that lives on ANOTHER page: its path + ?track&tour (+ #tab). */
function urlFor(trackId: string, i: number): string {
  const s = trackById(trackId)!.stops[i];
  const sep = s.path.includes('?') ? '&' : '?';
  return `${s.path}${sep}track=${trackId}&tour=${i}${s.hash ? `#${s.hash}` : ''}`;
}

/** The resume URL for a stop on the CURRENT page — keep the page's own pathname (so '/' stays '/'), just add
 * the track/tour params, so an in-place step doesn't rewrite the visible URL to a different spelling. */
function urlHere(trackId: string, i: number): string {
  const s = trackById(trackId)!.stops[i];
  const u = new URL(location.href);
  u.searchParams.set('track', trackId);
  u.searchParams.set('tour', String(i));
  return `${u.pathname}?${u.searchParams.toString()}${s.hash ? `#${s.hash}` : ''}`;
}

// --- shared card content (used by both the tour panel and an Explain popover) ---------------------
function conceptBadge(concept: string): HTMLElement {
  const b = el('span', 'demo-badge', CONCEPTS[concept] ?? concept);
  b.dataset.concept = concept;
  return b;
}
function fillCard(host: HTMLElement, s: Stop): void {
  const head = el('div', 'demo-card-head');
  head.append(conceptBadge(s.concept));
  host.append(head);
  host.append(el('h3', 'demo-title', s.title));
  host.append(el('p', 'demo-plain', s.plain));
  if (s.action) host.append(el('p', 'demo-action', s.action));
  if (s.tech) {
    const d = document.createElement('details');
    d.className = 'demo-tech';
    d.append(el('summary', undefined, 'onder de motorkap'));
    d.append(el('p', undefined, s.tech));
    host.append(d);
  }
}

// --- spotlight ------------------------------------------------------------------------------------
let spotEl: HTMLElement | null = null;
function clearSpot(): void { spotEl?.classList.remove('demo-spot'); spotEl = null; }
function spotlight(a?: Anchor, scroll = true): void {
  clearSpot();
  const t = resolveEl(a);
  if (!t) return;
  t.classList.add('demo-spot');
  spotEl = t;
  // scroll only on the initial spotlight — a re-spotlight after a live re-render must NOT yank the page
  if (scroll) { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* older engines */ } }
}

// The journey renderer re-renders reactively (an autofill lands, an input changes) by REPLACING #mount's
// children — which wipes the spotlight class and orphans the Explain-chip anchors. Watch the mount and
// re-apply them, so the demo survives live recomputes. Chips/panels live on <body> (outside #mount), so
// they never re-trigger this. Debounced; re-spotlight without scrolling.
let activeStop: Stop | null = null;
let currentSurface: Surface = 'catalogue';
let mo: MutationObserver | null = null;
let moTimer = 0;
function onDomChanged(): void {
  if (tourPanel && activeStop && !spotEl?.isConnected) {
    spotlight(activeStop.anchor, false); // re-apply without scrolling…
    if (spotEl) { // …but if the re-render pushed the target off-screen (e.g. autofill grew the page), re-centre it
      const r = spotEl.getBoundingClientRect();
      if (r.bottom < 40 || r.top > window.innerHeight - 40) { try { spotEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* older engines */ } }
    }
  }
  healChips();
}
function ensureObserver(): void {
  if (mo) return;
  const mount = document.getElementById('mount');
  if (!mount) return;
  // childList/subtree catches the renderer's replaceChildren; the `hidden` attribute catches a Loom tab
  // switch (its panels persist and only toggle `hidden`), so Explain chips reposition to the visible panel.
  mo = new MutationObserver(() => { clearTimeout(moTimer); moTimer = window.setTimeout(onDomChanged, 60); });
  mo.observe(mount, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
}

// --- the guided tour ------------------------------------------------------------------------------
let tourPanel: HTMLElement | null = null;
function removeTour(): void { tourPanel?.remove(); tourPanel = null; }

function endTour(): void {
  removeTour();
  clearSpot();
  activeStop = null;
  const u = new URL(location.href);
  u.searchParams.delete('tour');
  u.searchParams.delete('track');
  const q = u.searchParams.toString();
  history.replaceState(null, '', u.pathname + (q ? `?${q}` : '') + u.hash);
}

function goTo(trackId: string, i: number): void {
  const track = trackById(trackId);
  if (!track || i < 0 || i >= track.stops.length) return;
  const tgt = track.stops[i];
  if (onThisPage(tgt, currentSurface)) {
    // same page: switch the Loom tab in place if the stop names one, then re-render without a reload
    if (tgt.hash) document.getElementById(`lm-tab-${tgt.hash}`)?.click();
    history.replaceState(null, '', urlHere(trackId, i));
    renderTour(trackId, i);
  } else {
    location.href = urlFor(trackId, i); // cross-page: navigate; the next page renders this stop from the URL
  }
}

function renderTour(trackId: string, i: number): void {
  markSeen(); // engaging the tour retires the first-run invite
  removeTour();
  closeChooser();
  removeInvite();
  const track = trackById(trackId)!;
  const s = track.stops[i];
  const panel = el('div', 'demo-tour');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Rondleiding — ${track.label}`);

  const close = el('button', 'demo-x') as HTMLButtonElement;
  close.type = 'button';
  close.setAttribute('aria-label', 'Rondleiding sluiten');
  close.textContent = '✕';
  close.addEventListener('click', endTour);
  panel.append(close);

  panel.append(el('div', 'demo-eyebrow', `Rondleiding · ${track.label}`));
  fillCard(panel, s);

  const nav = el('div', 'demo-nav');
  const prev = el('button', 'demo-btn demo-btn-ghost', '‹ Vorige') as HTMLButtonElement;
  prev.type = 'button';
  prev.disabled = i === 0;
  prev.addEventListener('click', () => goTo(trackId, i - 1));
  const count = el('span', 'demo-count', `${i + 1} / ${track.stops.length}`);
  const last = i === track.stops.length - 1;
  const next = el('button', 'demo-btn demo-btn-primary', last ? 'Voltooien' : 'Volgende ›') as HTMLButtonElement;
  next.type = 'button';
  next.addEventListener('click', () => (last ? endTour() : goTo(trackId, i + 1)));
  nav.append(prev, count, next);
  panel.append(nav);

  document.body.append(panel);
  tourPanel = panel;
  activeStop = s;
  next.focus();
  spotlight(s.anchor);
}

// --- the track chooser (shown by the launcher when there is more than one track) ------------------
let chooser: HTMLElement | null = null;
let onDocClick: ((e: MouseEvent) => void) | null = null;
function closeChooser(): void {
  chooser?.remove();
  chooser = null;
  if (onDocClick) { document.removeEventListener('click', onDocClick); onDocClick = null; }
}
function openChooser(near: HTMLElement): void {
  if (chooser) { closeChooser(); return; }
  const menu = el('div', 'demo-choose');
  menu.setAttribute('role', 'menu');
  menu.append(el('div', 'demo-choose-head', 'Kies een rondleiding'));
  for (const tr of TRACKS) {
    const b = el('button', 'demo-choose-item') as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(el('span', 'demo-choose-title', tr.label));
    if (tr.subject) b.append(el('span', 'demo-choose-sub', tr.subject));
    b.addEventListener('click', () => { closeChooser(); goTo(tr.id, 0); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = near.getBoundingClientRect();
  const w = menu.offsetWidth || 300;
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
  chooser = menu;
  // close when clicking outside (attached next tick so this same click doesn't immediately close it)
  onDocClick = (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    if (chooser && !chooser.contains(t) && !t.classList.contains('demo-launch')) closeChooser();
  };
  setTimeout(() => onDocClick && document.addEventListener('click', onDocClick), 0);
}

/** Start the tour: pick a track first when there is more than one, else launch the only track. */
function launch(near: HTMLElement): void {
  if (TRACKS.length <= 1) goTo(TRACKS[0]?.id ?? '', 0);
  else openChooser(near);
}

// --- Explain mode: anchored "i" chips that open the same dual-register card -----------------------
interface Chip { chip: HTMLElement; anchor: HTMLElement }
let chips: Chip[] = [];
let pop: HTMLElement | null = null;
let reflow: (() => void) | null = null;

function closePop(): void {
  pop?.remove();
  pop = null;
  clearSpot();
  // a popover borrows the shared spotlight; when a tour runs underneath, restore its highlight on close
  if (tourPanel && activeStop) spotlight(activeStop.anchor, false);
  healChips();
}

function openPop(s: Stop, near: HTMLElement): void {
  closePop();
  const card = el('div', 'demo-pop');
  const x = el('button', 'demo-x', '✕') as HTMLButtonElement;
  x.type = 'button';
  x.setAttribute('aria-label', 'Sluiten');
  x.addEventListener('click', closePop);
  card.append(x);
  fillCard(card, s);
  document.body.append(card);
  const r = near.getBoundingClientRect();
  const w = Math.min(card.offsetWidth || 320, window.innerWidth - 24);
  card.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
  card.style.top = `${Math.min(r.bottom + 8, window.innerHeight - card.offsetHeight - 12)}px`;
  pop = card;
  spotlight(s.anchor);
}

function positionChips(): void {
  for (const { chip, anchor } of chips) {
    if (!anchor.isConnected) { chip.style.display = 'none'; continue; }
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { chip.style.display = 'none'; continue; }
    chip.style.display = '';
    chip.style.left = `${Math.min(r.right - 14, window.innerWidth - 28)}px`;
    chip.style.top = `${Math.max(r.top + 6, 6)}px`;
  }
}

// the stops that anchor to THIS exact page (across all tracks — surface alone isn't enough, two 'play'
// pages share the .jc-rail anchor). Used for both the on-page chips and the persistent Explain bar.
function stopsHere(surface: Surface): Stop[] {
  return TRACKS.flatMap((t) => t.stops).filter((s) => onThisPage(s, surface) && !!resolveEl(s.anchor));
}

// build one chip per stop on this page, each opening the same dual-register card.
function buildChips(surface: Surface): void {
  const here = stopsHere(surface);
  here.forEach((s, n) => {
    const anchor = resolveEl(s.anchor)!;
    const chip = el('button', 'demo-chip') as HTMLButtonElement;
    chip.type = 'button';
    chip.dataset.concept = s.concept;
    chip.textContent = String(n + 1);
    chip.title = `${CONCEPTS[s.concept] ?? s.concept}: ${s.title}`;
    chip.setAttribute('aria-label', chip.title);
    chip.addEventListener('click', (e) => { e.stopPropagation(); openPop(s, chip); });
    document.body.append(chip);
    chips.push({ chip, anchor });
  });
  positionChips();
  reflow = () => { positionChips(); };
  window.addEventListener('scroll', reflow, true);
  window.addEventListener('resize', reflow);
}

function clearChips(): void {
  chips.forEach(({ chip }) => chip.remove());
  chips = [];
  if (reflow) { window.removeEventListener('scroll', reflow, true); window.removeEventListener('resize', reflow); reflow = null; }
}

/** Keep Explain valid after a live re-render or a Loom tab switch: rebuild the chips if any anchor detached
 * (renderer replaceChildren), else just reposition (a hidden→visible tab). Never disturbs an open popover. */
function healChips(): void {
  if (pop || !document.body.classList.contains('demo-explaining')) return;
  if (chips.some((c) => !c.anchor.isConnected)) { clearChips(); buildChips(currentSurface); buildExplainBar(currentSurface); }
  else positionChips();
}

// The persistent Explain bar — while Uitleg is on, a docked strip that NAMES every explanation point on the
// page (so the value is visible at a glance, not hidden behind hunting for dots) and offers a clear off
// switch. Clicking an item opens that point's card and spotlights its anchor — the same card the chip opens.
let explainBar: HTMLElement | null = null;
function removeExplainBar(): void { explainBar?.remove(); explainBar = null; }
function buildExplainBar(surface: Surface): void {
  removeExplainBar();
  const here = stopsHere(surface);
  if (!here.length) return;
  const bar = el('div', 'demo-explain-bar');
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Uitleg op deze pagina');
  const head = el('div', 'demo-explain-head');
  head.append(el('span', 'demo-explain-dot', 'i'));
  head.append(el('span', 'demo-explain-headtext', `Uitleg — ${here.length} ${here.length === 1 ? 'punt' : 'punten'} op deze pagina`));
  bar.append(head);
  const list = el('div', 'demo-explain-list');
  here.forEach((s, n) => {
    const b = el('button', 'demo-explain-item') as HTMLButtonElement;
    b.type = 'button';
    b.dataset.concept = s.concept;
    b.append(el('span', 'demo-explain-num', String(n + 1)));
    b.append(el('span', 'demo-explain-lbl', s.title));
    b.addEventListener('click', () => { const a = resolveEl(s.anchor); if (a) openPop(s, a); });
    list.append(b);
  });
  bar.append(list);
  const off = el('button', 'demo-explain-off', 'Uitleg uitzetten') as HTMLButtonElement;
  off.type = 'button';
  off.addEventListener('click', () => toggleExplain(surface, false));
  bar.append(off);
  document.body.append(bar);
  explainBar = bar;
}

function enableExplain(surface: Surface): void {
  clearChips();
  document.body.classList.add('demo-explaining');
  buildChips(surface);
  buildExplainBar(surface);
}

function disableExplain(): void {
  clearChips();
  removeExplainBar();
  document.body.classList.remove('demo-explaining');
  closePop(); // removes any popover; restores the tour spotlight if one runs underneath (healChips no-ops now)
}

// module-level so the persistent bar's off switch and the first-run invite can drive the same state as the
// header toggle (keep the button's on/off appearance in sync wherever Explain is turned on or off).
let uitlegBtn: HTMLButtonElement | null = null;
function syncUitleg(): void {
  if (!uitlegBtn) return;
  const on = explainOn();
  uitlegBtn.classList.toggle('is-on', on);
  uitlegBtn.setAttribute('aria-pressed', String(on));
}
function toggleExplain(surface: Surface, on: boolean): void {
  setExplain(on);
  syncUitleg();
  if (on) { enableExplain(surface); showToast('Uitleg aan — de pagina licht zichzelf toe. Klik een punt hieronder of op de pagina.'); }
  else { disableExplain(); showToast('Uitleg uit.'); }
}

const explainOn = (): boolean => { try { return localStorage.getItem(EXPLAIN_KEY) === '1'; } catch { return false; } };
const setExplain = (v: boolean): void => { try { localStorage.setItem(EXPLAIN_KEY, v ? '1' : '0'); } catch { /* private mode */ } };

// --- header controls ------------------------------------------------------------------------------
function injectButtons(surface: Surface): void {
  const tools = document.querySelector<HTMLElement>('.bank-tools');
  if (!tools || tools.querySelector('.demo-tools')) return;
  const wrap = el('span', 'demo-tools');

  const tour = el('button', 'cc-btn cc-btn-quiet demo-launch', '▶ Rondleiding') as HTMLButtonElement;
  tour.type = 'button';
  tour.setAttribute('aria-haspopup', 'menu');
  tour.addEventListener('click', () => launch(tour));

  const uitleg = el('button', 'cc-btn cc-btn-quiet demo-uitleg', 'Uitleg') as HTMLButtonElement;
  uitleg.type = 'button';
  uitlegBtn = uitleg;
  uitleg.addEventListener('click', () => toggleExplain(surface, !explainOn()));
  syncUitleg();

  wrap.append(tour, uitleg);
  // sit just before the theme toggle so navigation/help group together
  const theme = tools.querySelector('.theme-toggle');
  if (theme) tools.insertBefore(wrap, theme); else tools.append(wrap);
}

// --- the first-run invitation --------------------------------------------------------------------
// The single biggest lever for "the demo does nothing": nobody starts it. On a first visit to the
// catalogue, an unmissable (but dismissible, once-only) card invites the viewer to take the tour or turn
// on Explain — so the whole demo layer isn't hidden behind two header buttons.
let invite: HTMLElement | null = null;
function removeInvite(): void { invite?.remove(); invite = null; }
function maybeInvite(surface: Surface): void {
  if (surface !== 'catalogue' || seen() || invite) return;
  const params = new URL(location.href).searchParams;
  if (params.get('tour') != null) return; // arriving mid-tour (shared link) — no invite
  const hero = document.querySelector('#mount .cat-hero');
  if (!hero) return;
  const card = el('div', 'demo-invite');
  card.append(el('span', 'demo-invite-eyebrow', 'Nieuw hier?'));
  card.append(el('h2', 'demo-invite-title', 'Zie in twee minuten hoe dit werkt'));
  card.append(el('p', 'demo-invite-text', 'Er is geen aparte code per product — het rekenmodel ís de app. Neem de rondleiding, of zet ‘Uitleg’ aan en de pagina licht zichzelf toe: in gewone taal én onder de motorkap.'));
  const row = el('div', 'demo-invite-row');
  const start = el('button', 'demo-btn demo-btn-primary', '▶ Start de rondleiding') as HTMLButtonElement;
  start.type = 'button';
  start.addEventListener('click', () => { removeInvite(); launch(start); });
  const ex = el('button', 'demo-btn demo-btn-ghost', 'Zet Uitleg aan') as HTMLButtonElement;
  ex.type = 'button';
  ex.addEventListener('click', () => { markSeen(); removeInvite(); toggleExplain(surface, true); });
  row.append(start, ex);
  card.append(row);
  const x = el('button', 'demo-x', '✕') as HTMLButtonElement;
  x.type = 'button';
  x.setAttribute('aria-label', 'Sluiten');
  x.addEventListener('click', () => { markSeen(); removeInvite(); });
  card.append(x);
  hero.insertAdjacentElement('afterend', card);
  invite = card;
}

/** Boot the demo layer on a surface: add the controls, resume a tour if the URL carries one, and turn on
 * Explain if the viewer left it on. Call AFTER the surface has rendered its DOM (so anchors resolve). */
export function initDemo(surface: Surface): void {
  injectButtons(surface);
  currentSurface = surface;
  ensureObserver();
  const params = new URL(location.href).searchParams;
  const trackId = params.get('track') ?? TRACKS[0]?.id;
  const t = params.get('tour');
  let resumed = false;
  if (t != null && trackId) {
    const i = Number(t);
    const track = trackById(trackId);
    const stop = track?.stops[i];
    // resume only if this stop truly belongs to THIS page (surface + identifying query), so a crafted/stale
    // URL on the wrong page doesn't render a mismatched stop.
    if (track && stop && Number.isInteger(i) && onThisPage(stop, surface)) { renderTour(trackId, i); resumed = true; }
  }
  if (explainOn()) enableExplain(surface);
  else if (!resumed) maybeInvite(surface); // first-run nudge, only when not already touring/explaining
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); closeChooser(); } });
}
