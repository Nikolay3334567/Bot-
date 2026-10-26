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


  // Backup / transfer: all settings (optionally with API keys and the vocabulary) to a file and back.
  if (!opts.only || opts.only.includes('backup')) {
    const btn = mk('button', 'ytam-set-tab', 'Перенос');
    const pane = mk('div', 'ytam-set-pane');
    pane.append(mk('p', 'ytam-set-note', 'Сохраните настройки в файл и загрузите его в другой копии расширения (или пришлите файл, чтобы я проверил такие же настройки). Версия расширения и дата записываются в файл.'));
    const chk = (label, checked, danger) => {
      const l = mk('label', 'ytam-set-chk' + (danger ? ' danger' : ''));
      const i = mk('input');
      i.type = 'checkbox';
      i.checked = checked;
      l.append(i, document.createTextNode(' ' + label));
      return { l, i };
    };
    const cKeys = chk('Сохранить вместе с API-ключами (Gemini, ИИ, Google Cloud, AnkiConnect)', false, true);
    const cVocab = chk('Сохранить мой словарь и список «Сохранённые»', true);
    const cDev = chk('Сохранить параметры разработчика / тестовые функции', true);
    cKeys.l.title = 'Ключи — это пароли: не отправляйте такой файл никому и не выкладывайте его.';
    const status = mk('div', 'ytam-set-note');
    const exportBtn = mk('button', 'ytam-set-reset', '⬇ Экспорт настроек в файл');
    exportBtn.addEventListener('click', async () => {
      try {
        const sync = await chrome.storage.sync.get(null);
        const settings = {};
        for (const k of Object.keys(D)) if (k in sync) settings[k] = sync[k];
        const want = [];
        if (cDev.i.checked) want.push('dev');
        if (cKeys.i.checked) want.push(...Object.keys(L));
        if (cVocab.i.checked) want.push('vocab', 'saved');
        const loc = want.length ? await chrome.storage.local.get(want) : {};
        const data = { format: 'ytam-settings', version: chrome.runtime.getManifest().version, at: new Date().toISOString(), settings };
        if (cDev.i.checked) data.dev = loc.dev || {};
        if (cKeys.i.checked) { data.keys = {}; for (const k of Object.keys(L)) if (loc[k]) data.keys[k] = loc[k]; }
        if (cVocab.i.checked) { data.vocab = loc.vocab || {}; data.saved = loc.saved || []; }
        const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
        const a = mk('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ytam-settings-v${data.version}-${data.at.slice(0, 10)}${data.keys ? '-with-keys' : ''}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        status.textContent = `✓ Файл сохранён: ${Object.keys(settings).length} настроек` + (data.keys ? `, ключей: ${Object.keys(data.keys).length}` : ', без ключей') + (data.vocab ? `, слов: ${Object.keys(data.vocab).length}` : '');
      } catch (e) { status.textContent = 'Ошибка экспорта: ' + e.message; }
    });
    const imp = async (text) => {
      let data;
      try { data = JSON.parse(text); } catch (e) { status.textContent = 'Это не JSON: ' + e.message; return; }
      if (!data || data.format !== 'ytam-settings') { status.textContent = 'Это не файл настроек этого расширения.'; return; }
      const sync = {};
      for (const k of Object.keys(D)) if (data.settings && k in data.settings) sync[k] = data.settings[k];
      const loc = {};
      if (data.dev) loc.dev = data.dev;
      let nKeys = 0;
      if (data.keys && cKeys.i.checked) for (const k of Object.keys(L)) if (data.keys[k]) { loc[k] = data.keys[k]; nKeys++; }
      if (data.vocab && cVocab.i.checked) {
        const cur = await chrome.storage.local.get({ vocab: {}, saved: [] });
        loc.vocab = { ...cur.vocab, ...data.vocab };
        const have = new Set((data.saved || []).map((e) => e.k));
        loc.saved = [...(data.saved || []), ...cur.saved.filter((e) => !have.has(e.k))];
      }
      await chrome.storage.sync.set(sync);
      if (Object.keys(loc).length) await chrome.storage.local.set(loc);
      status.textContent = `✓ Загружено: ${Object.keys(sync).length} настроек` + (data.keys ? (nKeys ? `, ключей: ${nKeys}` : ' (ключи в файле есть — отметьте «с API-ключами» и загрузите снова)') : '') +
        (loc.vocab ? `, слов: ${Object.keys(loc.vocab).length}` : '') + ` · файл от версии ${data.version || '?'}`;
    };
    const file = mk('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.addEventListener('change', async () => { if (file.files[0]) { await imp(await file.files[0].text()); file.value = ''; } });
    const paste = mk('textarea', 'ytam-set-paste');
    paste.rows = 4;
    paste.placeholder = 'Или вставьте сюда содержимое файла настроек…';
    paste.addEventListener('keydown', (e) => e.stopPropagation());
    const pasteBtn = mk('button', 'ytam-set-reset', 'Загрузить из вставленного текста');
    pasteBtn.addEventListener('click', () => imp(paste.value));
    pane.append(cKeys.l, cVocab.l, cDev.l, exportBtn, mk('div', 'ytam-set-group', 'Загрузка'), mk('div', '', 'Файл настроек:'), file, paste, pasteBtn, status);
    btn.addEventListener('click', () => select('backup'));
    nav.append(btn);
    body.append(pane);
    panes.backup = { btn, pane };
  }

  // Google Cloud usage / key test (Перевод tab)
  if (panes.subs && chrome.runtime && chrome.runtime.sendMessage) {
    const box = mk('div', 'ytam-cloud');
    const line = mk('div', 'ytam-cloud-line');
    const note = mk('div', 'ytam-cloud-note');
    const test = mk('button', 'ytam-set-reset', 'Проверить ключ Google Cloud');
    const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
    const draw = (u, limits) => {
      u = u || {};
      line.textContent = `В этом месяце · перевод: ${fmt(u.tr)} знаков` + (limits ? ` из ${fmt(limits.tr)}` : '') +
        ` · озвучка: ${fmt(u.tts)} знаков` + (limits ? ` из ${fmt(limits.tts)}` : '') +
        (u.fallbackTr ? ` · раз переключались на бесплатный перевод: ${u.fallbackTr}` : '');
    };
    const refresh = () => chrome.storage.sync.get(D, (c) => chrome.storage.local.get({ usage: null }, (r) => {
      const u = r.usage && r.usage.m === new Date().toISOString().slice(0, 7) ? r.usage : { tr: 0, tts: 0 };
      draw(u, { tr: c.cloudTrLimit, tts: c.ttsLimit });
    }));
    test.addEventListener('click', () => {
      note.textContent = 'Проверяю…';
      chrome.runtime.sendMessage({ type: 'cloudTest' }, (r) => {
        const res = r && r.result;
        if (!res) { note.textContent = (r && r.error) || 'Нет ответа от расширения'; return; }
        if (res.error) { note.textContent = res.error; return; }
        note.textContent = `Перевод: ${res.tr} · Озвучка: ${res.tts}`;
        refresh();
      });
    });
    box.append(line, test, note);
    panes.subs.pane.append(box);
    refresh();
    chrome.storage.onChanged.addListener((ch, area) => { if (ch.usage || ch.cloudTrLimit || ch.ttsLimit) refresh(); });
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
