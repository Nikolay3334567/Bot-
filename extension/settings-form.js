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

  const controls = {};       // key -> (value) => void
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

  function fieldRow(f) {
    const row = mk('div', 'ytam-set-row');
    const label = mk('div', 'ytam-set-label');
    label.append(mk('span', '', f.label));
    if (f.hint) label.append(mk('small', '', f.hint));
    const ctl = mk('div', 'ytam-set-ctl');
    row.append(label, ctl);
    const k = f.k;

    if (f.type === 'toggle') {
      const sw = mk('label', 'ytam-switch');
      const inp = mk('input');
      inp.type = 'checkbox';
      sw.append(inp, mk('span'));
      inp.addEventListener('change', () => { onPreview(k, inp.checked); save(k, inp.checked); });
      controls[k] = (v) => { inp.checked = !!v; };
      ctl.append(sw);
      if (f.color) {
        const c = mk('input');
        c.type = 'color';
        c.addEventListener('input', () => { onPreview(f.color, c.value); save(f.color, c.value, 300); });
        controls[f.color] = (v) => { c.value = v; };
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
      controls[k] = (v) => { inp.value = v; show(v); };
      ctl.append(inp, val);
    } else if (f.type === 'select') {
      const sel = mk('select');
      for (const [v, t] of f.options) sel.append(new Option(t, v));
      sel.addEventListener('change', () => { const v = cast(k, sel.value); onPreview(k, v); save(k, v); });
      controls[k] = (v) => { sel.value = String(v); };
      ctl.append(sel);
    } else if (f.type === 'textarea') {
      const ta = mk('textarea');
      ta.rows = 2;
      ta.spellcheck = false;
      ta.addEventListener('input', () => save(k, ta.value, 600));
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      controls[k] = (v) => { if (document.activeElement !== ta) ta.value = v; };
      ctl.append(ta);
      row.classList.add('wide');
    } else {
      const inp = mk('input');
      inp.type = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
      if (f.list) inp.setAttribute('list', f.list);
      inp.spellcheck = false;
      inp.addEventListener('change', () => { const v = cast(k, inp.value.trim()) || def(k); inp.value = v; save(k, v); });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      controls[k] = (v) => { if (document.activeElement !== inp) inp.value = v; };
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
  const models = mk('datalist');
  models.id = 'ytam-models';
  for (const m of ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash']) models.append(new Option(m, m));
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

  const apply = (vals) => { for (const [k, v] of Object.entries(vals)) if (controls[k]) controls[k](v); };
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
