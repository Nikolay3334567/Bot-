// Builds the settings form from YTAM_SCHEMA. Used by the in-player dialog and the options page.
// Values are stored in chrome.storage (sync, or local for fields marked local).
self.YTAM_buildSettings = function buildSettings(opts = {}) {
  const D = self.YTAM_DEFAULTS, L = self.YTAM_LOCAL_DEFAULTS;
  const onPreview = opts.onPreview || (() => {});
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const root = mk('div', 'ytam-set');
  const nav = mk('div', 'ytam-set-nav');
  const body = mk('div', 'ytam-set-body');
  root.append(nav, body);

  const controls = {};       // key -> [(value) => void]
  const addCtl = (k, fn) => { (controls[k] = controls[k] || []).push(fn); };
  const timers = {};
  const isLocal = (k) => k in L;
  const def = (k) => (isLocal(k) ? L[k] : D[k]);
  const cast = (k, v) => (typeof def(k) === 'number' ? (v === '' || isNaN(+v) ? def(k) : +v) : v);

  function save(k, v, delay) {
    clearTimeout(timers[k]);
    const area = isLocal(k) ? chrome.storage.local : chrome.storage.sync;
    const run = () => area.set({ [k]: v });
    if (delay) timers[k] = setTimeout(run, delay); else run();
  }

  // Switching provider swaps the default address (only if the user did not customise it).
  const PROVIDER_URL = { gemini: 'https://generativelanguage.googleapis.com', openai: 'https://api.openai.com/v1' };
  function switchProvider(v) {
    chrome.storage.sync.get({ aiBaseUrl: '' }, (r) => {
      const isDefault = !r.aiBaseUrl || Object.values(PROVIDER_URL).includes(r.aiBaseUrl);
      if (isDefault) { save('aiBaseUrl', PROVIDER_URL[v]); save('aiChatPath', '/chat/completions'); }
    });
  }

  // Custom API addresses need a host permission (asked only from the extension's own page).
  function requestHost(url) {
    try {
      const o = new URL(url);
      if (!chrome.permissions || !chrome.permissions.request) return;
      chrome.permissions.request({ origins: [o.origin + '/*'] });
    } catch (_) {}
  }

  function fieldRow(f) {
    const row = mk('div', 'ytam-set-row');
    const label = mk('div', 'ytam-set-label');
    label.append(mk('span', '', f.label));
    if (f.hint) label.append(mk('small', '', f.hint));
    const ctl = mk('div', 'ytam-set-ctl');
    row.append(label, ctl);
    const k = f.k;

    if (f.type === 'levels') {
      const btns = f.levels.map(([name, n]) => {
        const b = mk('button', 'ytam-lvl', name);
        b.title = `${n} слов`;
        b.addEventListener('click', () => { onPreview(k, n); save(k, n); });
        return [b, n];
      });
      ctl.append(...btns.map(([b]) => b));
      addCtl(k, (v) => btns.forEach(([b, n]) => b.classList.toggle('on', +v === n)));
    } else if (f.type === 'toggle') {
      const sw = mk('label', 'ytam-switch');
      const inp = mk('input');
      inp.type = 'checkbox';
      sw.append(inp, mk('span'));
      inp.addEventListener('change', () => { onPreview(k, inp.checked); save(k, inp.checked); });
      addCtl(k, (v) => { inp.checked = !!v; });
      ctl.append(sw);
      if (f.color) {
        const c = mk('input');
        c.type = 'color';
        c.addEventListener('input', () => { onPreview(f.color, c.value); save(f.color, c.value, 300); });
        addCtl(f.color, (v) => { c.value = v; });
        ctl.append(c);
        label.firstChild.dataset.colorKey = f.color;
      }
    } else if (f.type === 'range') {
      const inp = mk('input');
      Object.assign(inp, { type: 'range', min: f.min, max: f.max, step: f.step });
      const val = mk('span', 'ytam-set-val');
      const show = (v) => { val.textContent = v + (f.unit ? ' ' + f.unit : ''); };
      inp.addEventListener('input', () => {
        const v = cast(k, inp.value);
        show(v);
        onPreview(k, v, f.preview);
        save(k, v, 350);
      });
      addCtl(k, (v) => { inp.value = v; show(v); });
      ctl.append(inp, val);
    } else if (f.type === 'select') {
      const sel = mk('select');
      for (const [v, t] of f.options) sel.append(new Option(t, v));
      sel.addEventListener('change', () => {
        const v = cast(k, sel.value);
        onPreview(k, v);
        save(k, v);
        if (k === 'aiProvider') switchProvider(v);
      });
      addCtl(k, (v) => { sel.value = String(v); });
      ctl.append(sel);
    } else if (f.type === 'textarea') {
      const ta = mk('textarea');
      ta.rows = 2;
      ta.spellcheck = false;
      ta.addEventListener('input', () => save(k, ta.value, 600));
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      addCtl(k, (v) => { if (document.activeElement !== ta) ta.value = v; });
      ctl.append(ta);
      row.classList.add('wide');
    } else {
      const inp = mk('input');
      inp.type = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
      if (f.list) inp.setAttribute('list', f.list);
      inp.spellcheck = false;
      inp.addEventListener('change', () => {
        const v = cast(k, inp.value.trim()) || def(k);
        inp.value = v;
        save(k, v);
        if (k === 'aiBaseUrl') requestHost(v);
      });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      addCtl(k, (v) => { if (document.activeElement !== inp) inp.value = v; });
      ctl.append(inp);
    }
    return row;
  }

  const panes = {};
  for (const sec of self.YTAM_SCHEMA) {
    if (opts.only && !opts.only.includes(sec.id)) continue;
    const btn = mk('button', 'ytam-set-tab', sec.title);
    const pane = mk('div', 'ytam-set-pane');
    pane.dataset.id = sec.id;
    for (const f of sec.fields) pane.append(fieldRow(f));
    if (sec.id === 'view') {
      const reset = mk('button', 'ytam-set-reset', 'Сбросить вид по умолчанию');
      reset.addEventListener('click', () => {
        const vals = {};
        for (const f of sec.fields) vals[f.k] = D[f.k];
        chrome.storage.sync.set(vals);
      });
      pane.append(reset);
    }
    if (opts.extra && opts.extra[sec.id]) pane.append(opts.extra[sec.id]);
    btn.addEventListener('click', () => select(sec.id));
    nav.append(btn);
    body.append(pane);
    panes[sec.id] = { btn, pane };
  }
  // Developer / experimental tab: every internal number (chrome.storage.local.dev).
  if (!opts.only || opts.only.includes('dev')) {
    const btn = mk('button', 'ytam-set-tab', 'Разработчик');
    const pane = mk('div', 'ytam-set-pane');
    const DD = self.YTAM_DEV_DEFAULTS;
    let dev = { ...DD };
    const setters = {};
    let t = 0;
    const saveDev = () => { clearTimeout(t); t = setTimeout(() => chrome.storage.local.set({ dev: { ...dev } }), 300); };
    pane.append(mk('p', 'ytam-set-note', 'Экспериментальные параметры: меняйте на ходу, всё применяется сразу. ↺ — вернуть по умолчанию. Те же значения есть во вкладке 🛠 боковой панели (там же прослушивание клипа).'));
    for (const g of self.YTAM_DEV_SCHEMA) {
      pane.append(mk('div', 'ytam-set-group', g.title));
      for (const f of g.fields) {
        const row = mk('div', 'ytam-set-row');
        const label = mk('div', 'ytam-set-label');
        label.append(mk('span', '', f.label));
        if (f.hint) label.append(mk('small', '', f.hint));
        const ctl = mk('div', 'ytam-set-ctl');
        const rng = mk('input');
        Object.assign(rng, { type: 'range', min: f.min, max: f.max, step: f.step });
        const num = mk('input');
        Object.assign(num, { type: 'number', min: f.min, max: f.max, step: f.step });
        num.className = 'ytam-set-num';
        const rst = mk('button', 'ytam-set-rst', '↺');
        const set = (v) => { rng.value = v; num.value = v; rst.style.visibility = +v === f.def ? 'hidden' : 'visible'; };
        setters[f.k] = set;
        const put = (v) => { dev[f.k] = v; set(v); saveDev(); };
        rng.addEventListener('input', () => put(+rng.value));
        num.addEventListener('change', () => { const v = Math.min(f.max, Math.max(f.min, +num.value)); if (!isNaN(v)) put(v); });
        num.addEventListener('keydown', (e) => e.stopPropagation());
        rst.addEventListener('click', () => put(f.def));
        ctl.append(rng, num, f.unit ? mk('span', 'ytam-set-val', f.unit) : mk('span'), rst);
        row.append(label, ctl);
        pane.append(row);
      }
    }
    const resetAll = mk('button', 'ytam-set-reset', 'Сбросить все параметры разработчика');
    resetAll.addEventListener('click', () => { dev = { ...DD }; for (const [k, fn] of Object.entries(setters)) fn(DD[k]); saveDev(); });
    pane.append(resetAll);
    btn.addEventListener('click', () => select('dev'));
    nav.append(btn);
    body.append(pane);
    panes.dev = { btn, pane };
    const applyDev = (d) => { dev = { ...DD, ...(d || {}) }; for (const [k, fn] of Object.entries(setters)) fn(dev[k]); };
    chrome.storage.local.get({ dev: {} }, (r) => applyDev(r.dev));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.dev) applyDev(ch.dev.newValue); });
  }

  const models = mk('datalist');
  models.id = 'ytam-models';
  for (const m of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash']) models.append(new Option(m, m));
  root.append(models);

  function select(id) {
    for (const [k, p] of Object.entries(panes)) {
      p.btn.classList.toggle('on', k === id);
      p.pane.classList.toggle('on', k === id);
    }
    try { localStorage.setItem('ytam-set-tab', id); } catch (_) {}
  }
  let first = Object.keys(panes)[0];
  try { if (panes[localStorage.getItem('ytam-set-tab')]) first = localStorage.getItem('ytam-set-tab'); } catch (_) {}
  select(first);

  const apply = (vals) => { for (const [k, v] of Object.entries(vals)) for (const fn of controls[k] || []) fn(v); };
  chrome.storage.sync.get(D, apply);
  chrome.storage.local.get(L, apply);
  const onChange = (changes) => {
    const vals = {};
    for (const k in changes) vals[k] = changes[k].newValue === undefined ? def(k) : changes[k].newValue;
    apply(vals);
  };
  chrome.storage.onChanged.addListener(onChange);
  root.ytamDispose = () => chrome.storage.onChanged.removeListener(onChange);
  root.ytamSelect = select;
  return root;
};
