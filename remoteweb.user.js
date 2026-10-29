// ==UserScript==
// @name         RemoteWEB
// @namespace    remoteweb
// @version      0.3.0
// @description  D-pad / TV-remote navigation for any website, with per-site rules
// @license      Unlicense
// @homepageURL  https://github.com/iannisimo/RemoteWEB
// @updateURL    https://raw.githubusercontent.com/iannisimo/RemoteWEB/main/remoteweb.user.js
// @downloadURL  https://raw.githubusercontent.com/iannisimo/RemoteWEB/main/remoteweb.user.js
// @match        *://*/*
// @match        file:///*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * Arrow keys move a highlight ("virtual focus") between elements.
 * For each key press:
 *   1. the per-site rules are checked in order; the first match decides,
 *   2. otherwise spatial navigation picks the nearest element in that direction
 *      (same scroll container first, then wider),
 *   3. if nothing is there, the page scrolls.
 * OK clicks the highlighted element. On a text field, OK enters "edit mode":
 * the field gets real focus (so the system virtual keyboard can appear) and
 * keys go to the page until Back is pressed.
 *
 * The script is OFF on every page until enabled: Ctrl+Shift+F8 opens the settings
 * dialog (on/off, list and delete rules, options).
 * F4 records a new rule step by step (saved per site in localStorage).
 * F5 makes the highlighted element ignored by automatic movement (F5 again un-ignores).
 * F2 toggles a debug view that outlines every element the script can reach.
 * In the console, __remoteweb.why(el) explains why an element is or isn't usable.
 *
 * Uses no Tampermonkey APIs, so the same file can be injected into Electron
 * apps (webContents.executeJavaScript, a preload script, or CDP).
 */

(() => {
  'use strict';
  if (window.__remoteweb) return;

  // ------------------------------------------------------------------ config

  const CONFIG = {
    // Each action accepts KeyboardEvent.key or KeyboardEvent.code values.
    keys: {
      up: ['ArrowUp'],
      down: ['ArrowDown'],
      left: ['ArrowLeft'],
      right: ['ArrowRight'],
      ok: ['Enter'],
      back: ['Escape', 'BrowserBack', 'GoBack'],
      debug: ['F2'],
      record: ['F4'],
      ignore: ['F5'],
      settings: ['Ctrl+Shift+F8'], // key names can include modifiers: 'Ctrl+…', 'Alt+…', 'Shift+…'
    },

    // The script is off unless enabled for a site or page: in the settings dialog
    // (Ctrl+Shift+F8), or with `enabled: true` in a site entry below.
    enabled: false,

    // What spatial navigation considers a target. Sites can add more with `focusable`.
    focusable: [
      'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
      '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable="true"]',
      '[role=button]', '[role=link]', '[role=menuitem]', '[role=tab]', '[role=option]',
      '[role=checkbox]', '[role=switch]', '[role=treeitem]', '[role=gridcell]',
    ].join(','),

    // Also treat elements with `cursor: pointer` as usable. Catches divs/spans that
    // only have a JS click handler. Turn off per site if a site sets it everywhere.
    pointerCursor: true,

    // Accept elements with opacity 0 (buttons that only appear on mouse hover).
    // The highlighted element is forced visible.
    allowTransparent: true,

    // Send mouseover/mouseenter to the highlighted element, so menus and previews
    // that open on hover via JS react. (CSS :hover can't be triggered from JS.)
    hoverEvents: true,

    // Look inside shadow DOM (web components) for usable elements.
    shadowDom: true,

    // Also give real DOM focus to natively focusable, non-text elements.
    // Helps sites whose widgets react to :focus or focus events.
    realFocus: true,

    // If the site already shows its own focus style on the highlighted element
    // (background, border, shadow, outline, color, size…), don't draw ours on top.
    useSiteFocus: true,

    // Count the browser's default thin focus ring as "the site shows focus".
    // Off by default: it's hard to see from the couch.
    acceptBrowserRing: false,

    // Spatial navigation prefers elements in the same scroll container (list,
    // carousel) and only leaves it when nothing is left in that direction.
    containerFirst: true,

    // Animate scrolling. Turn off on slow machines for snappier navigation.
    smoothScroll: true,

    // When nothing is in the pressed direction, scroll by this fraction of the viewport.
    scrollStep: 0.6,

    // Back with no matching rule: 'pass' lets the page handle it (closes most modals),
    // 'history' calls history.back().
    backDefault: 'pass',

    // Called when a text field enters edit mode. Hook for a custom on-screen keyboard.
    onEditStart: null, // (el) => {}
    onEditEnd: null,   // (el) => {}

    // Per-site rules. `match` is a glob on location.href ('*' wildcard) or a RegExp.
    //
    // Rule fields:
    //   key:    'up'|'down'|'left'|'right'|'ok'|'back', or any other key as a KeyboardEvent.key
    //           value with optional modifiers ('h', 'MediaPlayPause', 'Ctrl+k', 'Shift+Tab'),
    //           or an array of these. Other keys are ignored while typing in a text field.
    //   from:   CSS selector; matches if the focused element is inside it.
    //           Omit to match anywhere.
    //   to:     where to move:
    //             '.selector'              first visible match; if it's a container, enters it
    //                                      (returns to the last focused child if any)
    //             { sibling: +1 }          next/previous sibling of the `from` element
    //             { index: 0, in: '.sel' } nth visible child of a container (negative = from end)
    //             'none'                   block the move
    //             (el, ctx) => Element     custom JS
    //   action: 'click' | 'back' | 'pass' | (el, ctx) => void   instead of moving
    //           'default' = normal arrow movement, skipping all later rules
    //           (use in a page rule to switch off a site-wide rule there)
    //   target: CSS selector for `action: 'click'` (default: focused element)
    //   send:   key to send to the page instead, e.g. 'k', 'Shift+N', 'ArrowRight', or an
    //           array for a sequence. Works with site shortcuts written in JS; the browser's
    //           own behavior (scrolling, typing, Tab) doesn't react to sent keys.
    //
    // Site fields:
    //   start:     selector to highlight first
    //   focusable: extra selectors spatial navigation should consider
    //   ignore:    selectors the script never uses at all
    //   autoIgnore: selectors arrow-key movement skips, but rules can still target (what F5 saves)
    //   autoUnignore: selectors to un-ignore here (use in a page entry to undo a site-wide autoIgnore)
    //
    // When several entries match (e.g. one for the whole site, one for a page), the one
    // with the most specific `match` is checked first.
    //   Any of these global options can be overridden per site:
    //   enabled, pointerCursor, allowTransparent, hoverEvents, shadowDom, containerFirst, useSiteFocus
    sites: [
      {
        match: '*demo.html*',
        enabled: true,
        start: '#grid > :first-child',
        rules: [
          { from: '#grid > :nth-child(4n+1)', key: 'left', to: '.leftbar' },
          { from: '#grid > *', key: 'right', to: { sibling: +1 } },
          { from: '#grid > *', key: 'left', to: { sibling: -1 } },
          { from: '.leftbar', key: 'right', to: '#grid' },
          { from: '.leftbar', key: ['up', 'down'], to: (el, ctx) => ctx.spatial(ctx.dir, '.leftbar') },
          { from: '#modal', key: 'back', action: 'click', target: '#modal .close' },
        ],
      },
    ],
  };

  // ------------------------------------------------------------------- state

  const FOCUS_CLASS = 'remoteweb-focus';     // our visible ring
  const CURRENT_CLASS = 'remoteweb-current'; // always on the highlighted element (no ring)
  let current = null;        // element with the highlight
  let lastRect = null;       // its last known position (to recover after re-renders)
  let editing = null;        // text field in edit mode, or null
  let debugOn = false;
  const memory = new WeakMap(); // container -> last focused element inside it

  // Settings for the current URL. Recomputed when the URL changes (single-page apps
  // navigate without reloading). More specific `match` patterns come first, so a
  // page entry's rules are checked before a whole-site entry's.
  // Per-site storage for the settings dialog (this site's localStorage).
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  // { site: true|false|undefined, pages: { '/path': true|false } }
  let enabledStore = loadJSON('remoteweb:enabled', { pages: {} });
  enabledStore.pages = enabledStore.pages || {};
  const saveEnabled = () => saveJSON('remoteweb:enabled', enabledStore);
  // Option overrides for this site, e.g. { smoothScroll: false }
  let storedOptions = loadJSON('remoteweb:options', {});
  const saveOptions = () => saveJSON('remoteweb:options', storedOptions);

  const site = {};
  let siteHref = null;
  function refreshSite() {
    const href = location.href;
    if (href === siteHref) return;
    siteHref = href;
    const specificity = (m) => (m instanceof RegExp ? m.source : m.replace(/\*/g, '')).length;
    const matching = CONFIG.sites
      .filter((s) => (s.match instanceof RegExp ? s.match.test(href) : globToRegExp(s.match).test(href)))
      .sort((a, b) => specificity(b.match) - specificity(a.match));
    Object.assign(site, {
      rules: matching.flatMap((s) => s.rules || []),
      start: matching.map((s) => s.start).find(Boolean),
      focusable: [CONFIG.focusable, ...matching.map((s) => s.focusable).filter(Boolean)].join(','),
      ignore: matching.map((s) => s.ignore).filter(Boolean).join(','),
      autoIgnore: matching.flatMap((s) => s.autoIgnore || []),
      autoUnignore: matching.flatMap((s) => s.autoUnignore || []),
      // Value of a global option, overridden by the most specific matching entry.
      configOpt(name) {
        const v = matching.map((s) => s[name]).find((x) => x !== undefined);
        return v !== undefined ? v : CONFIG[name];
      },
      // Settings-dialog overrides win over CONFIG.
      opt(name) {
        return name in storedOptions ? storedOptions[name] : this.configOpt(name);
      },
    });
  }
  refreshSite();

  function globToRegExp(glob) {
    return new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  }

  // --------------------------------------------- tree helpers (shadow DOM aware)

  // Parent, stepping out of a shadow root to its host element.
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function closestDeep(el, selector) {
    for (let a = el; a; a = parentOf(a)) if (a.matches(selector)) return a;
    return null;
  }

  function containsDeep(ancestor, el) {
    if (ancestor === document) return true;
    for (let a = el; a; a = parentOf(a)) if (a === ancestor) return true;
    return false;
  }

  // querySelectorAll that also searches open shadow roots.
  function queryDeep(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    if (site.opt('shadowDom')) {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) out.push(...queryDeep(selector, el.shadowRoot));
      }
    }
    return out;
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  // ------------------------------------------------------- candidate detection

  // Returns null if the element is usable, else a short reason why not.
  function rejectReason(el) {
    if (!el || !el.isConnected) return 'not in the page';
    if (el.disabled) return 'disabled';
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return 'zero size';
    const s = getComputedStyle(el);
    if (s.display === 'none') return 'display: none';
    if (s.visibility === 'hidden') return 'visibility: hidden';
    if (s.opacity === '0' && !site.opt('allowTransparent') && el !== current) return 'opacity: 0';
    if (closestDeep(el, '[inert],[aria-hidden="true"]')) return 'inside [inert] or [aria-hidden="true"]';
    if (site.ignore && closestDeep(el, site.ignore)) return 'matches the site ignore list';
    return null;
  }

  function isVisible(el) { return rejectReason(el) === null; }

  // Topmost element of a `cursor: pointer` chain (children inherit the cursor,
  // so only the outermost one is the clickable thing).
  function isPointerTarget(el) {
    if (el === document.body || el === document.documentElement) return false;
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    const p = parentOf(el);
    if (p && p !== document.body && getComputedStyle(p).cursor === 'pointer') return false;
    // Huge areas are page wrappers, not buttons.
    const r = el.getBoundingClientRect();
    if (r.width * r.height > innerWidth * innerHeight * 0.5) return false;
    return true;
  }

  // How the element qualifies: 'selector', 'pointer', or null.
  function matchKind(el) {
    if (closestDeep(el, '[data-remoteweb-ui]')) return null;
    if (el.matches(site.focusable)) return 'selector';
    if (site.opt('pointerCursor') && isPointerTarget(el)) return 'pointer';
    return null;
  }

  // All usable elements on the page. Cached for the current task, since one key
  // press may need the list several times.
  let cache = null;
  function allCandidates() {
    if (cache) return cache;
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const kind = matchKind(el);
        if (kind && isVisible(el)) out.push(el);
        if (el.shadowRoot && site.opt('shadowDom') && !el.hasAttribute('data-remoteweb-ui')) walk(el.shadowRoot);
      }
    };
    walk(document);
    cache = out;
    queueMicrotask(() => { cache = null; });
    return out;
  }

  // If a modal dialog is open, navigation stays inside it.
  function scopeRoot() {
    const dialogs = queryDeep('dialog[open], [aria-modal="true"]').filter((d) => {
      const s = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    });
    return dialogs[dialogs.length - 1] || document;
  }

  function candidates(root = scopeRoot()) {
    const all = allCandidates();
    return root === document ? all : all.filter((el) => el !== root && containsDeep(root, el));
  }

  const DPAD = ['up', 'down', 'left', 'right', 'ok', 'back'];
  const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS'];

  // "Ctrl+Alt+k", "Shift+Tab", "MediaPlayPause". Shift is left out for single
  // characters, since it already changes the character ("K" vs "k").
  function keyCombo(e) {
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.metaKey && 'Meta',
      e.shiftKey && e.key.length > 1 && 'Shift'].filter(Boolean);
    return [...mods, e.key].join('+');
  }

  // Key bindings can be plain ('F4', 'ArrowUp') or with modifiers ('Ctrl+Shift+F8').
  // With Ctrl/Alt/Meta held, only bindings that name the modifiers match.
  function actionFor(e, combo = keyCombo(e)) {
    const entries = Object.entries(CONFIG.keys);
    for (const [action, keys] of entries) if (keys.includes(combo)) return action;
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    for (const [action, keys] of entries) {
      if (keys.includes(e.key) || keys.includes(e.code)) return action;
    }
    return null;
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const nonText = ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'];
    return !nonText.includes((el.type || 'text').toLowerCase());
  }

  // ------------------------------------------------------------------ focus

  const STYLE = `
    .${FOCUS_CLASS} {
      outline: 4px solid #3d9eff !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 8px rgba(61, 158, 255, .35) !important;
    }
    .${CURRENT_CLASS} { opacity: 1 !important; }
    .remoteweb-editing {
      outline: 4px solid #ffb43d !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 8px rgba(255, 180, 61, .35) !important;
    }
    .remoteweb-measure { transition: none !important; }
  `;
  const styledRoots = new WeakSet();

  // Page CSS doesn't reach into shadow roots, so each root gets its own copy.
  function ensureStyle(el) {
    const root = el.getRootNode();
    const target = root instanceof ShadowRoot ? root : document;
    if (styledRoots.has(target)) return;
    styledRoots.add(target);
    const style = document.createElement('style');
    style.textContent = STYLE;
    (target === document ? (document.head || document.documentElement) : target).appendChild(style);
  }

  function mouseEvent(el, type, bubbles) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
  }

  // ------------------------------------------------- site's own focus style

  // Styles a site typically changes to show focus.
  const FOCUS_PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor',
    'backgroundImage', 'borderTopColor', 'borderTopWidth', 'borderBottomColor', 'color', 'textDecorationLine',
    'transform', 'filter', 'opacity'];
  // Checked later, when unrelated animations may be running: leave out the usual animated ones.
  const LATE_PROPS = FOCUS_PROPS.filter((p) => !['transform', 'filter', 'opacity'].includes(p));

  // The element plus its parent and first child: sites often style a wrapper
  // (:focus-within) or an inner part instead of the focused element itself.
  function measuredEls(el) {
    const p = parentOf(el);
    return [el, p && p !== document.body && p !== document.documentElement ? p : null, el.firstElementChild].filter(Boolean);
  }

  function snapshot(els, props) {
    return els.map((e) => { const cs = getComputedStyle(e); return props.map((p) => cs[p]); });
  }

  // Did the look change between two snapshots, beyond the browser's default ring?
  function looksDifferent(before, after, props) {
    for (let i = 0; i < before.length; i++) {
      const changed = props.filter((p, j) => before[i][j] !== after[i][j]);
      if (!changed.length) continue;
      const outlineOnly = changed.every((p) => p.startsWith('outline'));
      const browserRing = outlineOnly && after[i][props.indexOf('outlineStyle')] === 'auto';
      if (browserRing && !site.opt('acceptBrowserRing')) continue;
      return true;
    }
    return false;
  }

  // Run `change` (focus + hover events) and report whether the site restyled the element.
  function measureSiteFocus(el, change) {
    const els = measuredEls(el);
    els.forEach((e) => e.classList.add('remoteweb-measure')); // skip transitions: compare final looks
    const before = snapshot(els, FOCUS_PROPS);
    change();
    const styled = looksDifferent(before, snapshot(els, FOCUS_PROPS), FOCUS_PROPS);
    els.forEach((e) => e.classList.remove('remoteweb-measure'));
    return { styled, els, before: before.map((row) => row.filter((_, j) => LATE_PROPS.includes(FOCUS_PROPS[j]))) };
  }

  function showRing(el, on) {
    el.classList.toggle(FOCUS_CLASS, on);
  }

  // Some sites add their focus class a moment later (async frameworks): look again.
  function recheckSiteFocus(el, m) {
    for (const delay of [120, 400]) {
      setTimeout(() => {
        if (current !== el || !el.classList.contains(FOCUS_CLASS)) return;
        m.els.forEach((e) => e.classList.add('remoteweb-measure'));
        el.classList.remove(FOCUS_CLASS, CURRENT_CLASS); // measure without our own ring
        const now = snapshot(m.els, LATE_PROPS);
        el.classList.add(FOCUS_CLASS, CURRENT_CLASS);
        m.els.forEach((e) => e.classList.remove('remoteweb-measure'));
        if (looksDifferent(m.before, now, LATE_PROPS)) showRing(el, false);
      }, delay);
    }
  }

  function setFocus(el) {
    if (!el) return false;
    const prev = current;
    if (prev) prev.classList.remove(FOCUS_CLASS, CURRENT_CLASS);
    if (prev && prev !== el && prev.isConnected && site.opt('hoverEvents')) {
      mouseEvent(prev, 'pointerout', true); mouseEvent(prev, 'mouseout', true);
      mouseEvent(prev, 'pointerleave', false); mouseEvent(prev, 'mouseleave', false);
    }
    current = el;
    ensureStyle(el);
    lastRect = el.getBoundingClientRect();
    for (let a = parentOf(el); a; a = parentOf(a)) memory.set(a, el);

    const m = measureSiteFocus(el, () => {
      if (prev !== el && site.opt('hoverEvents')) {
        mouseEvent(el, 'pointerover', true); mouseEvent(el, 'mouseover', true);
        mouseEvent(el, 'pointerenter', false); mouseEvent(el, 'mouseenter', false);
      }
      const active = deepActiveElement();
      if (site.opt('realFocus') && !isEditable(el) && el.matches('a[href],button,select,summary,[tabindex]')) {
        el.focus({ preventScroll: true });
      } else if (active && active !== document.body && !containsDeep(el, active)) {
        active.blur();
      }
    });
    const useSite = site.opt('useSiteFocus');
    el.classList.add(CURRENT_CLASS);
    showRing(el, !(useSite && m.styled));
    if (useSite && !m.styled) recheckSiteFocus(el, m);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: site.opt('smoothScroll') ? 'smooth' : 'instant' });
    if (debugOn) drawDebug();
    return true;
  }

  // Current element, recovered if the page re-rendered it away.
  function getCurrent() {
    if (current && isVisible(current)) return current;
    const all = candidates().filter((el) => !autoIgnored(el));
    if (!all.length) return null;
    if (lastRect) return nearest(all, lastRect);
    const start = site.start && queryDeep(site.start).find(isVisible);
    return start || nearest(all, new DOMRect(0, 0, 0, 0));
  }

  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function nearest(list, rect) {
    const c = center(rect);
    let best = null, bestD = Infinity;
    for (const el of list) {
      const p = center(el.getBoundingClientRect());
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }

  // Enter a container: last focused child, else the usable child nearest to `from`.
  function enter(target, fromRect) {
    if (!target) return null;
    const remembered = memory.get(target);
    if (remembered && containsDeep(target, remembered) && isVisible(remembered)) return remembered;
    if (matchKind(target)) return target;
    const inside = candidates(target).filter((el) => !autoIgnored(el));
    if (!inside.length) return target;
    return fromRect ? nearest(inside, fromRect) : inside[0];
  }

  // ------------------------------------------------------- spatial navigation

  // Containers whose content overflows (scroll boxes, carousels), innermost first.
  function scrollContainers(el, stopAt) {
    const list = [];
    for (let a = parentOf(el); a && a !== stopAt && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
      const s = getComputedStyle(a);
      const overflowX = /(auto|scroll|hidden|clip)/.test(s.overflowX) && a.scrollWidth > a.clientWidth + 1;
      const overflowY = /(auto|scroll|hidden|clip)/.test(s.overflowY) && a.scrollHeight > a.clientHeight + 1;
      if (overflowX || overflowY) list.push(a);
    }
    return list;
  }

  // Nearest element in `dir`. Unless `within` is given, it looks in the innermost
  // scroll container first and widens step by step, so a carousel or list keeps
  // focus until there is nothing left in it in that direction.
  function spatial(dir, from = current, within) {
    if (!from) return null;
    if (within) {
      const root = queryDeep(within)[0];
      return root ? bestIn(dir, from, root) : null;
    }
    const scope = scopeRoot();
    // If a popup just opened and focus is still behind it, go straight into the popup.
    const inScope = scope === document || containsDeep(scope, from);
    if (inScope && site.opt('containerFirst')) {
      for (const container of scrollContainers(from, scope)) {
        const best = bestIn(dir, from, container);
        if (best) return best;
      }
    }
    return bestIn(dir, from, scope);
  }

  function bestIn(dir, from, root) {
    const a = from.getBoundingClientRect();
    const ca = center(a);
    let best = null, bestScore = Infinity;

    for (const el of candidates(root)) {
      if (autoIgnored(el)) continue;
      if (el === from || containsDeep(el, from) || containsDeep(from, el)) continue;
      const b = el.getBoundingClientRect();
      const cb = center(b);
      let primary, orthoGap, orthoOffset;

      if (dir === 'right' || dir === 'left') {
        const ahead = dir === 'right' ? cb.x > ca.x && b.right > a.right : cb.x < ca.x && b.left < a.left;
        if (!ahead) continue;
        primary = Math.max(0, dir === 'right' ? b.left - a.right : a.left - b.right);
        orthoGap = Math.max(0, b.top - a.bottom, a.top - b.bottom);
        orthoOffset = Math.abs(cb.y - ca.y);
      } else {
        const ahead = dir === 'down' ? cb.y > ca.y && b.bottom > a.bottom : cb.y < ca.y && b.top < a.top;
        if (!ahead) continue;
        primary = Math.max(0, dir === 'down' ? b.top - a.bottom : a.top - b.bottom);
        orthoGap = Math.max(0, b.left - a.right, a.left - b.right);
        orthoOffset = Math.abs(cb.x - ca.x);
      }
      // Prefer elements in the same row/column, then the closest one.
      const score = primary + orthoGap * 3 + orthoOffset * 0.1 + (orthoGap > 0 ? 100 : 0);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function scrollFallback(dir) {
    const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    const behavior = site.opt('smoothScroll') ? 'smooth' : 'instant';
    // Scroll the nearest scrollable ancestor that can move that way, else the window.
    for (let el = current && parentOf(current); el && el !== document.body; el = parentOf(el)) {
      const s = getComputedStyle(el);
      const canX = dx && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth;
      const canY = dy && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight;
      if (!(canX || canY)) continue;
      const room = dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1
        : dx < 0 ? el.scrollLeft > 0
        : dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
        : el.scrollTop > 0;
      if (room) {
        el.scrollBy({ left: dx * el.clientWidth * site.opt('scrollStep'), top: dy * el.clientHeight * site.opt('scrollStep'), behavior });
        return;
      }
    }
    window.scrollBy({ left: dx * innerWidth * site.opt('scrollStep'), top: dy * innerHeight * site.opt('scrollStep'), behavior });
  }

  // ------------------------------------------------------------------ rules

  // ------------------------------------------------------------- sending keys

  let sending = false; // our own synthetic events must not trigger rules again

  // Legacy keyCode values; many sites still read e.keyCode instead of e.key.
  const KEY_CODES = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
    ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222,
    '<': 188, '>': 190, '?': 191, ':': 186, '+': 187, '_': 189,
    MediaTrackNext: 176, MediaTrackPrevious: 177, MediaStop: 178, MediaPlayPause: 179,
  };

  function keyInfo(key) {
    if (/^[a-z]$/i.test(key)) return { code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0) };
    if (/^[0-9]$/.test(key)) return { code: 'Digit' + key, keyCode: key.charCodeAt(0) };
    if (/^F([1-9]|1[0-2])$/.test(key)) return { code: key, keyCode: 111 + +key.slice(1) };
    if (key === ' ') return { code: 'Space', keyCode: 32 };
    return { code: KEY_CODES[key] !== undefined && key.length === 1 ? '' : key, keyCode: KEY_CODES[key] || 0 };
  }

  // "Ctrl+Shift+k" -> one full key press (keydown, keypress for characters, keyup).
  function sendKey(combo) {
    const m = combo.match(/^((?:(?:Ctrl|Alt|Shift|Meta)\+)*)(.+)$/);
    const mods = m[1], key = m[2];
    const { code, keyCode } = keyInfo(key);
    const init = {
      key, code, bubbles: true, cancelable: true, composed: true, view: window,
      ctrlKey: mods.includes('Ctrl'), altKey: mods.includes('Alt'), metaKey: mods.includes('Meta'),
      shiftKey: mods.includes('Shift') || (key.length === 1 && key !== key.toLowerCase()),
    };
    const target = deepActiveElement() || document.body;
    const fire = (type, kc) => {
      const ev = new KeyboardEvent(type, init);
      // keyCode/which can't be set through the constructor in every browser.
      Object.defineProperty(ev, 'keyCode', { get: () => kc });
      Object.defineProperty(ev, 'which', { get: () => kc });
      if (type === 'keypress') Object.defineProperty(ev, 'charCode', { get: () => kc });
      target.dispatchEvent(ev);
    };
    sending = true;
    try {
      fire('keydown', keyCode);
      if (key.length === 1 && !init.ctrlKey && !init.altKey && !init.metaKey) fire('keypress', key.charCodeAt(0));
      fire('keyup', keyCode);
    } finally {
      sending = false;
    }
  }

  function sendKeys(send) {
    for (const combo of [].concat(send)) sendKey(combo);
  }

  function siblingOf(base, n) {
    let el = base;
    const step = n > 0 ? 'nextElementSibling' : 'previousElementSibling';
    for (let i = 0; i < Math.abs(n) && el;) {
      el = el[step];
      if (el && isVisible(el)) i++;
    }
    return el;
  }

  function resolveTo(to, matched, ctx) {
    const fromRect = current ? current.getBoundingClientRect() : null;
    if (typeof to === 'function') return to(current, ctx);
    if (typeof to === 'string') return enter(queryDeep(to).find(isVisible), fromRect);
    if (to && typeof to.sibling === 'number') return enter(siblingOf(matched, to.sibling), fromRect);
    if (to && typeof to.index === 'number') {
      const container = queryDeep(to.in)[0];
      if (!container) return null;
      const kids = [...container.children].filter(isVisible);
      return enter(kids[to.index < 0 ? kids.length + to.index : to.index], fromRect);
    }
    return null;
  }

  // Returns: an Element to move to, 'none' to block, 'handled', 'pass', or null (no rule matched).
  // `action` is a d-pad action name or null; `combo` is the raw key (see keyCombo).
  function applyRules(action, combo) {
    const ctx = { dir: action, key: combo, spatial: (dir, within) => spatial(dir, current, within) };
    for (const rule of allRules()) {
      const keys = [].concat(rule.key);
      if (!(action && keys.includes(action)) && !(combo && keys.includes(combo))) continue;
      const global = !rule.from || rule.from === 'html'; // "anywhere on the page"
      const matched = current
        ? (global ? current : closestDeep(current, rule.from))
        : (global ? document.documentElement : null);
      if (!matched) continue;

      if (rule.to === 'none') return 'none';
      if (rule.send) { sendKeys(rule.send); return 'handled'; }
      if (rule.action) {
        if (rule.action === 'pass') return 'pass';
        if (rule.action === 'default') return null;
        if (rule.action === 'back') { history.back(); return 'handled'; }
        if (rule.action === 'click') {
          const t = rule.target ? queryDeep(rule.target).find(isVisible) : current;
          if (t) { activate(t); return 'handled'; }
          continue;
        }
        if (typeof rule.action === 'function') { rule.action(current, ctx); return 'handled'; }
      }
      const dest = resolveTo(rule.to, matched, ctx);
      if (dest) return dest;
      // Target not found (e.g. no next sibling): try the next rule / spatial nav.
    }
    return null;
  }

  // ------------------------------------------------------------- activation

  function activate(el) {
    if (isEditable(el)) return startEdit(el);
    if (el.tagName === 'SELECT') {
      el.focus();
      try { el.showPicker(); } catch { /* not supported everywhere */ }
      return;
    }
    // Some sites listen to pointer/mouse down rather than click.
    mouseEvent(el, 'pointerdown', true);
    mouseEvent(el, 'mousedown', true);
    mouseEvent(el, 'pointerup', true);
    mouseEvent(el, 'mouseup', true);
    el.click();
  }

  function startEdit(el) {
    editing = el;
    ensureStyle(el);
    el.classList.add('remoteweb-editing');
    // Real focus is what tells the system (Wayland text-input protocol) that a text
    // field is active. The compositor's virtual keyboard can then show itself.
    el.focus({ preventScroll: true });
    // Chromium's VirtualKeyboard API, where available.
    try {
      if (navigator.virtualKeyboard) {
        el.setAttribute('virtualkeyboardpolicy', 'manual');
        navigator.virtualKeyboard.show();
      }
    } catch { /* ignore */ }
    if (CONFIG.onEditStart) CONFIG.onEditStart(el);
  }

  function endEdit() {
    const el = editing;
    editing = null;
    if (!el) return;
    el.classList.remove('remoteweb-editing');
    try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.hide(); } catch { /* ignore */ }
    if (deepActiveElement() === el) el.blur();
    if (CONFIG.onEditEnd) CONFIG.onEditEnd(el);
  }

  // ------------------------------------------------------------------ debug view

  // Blue = matched a selector, green = cursor: pointer, dashed = inside shadow DOM.
  let debugLayer = null;
  let debugFrame = 0;

  function drawDebug() {
    if (!debugOn) return;
    if (!debugLayer) {
      debugLayer = document.createElement('div');
      debugLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      document.documentElement.appendChild(debugLayer);
    }
    const list = allCandidates();
    const boxes = [];
    let counts = { selector: 0, pointer: 0, shadow: 0, ignored: 0 };
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const kind = matchKind(el);
      const inShadow = el.getRootNode() instanceof ShadowRoot;
      const ignored = autoIgnored(el);
      counts[kind]++;
      if (inShadow) counts.shadow++;
      if (ignored) counts.ignored++;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const color = ignored ? '#ff5c5c' : kind === 'pointer' ? '#3ddc84' : '#3d9eff';
      boxes.push(`<div style="position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
        `border:2px ${inShadow ? 'dashed' : 'solid'} ${color};background:${color}22;box-sizing:border-box;"></div>`);
    }
    boxes.push(`<div style="position:fixed;right:10px;top:10px;background:#000c;color:#fff;font:14px/1.4 monospace;` +
      `padding:8px 12px;border-radius:6px;">RemoteWEB debug (F2)<br>` +
      `<span style="color:#3d9eff">■</span> selector: ${counts.selector}<br>` +
      `<span style="color:#ff5c5c">■</span> ignored by auto-move (F5): ${counts.ignored}<br>` +
      `<span style="color:#3ddc84">■</span> cursor:pointer: ${counts.pointer}<br>` +
      `┅ in shadow DOM: ${counts.shadow}</div>`);
    debugLayer.innerHTML = boxes.join('');
  }

  function scheduleDebug() {
    if (!debugOn || debugFrame) return;
    debugFrame = requestAnimationFrame(() => { debugFrame = 0; drawDebug(); });
  }

  function toggleDebug() {
    debugOn = !debugOn;
    if (debugOn) drawDebug();
    else if (debugLayer) { debugLayer.remove(); debugLayer = null; }
  }

  // Explain why an element is or isn't usable. Use from the console: __remoteweb.why($0)
  function why(el) {
    if (!(el instanceof Element)) return 'not an element';
    const kind = matchKind(el);
    const reason = rejectReason(el);
    const lines = [];
    if (kind === 'selector') lines.push('✔ matches a focusable selector');
    else if (kind === 'pointer') lines.push('✔ has cursor: pointer');
    else {
      const cursor = getComputedStyle(el).cursor;
      const p = parentOf(el);
      if (cursor === 'pointer' && p && getComputedStyle(p).cursor === 'pointer') {
        lines.push('✘ cursor: pointer is inherited from its parent; the parent is the usable element');
      } else {
        lines.push('✘ matches no focusable selector and has no cursor: pointer → add it to the site `focusable`');
      }
    }
    lines.push(reason ? `✘ rejected: ${reason}` : '✔ visible');
    const ign = ignoreState(el);
    if (ign.ignored) {
      const what = ign.entries ? ign.entries.map((e) => e.sel).join(', ') : ign.sels.join(', ');
      lines.push(`✘ ignored by auto-move (${ign.level === 'page' ? 'this page' : ign.level === 'site' ? 'whole site' : 'CONFIG'}): ${what} (rules can still target it)`);
    } else if (ign.level) {
      lines.push(`ℹ un-ignored on this page (${ign.level === 'page' ? 'F5' : 'CONFIG autoUnignore'})`);
    }
    const usableAncestor = parentOf(el) && closestDeep(parentOf(el), site.focusable);
    if (usableAncestor) lines.push('ℹ inside another usable element; navigation can\'t move between nested elements', usableAncestor);
    const scope = scopeRoot();
    if (scope !== document && !containsDeep(scope, el)) lines.push('✘ a popup is open and this element is outside it', scope);
    if (el.getRootNode() instanceof ShadowRoot) lines.push(site.opt('shadowDom') ? 'ℹ inside shadow DOM (searched)' : '✘ inside shadow DOM, and shadowDom is off');
    return lines;
  }

  // ---------------------------------------------------------------- recorder

  // Recorded rules live in this site's localStorage and apply to the whole site,
  // before the CONFIG rules. __remoteweb.exportRules() prints them for CONFIG.
  const STORE_KEY = 'remoteweb:rules';
  let storedRules = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
  })();
  function saveStored() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(storedRules)); return true; } catch { return false; }
  }
  // This page's path, without query or hash, used to scope per-page entries.
  function currentPage() {
    return location.pathname.replace(/\/+$/, '') || '/';
  }

  // Page setting, else site setting (settings dialog), else CONFIG.
  function isEnabled() {
    const p = enabledStore.pages[currentPage()];
    if (p !== undefined) return p;
    if (enabledStore.site !== undefined) return enabledStore.site;
    return !!site.configOpt('enabled');
  }

  // Priority: this page's recorded rules, then whole-site recorded rules, then CONFIG.
  // Within each group, newest first.
  function allRules() {
    const page = currentPage();
    return [
      ...storedRules.filter((r) => r.page === page),
      ...storedRules.filter((r) => !r.page),
      ...site.rules,
    ];
  }

  // Selectors that automatic movement skips (F5). Explicit rules can still target them.
  // Entries: { sel, page? , unignore? }. A page entry overrides site-wide ones.
  const IGNORE_KEY = 'remoteweb:ignore';
  let storedIgnore = (() => {
    try {
      const list = JSON.parse(localStorage.getItem(IGNORE_KEY)) || [];
      return list.map((e) => (typeof e === 'string' ? { sel: e } : e)); // older format: plain selectors
    } catch { return []; }
  })();
  function saveIgnore() {
    try { localStorage.setItem(IGNORE_KEY, JSON.stringify(storedIgnore)); return true; } catch { return false; }
  }

  function hits(el, sel) { try { return !!closestDeep(el, sel); } catch { return false; } }

  // Whether `el` is ignored, and which level decided it:
  //   1. this page's recorded entries (newest wins)   2. CONFIG autoUnignore
  //   3. whole-site recorded entries                   4. CONFIG autoIgnore
  function ignoreState(el) {
    const page = currentPage();
    const pageHits = storedIgnore.filter((e) => e.page === page && hits(el, e.sel));
    if (pageHits.length) {
      const last = pageHits[pageHits.length - 1];
      return { ignored: !last.unignore, level: 'page', entries: pageHits };
    }
    if (site.autoUnignore.some((sel) => hits(el, sel))) return { ignored: false, level: 'config' };
    const siteHits = storedIgnore.filter((e) => !e.page && hits(el, e.sel));
    if (siteHits.length) return { ignored: true, level: 'site', entries: siteHits };
    const configHits = site.autoIgnore.filter((sel) => hits(el, sel));
    if (configHits.length) return { ignored: true, level: 'config', sels: configHits };
    return { ignored: false, level: null };
  }

  function autoIgnored(el) { return ignoreState(el).ignored; }

  // --- selector generation

  // Skip class names that look machine-generated (CSS modules, styled-components…).
  function isStableClass(c) {
    if (c.startsWith('remoteweb')) return false;
    if (/^(css|sc|jsx|svelte|emotion)-/.test(c)) return false;
    if (/__[\w-]*\d/.test(c)) return false;
    if ((c.match(/\d/g) || []).length >= 3) return false;
    return /^[a-zA-Z_-][\w-]*$/.test(c);
  }
  function stableId(el) {
    return el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id) ? el.id : null;
  }
  // tag + up to two stable classes, e.g. "div.card.large"
  function kindSelector(el) {
    return el.tagName.toLowerCase() +
      [...el.classList].filter(isStableClass).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
  }
  function countDeep(sel) { try { return queryDeep(sel).length; } catch { return 0; } }

  // Selector that matches only `el`: a path up to the nearest unique id (or body),
  // with :nth-child added from the bottom up only where needed.
  function uniqueSelector(el) {
    const uniqueId = (a) => { const id = stableId(a); return id && countDeep('#' + CSS.escape(id)) === 1 ? '#' + CSS.escape(id) : null; };
    if (uniqueId(el)) return uniqueId(el);
    const chain = [];
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      chain.push(a);
      if ((a !== el && uniqueId(a)) || a === document.body) break;
    }
    const segs = chain.map((a, i) => (i > 0 && uniqueId(a)) || kindSelector(a));
    const build = () => segs.slice().reverse().join(' > ');
    if (countDeep(build()) === 1) return build();
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      if (!a.parentElement) continue;
      segs[i] += `:nth-child(${[...a.parentElement.children].indexOf(a) + 1})`;
      if (countDeep(build()) === 1) return build();
    }
    return build();
  }

  function ancestorsOf(el, max) {
    const out = [];
    for (let a = el.parentElement; a && a !== document.body && out.length < max; a = a.parentElement) {
      if (stableId(a) || [...a.classList].some(isStableClass) || /^(NAV|MAIN|ASIDE|HEADER|FOOTER|UL|OL)$/.test(a.tagName)) out.push(a);
    }
    return out;
  }

  // Options for the FROM part of a rule, from specific to general.
  function fromOptions(el) {
    const opts = [];
    const add = (sel, label) => {
      if (opts.some((o) => o.value === sel)) return;
      const n = countDeep(sel);
      if (n) opts.push({ value: sel, label: `${label}  —  ${sel}  (${n} match${n > 1 ? 'es' : ''})`, els: () => queryDeep(sel) });
    };
    add(uniqueSelector(el), 'Only this element');
    if (el.parentElement && el.parentElement !== document.body) {
      add(uniqueSelector(el.parentElement) + ' > ' + kindSelector(el), 'Any similar item in this container');
    }
    if ([...el.classList].some(isStableClass)) add(kindSelector(el), 'Any similar item on the page');
    for (const a of ancestorsOf(el, 3)) add(uniqueSelector(a), 'Anything inside');
    opts.push({ value: 'html', label: 'Anywhere on the page  (for global shortcuts)', els: () => [] });
    return opts;
  }

  // Options for where a move goes.
  function toOptions(target, matched) {
    const opts = [];
    const add = (value, label, els) => opts.push({ value, label, els });
    if (matched && target.parentElement && target.parentElement === matched.parentElement) {
      const sibs = [...matched.parentElement.children].filter(isVisible);
      const k = sibs.indexOf(target) - sibs.indexOf(matched);
      if (k) add({ sibling: k }, `${k > 0 ? 'Next' : 'Previous'} sibling (${k > 0 ? '+' : ''}${k}) of the FROM element`, () => [target]);
    }
    const exact = uniqueSelector(target);
    add(exact, `Exactly this element  —  ${exact}`, () => queryDeep(exact).filter(isVisible).slice(0, 1));
    for (const a of ancestorsOf(target, 3)) {
      if (matched && containsDeep(a, matched)) continue; // entering the container you're in makes no sense
      const sel = uniqueSelector(a);
      add(sel, `Enter container (returns to last highlighted)  —  ${sel}`, () => queryDeep(sel).slice(0, 1));
    }
    if (target.parentElement && target.parentElement !== document.body) {
      const kids = [...target.parentElement.children].filter(isVisible);
      const i = kids.indexOf(target);
      const parentSel = uniqueSelector(target.parentElement);
      if (i >= 0) add({ index: i, in: parentSel }, `Item #${i + 1} of  ${parentSel}`, () => [target]);
      if (i === kids.length - 1 && i > 0) add({ index: -1, in: parentSel }, `Last item of  ${parentSel}`, () => [target]);
    }
    return opts;
  }

  function clickOptions(target) {
    const opts = [];
    const exact = uniqueSelector(target);
    opts.push({ value: exact, label: `Exactly this element  —  ${exact}`, els: () => queryDeep(exact).filter(isVisible).slice(0, 1) });
    const kind = kindSelector(target);
    if (kind !== exact && [...target.classList].some(isStableClass)) {
      opts.push({ value: kind, label: `First visible  ${kind}`, els: () => queryDeep(kind).filter(isVisible).slice(0, 1) });
    }
    return opts;
  }

  // --- UI

  let rec = null; // recording state
  let panel = null, previewLayer = null, toastTimer = 0;

  function uiBox(css, z = 2147483647) {
    const el = document.createElement('div');
    el.setAttribute('data-remoteweb-ui', '');
    el.style.cssText = `position:fixed;z-index:${z};font:20px/1.4 system-ui,sans-serif;` + css;
    document.documentElement.appendChild(el);
    return el;
  }

  function drawPreview(els) {
    if (!previewLayer) previewLayer = uiBox('inset:0;pointer-events:none;', 2147483646); // below the panel
    previewLayer.replaceChildren(...els.slice(0, 200).map((el) => {
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
        'border:3px dashed #ffb43d;background:#ffb43d22;box-sizing:border-box;';
      return b;
    }));
  }

  function renderPanel() {
    if (!panel) panel = uiBox('left:50%;bottom:24px;transform:translateX(-50%);width:min(900px,92vw);' +
      'background:#141414;color:#fff;border:2px solid #ffb43d;border-radius:12px;padding:16px 20px;box-shadow:0 8px 40px #000a;');
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;color:#ffb43d;margin-bottom:6px;';
    title.textContent = `● ${rec.heading || 'Recording rule'} — ${rec.title}`;
    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:.85;margin-bottom:8px;';
    hint.textContent = rec.hint;
    const children = [title, hint];
    if (rec.options) {
      rec.options.forEach((o, i) => {
        const row = document.createElement('div');
        row.dataset.i = i;
        row.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;word-break:break-all;' +
          (i === rec.index ? 'background:#ffb43d;color:#000;' : '');
        row.textContent = o.label;
        children.push(row);
      });
      drawPreview(rec.options[rec.index].els());
    } else if (previewLayer) {
      previewLayer.replaceChildren();
    }
    const foot = document.createElement('div');
    foot.style.cssText = 'opacity:.6;font-size:15px;margin-top:8px;';
    foot.textContent = /^(ignoreSel|unignoreScope)$/.test(rec.step) ? '↑↓ choose · OK confirm · Back or F5 cancel'
      : rec.step === 'ignoreScope' ? '↑↓ choose · OK confirm · Back previous step · F5 cancel'
      : rec.options ? '↑↓ choose · OK confirm · Back previous step · F4 cancel'
      : rec.step === 'key' || rec.step === 'sendKey' ? 'F4 cancel' : 'OK or mouse click to pick · Back previous step · F4 cancel';
    children.push(foot);
    panel.replaceChildren(...children);
  }

  function toast(text, ms = 5000) {
    const t = uiBox('left:50%;top:24px;transform:translateX(-50%);max-width:90vw;background:#141414;color:#fff;' +
      'border:2px solid #3ddc84;border-radius:12px;padding:12px 18px;white-space:pre-wrap;font-size:16px;font-family:monospace;');
    t.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
  }

  // --- steps

  const STEPS = {
    ignoreSel: { title: 'F5', hint: 'Which elements should arrow-key movement skip? (Rules can still move to them.)' },
    ignoreScope: { title: 'F5', hint: 'Where should they be skipped?' },
    unignoreScope: { title: 'F5', hint: 'This element is ignored on the whole site. Un-ignore it where?' },
    scope:   { title: 'save', hint: 'Where should this rule apply? Rules for this page are checked before whole-site rules.' },
    from:    { title: 'step 1/5', hint: 'Highlight the element the rule starts FROM, then press OK (or click it).' },
    fromSel: { title: 'step 2/5', hint: 'Which elements should this rule apply to?' },
    key:     { title: 'step 3/5', hint: 'Press the key this rule is for: an arrow, OK, Back, or any other key (letters, media keys, remote buttons, Ctrl+…).' },
    what:    { title: 'step 4/5', hint: 'What should that key do?' },
    sendKey: { title: 'step 5/5', hint: 'Press the key to send to the page (e.g. K to pause on YouTube). Ctrl/Alt/Shift combinations work too.' },
    target:  { title: 'step 5/5', hint: 'Highlight the TARGET element, then press OK (or click it with the mouse).' },
    toSel:   { title: 'step 5/5', hint: 'How should the target be found?' },
  };
  const PREV = { sendKey: 'what', fromSel: 'from', key: 'fromSel', what: 'key', target: 'what', toSel: 'target' };

  function goto(step, options = null) {
    if (step === 'what') STEPS.what.hint = `What should “${rec.key}” do?`;
    // Scope steps can follow different steps; remember where to go back to.
    if (/scope$/i.test(step) && rec.step && !/scope$/i.test(rec.step)) rec.prev = { step: rec.step, options: rec.options, index: rec.index };
    Object.assign(rec, STEPS[step], { step, options, index: 0 });
    renderPanel();
  }

  function startRecording() {
    if (editing) endEdit();
    rec = {};
    goto('from');
  }

  function stopRecording(message) {
    rec = null;
    if (panel) { panel.remove(); panel = null; }
    if (previewLayer) { previewLayer.remove(); previewLayer = null; }
    if (message) toast(message, 2500);
  }

  function back() {
    if (/scope$/i.test(rec.step) && rec.prev) {
      const { step, options, index } = rec.prev;
      rec.prev = null;
      Object.assign(rec, STEPS[step], { step, options, index });
      return renderPanel();
    }
    if (!PREV[rec.step]) return stopRecording('Cancelled');
    const step = PREV[rec.step];
    if (step === 'fromSel') goto(step, fromOptions(rec.source));
    else if (step === 'what') goto(step, whatOptions());
    else if (step === 'target') goto(step);
    else goto(step);
  }

  function whatOptions() {
    const els = () => [];
    return [
      { value: 'move', label: 'Move the highlight to another element', els },
      { value: 'click', label: 'Click an element', els },
      { value: 'send', label: 'Send a different key to the page (use the site’s own shortcuts)', els },
      { value: 'none', label: 'Block (do nothing)', els },
      { value: 'pass', label: 'Let the page handle the key', els },
      { value: 'default', label: 'Normal arrow movement (switches off other rules for this key)', els },
    ].filter((o) => o.value !== 'default' || DPAD.includes(rec.key));
  }

  function scopeOptions(siteLabel, pageLabel) {
    const els = () => [];
    return [
      { value: 'site', label: `${siteLabel}  —  every page of ${location.host || 'local files'}`, els },
      { value: 'page', label: `${pageLabel}  —  ${currentPage()}`, els },
    ];
  }

  function pick(el) {
    if (!el) return;
    if (rec.step === 'from') {
      rec.source = el;
      goto('fromSel', fromOptions(el));
    } else if (rec.step === 'target') {
      rec.target = el;
      goto('toSel', rec.what === 'click' ? clickOptions(el) : toOptions(el, rec.matched));
    }
  }

  // F5: ignore the highlighted element, or un-ignore it if it already is.
  function toggleIgnore() {
    const el = getCurrent();
    if (!el) return toast('Nothing highlighted', 2000);
    if (el !== current) setFocus(el);
    const st = ignoreState(el);
    const page = currentPage();
    const done = (msg) => { saveIgnore(); if (debugOn) drawDebug(); toast(msg, 3000); };

    if (st.level === 'page') {
      // Remove this page's entries: either un-ignores, or restores the site-wide ignore.
      storedIgnore = storedIgnore.filter((e) => !st.entries.includes(e));
      const now = ignoreState(el).ignored;
      return done(now ? '✔ Ignored again on this page (site-wide entry applies)' : '✔ No longer ignored on this page');
    }
    if (st.level === 'config' && !st.ignored) {
      return toast('Un-ignored here by CONFIG (autoUnignore); change it there.', 3500);
    }
    if (st.level === 'config') {
      for (const sel of st.sels) storedIgnore.push({ sel, page, unignore: true });
      return done('✔ Un-ignored on this page\n(it is ignored site-wide in CONFIG)');
    }
    rec = { heading: 'Ignore for auto-move', source: el };
    if (st.level === 'site') {
      rec.siteEntries = st.entries;
      return goto('unignoreScope', scopeOptions('Un-ignore everywhere', 'Un-ignore on this page only'));
    }
    goto('ignoreSel', fromOptions(el));
  }

  function choose(i) {
    const value = rec.options[i].value;
    if (rec.step === 'ignoreSel') {
      rec.ignoreSel = value;
      return goto('ignoreScope', scopeOptions('Whole site', 'This page only'));
    }
    if (rec.step === 'ignoreScope') {
      const entry = value === 'page' ? { sel: rec.ignoreSel, page: currentPage() } : { sel: rec.ignoreSel };
      storedIgnore.push(entry);
      const ok = saveIgnore();
      stopRecording();
      if (debugOn) drawDebug();
      toast((ok ? '✔ Ignored by auto-move' : '⚠ Could not save (storage blocked); active until reload') +
        ` (${value === 'page' ? 'this page' : 'whole site'}): ${entry.sel}\nPress F5 on it again to undo.`, 3500);
      return;
    }
    if (rec.step === 'unignoreScope') {
      const entries = rec.siteEntries;
      if (value === 'page') {
        for (const e of entries) storedIgnore.push({ sel: e.sel, page: currentPage(), unignore: true });
      } else {
        storedIgnore = storedIgnore.filter((e) => !entries.includes(e));
      }
      saveIgnore();
      stopRecording();
      if (debugOn) drawDebug();
      toast(value === 'page' ? '✔ Un-ignored on this page only' : '✔ No longer ignored anywhere', 3000);
      return;
    }
    if (rec.step === 'scope') {
      const rule = rec.pending;
      if (value === 'page') rule.page = currentPage();
      storedRules.unshift(rule); // newest first, so it wins over older rules
      const ok = saveStored();
      stopRecording();
      toast((ok ? `✔ Rule saved for ${value === 'page' ? 'this page' : 'the whole site'}\n`
        : '⚠ Could not save (storage blocked); active until reload\n') + JSON.stringify(rule, null, 2));
      return;
    }
    if (rec.step === 'fromSel') {
      rec.fromSel = value;
      rec.matched = closestDeep(rec.source, value);
      goto('key');
    } else if (rec.step === 'what') {
      rec.what = value;
      if (value === 'none') save({ to: 'none' });
      else if (value === 'pass') save({ action: 'pass' });
      else if (value === 'default') save({ action: 'default' });
      else if (value === 'send') goto('sendKey');
      else {
        // Start target picking from the source, so arrows navigate from there.
        if (rec.source.isConnected) setFocus(rec.source);
        goto('target');
      }
    } else if (rec.step === 'toSel') {
      save(rec.what === 'click' ? { action: 'click', target: value } : { to: value });
    }
  }

  // Last step: ask whether the rule is for the whole site or this page.
  function save(part) {
    rec.pending = { from: rec.fromSel, key: rec.key, ...part };
    goto('scope', scopeOptions('Whole site', 'This page only'));
  }

  // Returns true if the recorder consumed the key.
  function recorderKey(action, e, combo) {
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); return true; };
    if (rec.step === 'key') {
      rec.key = DPAD.includes(action) ? action : combo;
      goto('what', whatOptions());
      return stop();
    }
    if (rec.step === 'sendKey') {
      save({ send: combo }); // the real key, even if it's an arrow or Enter
      return stop();
    }
    if (!action) return stop(); // other keys do nothing while the panel is open
    if (rec.options) {
      if (action === 'up' || action === 'down') {
        const n = rec.options.length;
        rec.index = (rec.index + (action === 'down' ? 1 : n - 1)) % n;
        renderPanel();
      } else if (action === 'ok') choose(rec.index);
      else if (action === 'back') back();
      return stop();
    }
    // Picking steps: arrows navigate normally, OK picks, Back goes back.
    if (action === 'ok') { pick(getCurrent()); return stop(); }
    if (action === 'back') { back(); return stop(); }
    return false;
  }

  // Mouse: during picking, a click selects instead of activating the page.
  function onPointer(e) {
    if (!rec) return;
    const path = e.composedPath();
    const inPanel = path.some((n) => n instanceof Element && n.hasAttribute('data-remoteweb-ui'));
    if (inPanel) {
      if (e.type === 'click') {
        const row = path.find((n) => n instanceof Element && n.dataset && n.dataset.i !== undefined);
        if (row && rec.options) { rec.index = +row.dataset.i; choose(rec.index); }
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (rec.step !== 'from' && rec.step !== 'target') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const usable = path.find((n) => n instanceof Element && matchKind(n));
    const el = usable || path[0];
    if (el instanceof Element) { setFocus(el); pick(el); }
  }

  // Prints recorded rules and ignores as CONFIG.sites entries: one for the whole site,
  // one per page.
  function exportRules() {
    const pages = [...new Set([...storedRules, ...storedIgnore].map((x) => x.page).filter(Boolean))];
    const entryFor = (page) => {
      const e = {
        match: location.origin + (page ? page + '*' : '/*'),
        rules: storedRules.filter((r) => r.page === page).map(({ page: _, ...r }) => r),
      };
      const ign = storedIgnore.filter((x) => x.page === page);
      if (ign.some((x) => !x.unignore)) e.autoIgnore = ign.filter((x) => !x.unignore).map((x) => x.sel);
      if (ign.some((x) => x.unignore)) e.autoUnignore = ign.filter((x) => x.unignore).map((x) => x.sel);
      const on = page ? enabledStore.pages[page] : enabledStore.site;
      if (on !== undefined) e.enabled = on;
      if (!page) Object.assign(e, storedOptions);
      return e;
    };
    const pagesAll = [...new Set([...pages, ...Object.keys(enabledStore.pages)])];
    const entries = [...pagesAll.map(entryFor), entryFor(undefined)]
      .filter((e) => Object.keys(e).length > 2 || e.rules.length);
    const text = JSON.stringify(entries, null, 2);
    console.log('Paste these into CONFIG.sites, then run __remoteweb.clearAll():\n' + text);
    return text;
  }

  // ---------------------------------------------------------------- settings

  let settingsHost = null, settingsRoot = null, settingsIndex = 0;

  const OPTION_LABELS = [
    ['useSiteFocus', 'Use the site’s own focus style when it has one'],
    ['acceptBrowserRing', 'Count the browser’s thin focus ring as the site’s style'],
    ['pointerCursor', 'Treat hand-cursor elements as clickable'],
    ['allowTransparent', 'Allow hover-only (invisible) buttons'],
    ['hoverEvents', 'Send hover events to the highlighted element'],
    ['containerFirst', 'Stay inside lists and carousels while possible'],
    ['realFocus', 'Give real focus to highlighted buttons and links'],
    ['shadowDom', 'Search inside web components (shadow DOM)'],
    ['smoothScroll', 'Smooth scrolling'],
  ];

  // Tiny DOM builder; text is always set as text, never parsed as HTML.
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'onclick') e.addEventListener('click', v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) e.append(k);
    return e;
  }

  function describeKey(key) {
    const names = { up: '↑', down: '↓', left: '←', right: '→', ok: 'OK', back: 'Back' };
    return [].concat(key).map((k) => names[k] || k).join(' / ');
  }

  function describeRule(r) {
    const from = !r.from || r.from === 'html' ? 'anywhere' : r.from;
    let what;
    if (r.send) what = 'send ' + [].concat(r.send).join(', ');
    else if (r.to === 'none') what = 'block';
    else if (r.action === 'pass') what = 'let the page handle it';
    else if (r.action === 'default') what = 'normal arrow movement';
    else if (r.action === 'click') what = 'click ' + (r.target || 'it');
    else if (r.action === 'back') what = 'browser back';
    else if (typeof r.action === 'function' || typeof r.to === 'function') what = 'custom code';
    else if (typeof r.to === 'string') what = 'go to ' + r.to;
    else if (r.to && typeof r.to.sibling === 'number') what = `${r.to.sibling > 0 ? 'next' : 'previous'} sibling (${r.to.sibling > 0 ? '+' : ''}${r.to.sibling})`;
    else if (r.to && typeof r.to.index === 'number') what = `${r.to.index < 0 ? 'last item' : 'item #' + (r.to.index + 1)} of ${r.to.in}`;
    else what = '?';
    return `${describeKey(r.key)}   on ${from}   →  ${what}`;
  }

  function describeIgnore(x) {
    return `${x.unignore ? 'un-ignore' : 'skip'}  ${x.sel}`;
  }

  const SETTINGS_CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: #000a; display: flex; align-items: center; justify-content: center;
      font: 18px/1.4 system-ui, sans-serif; color: #eee; }
    .dlg { background: #141414; width: min(920px, 94vw); max-height: 88vh; overflow: auto; box-sizing: border-box;
      border: 2px solid #3d9eff; border-radius: 12px; padding: 20px 24px; box-shadow: 0 10px 50px #000c; }
    h2 { margin: 0; font-size: 24px; color: #3d9eff; }
    h3 { margin: 20px 0 6px; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #999; font-weight: 600; }
    .sub { opacity: .7; margin: 2px 0 12px; word-break: break-all; font-size: 15px; }
    .status { font-weight: 600; margin-bottom: 8px; }
    .status.on { color: #3ddc84; } .status.off { color: #ff8a8a; }
    .row { display: flex; gap: 12px; align-items: center; padding: 5px 0; border-bottom: 1px solid #262626; }
    .txt { flex: 1; font: 15px/1.4 ui-monospace, monospace; word-break: break-all; white-space: pre-wrap; }
    .where { color: #ffb43d; }
    .empty { opacity: .45; margin: 2px 0; font-size: 15px; }
    .btns { display: flex; gap: 10px; flex-wrap: wrap; }
    button { font: inherit; font-size: 16px; background: #262626; color: #eee; border: 1px solid #444; border-radius: 6px;
      padding: 7px 14px; cursor: pointer; text-align: left; }
    button.sel { outline: 3px solid #3d9eff; outline-offset: 2px; background: #2f4258; }
    button.del { color: #ff9a9a; flex: none; }
    .opts button { display: block; width: 100%; margin: 5px 0; }
    .changed { color: #ffb43d; font-size: 14px; }
    .foot { margin-top: 16px; opacity: .55; font-size: 14px; }
  `;

  function applyEnabledChange() {
    if (isEnabled()) return;
    if (editing) endEdit();
    if (current) current.classList.remove(FOCUS_CLASS, CURRENT_CLASS);
    current = null;
    if (debugOn) toggleDebug();
  }

  function renderSettings() {
    const page = currentPage();
    const host = location.host || 'local files';
    const siteOn = enabledStore.site !== undefined ? enabledStore.site : !!site.configOpt('enabled');
    const pageState = enabledStore.pages[page];
    const on = isEnabled();
    const rerender = () => renderSettings();

    const delRule = (r) => () => { storedRules = storedRules.filter((x) => x !== r); saveStored(); rerender(); };
    const delIgnore = (x) => () => { storedIgnore = storedIgnore.filter((y) => y !== x); saveIgnore(); if (debugOn) drawDebug(); rerender(); };
    const row = (text, onDelete, where) => h('div', { class: 'row' },
      h('span', { class: 'txt' }, where ? h('span', { class: 'where' }, where + '   ') : null, text),
      onDelete ? h('button', { class: 'del', onclick: onDelete }, 'Delete') : null);
    const section = (title, rows) => [h('h3', {}, title), rows.length ? rows : h('p', { class: 'empty' }, 'none')];

    const pageRules = storedRules.filter((r) => r.page === page);
    const siteRules = storedRules.filter((r) => !r.page);
    const otherRules = storedRules.filter((r) => r.page && r.page !== page);
    const pageIgnores = storedIgnore.filter((x) => x.page === page);
    const siteIgnores = storedIgnore.filter((x) => !x.page);
    const otherIgnores = storedIgnore.filter((x) => x.page && x.page !== page);

    const optionButtons = OPTION_LABELS.map(([name, label]) => {
      const value = !!site.opt(name);
      const changed = name in storedOptions;
      return h('button', { onclick: () => {
        storedOptions[name] = !value;
        if (storedOptions[name] === !!site.configOpt(name)) delete storedOptions[name];
        saveOptions(); rerender();
      } }, `${value ? '✅' : '⬜'}  ${label}`, changed ? h('span', { class: 'changed' }, '   (changed for this site)') : null);
    });
    const backValue = site.opt('backDefault');
    optionButtons.push(h('button', { onclick: () => {
      storedOptions.backDefault = backValue === 'pass' ? 'history' : 'pass';
      if (storedOptions.backDefault === site.configOpt('backDefault')) delete storedOptions.backDefault;
      saveOptions(); rerender();
    } }, `Back with no rule:  ${backValue === 'pass' ? 'let the page handle it' : 'browser back'}`,
      'backDefault' in storedOptions ? h('span', { class: 'changed' }, '   (changed for this site)') : null));

    const dlg = h('div', { class: 'dlg' },
      h('h2', {}, 'RemoteWEB settings'),
      h('div', { class: 'sub' }, `${host}  ·  ${page}`),
      h('div', { class: 'status ' + (on ? 'on' : 'off') }, on ? '● Active on this page' : '○ Off on this page'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => { enabledStore.site = !siteOn; saveEnabled(); applyEnabledChange(); rerender(); } },
          `Whole site: ${siteOn ? 'ON' : 'OFF'}`),
        h('button', { onclick: () => {
          // same as site -> ON -> OFF -> same as site
          if (pageState === undefined) enabledStore.pages[page] = true;
          else if (pageState === true) enabledStore.pages[page] = false;
          else delete enabledStore.pages[page];
          saveEnabled(); applyEnabledChange(); rerender();
        } }, `This page: ${pageState === undefined ? 'same as site' : pageState ? 'ON' : 'OFF'}`)),
      section('Rules for this page (checked first)', pageRules.map((r) => row(describeRule(r), delRule(r)))),
      section('Rules for the whole site', siteRules.map((r) => row(describeRule(r), delRule(r)))),
      section('Rules for other pages of this site', otherRules.map((r) => row(describeRule(r), delRule(r), r.page))),
      section('Ignored by arrow movement (F5)', [
        ...pageIgnores.map((x) => row(describeIgnore(x), delIgnore(x), 'this page')),
        ...siteIgnores.map((x) => row(describeIgnore(x), delIgnore(x), 'whole site')),
        ...otherIgnores.map((x) => row(describeIgnore(x), delIgnore(x), x.page)),
      ]),
      section('From CONFIG (read-only: edit the script to change)', [
        ...site.rules.map((r) => row(describeRule(r))),
        ...site.autoIgnore.map((sel) => row('skip  ' + sel)),
        ...site.autoUnignore.map((sel) => row('un-ignore  ' + sel)),
      ]),
      h('h3', {}, 'Options for this site'),
      h('div', { class: 'opts' }, optionButtons,
        Object.keys(storedOptions).length ? h('button', { onclick: () => { storedOptions = {}; saveOptions(); rerender(); } }, 'Reset options to defaults') : null),
      h('h3', {}, ''),
      h('div', { class: 'btns' },
        h('button', { onclick: () => {
          const text = exportRules();
          const done = (ok) => toast(ok ? '✔ Copied. Paste it into CONFIG.sites in the script.' : 'Could not copy; the text is in the browser console.', 3500);
          try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch { done(false); }
        } }, 'Copy as CONFIG (for the script file)'),
        h('button', { onclick: closeSettings }, 'Close')),
      h('div', { class: 'foot' }, '↑↓ move  ·  OK select  ·  Back close  ·  Ctrl+Shift+F8 close'));

    const backdrop = h('div', { class: 'backdrop' }, dlg);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSettings(); });
    const scrollTop = settingsRoot.querySelector('.dlg') ? settingsRoot.querySelector('.dlg').scrollTop : 0;
    settingsRoot.replaceChildren(h('style', {}, SETTINGS_CSS), backdrop);
    dlg.scrollTop = scrollTop;
    // Mouse clicks move the keyboard selection too.
    for (const [i, b] of [...settingsRoot.querySelectorAll('button')].entries()) {
      b.addEventListener('mousedown', () => { settingsIndex = i; });
    }
    markSelected();
  }

  function markSelected() {
    const controls = [...settingsRoot.querySelectorAll('button')];
    settingsIndex = Math.max(0, Math.min(settingsIndex, controls.length - 1));
    controls.forEach((b, i) => b.classList.toggle('sel', i === settingsIndex));
    if (controls[settingsIndex]) controls[settingsIndex].scrollIntoView({ block: 'nearest' });
  }

  function openSettings() {
    if (rec) stopRecording();
    if (editing) endEdit();
    settingsHost = document.createElement('div');
    settingsHost.setAttribute('data-remoteweb-ui', '');
    settingsHost.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
    settingsRoot = settingsHost.attachShadow({ mode: 'open' });
    // Keep clicks inside the dialog from reaching the page's own handlers.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      settingsHost.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(settingsHost);
    settingsIndex = 0;
    renderSettings();
  }

  function closeSettings() {
    if (settingsHost) settingsHost.remove();
    settingsHost = settingsRoot = null;
  }

  function settingsKey(action, e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const controls = [...settingsRoot.querySelectorAll('button')];
    if (action === 'up' || action === 'left') settingsIndex--;
    else if (action === 'down' || action === 'right') settingsIndex++;
    else if (action === 'ok') { if (controls[settingsIndex]) controls[settingsIndex].click(); return; }
    else if (action === 'back') { closeSettings(); return; }
    else return;
    markSelected();
  }

  // ------------------------------------------------------------------ input

  // A key that isn't a d-pad action: only rules can use it, otherwise the page gets it.
  function rawKey(e, combo) {
    if (rec) return;
    const active = deepActiveElement();
    if (editing || isEditable(active)) return; // typing
    if (current && !isVisible(current)) current = null;
    const result = applyRules(null, combo);
    if (result === null || result === 'pass') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (result instanceof Element) setFocus(result);
  }

  function onKeyDown(e) {
    if (sending) return;
    refreshSite();
    if (MODIFIER_KEYS.includes(e.key)) return;
    const combo = keyCombo(e);
    const action = actionFor(e, combo);
    if (action === 'settings') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (settingsHost) closeSettings(); else openSettings();
      return;
    }
    if (settingsHost) return settingsKey(action, e);
    if (!isEnabled()) return;
    if (rec && (rec.step === 'key' || rec.step === 'sendKey') && action !== 'record' && action !== 'ignore') {
      recorderKey(action, e, combo);
      return;
    }
    if (!action) return rawKey(e, combo);
    if (action === 'record') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (rec) stopRecording('Recording cancelled'); else startRecording();
      return;
    }
    if (action === 'ignore') {
      e.preventDefault(); // F5 would otherwise reload the page
      e.stopImmediatePropagation();
      if (rec) stopRecording('Cancelled'); else toggleIgnore();
      return;
    }
    if (rec && recorderKey(action, e)) return;
    if (action === 'debug') {
      e.preventDefault();
      toggleDebug();
      return;
    }

    if (editing) {
      if (!editing.isConnected || deepActiveElement() !== editing) {
        editing = null; // page moved focus away
      } else {
        const singleLine = editing.tagName === 'INPUT';
        const leave = action === 'back' || (singleLine && (action === 'up' || action === 'down'));
        if (!leave) return; // typing, cursor movement, Enter to submit: all go to the page
        e.preventDefault();
        e.stopImmediatePropagation();
        endEdit();
        if (action === 'back') return;
      }
    }

    const cur = getCurrent();
    if (!cur) {
      if (action !== 'ok' && action !== 'back') { e.preventDefault(); scrollFallback(action); }
      return;
    }
    if (cur !== current) {
      // First press, or recovering after a re-render: just show the highlight.
      setFocus(cur);
      if (action !== 'back') { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }

    const result = applyRules(action);
    if (result === 'pass') return;
    if (result === null && action === 'back' && site.opt('backDefault') === 'pass') return;

    e.preventDefault();
    e.stopImmediatePropagation();
    if (result === 'none' || result === 'handled') return;
    if (result instanceof Element) { setFocus(result); return; }

    if (action === 'ok') return activate(current);
    if (action === 'back') return history.back();
    const dest = spatial(action);
    if (dest) setFocus(dest);
    else scrollFallback(action);
  }

  // Keep the highlight in sync when the page or the mouse moves focus.
  function onFocusIn(e) {
    if (!isEnabled() || settingsHost) return;
    const el = e.composedPath()[0];
    if (el === current || !(el instanceof Element) || !matchKind(el)) return;
    if (isEditable(el)) return; // don't treat page-driven input focus as a highlight move
    // The page (or mouse) moved focus: we never saw the unfocused look, so we
    // can't tell if the site styles it. Show our ring to be safe.
    if (current) current.classList.remove(FOCUS_CLASS, CURRENT_CLASS);
    current = el;
    ensureStyle(el);
    el.classList.add(CURRENT_CLASS);
    showRing(el, true);
    lastRect = el.getBoundingClientRect();
  }

  // ------------------------------------------------------------------- init

  ensureStyle(document.documentElement);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('scroll', scheduleDebug, true);
  window.addEventListener('resize', scheduleDebug);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, onPointer, true);
  }

  // Small API for debugging from the console or an Electron injector.
  window.__remoteweb = {
    config: CONFIG,
    get current() { return current; },
    get editing() { return editing; },
    focus: setFocus,
    spatial,
    candidates: () => allCandidates(),
    why,
    toggleDebug,
    record: startRecording,
    get recording() { return rec && { step: rec.step, options: rec.options && rec.options.map((o) => o.label), index: rec.index }; },
    rules: () => storedRules,
    exportRules,
    removeRule(i) { storedRules.splice(i, 1); saveStored(); return storedRules; },
    clearRules() { storedRules = []; saveStored(); },
    ignored: () => storedIgnore,
    unignore(i) { storedIgnore.splice(i, 1); saveIgnore(); return storedIgnore; },
    clearIgnored() { storedIgnore = []; saveIgnore(); },
    // Everything recorded for this site: rules, ignores, on/off state, options.
    clearAll() {
      storedRules = []; saveStored(); storedIgnore = []; saveIgnore();
      enabledStore = { pages: {} }; saveEnabled(); storedOptions = {}; saveOptions();
      applyEnabledChange();
    },
    isEnabled,
    settings: () => (settingsHost ? closeSettings() : openSettings()),
    get settingsRoot() { return settingsRoot; },
  };
})();
