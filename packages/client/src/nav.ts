// One place for cross-surface navigation, so routes and words stop drifting between the catalogue, the
// aanvraag (player) and the model (Loom). Every surface builds its links through these helpers and renders
// the SAME context bar — a breadcrumb (where am I) + a symmetric Aanvraag|Model view-switch (the two views
// of the same subject) — so moving between a form, its model/rules, a journey and its configurators is
// consistent. Canonical vocabulary (one word per concept): Catalogus · Aanvraag · Model · Regels ·
// configurator (a single-collection building block) · reis (a composed, multi-configurator journey).

export const NAV = {
  catalogus: 'Catalogus',
  aanvraag: 'Aanvraag',
  model: 'Model',
  regels: 'Regels',
} as const;

/** The user-facing name for a cassette's SHAPE — consistent across the catalogue badge and the Loom badge. */
export function shapeLabel(collections: number): string {
  return collections > 1 ? 'Reis' : 'Configurator';
}

export const catalogueHref = (): string => '/catalogue.html';

/** The aanvraag (player) for a subject. A journey is loaded through the same `?cassette=` param as a flat
 * cassette (its id merely happens to be a journey id) — that is the one player route. */
export const playerHref = (id: string): string => `/play.html?cassette=${encodeURIComponent(id)}`;

/** The model (Loom) for a subject. A journey doc opens by `?journey=`, a flat/composed cassette by
 * `?cassette=`. `from` records the journey a configurator was drilled from (for the breadcrumb back-up);
 * `tab` selects a Loom tab (compositie/structuur/grafiek/regels). */
export function loomHref(id: string, opts: { isJourney?: boolean; from?: string; tab?: string } = {}): string {
  const param = opts.isJourney ? 'journey' : 'cassette';
  const from = opts.from ? `&from=${encodeURIComponent(opts.from)}` : '';
  const hash = opts.tab ? `#${opts.tab}` : '';
  return `/loom.html?${param}=${encodeURIComponent(id)}${from}${hash}`;
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export interface Crumb { label: string; href?: string }

export interface ContextBarOpts {
  /** the subject being viewed */
  subject: { id: string; title: string; isJourney: boolean };
  /** which view of the subject is on screen */
  view: 'aanvraag' | 'model';
  /** the journey this subject was drilled from (a member configurator opened from a reis), if any */
  from?: { id: string; title: string };
  /** show a dot on the Model view when edited rules / an edited composition are active */
  modelEdited?: boolean;
}

/** Render the shared context bar: a breadcrumb path + an Aanvraag|Model view-switch. Returns the element. */
export function renderContextBar(opts: ContextBarOpts): HTMLElement {
  const { subject, view, from } = opts;
  const bar = el('div', 'ctx-bar');

  // breadcrumb: Catalogus › [reis ›] subject
  const crumbs = el('nav', 'ctx-crumbs');
  crumbs.setAttribute('aria-label', 'Kruimelpad');
  const push = (c: Crumb, current = false): void => {
    if (crumbs.childElementCount) crumbs.append(el('span', 'ctx-sep', '›'));
    if (c.href && !current) {
      const a = el('a', 'ctx-crumb') as HTMLAnchorElement;
      a.href = c.href;
      a.textContent = c.label;
      crumbs.append(a);
    } else {
      const s = el('span', 'ctx-crumb ctx-current', c.label);
      if (current) s.setAttribute('aria-current', 'page');
      crumbs.append(s);
    }
  };
  push({ label: NAV.catalogus, href: catalogueHref() });
  if (from) push({ label: from.title, href: loomHref(from.id, { isJourney: true, tab: 'compositie' }) });
  push({ label: subject.title }, true);
  bar.append(crumbs);

  // view-switch: the two views of THIS subject, the current one active
  const views = el('div', 'ctx-views');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Weergave');
  const mk = (label: string, active: boolean, href: string, dot = false): HTMLElement => {
    const node = active ? el('span', 'ctx-view is-active', label) : Object.assign(el('a', 'ctx-view', label) as HTMLAnchorElement, { href });
    if (active) node.setAttribute('aria-current', 'page');
    if (dot) node.append(el('span', 'ctx-edited', ' •'));
    return node;
  };
  views.append(mk(NAV.aanvraag, view === 'aanvraag', playerHref(subject.id)));
  views.append(mk(NAV.model, view === 'model', loomHref(subject.id, { isJourney: subject.isJourney }), !!opts.modelEdited));
  bar.append(views);

  return bar;
}
