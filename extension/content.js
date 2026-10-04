(() => {
  'use strict';
  if (window.__ytamLoaded) return;
  window.__ytamLoaded = true;

  const DEFAULTS = self.YTAM_DEFAULTS;
  let settings = { ...DEFAULTS };

  const S = {
    videoId: null,
    title: '',
    tracks: [],
    track: null,
    words: [],          // subtitle words with timings: { text, start, end }
    cues: [],           // displayed phrases: { start, end, text, tr? }
    trans: [],
    saved: new Set(),   // cue start times saved to Anki
    active: -1,
    shown: -1,
    lastAutoPause: -1,
    token: 0,
    captured: new Map(), // videoId -> { url, body } of the player's own subtitle request
    waitingCapture: false,
    hoverPaused: false,
    userScrollAt: 0,
    vocab: {},          // word -> 1 (learning) | 2 (known)
    wordTr: new Map(),  // word -> short translation (prefetched)
    hoverWord: null,
    pending: [],        // cards waiting for their audio to be played
  };
  let ui = null;
  let pop = null;

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getVideo = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
  };
  const layer = () => document.fullscreenElement || document.body;
  const norm = (w) => w.toLowerCase().replace(/’/g, "'");

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  function bg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!r) return reject(new Error('Нет ответа от расширения'));
          if (r.error) return reject(new Error(r.error));
          resolve(r.result);
        });
      } catch (e) {
        reject(new Error('Расширение было обновлено — перезагрузите страницу'));
      }
    });
  }

  let toastEl = null, toastTimer = 0;
  function toast(text, kind = '', ms = 2200) {
    if (!toastEl) toastEl = h('div', { class: 'ytam-toast' });
    toastEl.className = 'ytam-toast ' + kind;
    toastEl.textContent = text;
    layer().append(toastEl);
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastEl.remove(), ms);
  }

  // ---------- vocabulary & highlighting ----------

  const FREQ = new Map();
  (self.YTAM_FREQ || '').split('\n').forEach((w, i) => { if (!FREQ.has(w)) FREQ.set(w, i + 1); });

  // Frequency rank with a crude fallback for inflected forms.
  function rankOf(w) {
    if (FREQ.has(w)) return FREQ.get(w);
    let best = Infinity;
    const tryForm = (f) => { if (f.length > 1 && FREQ.has(f)) best = Math.min(best, FREQ.get(f)); };
    if (w.endsWith("'s")) tryForm(w.slice(0, -2));
    if (w.endsWith('s')) tryForm(w.slice(0, -1));
    if (w.endsWith('es')) tryForm(w.slice(0, -2));
    if (w.endsWith('ies')) tryForm(w.slice(0, -3) + 'y');
    if (w.endsWith('ed')) { tryForm(w.slice(0, -2)); tryForm(w.slice(0, -1)); }
    if (w.endsWith('ing')) { tryForm(w.slice(0, -3)); tryForm(w.slice(0, -3) + 'e'); }
    if (w.endsWith('ly')) tryForm(w.slice(0, -2));
    if (w.endsWith('er')) { tryForm(w.slice(0, -2)); tryForm(w.slice(0, -1)); }
    if (w.endsWith('est')) tryForm(w.slice(0, -3));
    return best;
  }

  // '' = known / not highlighted, otherwise a CSS class.
  function wordLevel(w) {
    const st = S.vocab[w];
    if (st === 1) return settings.hlLearning ? 'ytam-learning' : '';
    if (st === 2) return '';
    if (/^\d/.test(w) || w.length < 2) return '';
    const r = rankOf(w);
    if (r <= settings.vocabSize) return '';
    if (r <= settings.vocabSize + settings.nextSize) return settings.hlNext ? 'ytam-next' : '';
    return settings.hlRare ? 'ytam-rare' : '';
  }

  function statusName(w) {
    const st = S.vocab[w];
    if (st === 1) return 'Изучаю';
    if (st === 2) return 'Знаю';
    return rankOf(w) <= settings.vocabSize ? 'Знаю (по частоте)' : 'Новое';
  }

  function recolor(word) {
    const sel = word ? `.ytam-w[data-w="${CSS.escape(word)}"]` : '.ytam-w';
    document.querySelectorAll(sel).forEach((el) => {
      el.className = ('ytam-w ' + wordLevel(el.dataset.w)).trim();
    });
  }

  async function setWordStatus(w, st) {
    if (st) S.vocab[w] = st; else delete S.vocab[w];
    recolor(w);
    try {
      const { vocab = {} } = await chrome.storage.local.get('vocab');
      if (st) vocab[w] = st; else delete vocab[w];
      await chrome.storage.local.set({ vocab });
    } catch (_) {}
  }

  // Middle click: new → learning → known → new.
  function cycleStatus(w, i) {
    const st = S.vocab[w];
    const next = st === 1 ? 2 : st === 2 ? 0 : 1;
    setWordStatus(w, next);
    toast(`${w}: ${['новое', 'изучаю', 'знаю'][next]}`);
    if (next === 1 && settings.ankiOnLearning && i != null) queueCard(i, { word: w }, true);
  }

  // ---------- subtitles ----------

  const cleanText = (s) => s.replace(/\s+/g, ' ').trim();

  // Parses YouTube json3 into a flat list of timed words.
  function parseJson3(text) {
    if (!text) return [];
    let data;
    try { data = JSON.parse(text); } catch (_) { return []; }
    const events = (data.events || []).filter((e) => e.segs && e.segs.length);
    const wordLevelTimes = events.some((e) => e.segs.some((s) => s.tOffsetMs !== undefined));
    const words = [];

    if (!wordLevelTimes) {
      for (const e of events) {
        const toks = cleanText(e.segs.map((s) => s.utf8 || '').join('')).split(' ').filter(Boolean);
        if (!toks.length) continue;
        const t0 = e.tStartMs / 1000, dur = (e.dDurationMs || 2000) / 1000;
        const total = toks.reduce((a, t) => a + t.length + 1, 0);
        let acc = 0;
        for (const t of toks) {
          const start = t0 + (dur * acc) / total;
          acc += t.length + 1;
          words.push({ text: t, start, end: t0 + (dur * acc) / total });
        }
      }
    } else {
      for (const e of events) {
        if (e.aAppend) continue;
        for (const s of e.segs) {
          const t = cleanText(s.utf8 || '');
          if (!t) continue;
          words.push({ text: t, start: (e.tStartMs + (s.tOffsetMs || 0)) / 1000, evEnd: (e.tStartMs + (e.dDurationMs || 0)) / 1000 });
        }
      }
      words.sort((a, b) => a.start - b.start);
      words.forEach((w, i) => {
        const next = words[i + 1];
        const evLen = w.evEnd > w.start ? w.evEnd - w.start : 1;
        w.end = next && next.start - w.start <= 0.8 ? next.start : w.start + Math.max(0.3, Math.min(0.8, evLen));
      });
    }
    return words;
  }

  // Rule-based grouping of words into phrases.
  function segment(words, maxWords) {
    const cues = [];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
      cur = [];
    };
    words.forEach((w, i) => {
      const next = words[i + 1];
      cur.push(w);
      const sentenceEnd = /[.!?…]["')\]]?$/.test(w.text);
      const clauseEnd = /[,;:—]$/.test(w.text);
      const gap = next ? next.start - w.end : Infinity;
      if (!next || sentenceEnd || gap > 0.6 || cur.length >= maxWords || (clauseEnd && cur.length >= maxWords * 0.6)) flush();
    });
    return cues;
  }

  const normTok = (t) => t.toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N}']/gu, '');

  // Matches the AI's punctuated lines back to the timed words.
  function alignLines(lines, words) {
    const W = words.map((w) => normTok(w.text));
    const cues = [];
    let p = 0, matched = 0, total = 0, prevEnd = words.length ? words[0].start : 0;
    for (const line of lines) {
      const s = cleanText(String(line.s || ''));
      if (!s) continue;
      let first = -1, last = -1;
      for (const tok of s.split(' ').map(normTok).filter(Boolean)) {
        total++;
        for (let q = p; q < Math.min(W.length, p + 6); q++) {
          if (W[q] === tok) {
            if (first < 0) first = q;
            last = q;
            p = q + 1;
            matched++;
            break;
          }
        }
      }
      const start = first >= 0 ? words[first].start : prevEnd;
      const end = last >= 0 ? words[last].end : start + 0.5;
      cues.push({ start, end: Math.max(end, start + 0.3), text: s, tr: String(line.t || '') });
      prevEnd = end;
    }
    return { cues, ratio: total ? matched / total : 0 };
  }

  async function aiProcess(words, token) {
    const key = `ai:${S.videoId}:${S.track.languageCode}:${S.track.kind}:${settings.targetLang}:${settings.maxWords}`;
    const cached = (await chrome.storage.local.get(key))[key];
    if (cached) return cached;

    // ~300-word chunks, cut at the longest pause near the boundary.
    const chunks = [];
    let from = 0;
    while (from < words.length) {
      let to = Math.min(words.length, from + 300);
      if (to < words.length) {
        let best = to, bestGap = -1;
        for (let k = from + 220; k < Math.min(words.length, from + 360); k++) {
          const gap = words[k].start - words[k - 1].end + (/[.!?]$/.test(words[k - 1].text) ? 5 : 0);
          if (gap > bestGap) { bestGap = gap; best = k; }
        }
        to = best;
      }
      chunks.push(words.slice(from, to));
      from = to;
    }

    const results = new Array(chunks.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < chunks.length) {
        const i = next++;
        if (token !== S.token) return;
        const res = await bg({
          type: 'aiSegment',
          text: chunks[i].map((w) => w.text).join(' '),
          tl: settings.targetLang,
          maxWords: settings.maxWords,
          model: settings.aiModel,
        });
        results[i] = alignLines(res.lines, chunks[i]);
        setStatus(`✨ ИИ обрабатывает субтитры… ${++done}/${chunks.length}`);
      }
    }));
    if (token !== S.token) return null;
    const ratio = results.reduce((a, r) => a + r.ratio, 0) / results.length;
    if (ratio < 0.7) throw new Error('ИИ слишком сильно изменил текст');
    const cues = results.flatMap((r) => r.cues);
    for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].start) cues[i].start = cues[i - 1].start;
    try {
      const { aiKeys = [] } = await chrome.storage.local.get('aiKeys');
      aiKeys.push(key);
      const drop = aiKeys.splice(0, Math.max(0, aiKeys.length - 150));
      if (drop.length) await chrome.storage.local.remove(drop);
      await chrome.storage.local.set({ [key]: cues, aiKeys });
    } catch (_) {}
    return cues;
  }

  function cueIndexAt(t) {
    const c = S.cues;
    let lo = 0, hi = c.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (c[m].start <= t + 0.02) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }

  let reqId = 0;
  const pendingReq = new Map();
  function requestPlayer() {
    return new Promise((resolve) => {
      const id = ++reqId;
      pendingReq.set(id, resolve);
      window.postMessage({ __ytamReq: 'playerResponse', id }, '*');
      setTimeout(() => { if (pendingReq.delete(id)) resolve(null); }, 1000);
    });
  }

  async function getPlayerData(videoId, token) {
    for (let i = 0; i < 30; i++) {
      const d = await requestPlayer();
      if (token !== S.token) return null;
      if (d && d.videoId === videoId) return d;
      await sleep(500);
    }
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ytam !== true) return;
    const d = e.data;
    if (d.type === 'playerResponse') {
      const resolve = pendingReq.get(d.id);
      if (resolve) { pendingReq.delete(d.id); resolve(d); }
    } else if (d.type === 'timedtext') {
      let v;
      try { v = new URL(d.url).searchParams.get('v'); } catch (_) { return; }
      if (!v) return;
      S.captured.set(v, { url: d.url, body: d.body });
      if (v === S.videoId && S.waitingCapture && !S.cues.length && S.track) {
        S.waitingCapture = false;
        loadTrack(S.track, S.token);
      }
    }
  });

  async function fetchText(url) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      return r.ok ? await r.text() : '';
    } catch (_) {
      return '';
    }
  }

  // If direct download is blocked, turn on CC so the player requests
  // the subtitles itself (with its token) and we capture that URL.
  async function waitCaptured(videoId, token) {
    if (S.captured.has(videoId)) return S.captured.get(videoId);
    const btn = document.querySelector('#movie_player .ytp-subtitles-button');
    if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (token !== S.token) return null;
      if (S.captured.has(videoId)) return S.captured.get(videoId);
    }
    return null;
  }

  async function loadTrack(track, token) {
    if (!track) return;
    S.track = track;
    setStatus('Загружаю субтитры…');
    let words = parseJson3(await fetchText(track.baseUrl + '&fmt=json3'));

    if (!words.length) {
      const cap = await waitCaptured(S.videoId, token);
      if (token !== S.token) return;
      if (cap) {
        const u = new URL(cap.url);
        const b = new URL(track.baseUrl, location.href);
        for (const k of ['lang', 'kind', 'name']) {
          const val = b.searchParams.get(k);
          if (val) u.searchParams.set(k, val); else u.searchParams.delete(k);
        }
        u.searchParams.delete('tlang');
        u.searchParams.set('fmt', 'json3');
        words = parseJson3(await fetchText(u.href));
        if (!words.length) words = parseJson3(cap.body);
      }
    }
    if (token !== S.token) return;

    if (!words.length) {
      S.waitingCapture = true;
      setStatus('Не получилось загрузить субтитры. Включите CC в плеере — подхвачу автоматически.',
        h('button', { class: 'ytam-link', text: 'Повторить', onclick: () => loadTrack(S.track, S.token) }));
      return;
    }

    S.waitingCapture = false;
    S.words = words;
    document.documentElement.classList.add('ytam-hide-native');
    setCues(segment(words, settings.maxWords));
    setStatus('');
    prefetchWords(token);

    if (settings.aiEnabled) {
      setStatus('✨ ИИ обрабатывает субтитры…');
      try {
        const cues = await aiProcess(words, token);
        if (token !== S.token || !cues) return;
        setCues(cues);
        setStatus('');
        return;
      } catch (e) {
        if (token !== S.token) return;
        setStatus('ИИ-обработка не удалась: ' + e.message + ' Показаны обычные субтитры.');
      }
    }
    translateAll(token);
  }

  function setCues(cues) {
    S.cues = cues;
    S.trans = cues.map((c) => c.tr || null);
    S.active = -1;
    S.shown = -1;
    S.lastAutoPause = -1;
    renderList();
  }

  async function translateAll(token) {
    const tl = settings.targetLang;
    const todo = S.cues.map((_, i) => i).filter((i) => S.trans[i] == null);
    const chunks = [];
    let cur = [], len = 0;
    for (const i of todo) {
      const c = S.cues[i];
      if (cur.length && (len + c.text.length > 1500 || cur.length >= 40)) { chunks.push(cur); cur = []; len = 0; }
      cur.push(i);
      len += c.text.length + 1;
    }
    if (cur.length) chunks.push(cur);

    // Start with what's on screen now.
    const v = getVideo();
    const at = Math.max(0, cueIndexAt(v ? v.currentTime : 0));
    const first = Math.max(0, chunks.findIndex((ch) => ch.includes(at)));
    const ordered = chunks.slice(first).concat(chunks.slice(0, first));

    for (const ch of ordered) {
      if (token !== S.token || tl !== settings.targetLang) return;
      try {
        const out = await bg({ type: 'translateLines', lines: ch.map((i) => S.cues[i].text), tl });
        if (token !== S.token || tl !== settings.targetLang) return;
        ch.forEach((i, k) => { S.trans[i] = out[k] || ''; updateRowTr(i); });
        if (ch.includes(S.shown)) renderOverlay();
      } catch (e) {
        setStatus('Ошибка перевода: ' + e.message);
        await sleep(1500);
      }
    }
  }

  // Translate every distinct word of the video up front so hover is instant.
  async function prefetchWords(token) {
    const tl = settings.targetLang;
    const re = /[\p{L}]+(?:['’-][\p{L}]+)*/gu;
    const set = new Set();
    for (const w of S.words) for (const m of w.text.matchAll(re)) set.add(norm(m[0]));
    const list = [...set].filter((w) => !S.wordTr.has(w));
    for (let i = 0; i < list.length; i += 300) {
      if (token !== S.token || tl !== settings.targetLang) return;
      try {
        const res = await bg({ type: 'translateWords', words: list.slice(i, i + 300), tl });
        for (const [w, t] of Object.entries(res)) S.wordTr.set(w, t);
      } catch (_) {
        await sleep(2000);
      }
    }
  }

  // ---------- UI ----------

  function wordsNode(text, cls) {
    const el = h('div', { class: cls });
    const re = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const w = norm(m[0]);
      el.append(h('span', { class: ('ytam-w ' + wordLevel(w)).trim(), 'data-w': w, text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
    return el;
  }

  function toggle(key, label) {
    const input = h('input', { type: 'checkbox', 'data-k': key, onchange: () => chrome.storage.sync.set({ [key]: input.checked }) });
    return h('label', { class: 'ytam-toggle' }, input, label);
  }

  // Word interactions shared by the panel and the overlay.
  function bindWords(root, cueOf) {
    root.addEventListener('mouseover', (e) => {
      const w = e.target.closest('.ytam-w');
      if (!w || !root.contains(w)) return;
      S.hoverWord = { el: w, i: cueOf(w) };
      if (settings.hoverTranslate && !pop) showTip(w);
    });
    root.addEventListener('mouseout', (e) => {
      const w = e.target.closest('.ytam-w');
      if (!w || (e.relatedTarget && w.contains(e.relatedTarget))) return;
      S.hoverWord = null;
      hideTip();
    });
    root.addEventListener('mousedown', (e) => {
      if (e.button === 1 && e.target.closest('.ytam-w')) e.preventDefault(); // no autoscroll
    });
    root.addEventListener('auxclick', (e) => {
      const w = e.target.closest('.ytam-w');
      if (!w || e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      cycleStatus(w.dataset.w, cueOf(w));
    });
  }

  function createUI() {
    const select = h('select', { class: 'ytam-track', title: 'Дорожка субтитров' });
    select.addEventListener('change', () => {
      S.cues = [];
      renderList();
      loadTrack(S.tracks[+select.value], S.token);
    });
    const status = h('div', { class: 'ytam-status' });
    const list = h('div', { class: 'ytam-list' });
    const collapse = h('button', { class: 'ytam-icon', title: 'Свернуть', text: '–' });
    const gear = h('button', { class: 'ytam-icon', title: 'Настройки и словарь', text: '⚙', onclick: () => bg({ type: 'openOptions' }) });
    const panel = h('div', { id: 'ytam-panel' },
      h('div', { class: 'ytam-head' },
        h('span', { class: 'ytam-logo', text: 'YT → Anki' }),
        select,
        toggle('autoPause', 'Автопауза'),
        toggle('showTranslation', 'Перевод'),
        gear,
        collapse),
      status,
      list,
      h('div', { class: 'ytam-foot' },
        'Наведение — перевод · клик — словарь · ', h('b', { text: 'колесо' }), ' — статус слова · ',
        h('kbd', { text: 'A' }), '/', h('kbd', { text: 'D' }), ' фразы · ',
        h('kbd', { text: 'S' }), ' повтор · ',
        h('kbd', { text: 'Q' }), ' автопауза · ',
        h('kbd', { text: 'E' }), ' фраза в Anki'));

    collapse.addEventListener('click', () => {
      panel.classList.toggle('ytam-collapsed');
      collapse.textContent = panel.classList.contains('ytam-collapsed') ? '+' : '–';
    });
    list.addEventListener('wheel', () => { S.userScrollAt = Date.now(); }, { passive: true });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.ytam-row');
      if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('.ytam-save')) return queueCard(i, null);
      const w = e.target.closest('.ytam-w');
      if (w) return openWord(w, i);
      seekCue(i, true);
    });
    bindWords(list, (w) => +w.closest('.ytam-row').dataset.i);

    const ovText = h('div', { class: 'ytam-ov-text' });
    const ovTr = h('div', { class: 'ytam-ov-tr' });
    const ovBox = h('div', { class: 'ytam-ov-box' }, ovText, ovTr);
    const overlay = h('div', { id: 'ytam-overlay', class: 'ytam-hidden' }, ovBox);
    for (const type of ['mousedown', 'mouseup', 'dblclick', 'click', 'auxclick']) {
      ovBox.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'click') return;
        const w = e.target.closest('.ytam-w');
        if (w && S.shown >= 0) openWord(w, S.shown);
      });
    }
    bindWords(ovBox, () => S.shown);
    ovBox.addEventListener('mouseenter', () => {
      const v = getVideo();
      if (settings.pauseOnHover && v && !v.paused) { v.pause(); S.hoverPaused = true; }
    });
    ovBox.addEventListener('mouseleave', () => { if (!pop) resumeAfterHover(); });

    return { panel, list, status, select, overlay, ovBox, ovText, ovTr, rows: [] };
  }

  function resumeAfterHover() {
    if (!S.hoverPaused) return;
    S.hoverPaused = false;
    if (ui && ui.ovBox.matches(':hover')) return;
    const v = getVideo();
    if (v) v.play();
  }

  function setStatus(text, extra) {
    if (!ui) return;
    ui.status.replaceChildren(text, extra || '');
  }

  function renderTracks() {
    ui.select.replaceChildren(...S.tracks.map((t, i) =>
      h('option', { value: String(i), text: t.name + (t.kind === 'asr' ? ' (авто)' : '') })));
    const i = S.tracks.indexOf(S.track);
    if (i >= 0) ui.select.value = String(i);
  }

  const savedKey = (c) => c.start.toFixed(1);

  function renderList() {
    if (!ui) return;
    const frag = document.createDocumentFragment();
    ui.rows = S.cues.map((c, i) => {
      const row = h('div', { class: 'ytam-row' + (S.saved.has(savedKey(c)) ? ' ytam-saved' : ''), 'data-i': String(i) },
        h('button', { class: 'ytam-time', text: fmtTime(c.start), title: 'Перейти' }),
        h('div', { class: 'ytam-body' },
          wordsNode(c.text, 'ytam-text'),
          h('div', { class: 'ytam-tr', text: S.trans[i] || '' })),
        h('button', { class: 'ytam-save', title: 'Фраза в Anki (E)', text: '+' }));
      frag.append(row);
      return row;
    });
    ui.list.replaceChildren(frag);
  }

  function updateRowTr(i) {
    const row = ui && ui.rows[i];
    if (row) row.querySelector('.ytam-tr').textContent = S.trans[i] || '';
  }

  function markRow(cue, cls, on) {
    if (!ui) return;
    const i = S.cues.findIndex((c) => savedKey(c) === savedKey(cue));
    if (ui.rows[i]) ui.rows[i].classList.toggle(cls, on);
  }

  function setActiveRow(a) {
    if (!ui) return;
    const old = ui.rows[S.active];
    if (old) old.classList.remove('ytam-active');
    const row = ui.rows[a];
    if (!row) return;
    row.classList.add('ytam-active');
    if (Date.now() - S.userScrollAt > 4000 && !ui.panel.classList.contains('ytam-collapsed')) {
      ui.list.scrollTo({ top: row.offsetTop - ui.list.clientHeight / 3, behavior: 'smooth' });
    }
  }

  function renderOverlay() {
    if (!ui) return;
    const c = S.cues[S.shown];
    ui.overlay.classList.toggle('ytam-hidden', !c);
    if (!c) return;
    ui.ovText.replaceChildren(...wordsNode(c.text, 'x').childNodes);
    ui.ovTr.textContent = S.trans[S.shown] || '';
  }

  function applySettings() {
    const root = document.documentElement.style;
    root.setProperty('--ytam-c-learning', settings.colorLearning);
    root.setProperty('--ytam-c-next', settings.colorNext);
    root.setProperty('--ytam-c-rare', settings.colorRare);
    if (!ui) return;
    ui.panel.querySelectorAll('input[data-k]').forEach((inp) => { inp.checked = !!settings[inp.dataset.k]; });
    ui.panel.classList.toggle('ytam-no-tr', !settings.showTranslation);
    ui.overlay.classList.toggle('ytam-no-tr', !settings.showTranslation);
    ui.overlay.classList.toggle('ytam-blur', !!settings.blurTranslation);
    ui.overlay.style.setProperty('--ytam-fs', (+settings.fontSize || 26) + 'px');
  }

  async function waitEl(selector, token, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(250);
      if (token !== S.token) return null;
    }
    return null;
  }

  function mountOverlay() {
    const player = document.getElementById('movie_player');
    if (ui && player && ui.overlay.parentNode !== player) player.append(ui.overlay);
  }

  // ---------- hover tooltip ----------

  let tipEl = null, tipFor = null;
  function placeAbove(el, anchor) {
    const r = anchor.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - el.offsetWidth / 2, innerWidth - el.offsetWidth - 8)) + 'px';
    const top = r.top - el.offsetHeight - 6;
    el.style.top = (top > 8 ? top : r.bottom + 6) + 'px';
  }

  async function showTip(span) {
    if (!tipEl) tipEl = h('div', { class: 'ytam-tip' });
    const w = span.dataset.w;
    tipFor = span;
    const fill = (t) => {
      tipEl.replaceChildren(h('b', { text: t || '…' }), h('span', { class: 'ytam-tip-st', text: statusName(w) }));
      placeAbove(tipEl, span);
    };
    layer().append(tipEl);
    fill(S.wordTr.get(w));
    if (!S.wordTr.has(w)) {
      try {
        const res = await bg({ type: 'translateWords', words: [w], tl: settings.targetLang });
        if (res[w]) S.wordTr.set(w, res[w]);
        if (tipFor === span) fill(res[w] || '—');
      } catch (_) {}
    }
  }

  function hideTip() {
    tipFor = null;
    if (tipEl) tipEl.remove();
  }

  // ---------- word popup ----------

  function closePop() {
    if (!pop) return;
    pop.el.remove();
    pop.span.classList.remove('ytam-w-sel');
    pop = null;
    resumeAfterHover();
  }

  async function openWord(span, i) {
    closePop();
    hideTip();
    const word = span.textContent;
    const w = span.dataset.w;
    const v = getVideo();
    if (v && !v.paused) { v.pause(); S.hoverPaused = true; }

    const body = h('div', { class: 'ytam-pop-body', text: S.wordTr.get(w) || 'Перевожу…' });
    const info = { word, meaning: S.wordTr.get(w) || '' };
    const stBtn = (st, label) => h('button', {
      class: 'ytam-st' + ((S.vocab[w] || 0) === st ? ' on' : ''),
      'data-st': String(st),
      text: label,
      onclick: (e) => {
        setWordStatus(w, st);
        e.target.parentNode.querySelectorAll('.ytam-st').forEach((b) => b.classList.toggle('on', +b.dataset.st === st));
      },
    });
    const el = h('div', { class: 'ytam-pop' },
      h('div', { class: 'ytam-pop-word', text: word }),
      body,
      h('div', { class: 'ytam-pop-status' }, stBtn(0, 'Новое'), stBtn(1, 'Изучаю'), stBtn(2, 'Знаю')),
      h('div', { class: 'ytam-pop-actions' },
        h('button', { class: 'ytam-btn', text: '+ Слово в Anki', onclick: () => { setWordStatus(w, 1); queueCard(i, info); closePop(); } }),
        h('button', { class: 'ytam-btn sec', text: '+ Фраза', onclick: () => { queueCard(i, null); closePop(); } })));
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => e.stopPropagation());
    layer().append(el);
    span.classList.add('ytam-w-sel');
    pop = { el, span };
    placeAbove(el, span);

    try {
      const res = await bg({ type: 'lookup', word, tl: settings.targetLang });
      if (!pop || pop.el !== el) return;
      const terms = res.dict.flatMap((d) => d.terms).filter((t) => t.toLowerCase() !== res.translation.toLowerCase());
      info.meaning = [res.translation, ...terms.slice(0, 4)].filter(Boolean).join(', ');
      body.replaceChildren(
        h('div', { class: 'ytam-pop-main', text: res.translation }),
        h('div', { class: 'ytam-pop-dict' }, res.dict.map((d) =>
          h('div', {}, h('i', { text: d.pos + ': ' }), d.terms.join(', ')))));
      placeAbove(el, span);
    } catch (e) {
      if (pop && pop.el === el && !S.wordTr.has(w)) body.textContent = 'Ошибка: ' + e.message;
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.el.contains(e.target)) closePop();
  }, true);

  // ---------- background audio capture ----------
  // While the video plays we keep the last few minutes of its sound in memory
  // (tagged with video time). Saving a phrase cuts it from there — playback
  // is never interrupted.

  const Tap = { v: null, stream: null, ctx: null, proc: null, src: null, srcIds: '', blocks: [], pass: 0, lastEnd: null };
  const TAP_MAX_BLOCKS = 2600; // ~4 min at 48 kHz / 4096

  function tapEnsure(v) {
    if (!settings.includeAudio || !v) return;
    if (Tap.v !== v) {
      try { Tap.stream = v.captureStream(); } catch (_) { Tap.stream = null; }
      Tap.v = v;
      Tap.blocks = [];
      Tap.srcIds = '';
      if (Tap.stream) Tap.stream.addEventListener('addtrack', tapConnect);
    }
    if (!Tap.stream) return;
    if (!Tap.ctx) {
      Tap.ctx = new AudioContext();
      Tap.proc = Tap.ctx.createScriptProcessor(4096, 2, 1);
      const mute = Tap.ctx.createGain();
      mute.gain.value = 0;
      Tap.proc.connect(mute);
      mute.connect(Tap.ctx.destination);
      Tap.proc.onaudioprocess = onAudio;
    }
    if (Tap.ctx.state === 'suspended' && !v.paused) Tap.ctx.resume().catch(() => {});
    tapConnect();
  }

  function tapConnect() {
    if (!Tap.stream || !Tap.ctx) return;
    const tracks = Tap.stream.getAudioTracks().filter((t) => t.readyState === 'live');
    const ids = tracks.map((t) => t.id).join();
    if (!tracks.length || ids === Tap.srcIds) return;
    if (Tap.src) Tap.src.disconnect();
    Tap.src = Tap.ctx.createMediaStreamSource(new MediaStream(tracks));
    Tap.src.connect(Tap.proc);
    Tap.srcIds = ids;
  }

  function onAudio(e) {
    const v = Tap.v;
    if (!v || v.paused || v.seeking || !Tap.src || !S.videoId) { Tap.lastEnd = null; return; }
    const inp = e.inputBuffer;
    const n = inp.length, sr = inp.sampleRate;
    const t1 = v.currentTime;
    const t0 = t1 - (n / sr) * v.playbackRate;
    if (Tap.lastEnd == null || Math.abs(t0 - Tap.lastEnd) > 0.25) Tap.pass++;
    Tap.lastEnd = t1;
    const f = sr >= 44100 ? 2 : 1;
    const c0 = inp.getChannelData(0), c1 = inp.numberOfChannels > 1 ? inp.getChannelData(1) : c0;
    const out = new Int16Array(Math.floor(n / f));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += c0[i * f + k] + c1[i * f + k];
      s /= 2 * f;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    Tap.blocks.push({ t0, t1, pass: Tap.pass, rate: sr / f, data: out });
    if (Tap.blocks.length > TAP_MAX_BLOCKS) Tap.blocks.splice(0, Tap.blocks.length - TAP_MAX_BLOCKS);
  }

  // Audio for [start, end) of video time from the most recent complete pass.
  function tapExtract(start, end) {
    const passes = new Map();
    for (const b of Tap.blocks) {
      if (b.t1 <= start || b.t0 >= end) continue;
      if (!passes.has(b.pass)) passes.set(b.pass, []);
      passes.get(b.pass).push(b);
    }
    let best = null, bestCov = 0;
    for (const bl of passes.values()) {
      const cov = (Math.min(end, bl[bl.length - 1].t1) - Math.max(start, bl[0].t0)) / (end - start);
      if (cov >= bestCov - 0.02) { best = bl; bestCov = cov; }
    }
    if (!best) return null;
    const parts = [];
    let first = null, last = null;
    for (const b of best) {
      const n = b.data.length;
      const i0 = Math.max(0, Math.ceil(((start - b.t0) / (b.t1 - b.t0)) * n));
      const i1 = Math.min(n, Math.floor(((end - b.t0) / (b.t1 - b.t0)) * n));
      if (i1 <= i0) continue;
      parts.push(b.data.subarray(i0, i1));
      if (first == null) first = b.t0 + ((b.t1 - b.t0) * i0) / n;
      last = b.t0 + ((b.t1 - b.t0) * i1) / n;
    }
    if (!parts.length) return null;
    const data = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { data.set(p, o); o += p.length; }
    return { data, rate: best[0].rate, t0: first, t1: last, cov: bestCov };
  }

  // Snap clip edges to nearby pauses (YouTube timings are often off).
  function trimClip(ext, cueStart, cueEnd) {
    const { data, rate } = ext;
    const frame = Math.max(1, Math.round(rate * 0.02));
    const nF = Math.floor(data.length / frame);
    const fAt = (t) => Math.max(0, Math.min(nF - 1, Math.round(((t - ext.t0) / (ext.t1 - ext.t0)) * data.length / frame)));
    let sF = fAt(cueStart - settings.padStart), eF = fAt(cueEnd + settings.padEnd);

    if (settings.smartTrim && nF > 10) {
      const rms = new Float32Array(nF);
      for (let f = 0; f < nF; f++) {
        let s = 0;
        for (let i = f * frame; i < (f + 1) * frame; i++) s += data[i] * data[i];
        rms[f] = Math.sqrt(s / frame);
      }
      const sorted = Array.from(rms).sort((a, b) => a - b);
      const thr = Math.max(250, sorted[Math.floor(nF * 0.9)] * 0.12);
      // start: walk back from the cue start to the first quiet spot
      for (let f = fAt(cueStart), lim = fAt(cueStart - 0.6); f > lim; f--) {
        if (rms[f] < thr && rms[f - 1] < thr) { sF = Math.max(0, f - 2); break; }
      }
      // end: walk forward from the cue end to the first 160 ms of quiet
      for (let f = fAt(cueEnd - 0.15), lim = fAt(cueEnd + 0.8), run = 0; f <= lim; f++) {
        run = rms[f] < thr ? run + 1 : 0;
        if (run >= 8) { eF = Math.min(nF, f - run + 4); break; }
      }
    }
    const out = data.slice(sF * frame, Math.max(sF + 1, eF) * frame);
    const fade = Math.min(out.length >> 1, Math.round(rate * 0.012));
    for (let i = 0; i < fade; i++) {
      out[i] = (out[i] * i) / fade;
      out[out.length - 1 - i] = (out[out.length - 1 - i] * i) / fade;
    }
    return out;
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function encodeMp3(pcm, rate) {
    const enc = new lamejs.Mp3Encoder(1, rate, 96);
    const parts = [];
    for (let i = 0; i < pcm.length; i += 1152) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
      if (b.length) parts.push(b);
    }
    const end = enc.flush();
    if (end.length) parts.push(end);
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.length), o); o += p.length; }
    return toBase64(out);
  }

  function snapshot(v) {
    try {
      if (!v || !v.videoWidth) return null;
      const scale = Math.min(1, 640 / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82).split(',')[1];
    } catch (_) {
      return null;
    }
  }

  // ---------- saving cards ----------

  function highlight(text, word) {
    const html = esc(text);
    if (!word) return html;
    const w = esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${w})(?=$|[^\\p{L}\\p{N}])`, 'iu'), '$1<b>$2</b>');
  }

  // Saving is instant for the user; the card goes to Anki once the
  // phrase's audio has been played (usually already the case).
  function queueCard(i, wordInfo, quiet) {
    const cue = S.cues[i];
    if (!cue) return;
    const v = getVideo();
    const near = v && v.currentTime > cue.start - 1 && v.currentTime < cue.end + 1.5;
    S.pending.push({
      videoId: S.videoId,
      title: S.title,
      cue: { start: cue.start, end: cue.end, text: cue.text },
      translation: S.trans[i],
      word: wordInfo ? wordInfo.word : '',
      meaning: wordInfo ? (wordInfo.meaning || S.wordTr.get(norm(wordInfo.word)) || '') : '',
      image: settings.includeImage && near ? snapshot(v) : null,
      queuedAt: Date.now(),
    });
    markRow(cue, 'ytam-pending', true);
    if (!quiet) toast(wordInfo ? `✓ Сохранено: ${wordInfo.word}` : '✓ Фраза сохранена', 'ok');
    processPending(false);
  }

  function processPending(force) {
    if (!S.pending.length) return;
    const v = getVideo();
    for (const item of [...S.pending]) {
      let ready = force || !settings.includeAudio || Date.now() - item.queuedAt > 10 * 60 * 1000;
      if (!ready) {
        const ext = tapExtract(item.cue.start - 0.7, item.cue.end + 0.9);
        ready = !!ext && ext.cov > 0.97;
        // Seeked away / phrase passed without being fully heard: don't wait forever.
        if (!ready && v && !v.paused && item.videoId === S.videoId &&
            (v.currentTime > item.cue.end + 5 || v.currentTime < item.cue.start - 30)) ready = Date.now() - item.queuedAt > 3000;
      }
      if (!ready) continue;
      S.pending.splice(S.pending.indexOf(item), 1);
      finalizeCard(item);
    }
  }

  async function finalizeCard(item) {
    const { cue } = item;
    try {
      let audio = null;
      if (settings.includeAudio) {
        const ext = tapExtract(cue.start - 0.7, cue.end + 0.9);
        if (ext && ext.cov > 0.5) audio = encodeMp3(trimClip(ext, cue.start, cue.end), ext.rate);
      }
      let translation = item.translation;
      if (translation == null) {
        try { translation = (await bg({ type: 'translateLines', lines: [cue.text], tl: settings.targetLang }))[0]; } catch (_) { translation = ''; }
      }
      let meaning = item.meaning;
      if (item.word) {
        try {
          const res = await bg({ type: 'lookup', word: item.word, tl: settings.targetLang });
          const terms = res.dict.flatMap((d) => d.terms).filter((t) => t.toLowerCase() !== res.translation.toLowerCase());
          meaning = [res.translation, ...terms.slice(0, 4)].filter(Boolean).join(', ');
        } catch (_) {}
      }
      await bg({
        type: 'addCard',
        card: {
          deck: settings.deck || DEFAULTS.deck,
          videoId: item.videoId,
          title: item.title,
          start: cue.start,
          sentenceHtml: highlight(cue.text, item.word),
          translation,
          word: item.word,
          wordMeaning: meaning,
          audio,
          image: item.image,
        },
      });
      if (item.videoId === S.videoId) {
        S.saved.add(savedKey(cue));
        markRow(cue, 'ytam-pending', false);
        markRow(cue, 'ytam-saved', true);
      }
      if (settings.includeAudio && !audio) toast('Карточка добавлена без аудио — фраза не прозвучала', 'warn', 3500);
    } catch (e) {
      if (item.videoId === S.videoId) markRow(cue, 'ytam-pending', false);
      toast('✗ Anki: ' + e.message, 'err', 7000);
    }
  }

  // ---------- playback control ----------

  function seekCue(i, play) {
    const v = getVideo();
    const c = S.cues[i];
    if (!v || !c) return;
    S.lastAutoPause = -1;
    v.currentTime = c.start;
    if (play) v.play();
  }

  let pendingTick = 0;
  function tick() {
    if (!S.videoId) return;
    const v = getVideo();
    if (!v) return;
    tapEnsure(v);
    if (++pendingTick % 5 === 0) processPending(false);
    if (!S.cues.length || !ui) return;
    mountOverlay();
    const t = v.currentTime;
    const a = cueIndexAt(t);
    if (a !== S.active) { setActiveRow(a); S.active = a; }
    const c = S.cues[a];
    const shown = c && t <= c.end + 0.25 ? a : -1;
    if (shown !== S.shown) { S.shown = shown; renderOverlay(); }

    if (settings.autoPause && c && !v.paused) {
      const next = S.cues[a + 1];
      const endT = Math.max(c.start + 0.3, Math.min(c.end, next ? next.start : Infinity) - 0.06);
      if (t >= endT && S.lastAutoPause !== a) {
        S.lastAutoPause = a;
        v.pause();
      }
    }
  }
  setInterval(tick, 50);

  document.addEventListener('pointerdown', () => {
    if (Tap.ctx && Tap.ctx.state === 'suspended') Tap.ctx.resume().catch(() => {});
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && pop) { closePop(); return; }
    if (!S.cues.length || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    // Status hotkeys while hovering a word.
    if (S.hoverWord && /^Digit[0-2]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      const st = +e.code.slice(5);
      const w = S.hoverWord.el.dataset.w;
      setWordStatus(w, st);
      toast(`${w}: ${['новое', 'изучаю', 'знаю'][st]}`);
      if (st === 1 && settings.ankiOnLearning) queueCard(S.hoverWord.i, { word: w }, true);
      return;
    }

    const cur = Math.max(0, S.active);
    const actions = {
      KeyA: () => seekCue(Math.max(0, cur - 1), true),
      KeyD: () => seekCue(Math.min(S.cues.length - 1, cur + 1), true),
      KeyS: () => seekCue(cur, true),
      KeyQ: () => {
        chrome.storage.sync.set({ autoPause: !settings.autoPause });
        toast(!settings.autoPause ? 'Автопауза включена' : 'Автопауза выключена');
      },
      KeyE: () => queueCard(cur, null),
    };
    const fn = actions[e.code];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }, true);

  // ---------- lifecycle ----------

  function teardown() {
    processPending(true);
    S.token++;
    S.videoId = null;
    S.cues = [];
    S.words = [];
    S.track = null;
    S.saved = new Set();
    S.waitingCapture = false;
    closePop();
    hideTip();
    document.documentElement.classList.remove('ytam-hide-native');
    if (ui) { ui.panel.remove(); ui.overlay.remove(); }
  }

  async function start(videoId) {
    teardown();
    const token = S.token;
    S.videoId = videoId;
    if (!ui) ui = createUI();
    applySettings();
    renderList();
    renderTracks();
    setStatus('Загружаю субтитры…');

    const container = await waitEl('#secondary-inner, #secondary', token);
    if (token !== S.token) return;
    if (container) container.prepend(ui.panel);

    const data = await getPlayerData(videoId, token);
    if (token !== S.token) return;
    if (!data) return setStatus('Не удалось получить данные плеера. Обновите страницу.');
    S.title = data.title || document.title;
    S.tracks = data.tracks;
    if (!S.tracks.length) return setStatus('У этого видео нет субтитров.');

    const en = (t) => /^en/i.test(t.languageCode);
    S.track = S.tracks.find((t) => en(t) && t.kind !== 'asr') || S.tracks.find(en) || S.tracks[0];
    renderTracks();
    loadTrack(S.track, token);
  }

  function onNavigate() {
    const id = new URLSearchParams(location.search).get('v');
    if (!settings.enabled || location.pathname !== '/watch' || !id) {
      if (S.videoId) teardown();
      return;
    }
    if (id !== S.videoId) start(id);
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  setInterval(onNavigate, 1000);
  window.addEventListener('pagehide', () => processPending(true));

  Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get({ vocab: {} })]).then(([s, l]) => {
    settings = { ...DEFAULTS, ...s };
    S.vocab = l.vocab || {};
    applySettings();
    onNavigate();
  });

  const RELOAD_KEYS = ['aiEnabled', 'aiModel', 'maxWords', 'targetLang'];
  const RECOLOR_KEYS = ['vocabSize', 'nextSize', 'hlLearning', 'hlNext', 'hlRare'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.vocab) { S.vocab = changes.vocab.newValue || {}; recolor(); }
      return;
    }
    if (area !== 'sync') return;
    const reload = RELOAD_KEYS.some((k) => changes[k] && changes[k].newValue !== settings[k]);
    for (const k in changes) settings[k] = changes[k].newValue;
    applySettings();
    if (RECOLOR_KEYS.some((k) => changes[k])) recolor();
    if (changes.targetLang) S.wordTr = new Map();
    if (changes.enabled) { if (!settings.enabled) teardown(); onNavigate(); }
    if (reload && S.track && S.words.length) { S.token++; loadTrack(S.track, S.token); }
  });
})();
