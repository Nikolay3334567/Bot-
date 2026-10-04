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

  // LR scheme: known = green, recommended = orange, rare = purple,
  // learning (saved to Anki) = outlined box.
  function wordLevel(w) {
    const st = S.vocab[w];
    if (st === 1) return settings.hlLearning ? 'ytam-learning' : '';
    if (st === 2) return settings.hlKnown ? 'ytam-known' : '';
    if (/^\d/.test(w)) return '';
    const r = rankOf(w);
    if (r <= settings.vocabSize) return settings.hlKnown ? 'ytam-known' : '';
    if (r <= settings.vocabSize + settings.nextSize) return settings.hlNext ? 'ytam-next' : '';
    return settings.hlRare ? 'ytam-rare' : '';
  }

  const isKnown = (w) => S.vocab[w] === 2 || (S.vocab[w] !== 1 && rankOf(w) <= settings.vocabSize);

  function spanClass(el) {
    let c = 'ytam-w ' + wordLevel(el.dataset.w);
    if (el.dataset.xl === '1' && settings.hlLearning) c = c.replace(/ytam-(known|next|rare)/, '') + ' ytam-learning';
    return c.replace(/\s+/g, ' ').trim();
  }

  function recolor(word) {
    const sel = word ? `.ytam-w[data-w="${CSS.escape(word)}"]` : '.ytam-w';
    document.querySelectorAll(sel).forEach((el) => { el.className = spanClass(el); });
  }

  async function setWordStatus(w, st) {
    if (st) S.vocab[w] = st; else delete S.vocab[w];
    if (w.includes(' ')) { renderList(); renderOverlay(); } else recolor(w);
    try {
      const { vocab = {} } = await chrome.storage.local.get('vocab');
      if (st) vocab[w] = st; else delete vocab[w];
      await chrome.storage.local.set({ vocab });
    } catch (_) {}
  }

  // Right / middle click (LR): learning ↔ known; anything else → learning.
  function toggleStatus(w, i, meaning) {
    const next = S.vocab[w] === 1 ? 2 : 1;
    setWordStatus(w, next);
    toast(`${w}: ${next === 1 ? 'изучаю' : 'знаю'}`);
    if (next === 1 && settings.ankiOnLearning && i != null) queueCard(i, { word: w, meaning }, true);
  }

  // ---------- expressions (idioms, phrasal verbs) ----------

  const TOKEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  const tokensOf = (text) => [...text.matchAll(TOKEN_RE)].map((m) => norm(m[0]));
  const POSSESSIVE = new Set(['my', 'your', 'his', 'her', 'our', 'their', 'its', 'one\'s']);

  const EXPR_BY_FORM = new Map();
  (() => {
    const irr = self.YTAM_IRREGULAR || {};
    const formsOf = (b) => {
      const f = new Set([b, b + 's', b + 'es', b + 'ed', b + 'd', b + 'ing']);
      if (b.endsWith('e')) f.add(b.slice(0, -1) + 'ing');
      if (b.endsWith('y')) { f.add(b.slice(0, -1) + 'ies'); f.add(b.slice(0, -1) + 'ied'); }
      for (const x of (irr[b] || '').split(' ')) if (x) f.add(x);
      return f;
    };
    for (const p of (self.YTAM_EXPR || '').split('|')) {
      const toks = tokensOf(p);
      if (toks.length < 2) continue;
      for (const f of formsOf(toks[0])) {
        if (!EXPR_BY_FORM.has(f)) EXPR_BY_FORM.set(f, []);
        EXPR_BY_FORM.get(f).push({ p, toks });
      }
    }
  })();

  const tokEq = (pattern, tok) => pattern === tok || (pattern === 'your' && POSSESSIVE.has(tok));

  // Finds pattern tokens in order; small gaps allowed ("pick it up").
  function findSeq(toks, pat, from = 0) {
    for (let i = from; i < toks.length; i++) {
      const idx = [];
      let j = i;
      for (let k = 0; k < pat.length; k++) {
        let found = -1;
        for (let g = 0; g <= (k === 0 ? 0 : 2) && j + g < toks.length; g++) {
          if (tokEq(pat[k], toks[j + g])) { found = j + g; break; }
        }
        if (found < 0) break;
        idx.push(found);
        j = found + 1;
      }
      if (idx.length === pat.length) return idx;
    }
    return null;
  }

  function cueExpr(c) {
    if (c._expr) return c._expr;
    const toks = tokensOf(c.text);
    const spans = [...c.text.matchAll(new RegExp(TOKEN_RE.source, 'gu'))];
    const out = [];
    const seen = new Set();
    const add = (p, t, idx) => {
      const key = idx.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const a = spans[idx[0]], b = spans[idx[idx.length - 1]];
      const surf = c.text.slice(a.index, b.index + b[0].length); // as written in the phrase
      out.push({ p, t, idx, key: norm(p), surf });
    };
    for (const x of c.x || []) {
      const pat = tokensOf(String(x.p || ''));
      if (pat.length < 2) continue;
      const idx = findSeq(toks, pat);
      if (idx) add(x.p, x.t || '', idx);
    }
    if (settings.builtinExpr) {
      toks.forEach((tok, i) => {
        for (const e of EXPR_BY_FORM.get(tok) || []) {
          const idx = findSeq(toks, [tok, ...e.toks.slice(1)], i);
          if (idx && idx[0] === i) add(e.p, '', idx);
        }
      });
    }
    // Longest expressions first.
    out.sort((a, b) => b.idx.length - a.idx.length);
    c._expr = out;
    return out;
  }

  function exprTr(e) {
    return e.t || S.wordTr.get(e.key) || '';
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
      cues.push({ start, end: Math.max(end, start + 0.3), text: s, tr: String(line.t || ''), x: line.x || [] });
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
    await saveAiCache(key, cues);
    return cues;
  }

  async function saveAiCache(key, cues) {
    try {
      const { aiKeys = [] } = await chrome.storage.local.get('aiKeys');
      aiKeys.push(key);
      const drop = aiKeys.splice(0, Math.max(0, aiKeys.length - 150));
      if (drop.length) await chrome.storage.local.remove(drop);
      await chrome.storage.local.set({ [key]: cues.map(({ _expr, ...c }) => c), aiKeys });
    } catch (_) {}
  }

  // Gemini listens to the video itself; YouTube word timings (if any) refine the times.
  async function aiVideoProcess(words, token) {
    const key = `aiv:${S.videoId}:${settings.targetLang}:${settings.maxWords}:${settings.aiModel}`;
    const cached = (await chrome.storage.local.get(key))[key];
    if (cached) return cached;
    let dur = 0;
    for (let i = 0; i < 40 && !(dur > 0 && isFinite(dur)); i++) {
      const v = getVideo();
      dur = v ? v.duration : 0;
      if (!(dur > 0 && isFinite(dur))) await sleep(250);
      if (token !== S.token) return null;
    }
    if (!(dur > 0 && isFinite(dur))) throw new Error('неизвестна длительность видео');

    const CHUNK = 600;
    const ranges = [];
    if (dur <= 12 * 60) ranges.push([0, dur]);
    else for (let t = 0; t < dur; t += CHUNK) ranges.push([t, Math.min(dur, t + CHUNK)]);

    const results = new Array(ranges.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < ranges.length) {
        const i = next++;
        if (token !== S.token) return;
        const [from, to] = ranges[i];
        const res = await bg({ type: 'aiVideo', videoId: S.videoId, from, to, tl: settings.targetLang, maxWords: settings.maxWords, model: settings.aiModel });
        results[i] = res.lines.filter((l) => l.b >= from - 5 && l.b < to + 5);
        setStatus(`🎧 ИИ слушает видео… ${++done}/${ranges.length}`);
      }
    }));
    if (token !== S.token) return null;

    let cues = results.flat().map((l) => ({ start: +l.b || 0, end: +l.e || (+l.b + 2), text: cleanText(String(l.s)), tr: String(l.t || ''), x: l.x || [] }))
      .filter((c) => c.text);
    cues.sort((a, b) => a.start - b.start);
    if (!cues.length) throw new Error('ИИ не вернул субтитры');

    // Snap to YouTube's word timings where the text matches.
    if (words.length) {
      const W = words.map((w) => normTok(w.text));
      let p = 0;
      for (const c of cues) {
        while (p < words.length && words[p].start < c.start - 2.5) p++;
        while (p > 0 && words[p - 1].start >= c.start - 2.5) p--;
        let q = p, first = -1, last = -1, hits = 0;
        const toks = c.text.split(' ').map(normTok).filter(Boolean);
        for (const tok of toks) {
          for (let k = q; k < Math.min(W.length, q + 8); k++) {
            if (W[k] === tok) { if (first < 0) first = k; last = k; q = k + 1; hits++; break; }
          }
        }
        if (toks.length && hits / toks.length >= 0.5) {
          c.start = words[first].start;
          c.end = Math.max(words[last].end, c.start + 0.3);
          p = last + 1;
        }
      }
      cues.sort((a, b) => a.start - b.start);
    }
    for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].start) cues[i].start = cues[i - 1].start;
    await saveAiCache(key, cues);
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

    if (settings.aiMode === 'text' || settings.aiMode === 'audio') {
      setStatus(settings.aiMode === 'audio' ? '🎧 ИИ слушает видео…' : '✨ ИИ обрабатывает субтитры…');
      try {
        const cues = settings.aiMode === 'audio' ? await aiVideoProcess(words, token) : await aiProcess(words, token);
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
    for (const c of S.cues) for (const e of cueExpr(c)) if (!e.t) set.add(e.key);
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

  function wordsNode(text, cls, cueIdx) {
    const el = h('div', { class: cls });
    const c = S.cues[cueIdx];
    const learnedTok = new Set();
    if (c) for (const e of cueExpr(c)) if (S.vocab[e.key] === 1) e.idx.forEach((k) => learnedTok.add(k));
    const re = new RegExp(TOKEN_RE.source, 'gu');
    let last = 0, m, ti = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const span = h('span', { 'data-w': norm(m[0]), 'data-ti': String(ti), text: m[0] });
      if (learnedTok.has(ti)) span.dataset.xl = '1';
      span.className = spanClass(span);
      el.append(span);
      ti++;
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
      if (settings.hoverTranslate && !pop) showTip(w, cueOf(w));
    });
    root.addEventListener('mouseout', (e) => {
      const w = e.target.closest('.ytam-w');
      if (!w || (e.relatedTarget && w.contains(e.relatedTarget))) return;
      S.hoverWord = null;
      scheduleHideTip();
    });
    root.addEventListener('mousedown', (e) => {
      if (e.button === 1 && e.target.closest('.ytam-w')) e.preventDefault(); // no autoscroll
    });
    const statusClick = (e) => {
      const w = e.target.closest('.ytam-w');
      if (!w) return;
      e.preventDefault();
      e.stopPropagation();
      toggleStatus(w.dataset.w, cueOf(w));
      if (tipFor === w) showTip(w, cueOf(w));
    };
    root.addEventListener('contextmenu', statusClick);
    root.addEventListener('auxclick', (e) => { if (e.button === 1) statusClick(e); });
  }

  const STAR = '☆', STAR_ON = '★';

  function createUI() {
    const select = h('select', { class: 'ytam-track', title: 'Дорожка субтитров' });
    select.addEventListener('change', () => {
      S.cues = [];
      renderList();
      S.token++;
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
        'Наведение — перевод · клик — словарь · ', h('b', { text: 'правая кнопка' }), ' — знаю/изучаю · ',
        h('kbd', { text: 'A' }), '/', h('kbd', { text: 'D' }), ' фразы · ',
        h('kbd', { text: 'S' }), ' повтор · ',
        h('kbd', { text: 'Q' }), ' автопауза · ',
        h('kbd', { text: 'E' }), ' ☆ фраза'));

    collapse.addEventListener('click', () => {
      panel.classList.toggle('ytam-collapsed');
      collapse.textContent = panel.classList.contains('ytam-collapsed') ? '+' : '–';
    });
    list.addEventListener('wheel', () => { S.userScrollAt = Date.now(); }, { passive: true });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.ytam-row');
      if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('.ytam-star')) return queueCard(i, null);
      if (e.target.closest('.ytam-play')) return seekCue(i, true);
      const w = e.target.closest('.ytam-w');
      if (w) return openWord(w, i);
      seekCue(i, true);
    });
    bindWords(list, (w) => +w.closest('.ytam-row').dataset.i);

    const ovText = h('div', { class: 'ytam-ov-text' });
    const ovTr = h('div', { class: 'ytam-ov-tr' });
    const ovPlay = h('button', { class: 'ytam-play', title: 'Повторить фразу (S)', onclick: () => seekCue(S.shown, true) });
    const ovStar = h('button', { class: 'ytam-star', title: 'Фраза в Anki (E)', text: STAR, onclick: () => queueCard(S.shown, null) });
    const ovBox = h('div', { class: 'ytam-ov-box' }, ovText);
    const ovLine = h('div', { class: 'ytam-ov-line' }, ovPlay, ovBox, ovStar);
    const overlay = h('div', { id: 'ytam-overlay', class: 'ytam-hidden' }, ovLine, ovTr);
    for (const type of ['mousedown', 'mouseup', 'dblclick', 'click', 'auxclick', 'contextmenu']) {
      ovLine.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'click') return;
        const w = e.target.closest('.ytam-w');
        if (w && S.shown >= 0) openWord(w, S.shown);
      });
    }
    bindWords(ovBox, () => S.shown);
    ovLine.addEventListener('mouseenter', () => {
      const v = getVideo();
      if (settings.pauseOnHover && v && !v.paused) { v.pause(); S.hoverPaused = true; }
    });
    ovLine.addEventListener('mouseleave', () => { if (!pop) resumeAfterHover(); });

    return { panel, list, status, select, overlay, ovLine, ovBox, ovText, ovTr, ovStar, rows: [] };
  }

  function resumeAfterHover() {
    if (!S.hoverPaused) return;
    S.hoverPaused = false;
    if (ui && ui.ovLine.matches(':hover')) return;
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
      const saved = S.saved.has(savedKey(c));
      const row = h('div', { class: 'ytam-row' + (saved ? ' ytam-saved' : ''), 'data-i': String(i) },
        h('button', { class: 'ytam-play', title: `Воспроизвести · ${fmtTime(c.start)}` }),
        h('div', { class: 'ytam-body' },
          wordsNode(c.text, 'ytam-text', i),
          h('div', { class: 'ytam-tr', text: S.trans[i] || '' })),
        h('button', { class: 'ytam-star', title: 'Фраза в Anki (E)', text: saved ? STAR_ON : STAR }));
      frag.append(row);
      return row;
    });
    const top = ui.list.scrollTop;
    ui.list.replaceChildren(frag);
    ui.list.scrollTop = top;
    if (ui.rows[S.active]) ui.rows[S.active].classList.add('ytam-active');
  }

  function updateRowTr(i) {
    const row = ui && ui.rows[i];
    if (row) row.querySelector('.ytam-tr').textContent = S.trans[i] || '';
  }

  function markRow(cue, cls, on) {
    if (!ui) return;
    const i = S.cues.findIndex((c) => savedKey(c) === savedKey(cue));
    const row = ui.rows[i];
    if (row) {
      row.classList.toggle(cls, on);
      row.querySelector('.ytam-star').textContent = row.matches('.ytam-saved, .ytam-pending') ? STAR_ON : STAR;
    }
    if (i === S.shown) renderOverlayStar();
  }

  function renderOverlayStar() {
    const row = ui && ui.rows[S.shown];
    const on = !!row && row.matches('.ytam-saved, .ytam-pending');
    ui.ovStar.textContent = on ? STAR_ON : STAR;
    ui.ovStar.classList.toggle('on', on);
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
    ui.ovText.replaceChildren(...wordsNode(c.text, 'x', S.shown).childNodes);
    ui.ovTr.textContent = S.trans[S.shown] || '';
    renderOverlayStar();
  }

  function applySettings() {
    const root = document.documentElement.style;
    root.setProperty('--ytam-c-known', settings.colorKnown);
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

  // ---------- dictionary prefetch ("buffering") ----------
  // Dictionary entries for words of the current and next phrases are fetched
  // ahead of time so the hover tooltip shows variants instantly.

  const dict = new Map();   // word -> { translation, dict } | Promise
  const dictQueue = [];
  let dictBusy = 0;

  function getDict(w) {
    if (dict.has(w)) return dict.get(w);
    const p = bg({ type: 'lookup', word: w, tl: settings.targetLang })
      .then((r) => { dict.set(w, r); return r; })
      .catch(() => { dict.delete(w); return null; });
    dict.set(w, p);
    return p;
  }

  function prefetchAround(a) {
    const words = [];
    for (let i = Math.max(0, a); i < Math.min(S.cues.length, a + 4); i++) {
      for (const w of tokensOf(S.cues[i].text)) if (!dict.has(w) && w.length > 1 && !/^\d/.test(w)) words.push(w);
    }
    words.sort((x, y) => isKnown(x) - isKnown(y)); // unknown words first
    for (const w of words) if (!dictQueue.includes(w)) dictQueue.push(w);
    pumpDict();
  }

  function pumpDict() {
    while (dictBusy < 2 && dictQueue.length) {
      const w = dictQueue.shift();
      if (dict.has(w)) continue;
      dictBusy++;
      Promise.resolve(getDict(w)).finally(() => { dictBusy--; setTimeout(pumpDict, 120); });
    }
  }

  function variants(w) {
    const d = dict.get(w);
    const out = [];
    const add = (t) => { if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); };
    if (d && !(d instanceof Promise)) {
      add(d.translation);
      for (const e of d.dict) for (const t of e.terms) add(t);
    } else add(S.wordTr.get(w));
    return out;
  }

  // ---------- hover tooltip (LR style) ----------

  let tipEl = null, tipFor = null, tipHideTimer = 0;

  function placeAbove(el, anchor, gap = 10) {
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - el.offsetWidth / 2, innerWidth - el.offsetWidth - 8));
    el.style.left = left + 'px';
    const top = r.top - el.offsetHeight - gap;
    const below = top < 8;
    el.style.top = (below ? r.bottom + gap : top) + 'px';
    el.classList.toggle('below', below);
    el.style.setProperty('--arrow-x', Math.max(14, Math.min(el.offsetWidth - 14, r.left + r.width / 2 - left)) + 'px');
  }

  function scheduleHideTip() {
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => { if (!tipEl || !tipEl.matches(':hover')) hideTip(); }, 220);
  }

  function hideTip() {
    tipFor = null;
    if (tipEl) tipEl.remove();
  }

  function exprsAt(i, ti) {
    const c = S.cues[i];
    return c ? cueExpr(c).filter((e) => e.idx.includes(ti)) : [];
  }

  function showTip(span, i) {
    clearTimeout(tipHideTimer);
    if (!tipEl) {
      tipEl = h('div', { class: 'ytam-tip' });
      tipEl.addEventListener('mouseleave', scheduleHideTip);
      tipEl.addEventListener('mousedown', (e) => e.stopPropagation());
      tipEl.addEventListener('click', (e) => e.stopPropagation());
    }
    const w = span.dataset.w;
    tipFor = span;
    const exprs = exprsAt(i, +span.dataset.ti).slice(0, 2);

    const fill = () => {
      if (tipFor !== span) return;
      const vars = variants(w).slice(0, 4);
      const st = S.vocab[w];
      tipEl.replaceChildren(
        ...exprs.map((e) => h('div', { class: 'ytam-tip-expr' },
          h('span', { class: 'ytam-tip-phrase', text: e.p }),
          h('span', { text: ' : ' + (exprTr(e) || '…') }),
          h('button', {
            class: 'ytam-tip-save' + (S.vocab[e.key] === 1 ? ' on' : ''),
            title: 'Сохранить выражение в Anki',
            text: '📖',
            onclick: () => {
              setWordStatus(e.key, 1);
              queueCard(i, { word: e.p, meaning: exprTr(e), expr: true, hl: e.surf });
              fill();
            },
          }))),
        h('div', { class: 'ytam-tip-vars' }, vars.length ? vars.map((t) => h('div', { text: t })) : h('div', { text: '…' })),
        h('div', { class: 'ytam-tip-btns' },
          h('button', { class: 'ytam-tb-known' + (isKnown(w) ? ' on' : ''), title: 'Знаю', text: '✓', onclick: () => { setWordStatus(w, 2); fill(); } }),
          h('button', {
            class: 'ytam-tb-learn' + (st === 1 ? ' on' : ''),
            title: 'Изучаю — в Anki',
            text: '📖',
            onclick: () => {
              if (S.vocab[w] === 1) return;
              setWordStatus(w, 1);
              if (settings.ankiOnLearning) queueCard(i, { word: w, meaning: variants(w).slice(0, 3).join(', ') }, true);
              toast(`${w}: изучаю`);
              fill();
            },
          })));
      placeAbove(tipEl, span);
    };

    layer().append(tipEl);
    fill();
    const d = getDict(w);
    if (d instanceof Promise) d.then(fill);
    for (const e of exprs) {
      if (!exprTr(e)) bg({ type: 'translateWords', words: [e.key], tl: settings.targetLang }).then((r) => { if (r[e.key]) { S.wordTr.set(e.key, r[e.key]); fill(); } }).catch(() => {});
    }
  }

  // ---------- word popup (left click) ----------

  const DICT_LINKS = [
    ['Re', 'Reverso Context', (w, tl) => `https://context.reverso.net/translation/english-${({ ru: 'russian', uk: 'ukrainian', de: 'german', fr: 'french', es: 'spanish', it: 'italian', pl: 'polish', tr: 'turkish', ja: 'japanese', 'zh-CN': 'chinese' })[tl] || 'russian'}/${encodeURIComponent(w)}`],
    ['Ca', 'Cambridge', (w, tl) => `https://dictionary.cambridge.org/dictionary/${tl === 'ru' ? 'english-russian' : 'english'}/${encodeURIComponent(w)}`],
    ['Gl', 'Glosbe', (w, tl) => `https://glosbe.com/en/${tl.split('-')[0]}/${encodeURIComponent(w)}`],
    ['Wi', 'Wiktionary', (w) => `https://en.wiktionary.org/wiki/${encodeURIComponent(w)}`],
    ['Wr', 'WordReference', (w, tl) => `https://www.wordreference.com/en${tl.split('-')[0]}/${encodeURIComponent(w)}`],
    ['Yg', 'YouGlish — произношение', (w) => `https://youglish.com/pronounce/${encodeURIComponent(w)}/english`],
    ['Ur', 'Urban Dictionary', (w) => `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(w)}`],
  ];

  const aiCache = new Map();

  function mdLite(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\n/g, '<br>');
  }

  function streamAI(params, out) {
    const key = JSON.stringify(params);
    if (aiCache.has(key)) { out.innerHTML = mdLite(aiCache.get(key)); return; }
    out.innerHTML = '<span class="ytam-dim">Думаю…</span>';
    let text = '';
    let port;
    try { port = chrome.runtime.connect({ name: 'ytam-ai' }); } catch (_) { out.textContent = 'Перезагрузите страницу'; return; }
    port.onMessage.addListener((m) => {
      if (m.delta) { text += m.delta; out.innerHTML = mdLite(text); }
      if (m.done) { aiCache.set(key, text); port.disconnect(); }
      if (m.error) { out.textContent = m.error; port.disconnect(); }
    });
    port.postMessage(params);
  }

  function closePop() {
    if (!pop) return;
    pop.el.remove();
    pop.span.classList.remove('ytam-w-sel');
    pop = null;
    resumeAfterHover();
  }

  function openWord(span, i) {
    // Second click on the same word closes the popup (LR behaviour).
    if (pop && pop.span === span) { closePop(); return; }
    closePop();
    hideTip();
    const word = span.textContent;
    const w = span.dataset.w;
    const cue = S.cues[i];
    if (!cue) return;
    const v = getVideo();
    if (v && !v.paused) { v.pause(); S.hoverPaused = true; }
    const exprs = exprsAt(i, +span.dataset.ti);

    const trLine = h('div', { class: 'ytam-pop-tr', text: variants(w).slice(0, 3).join(', ') || '…' });
    const pill = h('span', { class: 'ytam-pill' });
    const setPill = () => { pill.className = 'ytam-pill ' + (S.vocab[w] === 1 ? 'learning' : isKnown(w) ? 'known' : 'new'); };
    setPill();

    const aiOut = h('div', { class: 'ytam-ai-out' });
    const tabs = [['explain', 'Объяснить'], ['examples', 'Примеры'], ['grammar', 'Грамматика']];
    const tabBtns = tabs.map(([kind, label]) => h('button', {
      class: 'ytam-tab', text: label,
      onclick: () => {
        tabBtns.forEach((b) => b.classList.toggle('on', b.textContent === label));
        streamAI({ kind, word, sentence: cue.text, tl: settings.targetLang }, aiOut);
      },
    }));
    const ask = h('input', { class: 'ytam-ask', type: 'text', placeholder: 'Спросить о фразе…' });
    ask.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && ask.value.trim()) {
        tabBtns.forEach((b) => b.classList.remove('on'));
        streamAI({ kind: 'ask', word, sentence: cue.text, question: ask.value.trim(), tl: settings.targetLang }, aiOut);
        ask.value = '';
      }
    });

    const dictBox = h('div', { class: 'ytam-pop-dict' });
    const fillDict = () => {
      const d = dict.get(w);
      if (!d || d instanceof Promise) return;
      trLine.textContent = variants(w).slice(0, 3).join(', ');
      dictBox.replaceChildren(h('div', { class: 'ytam-dict-word', text: word }),
        ...(d.dict.length ? d.dict.map((e) => h('div', {}, h('i', { text: `(${e.pos}) ` }), e.terms.join(', '))) : [h('div', { text: d.translation })]));
    };

    const examples = S.cues.map((c, k) => k).filter((k) => k !== i && tokensOf(S.cues[k].text).includes(w)).slice(0, 4);
    const statusBtn = (st, text, title) => h('button', {
      class: 'ytam-sb', 'data-st': String(st), text, title,
      onclick: () => {
        if (st === 1 && S.vocab[w] !== 1 && settings.ankiOnLearning) queueCard(i, { word, meaning: variants(w).slice(0, 3).join(', ') }, true);
        setWordStatus(w, st);
        setPill();
        el.querySelectorAll('.ytam-sb').forEach((b) => b.classList.toggle('on', +b.dataset.st === (S.vocab[w] || 0)));
      },
    });

    const el = h('div', { class: 'ytam-pop' },
      h('div', { class: 'ytam-pop-head' },
        pill,
        h('div', { class: 'ytam-pop-title' }, h('div', { class: 'ytam-pop-word', text: word }), trLine),
        h('button', { class: 'ytam-x', title: 'Произнести', text: '🔊', onclick: () => speak(word) }),
        h('button', { class: 'ytam-x', title: 'Закрыть', text: '✕', onclick: closePop })),
      exprs.length ? h('div', { class: 'ytam-pop-exprs' }, exprs.map((e) => h('div', {},
        h('span', { class: 'ytam-tip-phrase', text: e.p }), ' — ' + (exprTr(e) || '…'),
        h('button', { class: 'ytam-tip-save' + (S.vocab[e.key] === 1 ? ' on' : ''), text: '📖', title: 'Выражение в Anki',
          onclick: (ev) => { setWordStatus(e.key, 1); queueCard(i, { word: e.p, meaning: exprTr(e), expr: true, hl: e.surf }); ev.target.classList.add('on'); } })))) : null,
      h('div', { class: 'ytam-tabs' }, tabBtns),
      aiOut,
      ask,
      dictBox,
      examples.length ? h('div', { class: 'ytam-pop-ex' },
        h('div', { class: 'ytam-ex-head', text: 'Примеры из этого видео' }),
        examples.map((k) => h('div', { class: 'ytam-ex', onclick: () => { closePop(); seekCue(k, true); } }, wordsNode(S.cues[k].text, 'x', k)))) : null,
      h('div', { class: 'ytam-pop-links' }, DICT_LINKS.map(([abbr, title, url]) =>
        h('a', { href: url(word, settings.targetLang), target: '_blank', rel: 'noopener', title, text: abbr }))),
      h('div', { class: 'ytam-pop-actions' },
        statusBtn(2, '✓', 'Знаю'),
        statusBtn(1, '📖', 'Изучаю — карточка в Anki'),
        statusBtn(0, '⊘', 'Сбросить статус'),
        h('button', { class: 'ytam-sb', text: STAR, title: 'Только фраза в Anki', onclick: () => { queueCard(i, null); closePop(); } })));
    el.querySelectorAll('.ytam-sb[data-st]').forEach((b) => b.classList.toggle('on', +b.dataset.st === (S.vocab[w] || 0)));
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('contextmenu', (e) => e.stopPropagation());
    layer().append(el);
    span.classList.add('ytam-w-sel');
    pop = { el, span };
    placeAbove(el, span, 14);

    fillDict();
    const d = getDict(w);
    if (d instanceof Promise) d.then(() => { if (pop && pop.el === el) { fillDict(); placeAbove(el, span, 14); } });
    tabBtns[0].click();
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  document.addEventListener('mousedown', (e) => {
    if (!pop || pop.el.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.ytam-w') === pop.span) return; // handled by the click toggle
    closePop();
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
    // Pauses keep the pass going; only a jump in video time (seek) starts a new one.
    if (!v || v.paused || v.seeking || !Tap.src || !S.videoId) return;
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
    const reEsc = (x) => esc(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = word.split(/\s+/).filter(Boolean);
    const B = '(^|[^\\p{L}\\p{N}])', E = '(?=$|[^\\p{L}\\p{N}])';
    const whole = html.replace(new RegExp(`${B}(${parts.map(reEsc).join('[^\\p{L}\\p{N}]+')})${E}`, 'iu'), '$1<b>$2</b>');
    if (whole !== html || parts.length === 1) return whole;
    // Separated phrase ("pick it up"): bold each part.
    return parts.reduce((acc, p) => acc.replace(new RegExp(`${B}(${reEsc(p)})${E}`, 'iu'), '$1<b>$2</b>'), html);
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
      expr: !!(wordInfo && wordInfo.expr),
      hl: wordInfo ? (wordInfo.hl || wordInfo.word) : '',
      meaning: wordInfo ? (wordInfo.meaning || S.wordTr.get(norm(wordInfo.word)) || '') : '',
      image: settings.includeImage && near ? snapshot(v) : null,
      queuedAt: Date.now(),
    });
    markRow(cue, 'ytam-pending', true);
    if (!quiet) toast(wordInfo ? `✓ Сохранено: ${wordInfo.word}` : '★ Фраза сохранена', 'ok');
    processPending(false);
  }

  function processPending(force) {
    if (!S.pending.length) return;
    const v = getVideo();
    for (const item of [...S.pending]) {
      let ready = force || !settings.includeAudio || Date.now() - item.queuedAt > 10 * 60 * 1000;
      if (!ready) {
        const ext = tapExtract(Math.max(0, item.cue.start - 0.7), item.cue.end + 0.9);
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
        const ext = tapExtract(Math.max(0, cue.start - 0.7), cue.end + 0.9);
        if (ext && ext.cov > 0.5) audio = encodeMp3(trimClip(ext, cue.start, cue.end), ext.rate);
      }
      let translation = item.translation;
      if (translation == null) {
        try { translation = (await bg({ type: 'translateLines', lines: [cue.text], tl: settings.targetLang }))[0]; } catch (_) { translation = ''; }
      }
      let meaning = item.meaning;
      if (item.word && item.expr && !meaning) {
        try { meaning = (await bg({ type: 'translateWords', words: [item.word.toLowerCase()], tl: settings.targetLang }))[item.word.toLowerCase()] || ''; } catch (_) {}
      }
      if (item.word && !item.expr) {
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
          sentenceHtml: highlight(cue.text, item.hl || item.word),
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
    if (a !== S.active) { setActiveRow(a); S.active = a; prefetchAround(a); }
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
      if (st === 1 && settings.ankiOnLearning) queueCard(S.hoverWord.i, { word: w, meaning: variants(w).slice(0, 3).join(', ') }, true);
      if (tipFor) showTip(tipFor, S.hoverWord.i);
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
    dictQueue.length = 0;
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
    if (!S.tracks.length) {
      if (settings.aiMode !== 'audio') return setStatus('У этого видео нет субтитров. Включите режим «ИИ слушает видео» — он создаст их сам.');
      S.track = { languageCode: 'ai', kind: 'ai', name: 'ИИ', baseUrl: '' };
      setStatus('🎧 ИИ слушает видео…');
      try {
        const cues = await aiVideoProcess([], token);
        if (token !== S.token || !cues) return;
        document.documentElement.classList.add('ytam-hide-native');
        setCues(cues);
        setStatus('');
        prefetchWords(token);
      } catch (e) {
        if (token === S.token) setStatus('ИИ не смог создать субтитры: ' + e.message);
      }
      return;
    }

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

  const RELOAD_KEYS = ['aiMode', 'aiModel', 'maxWords', 'targetLang'];
  const RERENDER_KEYS = ['vocabSize', 'nextSize', 'hlKnown', 'hlLearning', 'hlNext', 'hlRare', 'builtinExpr'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.vocab) {
        const nv = changes.vocab.newValue || {};
        const keys = new Set([...Object.keys(nv), ...Object.keys(S.vocab)]);
        const diff = [...keys].filter((k) => nv[k] !== S.vocab[k]);
        S.vocab = nv;
        if (!diff.length) return; // our own change, already applied
        if (diff.length > 20 || diff.some((k) => k.includes(' '))) { renderList(); renderOverlay(); } else diff.forEach(recolor);
      }
      return;
    }
    if (area !== 'sync') return;
    const reload = RELOAD_KEYS.some((k) => changes[k] && changes[k].newValue !== settings[k]);
    for (const k in changes) settings[k] = changes[k].newValue;
    applySettings();
    if (RERENDER_KEYS.some((k) => changes[k])) {
      S.cues.forEach((c) => { delete c._expr; });
      renderList();
      renderOverlay();
    }
    if (changes.targetLang) { S.wordTr = new Map(); dict.clear(); aiCache.clear(); }
    if (changes.enabled) { if (!settings.enabled) teardown(); onNavigate(); }
    if (reload && S.track && S.words.length) { S.token++; loadTrack(S.track, S.token); }
  });
})();
