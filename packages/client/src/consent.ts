// A REUSABLE cookie / storage-consent controller. It is deliberately decoupled from the cassette
// and the engine: everything — categories, copy, policy link, storage key — is passed in as data, so
// the same module drops into any of the example sites. It renders two forms (a labelled bottom
// banner and a modal preferences dialog), persists the decision in localStorage, and exposes a small
// API (get / granted / onChange / openPreferences) that feature code checks before loading anything
// non-essential.
//
// Legal note (EU/NL ePrivacy — Telecommunicatiewet 11.7a): storage that is STRICTLY NECESSARY for a
// service the user asked for (here: the theme choice, the in-tab workspace state, and this consent
// record itself) is EXEMPT from prior consent. So the `necessary` category is always-on and never
// gated; only the OPTIONAL categories (analytics, marketing, …) default OFF and require an opt-in.
// A site that sets no optional cookies still shows this as a transparency notice, not a gate.

export interface ConsentCategory {
  id: string;
  label: string;
  description: string;
  required?: boolean; // strictly necessary → locked on, never gated
}

export interface ConsentCopy {
  bannerTitle: string;
  bannerBody: string; // may include "{policy}" — replaced by the policy link
  policyLabel?: string;
  policyHref?: string;
  acceptAll: string;
  necessaryOnly: string;
  customize: string;
  dialogTitle: string;
  dialogIntro: string;
  save: string;
  lockedLabel: string; // shown next to a required category instead of a switch
}

export interface ConsentConfig {
  storageKey: string;
  version?: number; // bump when the policy/categories change to re-ask
  categories: ConsentCategory[];
  copy: ConsentCopy;
  mount?: HTMLElement; // default document.body
  locale?: string; // for the stored record's readability; the page owns actual localization
}

export interface ConsentState {
  version: number;
  at: number; // epoch ms of the decision
  choices: Record<string, boolean>; // categoryId → granted
}

export interface ConsentController {
  get(): ConsentState | null;
  granted(categoryId: string): boolean;
  onChange(cb: (s: ConsentState) => void): () => void;
  openPreferences(): void;
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function initConsent(config: ConsentConfig): ConsentController {
  const version = config.version ?? 1;
  const mount = config.mount ?? document.body;
  const subs = new Set<(s: ConsentState) => void>();
  let state: ConsentState | null = read();

  function read(): ConsentState | null {
    try {
      const raw = localStorage.getItem(config.storageKey);
      if (!raw) return null;
      const s = JSON.parse(raw) as ConsentState;
      return s && s.version === version ? s : null; // stale version → re-ask
    } catch {
      return null;
    }
  }
  function write(choices: Record<string, boolean>): void {
    state = { version, at: Date.now(), choices };
    try {
      localStorage.setItem(config.storageKey, JSON.stringify(state));
    } catch {
      /* private mode — the decision holds for this session in memory */
    }
    for (const cb of subs) cb(state);
  }

  const decide = (all: boolean): Record<string, boolean> =>
    Object.fromEntries(config.categories.map((c) => [c.id, c.required ? true : all]));

  // --- the bottom banner (a labelled region, not a modal — it blocks nothing) ---
  let banner: HTMLElement | null = null;
  function showBanner(): void {
    if (banner) return;
    banner = el('section', 'cc-banner');
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', config.copy.bannerTitle);
    const text = el('p', 'cc-banner-text');
    const body = el('span');
    body.append(el('strong', undefined, config.copy.bannerTitle + ' '));
    // splice the policy link into the body at "{policy}"
    const [before, after] = config.copy.bannerBody.split('{policy}');
    body.append(document.createTextNode(before));
    if (config.copy.policyHref && after !== undefined) {
      const a = el('a') as HTMLAnchorElement;
      a.href = config.copy.policyHref;
      a.textContent = config.copy.policyLabel ?? config.copy.policyHref; // no locale-specific fallback — keep the module language-neutral
      a.target = '_blank';
      a.rel = 'noopener';
      body.append(a, document.createTextNode(after));
    } else {
      body.append(document.createTextNode(after ?? ''));
    }
    text.append(body);

    const actions = el('div', 'cc-actions');
    const customize = el('button', 'cc-btn cc-btn-quiet', config.copy.customize) as HTMLButtonElement;
    const necessary = el('button', 'cc-btn', config.copy.necessaryOnly) as HTMLButtonElement;
    const accept = el('button', 'cc-btn cc-btn-primary', config.copy.acceptAll) as HTMLButtonElement;
    customize.addEventListener('click', () => openDialog());
    necessary.addEventListener('click', () => { write(decide(false)); hideBanner(); });
    accept.addEventListener('click', () => { write(decide(true)); hideBanner(); });
    actions.append(customize, necessary, accept);

    banner.append(text, actions);
    mount.append(banner);
  }
  function hideBanner(): void {
    banner?.remove();
    banner = null;
  }

  // --- the preferences dialog (a real modal: focus-trapped, Escape-closable) ---
  function openDialog(): void {
    const opener = document.activeElement as HTMLElement | null;
    const scrim = el('div', 'cc-scrim');
    const dialog = el('div', 'cc-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const titleId = 'cc-title';
    dialog.setAttribute('aria-labelledby', titleId);
    const title = el('h2', 'cc-title', config.copy.dialogTitle);
    title.id = titleId;
    const intro = el('p', 'cc-intro', config.copy.dialogIntro);
    dialog.append(title, intro);

    const boxes = new Map<string, HTMLInputElement>();
    const current = state?.choices ?? decide(false);
    for (const c of config.categories) {
      const row = el('div', 'cc-cat');
      const main = el('div', 'cc-cat-main');
      const name = el('div', 'cc-cat-name', c.label);
      const desc = el('div', 'cc-cat-desc', c.description);
      main.append(name, desc);
      if (c.required) {
        const locked = el('span', 'cc-locked', config.copy.lockedLabel);
        row.append(main, locked);
      } else {
        const wrap = el('label', 'cc-switch');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = current[c.id] ?? false;
        box.setAttribute('aria-label', c.label);
        wrap.append(box);
        boxes.set(c.id, box);
        row.append(main, wrap);
      }
      dialog.append(row);
    }

    const actions = el('div', 'cc-dialog-actions');
    const necessary = el('button', 'cc-btn', config.copy.necessaryOnly) as HTMLButtonElement;
    const save = el('button', 'cc-btn cc-btn-primary', config.copy.save) as HTMLButtonElement;
    necessary.addEventListener('click', () => { write(decide(false)); close(); hideBanner(); });
    save.addEventListener('click', () => {
      const choices = decide(false);
      for (const [id, box] of boxes) choices[id] = box.checked;
      write(choices);
      close();
      hideBanner();
    });
    actions.append(necessary, save);
    dialog.append(actions);
    scrim.append(dialog);
    mount.append(scrim);

    // focus management: focus into the dialog, trap Tab, restore focus on close
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])')].filter((e) => !e.hasAttribute('disabled'));
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    };
    scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) close(); });
    dialog.addEventListener('keydown', onKey);
    (focusables()[0] ?? dialog).focus();

    function close(): void {
      scrim.remove();
      opener?.focus?.();
    }
  }

  // initial: if no valid decision on record, invite one
  if (!state) showBanner();

  return {
    get: () => state,
    granted: (id) => state?.choices[id] ?? config.categories.find((c) => c.id === id)?.required ?? false,
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    openPreferences: () => openDialog(),
  };
}
