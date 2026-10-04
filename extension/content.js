(() => {
  'use strict';
  if (window.__ytamLoaded) return;
  window.__ytamLoaded = true;

  const DEFAULTS = {
    enabled: true,
    deck: 'English::YouTube',
    targetLang: 'ru',
    autoPause: false,
    pauseOnHover: true,
    showTranslation: true,
    blurTranslation: false,
    includeAudio: true,
    includeImage: true,
    padStart: 0.25,
    padEnd: 0.4,
    fontSize: 26,
  };
  let settings = { ...DEFAULTS };

  const S = {
    videoId: null,
    title: '',
    tracks: [],
    track: null,
    cues: [],
    trans: [],
    saved: new Set(),
    active: -1,
    shown: -1,
    lastAutoPause: -1,
    recording: false,
    token: 0,
    captured: new Map(), // videoId -> { url, body } of the player's own subtitle request
    waitingCapture: false,
    stream: null,
    streamVideo: null,
    hoverPaused: false,
    userScrollAt: 0,
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
  function toast(text, kind = '', ms = 2500) {
    if (!toastEl) toastEl = h('div', { class: 'ytam-toast' });
    toastEl.className = 'ytam-toast ' + kind;
    toastEl.textContent = text;
    layer().append(toastEl);
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastEl.remove(), ms);
  }

  // ---------- subtitles ----------

  function cleanText(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  // Parses YouTube's json3 subtitle format. Auto-generated (ASR) tracks come
  // word-by-word, so those are regrouped into sentence-sized cues.
  function parseJson3(text) {
    if (!text) return [];
    let data;
    try { data = JSON.parse(text); } catch (_) { return []; }
    const events = (data.events || []).filter((e) => e.segs && e.segs.length);
    const wordLevel = events.some((e) => e.segs.some((s) => s.tOffsetMs !== undefined));

    if (!wordLevel) {
      const cues = events
        .map((e) => ({
          start: e.tStartMs / 1000,
          end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000,
          text: cleanText(e.segs.map((s) => s.utf8 || '').join('')),
        }))
        .filter((c) => c.text);
      cues.sort((a, b) => a.start - b.start);
      return cues;
    }

    const words = [];
    for (const e of events) {
      if (e.aAppend) continue;
      for (const s of e.segs) {
        const t = cleanText(s.utf8 || '');
        if (!t) continue;
        words.push({ text: t, start: (e.tStartMs + (s.tOffsetMs || 0)) / 1000, evEnd: (e.tStartMs + (e.dDurationMs || 0)) / 1000 });
      }
    }
    words.sort((a, b) => a.start - b.start);

    const cues = [];
    let cur = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i], next = words[i + 1];
      if (!cur) cur = { start: w.start, words: [] };
      cur.words.push(w.text);
      const gap = next ? next.start - w.start : Infinity;
      const wordEnd = gap <= 1.5 ? next.start : Math.max(w.start + 0.6, Math.min(w.evEnd, w.start + 1.5));
      const sentenceEnd = /[.!?…]["')\]]?$/.test(w.text);
      const tooLong = cur.words.length >= 16 || (w.start - cur.start > 7 && cur.words.length >= 6);
      if (!next || sentenceEnd || tooLong || gap > 1.5) {
        cues.push({ start: cur.start, end: wordEnd, text: cur.words.join(' ') });
        cur = null;
      }
    }
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
  const pending = new Map();
  function requestPlayer() {
    return new Promise((resolve) => {
      const id = ++reqId;
      pending.set(id, resolve);
      window.postMessage({ __ytamReq: 'playerResponse', id }, '*');
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, 1000);
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
      const resolve = pending.get(d.id);
      if (resolve) { pending.delete(d.id); resolve(d); }
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
    let cues = parseJson3(await fetchText(track.baseUrl + '&fmt=json3'));

    if (!cues.length) {
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
        cues = parseJson3(await fetchText(u.href));
        if (!cues.length) cues = parseJson3(cap.body);
      }
    }
    if (token !== S.token) return;

    if (!cues.length) {
      S.waitingCapture = true;
      setStatus('Не получилось загрузить субтитры. Включите CC в плеере — подхвачу автоматически.',
        h('button', { class: 'ytam-link', text: 'Повторить', onclick: () => loadTrack(S.track, S.token) }));
      return;
    }

    S.waitingCapture = false;
    S.cues = cues;
    S.trans = new Array(cues.length).fill(null);
    S.saved = new Set();
    S.active = -1;
    S.shown = -1;
    S.lastAutoPause = -1;
    document.documentElement.classList.add('ytam-hide-native');
    renderList();
    setStatus('');
    translateAll(token);
  }

  async function translateAll(token) {
    const tl = settings.targetLang;
    const chunks = [];
    let cur = [], len = 0;
    S.cues.forEach((c, i) => {
      if (cur.length && (len + c.text.length > 1500 || cur.length >= 40)) { chunks.push(cur); cur = []; len = 0; }
      cur.push(i);
      len += c.text.length + 1;
    });
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

  // ---------- UI ----------

  function wordsNode(text, cls) {
    const el = h('div', { class: cls });
    const re = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      el.append(h('span', { class: 'ytam-w', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
    return el;
  }

  function toggle(key, label) {
    const input = h('input', { type: 'checkbox', 'data-k': key, onchange: () => chrome.storage.sync.set({ [key]: input.checked }) });
    return h('label', { class: 'ytam-toggle' }, input, label);
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
    const panel = h('div', { id: 'ytam-panel' },
      h('div', { class: 'ytam-head' },
        h('span', { class: 'ytam-logo', text: 'YT → Anki' }),
        select,
        toggle('autoPause', 'Автопауза'),
        toggle('showTranslation', 'Перевод'),
        collapse),
      status,
      list,
      h('div', { class: 'ytam-foot' },
        h('kbd', { text: 'A' }), '/', h('kbd', { text: 'D' }), ' пред/след · ',
        h('kbd', { text: 'S' }), ' повтор · ',
        h('kbd', { text: 'Q' }), ' автопауза · ',
        h('kbd', { text: 'E' }), ' в Anki · клик по слову — перевод'));

    collapse.addEventListener('click', () => {
      panel.classList.toggle('ytam-collapsed');
      collapse.textContent = panel.classList.contains('ytam-collapsed') ? '+' : '–';
    });
    list.addEventListener('wheel', () => { S.userScrollAt = Date.now(); }, { passive: true });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.ytam-row');
      if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('.ytam-save')) return saveCard(i);
      const w = e.target.closest('.ytam-w');
      if (w) return openWord(w, i);
      seekCue(i, true);
    });

    const ovText = h('div', { class: 'ytam-ov-text' });
    const ovTr = h('div', { class: 'ytam-ov-tr' });
    const ovBox = h('div', { class: 'ytam-ov-box' }, ovText, ovTr);
    const overlay = h('div', { id: 'ytam-overlay', class: 'ytam-hidden' }, ovBox);
    for (const type of ['mousedown', 'mouseup', 'dblclick', 'click']) {
      ovBox.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'click') return;
        const w = e.target.closest('.ytam-w');
        if (w && S.shown >= 0) openWord(w, S.shown);
      });
    }
    ovBox.addEventListener('mouseenter', () => {
      const v = getVideo();
      if (settings.pauseOnHover && v && !v.paused && !S.recording) { v.pause(); S.hoverPaused = true; }
    });
    ovBox.addEventListener('mouseleave', () => { if (!pop) resumeAfterHover(); });

    return { panel, list, status, select, overlay, ovBox, ovText, ovTr, rows: [] };
  }

  function resumeAfterHover() {
    if (!S.hoverPaused) return;
    S.hoverPaused = false;
    if (ui && ui.ovBox.matches(':hover')) return;
    const v = getVideo();
    if (v && !S.recording) v.play();
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

  function renderList() {
    if (!ui) return;
    const frag = document.createDocumentFragment();
    ui.rows = S.cues.map((c, i) => {
      const row = h('div', { class: 'ytam-row' + (S.saved.has(i) ? ' ytam-saved' : ''), 'data-i': String(i) },
        h('button', { class: 'ytam-time', text: fmtTime(c.start), title: 'Перейти' }),
        h('div', { class: 'ytam-body' },
          wordsNode(c.text, 'ytam-text'),
          h('div', { class: 'ytam-tr', text: S.trans[i] || '' })),
        h('button', { class: 'ytam-save', title: 'Сохранить фрагмент в Anki (E)', text: '+' }));
      frag.append(row);
      return row;
    });
    ui.list.replaceChildren(frag);
  }

  function updateRowTr(i) {
    const row = ui && ui.rows[i];
    if (row) row.querySelector('.ytam-tr').textContent = S.trans[i] || '';
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
    ui.ovText.replaceChildren(...wordsNode(c.text, 'ytam-ov-words').childNodes);
    ui.ovTr.textContent = S.trans[S.shown] || '';
  }

  function applySettings() {
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
    const word = span.textContent;
    const v = getVideo();
    if (v && !v.paused && !S.recording) { v.pause(); S.hoverPaused = true; }

    const body = h('div', { class: 'ytam-pop-body', text: 'Перевожу…' });
    const info = { word, meaning: '' };
    const el = h('div', { class: 'ytam-pop' },
      h('div', { class: 'ytam-pop-word', text: word }),
      body,
      h('div', { class: 'ytam-pop-actions' },
        h('button', { class: 'ytam-btn', text: '+ В Anki со словом', onclick: () => saveCard(i, info) }),
        h('button', { class: 'ytam-btn sec', text: '+ Только фраза', onclick: () => saveCard(i) })));
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => e.stopPropagation());
    layer().append(el);
    span.classList.add('ytam-w-sel');
    pop = { el, span };

    const r = span.getBoundingClientRect();
    const w = el.offsetWidth, hgt = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    el.style.top = (r.top - hgt - 8 > 8 ? r.top - hgt - 8 : r.bottom + 8) + 'px';

    try {
      const res = await bg({ type: 'lookup', word, tl: settings.targetLang });
      if (!pop || pop.el !== el) return;
      const terms = res.dict.flatMap((d) => d.terms).filter((t) => t.toLowerCase() !== res.translation.toLowerCase());
      info.meaning = [res.translation, ...terms.slice(0, 4)].filter(Boolean).join(', ');
      body.replaceChildren(
        h('div', { class: 'ytam-pop-main', text: res.translation }),
        h('div', { class: 'ytam-pop-dict' }, res.dict.map((d) =>
          h('div', {}, h('i', { text: d.pos + ': ' }), d.terms.join(', ')))));
      const reposTop = r.top - el.offsetHeight - 8;
      el.style.top = (reposTop > 8 ? reposTop : r.bottom + 8) + 'px';
    } catch (e) {
      if (pop && pop.el === el) body.textContent = 'Ошибка: ' + e.message;
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.el.contains(e.target)) closePop();
  }, true);

  // ---------- recording the clip ----------

  function seekTo(v, t) {
    return new Promise((resolve) => {
      if (Math.abs(v.currentTime - t) < 0.01) return resolve();
      const done = () => { v.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 3000);
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  function snapshot(v) {
    if (!v.videoWidth) return null;
    const scale = Math.min(1, 640 / v.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82).split(',')[1];
  }

  const blobToB64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  async function liveAudioTracks(v) {
    if (!S.stream || S.streamVideo !== v) {
      S.stream = v.captureStream();
      S.streamVideo = v;
    }
    let tracks = S.stream.getAudioTracks().filter((t) => t.readyState === 'live');
    if (tracks.length) return tracks;
    // Audio tracks only show up once the element is playing.
    const t = v.currentTime;
    await v.play().catch(() => {});
    for (let i = 0; i < 30 && !tracks.length; i++) {
      await sleep(50);
      tracks = S.stream.getAudioTracks().filter((tr) => tr.readyState === 'live');
    }
    v.pause();
    await seekTo(v, t);
    return tracks;
  }

  async function recordAudio(v, start, end) {
    const tracks = await liveAudioTracks(v);
    if (!tracks.length) throw new Error('не найдена аудиодорожка');
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, audioBitsPerSecond: 128000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });

    await seekTo(v, start);
    rec.start();
    await v.play().catch(() => {});
    const t0 = Date.now();
    const limit = (end - start) * 1000 + 3000;
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (v.currentTime >= end || v.ended || Date.now() - t0 > limit) { clearInterval(iv); resolve(); }
      }, 15);
    });
    v.pause();
    rec.stop();
    await stopped;
    return blobToB64(new Blob(chunks, { type: 'audio/webm' }));
  }

  async function captureClip(cue) {
    const v = getVideo();
    const start = Math.max(0, cue.start - settings.padStart);
    const end = Math.min(v.duration || Infinity, cue.end + settings.padEnd);
    const rate = v.playbackRate;
    const out = { audio: null, image: null, warn: '' };
    S.recording = true;
    try {
      v.pause();
      if (settings.includeImage) {
        await seekTo(v, (cue.start + cue.end) / 2);
        await sleep(120);
        try { out.image = snapshot(v); } catch (e) { out.warn = 'кадр не сохранён'; }
      }
      if (settings.includeAudio) {
        v.playbackRate = 1;
        try { out.audio = await recordAudio(v, start, end); } catch (e) { out.warn = 'аудио не записано (' + e.message + ')'; }
      }
    } finally {
      v.playbackRate = rate;
      S.recording = false;
    }
    return out;
  }

  function highlight(text, word) {
    const html = esc(text);
    if (!word) return html;
    const w = esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${w})(?=$|[^\\p{L}\\p{N}])`, 'iu'), '$1<b>$2</b>');
  }

  async function saveCard(i, wordInfo) {
    const v = getVideo();
    const cue = S.cues[i];
    if (!v || !cue) return;
    if (S.recording) return toast('Уже записываю фрагмент…');
    const backTo = v.currentTime;
    const resume = !v.paused || S.hoverPaused;
    S.hoverPaused = false;
    closePop();
    toast('🎙 Записываю фрагмент…', '', 0);
    try {
      const media = await captureClip(cue);
      let translation = S.trans[i];
      if (translation == null) {
        try { translation = (await bg({ type: 'translateLines', lines: [cue.text], tl: settings.targetLang }))[0]; } catch (_) { translation = ''; }
      }
      await bg({
        type: 'addCard',
        card: {
          deck: settings.deck || DEFAULTS.deck,
          videoId: S.videoId,
          title: S.title,
          start: cue.start,
          sentenceHtml: highlight(cue.text, wordInfo && wordInfo.word),
          translation,
          word: wordInfo ? wordInfo.word : '',
          wordMeaning: wordInfo ? wordInfo.meaning : '',
          audio: media.audio,
          image: media.image,
        },
      });
      S.saved.add(i);
      if (ui && ui.rows[i]) ui.rows[i].classList.add('ytam-saved');
      toast('✓ Добавлено в «' + settings.deck + '»' + (media.warn ? ' — ' + media.warn : ''), media.warn ? 'warn' : 'ok', 3500);
    } catch (e) {
      toast('✗ ' + e.message, 'err', 7000);
    } finally {
      await seekTo(v, backTo);
      S.lastAutoPause = cueIndexAt(backTo);
      if (resume) v.play();
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

  function tick() {
    if (!S.cues.length || !ui) return;
    const v = getVideo();
    if (!v) return;
    mountOverlay();
    const t = v.currentTime;
    const a = cueIndexAt(t);
    if (a !== S.active) { setActiveRow(a); S.active = a; }
    const c = S.cues[a];
    const shown = c && t <= c.end + 0.25 ? a : -1;
    if (shown !== S.shown) { S.shown = shown; renderOverlay(); }

    if (settings.autoPause && c && !v.paused && !S.recording) {
      const next = S.cues[a + 1];
      const endT = Math.max(c.start + 0.3, Math.min(c.end, next ? next.start : Infinity) - 0.06);
      if (t >= endT && S.lastAutoPause !== a) {
        S.lastAutoPause = a;
        v.pause();
      }
    }
  }
  setInterval(tick, 50);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && pop) { closePop(); return; }
    if (!S.cues.length || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const cur = Math.max(0, S.active);
    const actions = {
      KeyA: () => seekCue(Math.max(0, cur - 1), true),
      KeyD: () => seekCue(Math.min(S.cues.length - 1, cur + 1), true),
      KeyS: () => seekCue(cur, true),
      KeyQ: () => {
        chrome.storage.sync.set({ autoPause: !settings.autoPause });
        toast(!settings.autoPause ? 'Автопауза включена' : 'Автопауза выключена');
      },
      KeyE: () => saveCard(cur),
    };
    const fn = actions[e.code];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }, true);

  // ---------- lifecycle ----------

  function teardown() {
    S.token++;
    S.videoId = null;
    S.cues = [];
    S.track = null;
    S.waitingCapture = false;
    closePop();
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

  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    applySettings();
    onNavigate();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const langChanged = changes.targetLang && changes.targetLang.newValue !== settings.targetLang;
    for (const k in changes) settings[k] = changes[k].newValue;
    applySettings();
    if (changes.enabled) { if (!settings.enabled) teardown(); onNavigate(); }
    if (langChanged && S.cues.length) {
      S.trans = new Array(S.cues.length).fill(null);
      renderList();
      S.active = -1;
      translateAll(S.token);
    }
  });
})();
