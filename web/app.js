/* Arena Touch — control Resolume Arena/Avenue from a phone or tablet.
 * Talks to Resolume's WebSocket API (/api/v1) through the relay server, using the
 * same protocol as Resolume's own example app:
 *   {action:"subscribe"|"unsubscribe"|"get", parameter:"/parameter/by-id/<id>"}
 *   {action:"set", parameter:"/parameter/by-id/<id>", value}
 *   {action:"trigger", parameter:"/composition/.../connect", value:true|false}
 * Resolume pushes the full composition on connect and on structural changes,
 * and "parameter_update" messages for anything we subscribe to.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ utils
  const $ = (s, r = document) => r.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('arenatouch.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('arenatouch.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pname = (p, i, fallback) => {
    const n = (p && p.value) || fallback;
    return n.includes('#') ? n.replace('#', i) : n;
  };

  const CFG = window.ARENA_TOUCH_CONFIG || {};
  const colourOf = p => {
    if (!p) return null;
    const v = (S.params.get(p.id) || p).value;
    return (CFG.colours || {})[String(v)] || null;
  };
  const tint = (el, c) => { if (c) el.style.setProperty('--cc', c); else el.style.removeProperty('--cc'); el.classList.toggle('tinted', !!c); };

  // ------------------------------------------------------------------ state
  const S = {
    ws: null, open: false, comp: null, compAt: 0,
    params: new Map(),          // id -> param object (value, options, min, max…)
    binds: { top: new Map(), grid: new Map(), mixer: new Map(), fx: new Map(), pos: new Map(), clip: new Map(), sel: new Map() },
    selClip: null,
    colsPerPage: store.get('colsPerPage', (window.ARENA_TOUCH_CONFIG || {}).columnsPerPage ?? 8),
    colPage: 0,
    subs: new Set(),
    dragging: new Set(),
    view: store.get('view', 'clips'),
    panel: store.get('panel', 'mixer'),
    fxTarget: store.get('fxTarget', 'comp'),
    fxOpen: new Set(store.get('fxOpen', [])),
    tile: store.get('tile', window.innerWidth < 640 ? 104 : 132),
    locked: false,
    retry: 500,
  };

  // ------------------------------------------------------------------ websocket
  function connect() {
    if (S.ws && S.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = new URLSearchParams(location.search).get('ws') || `${proto}://${location.host}/api/v1`;
    let ws;
    try { ws = new WebSocket(url); } catch { return scheduleReconnect(); }
    S.ws = ws;
    ws.onopen = () => { S.open = true; S.retry = 500; S.subs.clear(); setOnline(true); Preview.start(); };
    ws.onclose = () => { if (S.ws === ws) { S.open = false; setOnline(false); scheduleReconnect(); } };
    ws.onerror = () => { try { ws.close(); } catch { } };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  }
  function scheduleReconnect() {
    setTimeout(connect, S.retry);
    S.retry = Math.min(S.retry * 2, 4000);
  }
  function send(msg) { if (S.open) S.ws.send(JSON.stringify(msg)); }
  const byId = (id) => `/parameter/by-id/${id}`;
  function setParam(id, value) {
    const p = S.params.get(id);
    if (p && typeof p.value === typeof value) p.value = value; // keep choice params as their option text
    send({ action: 'set', parameter: byId(id), value });
  }
  function trigger(path, value) {
    send(value === undefined ? { action: 'trigger', parameter: path } : { action: 'trigger', parameter: path, value });
  }
  function pulse(id) { setParam(id, true); setTimeout(() => setParam(id, false), 60); }

  function onMessage(m) {
    if (typeof m.type !== 'string') {
      if (m.layers && m.columns) onComposition(m);
      return;
    }
    switch (m.type) {
      case 'parameter_update': case 'parameter_subscribed': case 'parameter_set': case 'parameter_get':
        if (typeof m.id === 'number') onParam(m);
        break;
      case 'thumbnail_update':
        if (m.value && m.value.id) updateThumb(m.value);
        break;
    }
  }

  // ------------------------------------------------------------------ param store
  function indexParams(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(indexParams); return; }
    if (typeof node.id === 'number' && typeof node.valuetype === 'string') S.params.set(node.id, node);
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') indexParams(v); }
  }
  function onParam(m) {
    let p = S.params.get(m.id);
    if (!p) { p = {}; S.params.set(m.id, p); }
    Object.assign(p, m);
    if (S.dragging.has(m.id)) return;
    for (const group of Object.values(S.binds)) {
      const fns = group.get(m.id); if (fns) for (const fn of fns) fn(p);
    }
  }
  function bind(group, param, fn) {
    if (!param || typeof param.id !== 'number') return;
    const g = S.binds[group];
    if (!g.has(param.id)) g.set(param.id, new Set());
    g.get(param.id).add(fn);
    fn(S.params.get(param.id) || param);
  }
  let subTimer = 0;
  const syncSubsSoon = () => { if (!subTimer) subTimer = setTimeout(() => { subTimer = 0; syncSubs(); }, 30); };
  function syncSubs() {
    if (!S.open) return;
    const want = new Set();
    for (const g of Object.values(S.binds)) for (const id of g.keys()) want.add(id);
    for (const id of S.subs) if (!want.has(id)) send({ action: 'unsubscribe', parameter: byId(id) });
    for (const id of want) if (!S.subs.has(id)) send({ action: 'subscribe', parameter: byId(id) });
    S.subs = want;
  }

  // ------------------------------------------------------------------ composition
  let pendingDeck = null, deckTimer = 0;
  function onComposition(comp) {
    S.comp = comp; S.compAt = Date.now();
    S.params.clear(); indexParams(comp);
    pendingDeck = null; clearTimeout(deckTimer);
    renderAll();
  }
  async function refetchComposition() {
    try {
      const r = await fetch('/api/v1/composition', { cache: 'no-store' });
      if (r.ok) onComposition(await r.json());
    } catch { /* offline */ }
  }
  function layersTopDown() {
    const c = S.comp; if (!c) return [];
    const groupOf = new Map();
    (c.layergroups || []).forEach((g, gi) => (g.layers || []).forEach(l => groupOf.set(l.id, { g, gi })));
    return c.layers.map((l, i) => ({ layer: l, index: i + 1, group: groupOf.get(l.id) })).reverse();
  }

  function renderAll() {
    if (!findClip(S.selClip)) S.selClip = selectedFromComp();
    renderTop(); renderDecks(); renderGrid(); renderMixer(); renderFx(); renderClip(); watchSelection(); syncSubs();
  }

  // ------------------------------------------------------------------ top bar / tempo
  function renderTop() {
    S.binds.top.clear();
    const c = S.comp; if (!c) return;
    $('#compName').textContent = (c.name && c.name.value) || 'Composition';
    const tc = c.tempocontroller || {};
    bind('top', tc.tempo, p => {
      if (typeof p.value !== 'number') return;
      $('#bpm').textContent = p.value.toFixed(1);
      beatSetBpm(p.value);
    });
    bind('top', tc.play_state, p => { B.playing = p.value === undefined || p.value === 'Play'; });
    for (const t of blackoutTargets()) bind('top', t.param, refreshBlackout);
  }

  // ---- blackout. Zeroes the master of every layer, every group and the composition, so the wall
  // goes black whatever Advanced Output slices use as their input (a slice fed by a group or layer
  // skips the composition master). Clips keep playing. Tapping again restores the previous levels.
  const BO_KEY = 'blackout';
  function blackoutTargets() {
    const c = S.comp; if (!c) return [];
    const t = [];
    for (const l of c.layers || []) if (l.master) t.push({ key: 'l' + l.id, param: l.master, layer: true });
    for (const g of c.layergroups || []) if (g.master) t.push({ key: 'g' + g.id, param: g.master });
    if (c.master) t.push({ key: 'comp', param: c.master });
    return t;
  }
  const valueOf = p => { const q = S.params.get(p.id) || p; return typeof q.value === 'number' ? q.value : 0; };
  function isBlack() {
    const layers = blackoutTargets().filter(t => t.layer);
    return layers.length > 0 && layers.every(t => valueOf(t.param) < 0.001);
  }
  function refreshBlackout() {
    const on = isBlack();
    const b = $('#blackout');
    b.classList.toggle('on', on);
    b.textContent = on ? 'Restore' : 'Blackout';
    document.body.classList.toggle('is-black', on);
  }
  function toggleBlackout() {
    const targets = blackoutTargets(); if (!targets.length) return;
    if (!isBlack()) {
      const saved = {};
      for (const t of targets) { saved[t.key] = valueOf(t.param); setParam(t.param.id, 0); }
      store.set(BO_KEY, saved);
    } else {
      // Levels saved on this device are restored exactly; if blackout was started on another
      // tablet (or before a reload of Arena) anything we don't know comes back at full.
      const saved = store.get(BO_KEY, {}) || {};
      for (const t of targets) {
        if (valueOf(t.param) >= 0.001) continue; // someone already brought this one back up
        const v = saved[t.key];
        setParam(t.param.id, typeof v === 'number' && v > 0 ? v : 1);
      }
      store.set(BO_KEY, null);
    }
    refreshBlackout();
  }

  // ---- beat pulse. Resolume's API exposes BPM but not the beat position, so the pulse runs on a
  // local clock at the live BPM. It snaps to the beat whenever TAP is pressed and restarts the bar
  // on SYNC (resync), which is exactly what Resolume does, so the two stay aligned.
  const B = { bpm: 0, anchor: performance.now(), last: -1, playing: true };
  const beatsAt = t => (t - B.anchor) * B.bpm / 60000;
  function beatSetBpm(bpm) {
    const now = performance.now();
    const b = B.bpm ? beatsAt(now) : 0;
    B.bpm = bpm;
    B.anchor = now - b * 60000 / bpm;
  }
  function beatAlign(restartBar) {
    if (!B.bpm) return;
    const now = performance.now();
    const k = restartBar ? 0 : Math.round(beatsAt(now));
    B.anchor = now - k * 60000 / B.bpm;
    B.last = -1;
  }
  const beatDots = [...document.querySelectorAll('#beats i')];
  const bpmBox = $('#bpmBox'), tapBtn = document.querySelector('[data-tempo=tap]');
  function beatLoop() {
    requestAnimationFrame(beatLoop);
    if (!B.bpm || !B.playing || !S.open) {
      if (B.last !== -2) { beatDots.forEach(d => d.className = ''); B.last = -2; }
      return;
    }
    const b = Math.floor(beatsAt(performance.now()));
    if (b === B.last) return;
    B.last = b;
    const inBar = ((b % 4) + 4) % 4;
    beatDots.forEach((d, i) => d.className = i === inBar ? (i === 0 ? 'on one' : 'on') : '');
    bpmBox.classList.remove('pulse', 'pulse1'); tapBtn.classList.remove('beat');
    void bpmBox.offsetWidth; // restart the CSS animation
    bpmBox.classList.add(inBar === 0 ? 'pulse1' : 'pulse'); tapBtn.classList.add('beat');
  }
  requestAnimationFrame(beatLoop);
  function tempoAction(kind) {
    const tc = S.comp && S.comp.tempocontroller; if (!tc) return;
    const t = tc.tempo && S.params.get(tc.tempo.id);
    const bpm = t ? t.value : 120;
    const setBpm = v => { setParam(tc.tempo.id, clamp(v, t.min ?? 20, t.max ?? 500)); $('#bpm').textContent = clamp(v, 20, 500).toFixed(1); };
    if (kind === 'tap' && tc.tempo_tap) { pulse(tc.tempo_tap.id); beatAlign(false); }
    if (kind === 'resync' && tc.resync) { pulse(tc.resync.id); beatAlign(true); }
    if (kind === 'half') setBpm(bpm / 2);
    if (kind === 'double') setBpm(bpm * 2);
    if (kind === 'up') setBpm(Math.round(bpm) + 1);
    if (kind === 'down') setBpm(Math.round(bpm) - 1);
  }

  // ------------------------------------------------------------------ decks
  function renderDecks() {
    const nav = $('#decks'); nav.textContent = '';
    const c = S.comp; if (!c) return;
    for (const d of c.decks || []) {
      const sel = d.selected && d.selected.value;
      const b = h('button', { class: 'deck' + (sel ? ' sel' : '') + (pendingDeck === d.id ? ' pending' : '') }, (d.name && d.name.value) || 'Deck');
      b.addEventListener('click', () => {
        if (sel) return;
        pendingDeck = d.id;
        nav.querySelectorAll('.deck').forEach(x => x.classList.remove('pending'));
        b.classList.add('pending');
        trigger(`/composition/decks/by-id/${d.id}/select`);
        S.colPage = 0;
        const before = S.compAt;
        clearTimeout(deckTimer);
        deckTimer = setTimeout(() => { if (S.compAt === before) refetchComposition(); }, 1200);
      });
      nav.append(b);
      if (sel) requestAnimationFrame(() => b.scrollIntoView({ block: 'nearest', inline: 'center' }));
    }
  }

  // ------------------------------------------------------------------ clip grid
  function thumbUrl(clip, t) {
    t = t || clip.thumbnail;
    if (!t || t.is_default) return null;
    return `/api/v1/composition/clips/by-id/${clip.id}/thumbnail/${t.last_update}`;
  }
  function updateThumb(t) {
    const img = document.querySelector(`.clip[data-id="${t.id}"] img`);
    if (img) { const u = thumbUrl({ id: t.id }, t); if (u) img.src = u; }
  }
  function holdButton(el, down, up) {
    let held = false;
    el.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      held = true; el.classList.add('pressed'); down();
      try { el.setPointerCapture(e.pointerId); } catch { }
    });
    const release = () => { if (!held) return; held = false; el.classList.remove('pressed'); up && up(); };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  // Playback progress: only clips that are actually playing get their position subscribed,
  // so the tablet isn't flooded with updates for the whole grid.
  function watchPosition(pos, fill, on) {
    const g = S.binds.pos;
    if (on) {
      if (g.has(pos.id)) return;
      let raf = 0, latest = 0;
      const draw = () => { raf = 0; fill.style.transform = `scaleX(${latest})`; };
      g.set(pos.id, new Set([p => {
        const span = (p.max ?? 1) - (p.min ?? 0);
        latest = span > 0 ? clamp((p.value - (p.min ?? 0)) / span, 0, 1) : 0;
        if (!raf) raf = requestAnimationFrame(draw);
      }]));
    } else {
      if (!g.has(pos.id)) return;
      g.delete(pos.id);
      fill.style.transform = 'scaleX(0)';
    }
    syncSubsSoon();
  }

  function renderPager(total, first, count, pages) {
    const bar = $('#pager'); bar.textContent = '';
    const prev = h('button', { class: 'btn sm' }, '◀'), next = h('button', { class: 'btn sm' }, '▶');
    prev.disabled = S.colPage <= 0; next.disabled = S.colPage >= pages - 1;
    const go = d => { S.colPage += d; renderGrid(); syncSubs(); };
    prev.addEventListener('click', () => go(-1)); next.addEventListener('click', () => go(1));
    const sel = h('select', { class: 'pgsel', title: 'Columns per page' });
    for (const n of [0, 4, 6, 8, 10, 12, 16]) sel.append(h('option', { value: n }, n ? `${n} per page` : 'All columns'));
    sel.value = String(S.colsPerPage);
    sel.addEventListener('change', () => {
      const firstCol = S.colPage * (S.colsPerPage || total);
      S.colsPerPage = parseInt(sel.value, 10); store.set('colsPerPage', S.colsPerPage);
      S.colPage = S.colsPerPage ? Math.floor(firstCol / S.colsPerPage) : 0;
      renderGrid(); syncSubs();
    });
    const label = h('span', { class: 'pglabel' }, total ? `Columns ${first + 1}–${first + count} of ${total}` : 'No columns');
    const dots = h('span', { class: 'pgdots' });
    if (pages > 1 && pages <= 12) for (let i = 0; i < pages; i++) {
      const d = h('button', { class: 'pgdot' + (i === S.colPage ? ' on' : ''), title: `Page ${i + 1}` });
      d.addEventListener('click', () => { S.colPage = i; renderGrid(); syncSubs(); });
      dots.append(d);
    }
    if (pages > 1) bar.append(prev, label, next, dots); else bar.append(label);
    bar.append(sel);
  }

  function renderGrid() {
    S.binds.grid.clear(); S.binds.pos.clear();
    const grid = $('#grid'); grid.textContent = '';
    const c = S.comp; if (!c) return;
    const allCols = c.columns || [];
    const per = S.colsPerPage > 0 ? S.colsPerPage : allCols.length;
    const pages = Math.max(1, Math.ceil(allCols.length / per));
    S.colPage = clamp(S.colPage, 0, pages - 1);
    const first = S.colPage * per;
    const shown = allCols.map((col, i) => ({ col, i })).slice(first, first + per);
    renderPager(allCols.length, first, shown.length, pages);
    grid.style.setProperty('--cols', shown.length);
    document.documentElement.style.setProperty('--tile', S.tile + 'px');

    const clearAll = h('button', { class: 'btn' }, 'Clear all');
    clearAll.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/v1/composition/disconnect-all', { method: 'POST' });
        if (r.ok) return;
      } catch { /* fall back below */ }
      c.layers.forEach(l => trigger(`/composition/layers/by-id/${l.id}/clear`));
    });
    grid.append(h('div', { class: 'corner' }, clearAll));

    shown.forEach(({ col, i }) => {
      const b = h('button', null, pname(col.name, i + 1, `Column ${i + 1}`));
      holdButton(b,
        () => trigger(`/composition/columns/by-id/${col.id}/connect`, true),
        () => trigger(`/composition/columns/by-id/${col.id}/connect`, false));
      bind('grid', col.connected, p => b.classList.toggle('live', p.value === 'Connected'));
      grid.append(h('div', { class: 'colhead' }, b));
    });

    for (const { layer: l, index, group } of layersTopDown()) {
      const bypass = h('button', { class: 'mini bypass', title: 'Bypass' }, 'B');
      const solo = h('button', { class: 'mini', title: 'Solo' }, 'S');
      const clear = h('button', { class: 'mini clear', title: 'Clear layer' }, '✕');
      const bar = h('i');
      bypass.addEventListener('click', () => setParam(l.bypassed.id, !S.params.get(l.bypassed.id).value));
      solo.addEventListener('click', () => setParam(l.solo.id, !S.params.get(l.solo.id).value));
      clear.addEventListener('click', () => trigger(`/composition/layers/by-id/${l.id}/clear`));
      bind('grid', l.bypassed, p => bypass.classList.toggle('on', !!p.value));
      bind('grid', l.solo, p => solo.classList.toggle('on', !!p.value));
      bind('grid', l.master, p => { bar.style.width = (clamp(p.value, 0, 1) * 100) + '%'; });
      const head = h('div', { class: 'layhead' + (group ? ' grouped' : '') },
        h('div', { class: 'lname' }, pname(l.name, index, `Layer ${index}`)),
        group ? h('div', { class: 'lgroup' }, pname(group.g.name, group.gi + 1, 'Group')) : null,
        h('div', { class: 'row' }, bypass, solo, clear),
        h('div', { class: 'lbar' }, bar));
      bind('grid', l.colorid, () => tint(head, colourOf(l.colorid) || (group && colourOf(group.g.colorid))));
      grid.append(head);

      shown.forEach(({ i: ci }) => {
        const clip = l.clips[ci];
        if (!clip) { grid.append(h('div', { class: 'clip empty' })); return; }
        const url = thumbUrl(clip);
        const progFill = h('i');
        const tile = h('div', { class: 'clip' + (clip.id === S.selClip ? ' sel' : ''), 'data-id': clip.id },
          url ? h('img', { src: url, loading: 'lazy', alt: '', draggable: 'false' }) : null,
          clip.name && clip.name.value ? h('div', { class: 'cname' }, clip.name.value) : null,
          h('div', { class: 'ctag' }),
          h('div', { class: 'prog' }, progFill));
        tint(tile, colourOf(clip.colorid));
        const pos = clip.transport && clip.transport.position;
        bind('grid', clip.connected, p => {
          const v = p.value;
          const live = v === 'Connected' || v === 'Connected & previewing';
          tile.classList.toggle('empty', v === 'Empty');
          tile.classList.toggle('live', live);
          tile.classList.toggle('preview', v === 'Previewing');
          if (pos) watchPosition(pos, progFill, live);
        });
        holdButton(tile,
          () => {
            if (tile.classList.contains('empty')) return;
            trigger(`/composition/clips/by-id/${clip.id}/connect`, true);
            trigger(`/composition/clips/by-id/${clip.id}/select`);
            setSelectedClip(clip.id);
          },
          () => { if (!tile.classList.contains('empty')) trigger(`/composition/clips/by-id/${clip.id}/connect`, false); });
        grid.append(tile);
      });
    }
  }

  // ------------------------------------------------------------------ fader widget
  function fader(group, param, opts = {}) {
    const vertical = !!opts.vertical;
    const el = h('div', { class: 'fader ' + (vertical ? 'v' : 'h') + (opts.xf ? ' xf' : '') });
    const fill = opts.xf ? null : h('div', { class: 'fill' });
    const knob = opts.xf ? h('div', { class: 'knob' }) : null;
    const label = h('div', { class: 'val' });
    if (opts.xf) el.append(h('div', { class: 'center' }), knob); else el.append(fill);
    if (!opts.xf) el.append(label);
    const lo = () => (param.min ?? 0), hi = () => (param.max ?? 1);
    const fmt = opts.format || (v => Math.round((v - lo()) / (hi() - lo()) * 100) + '%');
    const draw = v => {
      const f = clamp((v - lo()) / (hi() - lo() || 1), 0, 1);
      if (fill) { if (vertical) fill.style.height = f * 100 + '%'; else fill.style.width = f * 100 + '%'; }
      if (knob) knob.style.left = f * 100 + '%';
      label.textContent = fmt(v);
    };
    bind(group, param, p => draw(p.value));
    let last = 0, queued = null, timer = 0;
    const push = v => {
      queued = v;
      const now = performance.now();
      if (now - last > 33) { last = now; setParam(param.id, queued); queued = null; }
      else if (!timer) timer = setTimeout(() => { timer = 0; if (queued != null) { last = performance.now(); setParam(param.id, queued); queued = null; } }, 34);
    };
    const valueAt = e => {
      const r = el.getBoundingClientRect();
      const f = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      let v = lo() + clamp(f, 0, 1) * (hi() - lo());
      if (opts.xf && Math.abs(v) < 0.03) v = 0;
      return v;
    };
    // relative drag so touching a fader never jumps the value
    let startV = 0, startPos = 0;
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      S.dragging.add(param.id);
      const cur = (S.params.get(param.id) || param).value;
      if (opts.jump) { startV = valueAt(e); push(startV); draw(startV); }
      else startV = cur;
      startPos = vertical ? e.clientY : e.clientX;
    });
    el.addEventListener('pointermove', e => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const r = el.getBoundingClientRect();
      const d = vertical ? (startPos - e.clientY) / r.height : (e.clientX - startPos) / r.width;
      let v = clamp(startV + d * (hi() - lo()), lo(), hi());
      if (opts.xf && Math.abs(v) < 0.03) v = 0;
      draw(v); push(v);
    });
    const end = () => { setTimeout(() => S.dragging.delete(param.id), 150); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => { const v = opts.reset ?? lo(); setParam(param.id, v); draw(v); });
    return el;
  }

  // ------------------------------------------------------------------ mixer
  function toggleBtn(group, param, text, cls, title) {
    const b = h('button', { class: 'mini ' + (cls || ''), title }, text);
    if (!param) { b.disabled = true; return b; }
    b.addEventListener('click', () => setParam(param.id, !(S.params.get(param.id) || param).value));
    bind(group, param, p => b.classList.toggle('on', !!p.value));
    return b;
  }
  function choiceSelect(group, param) {
    const sel = h('select');
    if (!param || !param.options) { sel.disabled = true; return sel; }
    param.options.forEach((o, i) => sel.append(h('option', { value: i }, o)));
    sel.addEventListener('change', () => setParam(param.id, parseInt(sel.value, 10)));
    bind(group, param, p => { const i = p.options ? p.options.indexOf(p.value) : p.index; if (i >= 0) sel.value = i; });
    return sel;
  }
  function xfGroup(group, param) {
    const row = h('div', { class: 'row' });
    if (!param) return row;
    const opts = param.options || ['None', 'A', 'B'];
    const bA = h('button', { class: 'mini xa' }, 'A'), bB = h('button', { class: 'mini xb' }, 'B');
    const pick = name => { const cur = (S.params.get(param.id) || param).value; const t = cur === name ? 'None' : name; setParam(param.id, opts.indexOf(t)); };
    bA.addEventListener('click', () => pick('A')); bB.addEventListener('click', () => pick('B'));
    bind(group, param, p => { bA.classList.toggle('on', p.value === 'A'); bB.classList.toggle('on', p.value === 'B'); });
    row.append(bA, bB);
    return row;
  }
  function strip(obj, title, sub, isGroup, clearPath) {
    const s = h('div', { class: 'strip' + (isGroup ? ' group' : '') },
      h('div', { class: 'sname' }, title), h('div', { class: 'sgroup' }, sub || ''));
    tint(s, colourOf(obj.colorid));
    if (obj.master) s.append(fader('mixer', obj.master, { vertical: true }));
    s.append(h('div', { class: 'row' },
      toggleBtn('mixer', obj.bypassed, 'B', 'bypass', 'Bypass'),
      toggleBtn('mixer', obj.solo, 'S', '', 'Solo')));
    s.append(xfGroup('mixer', obj.crossfadergroup));
    const blend = obj.video && obj.video.mixer && obj.video.mixer['Blend Mode'];
    if (blend) s.append(choiceSelect('mixer', blend));
    if (clearPath) {
      const c = h('button', { class: 'mini clear' }, 'Clear');
      c.addEventListener('click', () => trigger(clearPath));
      s.append(h('div', { class: 'row' }, c));
    }
    return s;
  }
  function renderMixer() {
    S.binds.mixer.clear();
    const v = $('#mixerView'); v.textContent = '';
    const c = S.comp; if (!c) return;
    v.append(Preview.build());
    const top = h('div', { class: 'sect' }, h('h3', null, 'Composition master'));
    if (c.master) top.append(fader('mixer', c.master, { jump: false }));
    v.append(top);
    if (c.crossfader && c.crossfader.phase) {
      v.append(h('div', { class: 'sect' }, h('h3', null, 'Crossfader  (double-tap to centre)'),
        h('div', { class: 'xfrow' }, h('span', { class: 'lbl', style: 'color:var(--a)' }, 'A'),
          fader('mixer', c.crossfader.phase, { xf: true, reset: 0 }),
          h('span', { class: 'lbl', style: 'color:var(--b)' }, 'B'))));
    }
    const strips = h('div', { class: 'strips' });
    (c.layergroups || []).forEach((g, gi) => strips.append(strip(g, pname(g.name, gi + 1, 'Group'), 'Group', true, null)));
    for (const { layer: l, index, group } of layersTopDown()) {
      strips.append(strip(l, pname(l.name, index, `Layer ${index}`), group ? pname(group.g.name, group.gi + 1, '') : '', false,
        `/composition/layers/by-id/${l.id}/clear`));
    }
    v.append(h('div', { class: 'sect' }, h('h3', null, 'Layers'), strips));
  }

  // ------------------------------------------------------------------ output preview
  // Resolume can return a JPEG snapshot of any render target (composition, preview, busses,
  // groups, layers). Fetching one after another gives a live-ish preview of what's going out.
  const Preview = {
    live: store.get('previewLive', true),
    target: store.get('previewTarget', 'Composition'),
    fps: 5,
    img: null, note: null, select: null, running: false, url: null, monitors: [],
    build() {
      const sel = h('select', { class: 'pvsel' });
      const btn = h('button', { class: 'btn sm pvlive' });
      const img = h('img', { class: 'pvimg', alt: '' });
      const note = h('div', { class: 'pvnote' }, 'Loading preview…');
      sel.addEventListener('change', () => { this.target = sel.value; store.set('previewTarget', sel.value); });
      btn.addEventListener('click', () => { this.live = !this.live; store.set('previewLive', this.live); this.paint(); this.start(); });
      Object.assign(this, { img, note, select: sel, btn });
      if (this.url) img.src = this.url;
      this.paint(); this.loadMonitors(); this.start();
      return h('div', { class: 'sect preview' },
        h('div', { class: 'pvhead' }, h('h3', null, 'Output preview'), sel, btn),
        h('div', { class: 'pvframe' }, img, note));
    },
    paint() {
      if (!this.btn) return;
      this.btn.textContent = this.live ? 'Live' : 'Paused';
      this.btn.classList.toggle('on', this.live);
    },
    async loadMonitors() {
      try {
        const r = await fetch('/api/v1/composition/monitors', { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        this.monitors = await r.json();
      } catch {
        this.monitors = [];
        this.note.textContent = 'Preview needs a newer Resolume version (no snapshot support).';
        this.note.style.display = 'flex';
        return;
      }
      const sel = this.select; sel.textContent = '';
      for (const m of this.monitors) sel.append(h('option', { value: m.name }, m.name));
      if (!this.monitors.some(m => m.name === this.target)) this.target = (this.monitors[0] || {}).name;
      sel.value = this.target;
    },
    visible() { return this.img && this.img.isConnected && this.img.offsetParent !== null && document.visibilityState === 'visible'; },
    start() {
      if (this.running) return;
      this.running = true;
      const loop = async () => {
        while (this.live && S.open) {
          const m = this.monitors.find(x => x.name === this.target);
          if (!m || !this.visible()) { await new Promise(r => setTimeout(r, 400)); continue; }
          const t0 = performance.now();
          try {
            const r = await fetch(`/api/v1/composition/monitors/${m.id}/snapshot.jpg?t=${Date.now()}`, { cache: 'no-store' });
            if (!r.ok) throw new Error(r.status);
            const url = URL.createObjectURL(await r.blob());
            const old = this.url; this.url = url;
            this.img.src = url; this.note.style.display = 'none';
            if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
          } catch {
            this.note.textContent = 'Preview unavailable'; this.note.style.display = 'flex';
            await new Promise(r => setTimeout(r, 1500));
          }
          const wait = 1000 / this.fps - (performance.now() - t0);
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
        }
        this.running = false;
      };
      loop();
    },
  };
  document.addEventListener('visibilitychange', () => Preview.start());

  // ------------------------------------------------------------------ effects
  function fxTargets() {
    const c = S.comp; if (!c) return [];
    const t = [{ key: 'comp', label: 'Composition', obj: c }];
    (c.layergroups || []).forEach((g, gi) => t.push({ key: 'g' + g.id, label: pname(g.name, gi + 1, 'Group'), obj: g }));
    for (const { layer: l, index } of layersTopDown()) t.push({ key: 'l' + l.id, label: pname(l.name, index, `Layer ${index}`), obj: l });
    return t;
  }
  function paramControl(name, p, group = 'fx') {
    const view = p.view || {};
    const wrap = h('div', { class: 'prm' });
    const label = h('div', { class: 'plabel' }, h('span', null, view.alternative_name || name));
    wrap.append(label);
    switch (p.valuetype) {
      case 'ParamRange': {
        const span = (p.max ?? 1) - (p.min ?? 0);
        const mult = view.multiplier || 1, suffix = view.suffix || '';
        const fmt = v => {
          const x = v * mult;
          return (Math.abs(x) >= 100 || Number.isInteger(x) ? Math.round(x) : x.toFixed(2)) + suffix;
        };
        if (span > 2000 || view.control_type === 'spinner') {
          const step = view.step || 1;
          const num = h('span', { class: 'num' });
          const mk = (t, d) => { const b = h('button', { class: 'btn sm' }, t); b.addEventListener('click', () => {
            const cur = (S.params.get(p.id) || p).value; setParam(p.id, clamp(cur + d, p.min, p.max)); num.textContent = fmt(clamp(cur + d, p.min, p.max)); }); return b; };
          const reset = h('button', { class: 'btn sm' }, '0');
          reset.addEventListener('click', () => { send({ action: 'reset', parameter: byId(p.id) }); });
          bind(group, p, q => { num.textContent = fmt(q.value); });
          wrap.append(h('div', { class: 'inline' }, mk('−10', -10 * step), mk('−', -step), num, mk('+', step), mk('+10', 10 * step), reset));
        } else {
          wrap.append(fader(group, p, { format: fmt }));
        }
        break;
      }
      case 'ParamBoolean': {
        const b = h('button', { class: 'btn' }, 'Off');
        b.addEventListener('click', () => setParam(p.id, !(S.params.get(p.id) || p).value));
        bind(group, p, q => { b.classList.toggle('on', !!q.value); b.textContent = q.value ? 'On' : 'Off'; });
        wrap.append(b);
        break;
      }
      case 'ParamChoice': case 'ParamState':
        wrap.append(choiceSelect(group, p));
        break;
      case 'ParamEvent': case 'ParamTrigger': {
        const b = h('button', { class: 'btn' }, view.alternative_name || name);
        holdButton(b, () => setParam(p.id, true), () => setParam(p.id, false));
        label.remove();
        wrap.append(b);
        break;
      }
      case 'ParamColor': {
        const inp = h('input', { type: 'color' });
        let alpha = 'ff';
        inp.addEventListener('input', () => setParam(p.id, inp.value + alpha));
        bind(group, p, q => { if (typeof q.value === 'string') { inp.value = q.value.slice(0, 7); alpha = q.value.slice(7, 9) || 'ff'; } });
        wrap.append(inp);
        break;
      }
      default:
        return null;
    }
    return wrap;
  }
  function effectCards(container, effects, group) {
    for (const fx of effects) {
      const open = S.fxOpen.has(fx.id);
      const card = h('div', { class: 'fx' + (open ? ' open' : '') });
      const chev = h('span', { class: 'chev' }, open ? '▾' : '▸');
      const head = h('div', { class: 'fxhead' }, chev, h('span', { class: 'fxname' }, fx.display_name || fx.name));
      if (fx.bypassed) {
        const b = h('button', { class: 'btn sm' }, 'On');
        b.addEventListener('click', e => { e.stopPropagation(); setParam(fx.bypassed.id, !(S.params.get(fx.bypassed.id) || fx.bypassed).value); });
        bind(group, fx.bypassed, q => { b.textContent = q.value ? 'Off' : 'On'; b.classList.toggle('on', !q.value); card.classList.toggle('off', !!q.value); });
        head.append(b);
      }
      const body = h('div', { class: 'fxbody' });
      head.addEventListener('click', () => {
        const now = !card.classList.contains('open');
        card.classList.toggle('open', now); chev.textContent = now ? '▾' : '▸';
        if (now) { S.fxOpen.add(fx.id); fillBody(); } else { S.fxOpen.delete(fx.id); }
        store.set('fxOpen', [...S.fxOpen].slice(-50));
        syncSubs();
      });
      let filled = false;
      const fillBody = () => {
        if (filled) return; filled = true;
        for (const [name, p] of Object.entries(fx.params || {})) {
          if (!p || typeof p.id !== 'number') continue;
          const ctl = paramControl(name, p, group); if (ctl) body.append(ctl);
        }
      };
      if (open) fillBody();
      card.append(head, body);
      container.append(card);
    }
  }

  // ------------------------------------------------------------------ clip panel
  // Follows the selected clip (selected in Arena, or the last clip triggered from here).
  function findClip(id) {
    const c = S.comp; if (!c || !id) return null;
    for (let li = 0; li < c.layers.length; li++) {
      const l = c.layers[li], ci = l.clips.findIndex(x => x.id === id);
      if (ci >= 0) return { clip: l.clips[ci], layer: l, layerIndex: li + 1, colIndex: ci + 1 };
    }
    return null;
  }
  function selectedFromComp() {
    const c = S.comp; if (!c) return null;
    for (const l of c.layers) for (const x of l.clips) {
      const p = x.selected && (S.params.get(x.selected.id) || x.selected);
      if (p && p.value === true && x.connected && x.connected.value !== 'Empty') return x.id;
    }
    return null;
  }
  function setSelectedClip(id) {
    if (!id || id === S.selClip) return;
    S.selClip = id;
    document.querySelectorAll('.clip.sel').forEach(t => t.classList.remove('sel'));
    const t = document.querySelector(`.clip[data-id="${id}"]`); if (t) t.classList.add('sel');
    renderClip(); syncSubsSoon();
  }
  // Every clip in the deck (not just the visible page) so selecting in Arena is always followed.
  function watchSelection() {
    S.binds.sel.clear();
    const c = S.comp; if (!c) return;
    for (const l of c.layers) for (const x of l.clips) {
      if (!x.selected) continue;
      bind('sel', x.selected, p => { if (p.value === true) setSelectedClip(x.id); });
    }
  }
  const fmtTime = ms => { const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60), sec = t - m * 60; return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`; };
  function renderClip() {
    S.binds.clip.clear();
    const v = $('#clipView'); v.textContent = '';
    const f = findClip(S.selClip);
    if (!f) {
      v.append(h('div', { class: 'empty-note' }, 'Trigger a clip, or select one in Arena, and its controls appear here.'));
      return;
    }
    const { clip, layer, layerIndex, colIndex } = f;
    const url = thumbUrl(clip);
    const state = h('span', { class: 'cstate' });
    const trig = h('button', { class: 'btn ctrig' }, 'Trigger');
    holdButton(trig,
      () => trigger(`/composition/clips/by-id/${clip.id}/connect`, true),
      () => trigger(`/composition/clips/by-id/${clip.id}/connect`, false));
    const clr = h('button', { class: 'btn' }, 'Clear layer');
    clr.addEventListener('click', () => trigger(`/composition/layers/by-id/${layer.id}/clear`));
    bind('clip', clip.connected, p => {
      const live = p.value === 'Connected' || p.value === 'Connected & previewing';
      state.textContent = live ? 'Playing' : p.value === 'Previewing' ? 'Previewing' : 'Stopped';
      state.className = 'cstate' + (live ? ' live' : '');
      trig.classList.toggle('on', live);
    });
    v.append(h('div', { class: 'chead' },
      h('div', { class: 'cthumb' }, url ? h('img', { src: url, alt: '' }) : null),
      h('div', { class: 'cinfo' },
        h('div', { class: 'ctitle' }, (clip.name && clip.name.value) || 'Clip'),
        h('div', { class: 'csub' }, `${pname(layer.name, layerIndex, 'Layer ' + layerIndex)} · Column ${colIndex}`),
        state)));
    v.append(h('div', { class: 'row cbtns' }, trig, clr));

    const tr = clip.transport || {};
    const sect = (title, ...kids) => { const el = h('div', { class: 'sect' }, h('h3', null, title), ...kids.filter(Boolean)); v.append(el); return el; };
    if (tr.position) {
      const dur = clip.video && clip.video.fileinfo && clip.video.fileinfo.duration_ms;
      const isMs = dur && Math.abs((tr.position.max ?? 0) - dur) < 2;
      const fmt = isMs ? (x => `${fmtTime(x)} / ${fmtTime(dur)}`) : undefined;
      sect('Position (drag to scrub)', fader('clip', tr.position, fmt ? { format: fmt } : {}));
    }
    const ctl = tr.controls || {};
    const ctlKids = Object.entries(ctl).map(([name, p]) => p && typeof p.id === 'number' ? paramControl(LABELS[name] || name, p, 'clip') : null);
    if (ctlKids.some(Boolean)) sect('Transport', ...ctlKids);

    const vid = clip.video || {};
    const blend = vid.mixer && vid.mixer['Blend Mode'];
    sect('Video',
      vid.opacity ? paramControl('Opacity', vid.opacity, 'clip') : null,
      blend ? paramControl('Blend mode', blend, 'clip') : null,
      vid.resize ? paramControl('Resize', vid.resize, 'clip') : null);

    sect('Trigger',
      clip.transporttype ? paramControl('Transport type', clip.transporttype, 'clip') : null,
      clip.triggerstyle ? paramControl('Trigger style', clip.triggerstyle, 'clip') : null,
      clip.beatsnap ? paramControl('Beat snap', clip.beatsnap, 'clip') : null);

    const effects = vid.effects || [];
    const fxs = sect('Clip effects');
    if (effects.length) effectCards(fxs, effects, 'clip');
    else fxs.append(h('div', { class: 'empty-note' }, 'No effects on this clip.'));
  }
  const LABELS = { speed: 'Speed', playdirection: 'Direction', playmode: 'Play mode', playmodeaway: 'When re-triggered', duration: 'Duration (s)' };

  function renderFx() {
    S.binds.fx.clear();
    const v = $('#fxView'); v.textContent = '';
    const c = S.comp; if (!c) return;
    const targets = fxTargets();
    let cur = targets.find(t => t.key === S.fxTarget) || targets[0];
    const chips = h('div', { class: 'targets' });
    for (const t of targets) {
      const b = h('button', { class: 'chip' + (t === cur ? ' on' : '') }, t.label);
      tint(b, colourOf(t.obj.colorid));
      b.addEventListener('click', () => { S.fxTarget = t.key; store.set('fxTarget', t.key); renderFx(); syncSubs(); });
      chips.append(b);
    }
    v.append(chips);
    const effects = (cur.obj.video && cur.obj.video.effects) || [];
    if (!effects.length) { v.append(h('div', { class: 'empty-note' }, 'No video effects on ' + cur.label + '.')); return; }
    effectCards(v, effects, 'fx');
  }

  // ------------------------------------------------------------------ chrome
  function setOnline(ok) {
    $('#status').classList.toggle('ok', ok);
    document.body.classList.toggle('offline', !ok);
    if (!ok) $('#banner').textContent = 'Reconnecting to Resolume…';
  }
  function setView(v) {
    S.view = v; store.set('view', v);
    document.body.classList.remove('view-clips', 'view-mixer', 'view-fx', 'view-clip');
    document.body.classList.add('view-' + v);
    if (v !== 'clips') setPanel(v);
    document.querySelectorAll('#bottomNav .tab').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  }
  function setPanel(p) {
    S.panel = p; store.set('panel', p);
    document.body.classList.remove('panel-mixer', 'panel-fx', 'panel-clip');
    document.body.classList.add('panel-' + p);
    document.querySelectorAll('.sidetabs .tab').forEach(b => b.classList.toggle('on', b.dataset.panel === p));
  }
  function setTile(px) {
    S.tile = clamp(px, 72, 260); store.set('tile', S.tile);
    document.documentElement.style.setProperty('--tile', S.tile + 'px');
  }

  document.querySelectorAll('#bottomNav .tab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('.sidetabs .tab').forEach(b => b.addEventListener('click', () => setPanel(b.dataset.panel)));
  document.querySelectorAll('[data-tempo]').forEach(b => {
    const kind = b.dataset.tempo;
    b.addEventListener('pointerdown', () => {
      tempoAction(kind);
      if (kind === 'tap') { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 90); }
    });
  });
  $('#zoomIn').addEventListener('click', () => setTile(S.tile + 20));
  $('#zoomOut').addEventListener('click', () => setTile(S.tile - 20));
  $('#blackout').addEventListener('click', toggleBlackout);
  $('#lock').addEventListener('click', () => {
    S.locked = !S.locked;
    document.body.classList.toggle('locked', S.locked);
    $('#lock').classList.toggle('on', S.locked);
    $('#lock').textContent = S.locked ? 'Locked' : 'Lock';
  });
  $('#fullscreen').addEventListener('click', () => {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else { const e = d.documentElement; (e.requestFullscreen || e.webkitRequestFullscreen || (() => { })).call(e); }
  });
  // keep the tablet awake while the app is open (only where the browser allows it)
  // Keep the tablet awake. Browsers only grant the Wake Lock API on secure (https/localhost)
  // pages, and the tablet opens this app over plain http on the LAN, so when the request is
  // refused we fall back to a tiny muted looping video, which also stops phones sleeping.
  let wakeLock = null, awakeVideo = null;
  async function keepAwake() {
    if (document.visibilityState !== 'visible') return;
    try {
      if (window.isSecureContext && 'wakeLock' in navigator) {
        if (!wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
        return;
      }
    } catch { /* refused: use the video fallback */ }
    if (!awakeVideo) {
      awakeVideo = h('video', { muted: true, playsinline: true, 'webkit-playsinline': true, loop: true, 'aria-hidden': 'true',
        style: 'position:fixed;width:1px;height:1px;opacity:0.01;left:0;bottom:0;pointer-events:none' },
        h('source', { src: 'keepawake.mp4', type: 'video/mp4' }),
        h('source', { src: 'keepawake.webm', type: 'video/webm' }));
      awakeVideo.muted = true;
      document.body.append(awakeVideo);
    }
    try { await awakeVideo.play(); } catch { /* needs a user gesture; retried on the next tap */ }
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake);

  // A thumbnail can arrive before the lazy <img> exists; also refresh the whole state if the
  // tab was in the background (phones suspend websockets).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.ws && S.ws.readyState > 1) connect();
  });

  setTile(S.tile);
  setPanel(['fx', 'clip'].includes(S.panel) ? S.panel : 'mixer');
  setView(['clips', 'mixer', 'fx', 'clip'].includes(S.view) ? S.view : 'clips');
  setOnline(false);
  connect();
})();
