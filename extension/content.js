(() => {
  'use strict';
  if (window.__ytamLoaded) return;
  window.__ytamLoaded = true;

  const DEFAULTS = self.YTAM_DEFAULTS;
  let settings = { ...DEFAULTS };
  // Developer parameters (🛠 tab), live-tunable.
  const X = { ...self.YTAM_DEV_DEFAULTS };

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
    helper: { state: 'off', progress: 0, error: '' },
    progress: {},       // word -> Anki card interval in days
    hoverIn: false,     // pointer is over the subtitle line
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

  // Source language of the subtitles (en, de, …) — lets Cloud Translation skip language detection.
  const srcLang = () => (S.track && /^[a-z]{2,3}/i.test(S.track.languageCode || '') && S.track.languageCode !== 'ai' ? S.track.languageCode.slice(0, 2).toLowerCase() : 'en');

  function bg(msg) {
    if ((msg.type === 'translateLines' || msg.type === 'translateWords' || msg.type === 'lookup') && !msg.sl) msg = { ...msg, sl: srcLang() };
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

  // Statuses: 1 = learning (in Anki), 2 = known, 3 = don't learn.
  // LR scheme: known = green, suggested = orange, don't learn / rare = purple,
  // learning = outlined box (and/or colored text).
  const suggestedLimit = () => settings.vocabSize + Math.max(500, settings.vocabSize * (+settings.suggestedRatio || 1));

  function learnClass() {
    return [settings.hlLearning ? 'ytam-learning' : '', settings.hlLearnText ? 'ytam-learn-text' : ''].join(' ');
  }

  function wordLevel(w) {
    const st = S.vocab[w];
    if (st === 1) return learnClass();
    if (st === 2) return settings.hlKnown ? 'ytam-known' : '';
    if (st === 3) return settings.hlRare ? 'ytam-rare' : '';
    if (/^\d/.test(w)) return '';
    const r = rankOf(w);
    if (r <= settings.vocabSize) return settings.hlKnown ? 'ytam-known' : '';
    if (r <= suggestedLimit()) return settings.hlNext ? 'ytam-next' : '';
    return settings.hlRare ? 'ytam-rare' : '';
  }

  const isKnown = (w) => S.vocab[w] === 2 || (!S.vocab[w] && rankOf(w) <= settings.vocabSize);

  function spanClass(el) {
    let c = 'ytam-w ' + wordLevel(el.dataset.w);
    if (el.dataset.xl === '1') c = c.replace(/ytam-(known|next|rare)/, '') + ' ' + learnClass();
    return c.replace(/\s+/g, ' ').trim();
  }

  // Class + progress variable (--p: 0 = orange … 1 = green) from Anki intervals.
  function styleSpan(el) {
    el.className = spanClass(el);
    const ivl = S.vocab[el.dataset.w] === 1 && settings.ankiGradient && settings.ankiSync ? S.progress[el.dataset.w] : null;
    if (ivl != null) el.style.setProperty('--p', Math.max(0, Math.min(1, ivl / X.ankiGradMax)).toFixed(2));
    else el.style.removeProperty('--p');
  }

  function recolor(word) {
    const sel = word ? `.ytam-w[data-w="${CSS.escape(word)}"]` : '.ytam-w';
    document.querySelectorAll(sel).forEach(styleSpan);
  }

  async function setWordStatus(w, st, silent) {
    const prev = S.vocab[w];
    if (st) S.vocab[w] = st; else delete S.vocab[w];
    if (w.includes(' ')) { renderList(); renderOverlay(); } else recolor(w);
    if (st === 1 && prev !== 1) logSaved({ k: w, t: w.includes(' ') ? 'x' : 'w', text: w });
    if (prev === 1 && st !== 1) { if (silent) updateSaved((saved) => saved.filter((e) => e.k !== w)); else leftLearning(w, st); }
    try {
      const { vocab = {} } = await chrome.storage.local.get('vocab');
      if (st) vocab[w] = st; else delete vocab[w];
      await chrome.storage.local.set({ vocab });
    } catch (_) {}
    refreshSideTabs();
  }

  // Right / middle click (LR): learning ↔ known; anything else → learning.
  function toggleStatus(w, i, meaning) {
    const next = S.vocab[w] === 1 ? 2 : 1;
    setWordStatus(w, next);
    toast(`${w}: ${next === 1 ? 'изучаю' : 'знаю'}`);
    if (next === 1 && settings.ankiOnLearning && i != null && i >= 0) queueCard(i, { word: w, meaning: meaning || variants(w).slice(0, 3).join(', ') }, true);
  }

  // ---------- saved items & Anki sync ----------
  // chrome.storage.local.saved: [{ k, t: 'w'|'x'|'p', text, ts, ids: [noteId] }]

  async function updateSaved(fn) {
    const { saved = [] } = await chrome.storage.local.get('saved');
    const out = fn(saved) || saved;
    await chrome.storage.local.set({ saved: out.slice(0, 3000) });
    S.savedList = out;
    refreshSideTabs();
  }

  function logSaved(entry) {
    return updateSaved((saved) => {
      const old = saved.find((e) => e.k === entry.k);
      const rest = saved.filter((e) => e.k !== entry.k);
      return [{ ids: [], ...old, ...entry, ts: Date.now() }, ...rest];
    });
  }

  function addNoteId(k, id) {
    if (!id) return;
    return updateSaved((saved) => {
      const e = saved.find((x) => x.k === k);
      if (e) e.ids = [...new Set([...(e.ids || []), id])];
      else saved.unshift({ k, t: k.startsWith('p:') ? 'p' : 'w', text: k, ts: Date.now(), ids: [id] });
      return saved;
    });
  }

  // A word left "learning": drop its pending card, and maybe its Anki note (after 30 s).
  function leftLearning(k, st) {
    S.pending = S.pending.filter((p) => p.key !== k);
    const del = st === 2 ? settings.ankiDeleteOnKnown : settings.ankiDeleteOnRemove;
    if (del) scheduleAnkiDelete(k, st);
    else if (st !== 2) updateSaved((saved) => saved.filter((e) => e.k !== k));
  }

  async function scheduleAnkiDelete(k, st) {
    const { saved = [], ankiDel = [] } = await chrome.storage.local.get(['saved', 'ankiDel']);
    const e = saved.find((x) => x.k === k);
    ankiDel.push({ k, st, ids: e ? e.ids || [] : [], due: Date.now() + X.ankiDeleteSec * 1000 });
    await chrome.storage.local.set({ ankiDel, saved: saved.filter((x) => x.k !== k) });
    S.savedList = saved.filter((x) => x.k !== k);
    refreshSideTabs();
  }

  async function processAnkiDeletes() {
    let { ankiDel = [] } = await chrome.storage.local.get('ankiDel');
    if (!ankiDel.length) return;
    const now = Date.now();
    const due = ankiDel.filter((d) => d.due <= now);
    if (!due.length) return;
    const keep = ankiDel.filter((d) => d.due > now);
    for (const d of due) {
      // Re-marked as learning in the meantime → keep the card.
      if (!d.k.startsWith('p:') && S.vocab[d.k] === 1) continue;
      // The setting may have been switched off since the card was scheduled (st undefined = explicit trash on a phrase).
      if (d.st !== undefined && (d.st === 2 ? !settings.ankiDeleteOnKnown : !settings.ankiDeleteOnRemove)) continue;
      if (!d.ids.length) continue;
      try { await bg({ type: 'deleteNotes', ids: d.ids }); } catch (_) { d.due = now + 60000; keep.push(d); }
    }
    await chrome.storage.local.set({ ankiDel: keep });
  }
  setInterval(() => { processAnkiDeletes().catch(() => {}); }, 5000);

  // ---------- Anki outbox (cards made while Anki was closed) ----------

  function renderOutbox(n) {
    S.outboxCount = n;
    if (!ui) return;
    ui.syncBadge.textContent = n ? String(n) : '';
    ui.syncBtn.classList.toggle('has', n > 0);
    ui.syncBtn.title = n ? `Синхронизировать с Anki — в очереди: ${n}` : 'Синхронизировать с Anki';
  }

  async function syncNow(quiet) {
    if (!quiet) toast('⟳ Синхронизирую с Anki…', '', 0);
    let r;
    try { r = await bg({ type: 'syncNow' }); } catch (e) { r = { sent: 0, left: S.outboxCount, error: e.message }; }
    if (r.left && r.error && !r.sent) toast(`✗ Anki не отвечает${r.left ? ` — в очереди: ${r.left}` : ''}. Откройте Anki и нажмите ⟳ снова`, 'err', 5000);
    else if (r.sent) toast(`✓ Отправлено в Anki: ${r.sent}` + (r.left ? `, осталось ${r.left}` : ''), 'ok', 3500);
    else if (!quiet) toast('✓ Всё уже в Anki', 'ok', 2000);
    syncAnki().catch(() => {});
  }

  // ---------- progress from Anki ----------
  // Card intervals of our notes → gradient of the "learning" outline and auto "known".

  async function syncAnki() {
    if (!settings.ankiSync) return;
    let words;
    try { words = await bg({ type: 'ankiProgress' }); } catch (_) { return; } // Anki closed: silently skip
    S.progress = {};
    const noteIds = {};
    for (const [w, info] of Object.entries(words)) {
      S.progress[w] = info.ivl;
      noteIds[w] = info.notes;
    }
    // Remember note ids (so the card can be deleted later) for words we track.
    await updateSaved((saved) => {
      for (const e of saved) if (noteIds[e.k]) e.ids = [...new Set([...(e.ids || []), ...noteIds[e.k]])];
    });
    if (settings.ankiAutoKnown) {
      for (const [w, ivl] of Object.entries(S.progress)) {
        if (S.vocab[w] === 1 && ivl >= settings.ankiMatureDays) await setWordStatus(w, 2, true);
      }
    }
    recolor();
    refreshSideTabs();
  }

  function syncLoop() {
    syncAnki().catch(() => {}).finally(() => setTimeout(syncLoop, Math.max(1, X.ankiSyncMin) * 60000));
  }
  setTimeout(syncLoop, 4000); // after settings and vocabulary have loaded

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
        w.end = next && next.start - w.start <= X.asrWordMax ? next.start : w.start + Math.max(0.3, Math.min(X.asrWordMax, evLen));
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
      if (!next || sentenceEnd || gap > X.segGap || cur.length >= maxWords || (clauseEnd && cur.length >= maxWords * X.clauseRatio)) flush();
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
      const N = X.aiChunkWords;
      let to = Math.min(words.length, from + N);
      if (to < words.length) {
        let best = to, bestGap = -1;
        for (let k = from + Math.round(N * 0.75); k < Math.min(words.length, from + Math.round(N * 1.2)); k++) {
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
    await Promise.all(Array.from({ length: X.aiConc }, async () => {
      while (next < chunks.length) {
        const i = next++;
        if (token !== S.token) return;
        const res = await bg({
          type: 'aiSegment',
          text: chunks[i].map((w) => w.text).join(' '),
          tl: settings.targetLang,
          maxWords: settings.maxWords,
          model: settings.aiModel,
          temperature: X.aiTemp,
        });
        results[i] = alignLines(res.lines, chunks[i]);
        ++done;
        setProgress(`✨ ИИ обрабатывает субтитры ${done}/${chunks.length}`, done / chunks.length);
      }
    }));
    if (token !== S.token) return null;
    const ratio = results.reduce((a, r) => a + r.ratio, 0) / results.length;
    if (ratio < X.aiMinMatch) throw new Error('ИИ слишком сильно изменил текст');
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

    const CHUNK = X.aiVideoChunkSec;
    const ranges = [];
    if (dur <= X.aiSingleMaxMin * 60) ranges.push([0, dur]);
    else for (let t = 0; t < dur; t += CHUNK) ranges.push([t, Math.min(dur, t + CHUNK)]);

    const results = new Array(ranges.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: X.aiConc }, async () => {
      while (next < ranges.length) {
        const i = next++;
        if (token !== S.token) return;
        const [from, to] = ranges[i];
        const res = await bg({ type: 'aiVideo', videoId: S.videoId, from, to, tl: settings.targetLang, maxWords: settings.maxWords, model: settings.aiModel, fps: X.aiVideoFps, temperature: X.aiTemp });
        results[i] = res.lines.filter((l) => l.b >= from - 5 && l.b < to + 5);
        ++done;
        setProgress(ranges.length > 1 ? `🎧 ИИ слушает видео ${done}/${ranges.length}` : '🎧 ИИ слушает видео', ranges.length > 1 ? done / ranges.length : null);
      }
    }));
    if (token !== S.token) return null;

    let cues = results.flat().map((l) => ({ start: +l.b || 0, end: +l.e || (+l.b + 2), text: cleanText(String(l.s)), tr: String(l.t || ''), x: l.x || [] }))
      .filter((c) => c.text);
    cues.sort((a, b) => a.start - b.start);
    if (!cues.length) throw new Error('ИИ не вернул субтитры');

    // The model's timestamps can be seconds off; YouTube's word times are not. Align by text.
    const ratio = alignToWords(cues, words);
    if (words.length) setStatus(`Тайминги ИИ выровнены по YouTube: ${Math.round(ratio * 100)}% фраз`);
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

    const CHUNK = X.aiVideoChunkSec;
    const ranges = [];
    if (dur <= X.aiSingleMaxMin * 60) ranges.push([0, dur]);
    else for (let t = 0; t < dur; t += CHUNK) ranges.push([t, Math.min(dur, t + CHUNK)]);

    const results = new Array(ranges.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: X.aiConc }, async () => {
      while (next < ranges.length) {
        const i = next++;
        if (token !== S.token) return;
        const [from, to] = ranges[i];
        const res = await bg({ type: 'aiVideo', videoId: S.videoId, from, to, tl: settings.targetLang, maxWords: settings.maxWords, model: settings.aiModel, fps: X.aiVideoFps, temperature: X.aiTemp });
        results[i] = res.lines.filter((l) => l.b >= from - 5 && l.b < to + 5);
        ++done;
        setProgress(ranges.length > 1 ? `🎧 ИИ слушает видео ${done}/${ranges.length}` : '🎧 ИИ слушает видео', ranges.length > 1 ? done / ranges.length : null);
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

  // Aligns cues (text + approximate times) to timed words: each cue gets the start of its first
  // word and the end of its last word, searched near its approximate time. Returns the aligned share.
  function alignToWords(cues, words) {
    if (!words.length || !cues.length) return 0;
    const W = words.map((w) => normTok(w.text));
    const idx = new Map();
    W.forEach((t, i) => { if (t) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); } });
    let prevLast = -1, ok = 0;
    for (const c of cues) {
      const toks = c.text.split(' ').map(normTok).filter(Boolean);
      if (!toks.length) continue;
      const cand = new Set();
      for (let k = 0; k < Math.min(3, toks.length); k++) {
        for (const i of idx.get(toks[k]) || []) {
          if (Math.abs(words[i].start - c.start) <= X.aiAlignWin && i - k > prevLast - 3) cand.add(Math.max(0, i - k));
        }
      }
      let best = null;
      for (const s0 of cand) {
        let q = s0, hits = 0, first = -1, last = -1;
        for (const tok of toks) {
          for (let j = q; j < Math.min(W.length, q + 4); j++) {
            if (W[j] === tok) { if (first < 0) first = j; last = j; q = j + 1; hits++; break; }
          }
        }
        if (first < 0 || hits < Math.min(3, toks.length) || hits / toks.length < 0.6) continue;
        const score = hits / toks.length - Math.abs(words[first].start - c.start) * 0.02;
        if (!best || score > best.score) best = { first, last, score };
      }
      if (!best) continue;
      c.start = words[best.first].start;
      c.end = Math.max(words[best.last].end, c.start + 0.3);
      c.aligned = true;
      prevLast = best.last;
      ok++;
    }
    return ok / cues.length;
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
      setProgress(settings.aiMode === 'audio' ? '🎧 ИИ слушает видео' : '✨ ИИ обрабатывает субтитры', null);
      try {
        const cues = settings.aiMode === 'audio' ? await aiVideoProcess(words, token) : await aiProcess(words, token);
        if (token !== S.token || !cues) return;
        setProgress(null);
        setCues(cues);
        setStatus('');
        return;
      } catch (e) {
        if (token !== S.token) return;
        setProgress(null);
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

    let doneCh = 0;
    for (const ch of ordered) {
      if (token !== S.token || tl !== settings.targetLang) return;
      if (ordered.length > 2) setProgress('Перевод фраз', doneCh++ / ordered.length);
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
    if (token === S.token) setProgress(null);
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

  const ICON = {
    check: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 24 24" width="1.15em" height="1.15em"><path d="M1.5 5.2C4.3 3.8 8 3.9 11.2 5.6v14.6C8 18.6 4.3 18.5 1.5 19.9z" fill="currentColor"/><path d="M22.5 5.2c-2.8-1.4-6.5-1.3-9.7.4v14.6c3.2-1.6 6.9-1.7 9.7-.3z" fill="currentColor"/><path d="M15 9.2h5M15 12.2h5M15 15.2h5" stroke="rgba(0,0,0,.45)" stroke-width="1.3"/></svg>',
    bookClock: '<svg viewBox="0 0 28 24" width="1.3em" height="1.1em"><path d="M1.5 5.2C4.3 3.8 8 3.9 11.2 5.6v14.6C8 18.6 4.3 18.5 1.5 19.9z" fill="currentColor"/><path d="M22.5 5.2c-2.8-1.4-6.5-1.3-9.7.4v14.6c3.2-1.6 6.9-1.7 9.7-.3z" fill="currentColor"/><path d="M15 9.2h5M15 12.2h5" stroke="rgba(0,0,0,.45)" stroke-width="1.3"/><circle cx="21.5" cy="17" r="5" fill="#0d4f7a" stroke="currentColor" stroke-width="1.6"/><path d="M21.5 14.4V17l1.8 1.2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    ban: '<svg viewBox="0 0 24 24" width="1em" height="1em"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M6 18L18 6" stroke="currentColor" stroke-width="2.2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10.5 10v7M13.5 10v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6c-.6.3-1.2.6-1.7 1l-2.5-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    updown: '<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M7 9.5l5-5 5 5M7 14.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const svgBtn = (cls, icon, title, onclick) => {
    const b = h('button', { class: cls, title, onclick });
    b.innerHTML = ICON[icon];
    return b;
  };

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
      styleSpan(span);
      el.append(span);
      ti++;
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
    return el;
  }

  // Word interactions shared by the panel, the overlay and the word list.
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
    const statusClick = (e, viaRight) => {
      const w = e.target.closest('.ytam-w');
      if (!w) return;
      if (viaRight && settings.rightClick === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      if (viaRight && settings.rightClick === 'dict') return openWord(w, cueOf(w));
      toggleStatus(w.dataset.w, cueOf(w));
      if (tipFor === w) showTip(w, cueOf(w));
    };
    root.addEventListener('contextmenu', (e) => statusClick(e, true));
    root.addEventListener('auxclick', (e) => { if (e.button === 1) statusClick(e, false); });
  }

  const STAR = '☆', STAR_ON = '★';

  function createUI() {
    // --- side panel ---
    const select = h('select', { class: 'ytam-track', title: 'Дорожка субтитров' });
    select.addEventListener('change', () => {
      S.cues = [];
      renderList();
      S.token++;
      loadTrack(S.tracks[+select.value], S.token);
    });
    const trToggle = h('input', { type: 'checkbox', 'data-k': 'showTranslation', onchange: () => chrome.storage.sync.set({ showTranslation: trToggle.checked }) });
    const status = h('div', { class: 'ytam-status' });
    const progLabel = h('span', { class: 'ytam-prog-label' });
    const progFill = h('i');
    const progBar = h('div', { class: 'ytam-prog-bar' }, progFill);
    const prog = h('div', { class: 'ytam-prog', hidden: true }, progLabel, progBar);
    const list = h('div', { class: 'ytam-list' });
    const wordsPane = h('div', { class: 'ytam-pane ytam-words' });
    const savedPane = h('div', { class: 'ytam-pane ytam-savedp' });
    const devPane = h('div', { class: 'ytam-pane ytam-devp' });
    const tabBtn = (id, label) => h('button', { class: 'ytam-ptab', 'data-tab': id, text: label, onclick: () => setTab(id) });
    const tabs = [tabBtn('subs', 'Субтитры'), tabBtn('words', 'Слова'), tabBtn('saved', 'Сохранённые'), tabBtn('dev', '🛠')];
    tabs[3].title = 'Меню разработчика: все параметры вживую';
    const collapse = h('button', { class: 'ytam-icon', title: 'Свернуть', text: '–' });
    const syncBadge = h('span', { class: 'ytam-qbadge' });
    const syncBtn = h('button', { class: 'ytam-icon ytam-syncbtn', title: 'Синхронизировать с Anki', onclick: () => syncNow() }, '⟳', syncBadge);
    const panel = h('div', { id: 'ytam-panel' },
      h('div', { class: 'ytam-head' }, tabs, h('span', { class: 'ytam-sp' }),
        syncBtn, svgBtn('ytam-icon', 'gear', 'Настройки', () => openSettings()), collapse),
      h('div', { class: 'ytam-subbar' }, select, h('label', { class: 'ytam-toggle' }, trToggle, 'Перевод')),
      status, prog, list, wordsPane, savedPane, devPane,
      h('div', { class: 'ytam-foot' },
        h('kbd', { text: 'A' }), h('kbd', { text: 'S' }), h('kbd', { text: 'D' }), ' фразы · ',
        h('kbd', { text: 'Q' }), ' автопауза · ', h('kbd', { text: 'R' }), ' ☆ фраза · ПКМ — знаю/изучаю'));
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
    wordsPane.addEventListener('click', (e) => {
      const w = e.target.closest('.ytam-w');
      if (w) openWord(w, firstCueOf(w.dataset.w));
    });
    bindWords(wordsPane, (w) => firstCueOf(w.dataset.w));

    // --- subtitles over the video ---
    const ovText = h('div', { class: 'ytam-ov-text' });
    const ovTr = h('div', { class: 'ytam-ov-tr' });
    const ovPlay = h('button', { class: 'ytam-play', title: 'Повторить фразу (S)', onclick: () => seekCue(S.shown, true) });
    const ovStar = h('button', { class: 'ytam-star', title: 'Фраза в Anki (R)', text: STAR, onclick: () => queueCard(S.shown, null) });
    const ovBox = h('div', { class: 'ytam-ov-box' }, ovText);
    const ovLine = h('div', { class: 'ytam-ov-line' }, ovPlay, ovBox, ovStar);
    const overlay = h('div', { id: 'ytam-overlay', class: 'ytam-hidden' }, ovLine, ovTr);
    for (const type of ['mousedown', 'mouseup', 'dblclick', 'click', 'auxclick', 'contextmenu']) {
      overlay.addEventListener(type, (e) => {
        if (S.posEdit) return;
        e.stopPropagation();
        if (type !== 'click') return;
        const w = e.target.closest('.ytam-w');
        if (w && S.shown >= 0) openWord(w, S.shown);
      });
    }
    bindWords(ovBox, () => S.shown);
    // The whole English line (with its background) is one pause zone.
    ovLine.addEventListener('mouseenter', () => {
      clearTimeout(S.resumeTimer);
      S.hoverIn = true;
      const v = getVideo();
      // 'now': stop at once. 'end': keep playing, tick() stops at the end of the phrase.
      if (settings.pauseOnHover && settings.hoverPauseMode === 'now' && v && !v.paused && !S.posEdit) { v.pause(); S.hoverPaused = true; }
    });
    ovLine.addEventListener('mouseleave', () => { S.hoverIn = false; scheduleResume(); });

    // --- buttons at the sides of the video (LR) ---
    const apInput = h('input', { type: 'checkbox', 'data-k': 'autoPause', onchange: () => chrome.storage.sync.set({ autoPause: apInput.checked }) });
    const sideL = h('div', { class: 'ytam-side left' },
      svgBtn('ytam-sbtn', 'next', 'Следующая фраза (D)', () => seekCue(Math.min(S.cues.length - 1, Math.max(0, S.active) + 1), true)),
      svgBtn('ytam-sbtn', 'repeat', 'Повторить (S)', () => seekCue(Math.max(0, S.active), true)),
      svgBtn('ytam-sbtn', 'prev', 'Предыдущая фраза (A)', () => seekCue(Math.max(0, S.active - 1), true)));
    const posBtn = svgBtn('ytam-sbtn ytam-posbtn', 'updown', 'Положение субтитров: зажмите и тяните (или крутите колесо)', null);
    posBtn.addEventListener('pointerdown', startPosDrag);
    posBtn.addEventListener('wheel', (e) => {
      e.preventDefault();
      setPos(settings.subPos + (e.deltaY < 0 ? 1 : -1));
      clearTimeout(S.posSaveTimer);
      S.posSaveTimer = setTimeout(() => chrome.storage.sync.set({ subPos: settings.subPos }), 400);
      showPosRect(900);
    }, { passive: false });
    const sideR = h('div', { class: 'ytam-side right' },
      h('label', { class: 'ytam-ap', title: 'Автопауза после фразы (Q)' }, apInput, h('span'), h('b', { text: 'AP' })),
      posBtn);
    for (const el of [sideL, sideR]) {
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) el.addEventListener(type, (e) => e.stopPropagation());
    }

    return { syncBtn, syncBadge, panel, list, status, select, prog, progLabel, progBar, progFill, wordsPane, savedPane, devPane, tabs, overlay, ovLine, ovBox, ovText, ovTr, ovStar, sideL, sideR, rows: [] };
  }

  function scheduleResume() {
    clearTimeout(S.resumeTimer);
    S.resumeTimer = setTimeout(() => {
      if (pop || (ui && ui.ovLine.matches(':hover')) || (tipEl && tipEl.matches(':hover'))) return;
      resumeAfterHover();
    }, X.resumeMs);
  }

  function resumeAfterHover() {
    if (!S.hoverPaused) return;
    if (ui && ui.ovLine.matches(':hover')) return;
    S.hoverPaused = false;
    const v = getVideo();
    if (v) v.play();
  }

  function setStatus(text, extra) {
    if (!ui) return;
    ui.status.replaceChildren(text, extra || '');
  }

  // Progress bar in the panel. frac = null → indeterminate; label = null → hide.
  let progTimer = 0;
  function setProgress(label, frac) {
    if (!ui) return;
    clearInterval(progTimer);
    if (label == null) { ui.prog.hidden = true; return; }
    ui.prog.hidden = false;
    ui.progBar.classList.toggle('indet', frac == null);
    if (frac != null) ui.progFill.style.width = Math.round(frac * 100) + '%';
    const t0 = Date.now();
    const draw = () => { ui.progLabel.textContent = `${label} · ${Math.round((Date.now() - t0) / 1000)} с`; };
    draw();
    progTimer = setInterval(draw, 1000);
  }

  function setTab(id) {
    S.tab = id;
    ui.tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    ui.panel.dataset.tab = id;
    refreshSideTabs(true);
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
        h('button', { class: 'ytam-star', title: 'Фраза в Anki (R)', text: saved ? STAR_ON : STAR }));
      frag.append(row);
      return row;
    });
    const top = ui.list.scrollTop;
    ui.list.replaceChildren(frag);
    ui.list.scrollTop = top;
    if (ui.rows[S.active]) ui.rows[S.active].classList.add('ytam-active');
    refreshSideTabs();
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
    if (S.tab === 'subs' && Date.now() - S.userScrollAt > 4000 && !ui.panel.classList.contains('ytam-collapsed') && !ui.list.matches(':hover')) {
      ui.list.scrollTo({ top: row.offsetTop - ui.list.clientHeight / 3, behavior: 'smooth' });
    }
  }

  function renderOverlay() {
    if (!ui) return;
    const c = S.cues[S.shown];
    ui.overlay.classList.toggle('ytam-hidden', !c && !S.posEdit);
    if (!c) {
      if (S.posEdit) { ui.ovText.textContent = 'Субтитры будут здесь, на этой высоте'; ui.ovTr.textContent = 'Перевод субтитров'; }
      return;
    }
    ui.ovText.replaceChildren(...wordsNode(c.text, 'x', S.shown).childNodes);
    ui.ovTr.textContent = S.trans[S.shown] || '';
    renderOverlayStar();
  }

  const FONT_STACK = 'Roboto, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

  function applySettings() {
    const root = document.documentElement;
    const st = root.style;
    st.setProperty('--ytam-c-known', settings.colorKnown);
    st.setProperty('--ytam-c-learning', settings.colorLearning);
    st.setProperty('--ytam-c-next', settings.colorNext);
    st.setProperty('--ytam-c-rare', settings.colorRare);
    st.setProperty('--ytam-sub-font', settings.fontFamily === 'default' ? FONT_STACK : `${settings.fontFamily}, ${FONT_STACK}`);
    st.setProperty('--ytam-fs', (+settings.fontSize || 26) + 'px');
    st.setProperty('--ytam-fw', String(settings.fontWeight || 600));
    st.setProperty('--ytam-tr-scale', String((+settings.trScale || 80) / 100));
    st.setProperty('--ytam-bg-a', String((+settings.subBgOpacity) / 100));
    st.setProperty('--ytam-pos', String(+settings.subPos));
    st.setProperty('--ytam-sub-w', String(+settings.subWidth || 92));
    st.setProperty('--ytam-tip-px', (+settings.tipPadX) + 'px');
    st.setProperty('--ytam-tip-py', (+settings.tipPadY) + 'px');
    st.setProperty('--ytam-tip-maxw', (+settings.tipMaxW || 260) + 'px');
    st.setProperty('--ytam-panel-fs', (+settings.panelFontSize || 16) + 'px');
    st.setProperty('--ytam-tip-fs', (+settings.tipFontSize || 16) + 'px');
    st.setProperty('--ytam-tip-anim', (+settings.tipAnim || 0) + 'ms');
    st.setProperty('--ytam-pop-w', (+settings.popWidth || 330) + 'px');
    st.setProperty('--ytam-pop-fs', (+settings.popFontSize || 13) + 'px');
    root.classList.toggle('ytam-hidebar', !!settings.hidePlaybar && !!S.videoId);
    if (!ui) return;
    ui.panel.querySelectorAll('input[data-k]').forEach((inp) => { inp.checked = !!settings[inp.dataset.k]; });
    ui.sideR.querySelectorAll('input[data-k]').forEach((inp) => { inp.checked = !!settings[inp.dataset.k]; });
    ui.panel.classList.toggle('ytam-no-tr', !settings.showTranslation);
    ui.panel.hidden = !settings.showPanel;
    const o = ui.overlay.classList;
    o.toggle('ytam-no-tr', !settings.showTranslation);
    o.toggle('ytam-blur-tr', settings.hideSubs === 'tr' || settings.hideSubs === 'both');
    o.toggle('ytam-blur-orig', settings.hideSubs === 'orig' || settings.hideSubs === 'both');
    o.toggle('ytam-two', !!settings.twoLines);
    o.toggle('ytam-noctl', !settings.showSubControls);
    ui.sideL.hidden = ui.sideR.hidden = !settings.showSideControls;
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
    if (!ui || !player) return;
    if (ui.overlay.parentNode !== player) player.append(ui.overlay);
    if (ui.sideL.parentNode !== player) player.append(ui.sideL, ui.sideR);
  }

  // ---------- subtitle position: press the ⌃⌄ button and drag ----------
  // While dragging, a translucent rectangle (the size of the subtitles) follows the pointer.

  function showPosRect(ms) {
    if (!ui) return;
    S.posEdit = true;
    ui.overlay.classList.add('ytam-pos-edit');
    renderOverlay();
    clearTimeout(S.flashTimer);
    if (ms) S.flashTimer = setTimeout(hidePosRect, ms);
  }

  function hidePosRect() {
    if (!ui || S.posDrag) return;
    S.posEdit = false;
    ui.overlay.classList.remove('ytam-pos-edit');
    renderOverlay();
  }

  function flashPos() { showPosRect(1200); }

  function setPos(p) {
    settings.subPos = Math.max(X.ovBottomMin, Math.min(70, Math.round(p * 100) / 100));
    document.documentElement.style.setProperty('--ytam-pos', String(settings.subPos));
  }

  function startPosDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const player = document.getElementById('movie_player');
    if (!player) return;
    const height = player.getBoundingClientRect().height || 1;
    const startY = e.clientY, startPos = settings.subPos;
    let target = startPos, shown = startPos, raf = 0;
    S.posDrag = true;
    showPosRect(0);
    document.documentElement.classList.add('ytam-dragging');
    const frame = () => {
      raf = 0;
      shown += (target - shown) * (1 - X.dragSmooth);
      if (Math.abs(target - shown) < 0.02) shown = target;
      setPos(shown);
      if (shown !== target) raf = requestAnimationFrame(frame);
    };
    const move = (ev) => {
      target = startPos + ((startY - ev.clientY) / height) * 100;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const up = () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      cancelAnimationFrame(raf);
      setPos(target);
      S.posDrag = false;
      document.documentElement.classList.remove('ytam-dragging');
      hidePosRect();
      chrome.storage.sync.set({ subPos: settings.subPos });
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }

  // ---------- side panel tabs: words of the video / saved items ----------

  let sideTimer = 0;
  function refreshSideTabs(now) {
    clearTimeout(sideTimer);
    if (!ui || S.tab === 'subs') return;
    if (S.tab === 'dev') { renderDevTab(); return; }
    sideTimer = setTimeout(() => (S.tab === 'words' ? renderWordsTab() : renderSavedTab()), now ? 0 : 250);
  }

  let firstCueCache = null;
  function firstCueOf(w) {
    if (!firstCueCache || firstCueCache.cues !== S.cues) {
      const map = new Map();
      S.cues.forEach((c, i) => { for (const t of tokensOf(c.text)) if (!map.has(t)) map.set(t, i); });
      firstCueCache = { cues: S.cues, map };
    }
    const i = firstCueCache.map.get(w);
    return i == null ? -1 : i;
  }

  function bucketOf(r) {
    if (r === Infinity) return 'Вне частотного словаря';
    const size = r <= 1000 ? 100 : r <= 5000 ? 500 : r <= 20000 ? 2500 : 10000;
    const from = Math.floor((r - 1) / size) * size + 1;
    return `Ранг ${from} – ${from + size - 1}`;
  }

  function renderWordsTab() {
    const counts = new Map();
    for (const c of S.cues) for (const t of tokensOf(c.text)) if (/\p{L}/u.test(t) && t.length > 0) counts.set(t, (counts.get(t) || 0) + 1);
    const words = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
    let known = 0, learning = 0, skip = 0;
    for (const w of words) {
      if (S.vocab[w] === 1) learning++;
      else if (isKnown(w)) known++;
      else if (wordLevel(w).includes('ytam-rare')) skip++;
    }
    const groups = new Map();
    for (const w of words) {
      const b = bucketOf(rankOf(w));
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(w);
    }
    const stat = (icon, n, cls) => { const s = h('span', { class: 'ytam-wstat ' + cls }); s.innerHTML = ICON[icon]; s.append(' ' + n); return s; };
    ui.wordsPane.replaceChildren(
      h('div', { class: 'ytam-whint', text: 'Слова этого видео по частоте · ПКМ — отметить · клик — словарь' }),
      h('div', { class: 'ytam-wstats' }, stat('check', known, 'k'), stat('book', learning, 'l'), stat('ban', skip, 'r'), h('span', { class: 'ytam-wstat t', text: '/ ' + words.length })),
      ...[...groups].map(([title, ws]) => h('div', { class: 'ytam-wgroup' },
        h('div', { class: 'ytam-wg-title', text: title }),
        h('div', { class: 'ytam-wg-words' }, ws.map((w) => {
          const s = h('span', { 'data-w': w, 'data-ti': '-1', text: w });
          styleSpan(s);
          return s;
        })))));
  }

  function renderSavedTab() {
    const items = (S.savedList || []).filter((e) => e.t === 'p' || S.vocab[e.k] === 1);
    ui.savedPane.replaceChildren(
      h('div', { class: 'ytam-whint', text: `Сохранено: ${items.length} · 🗑 — убрать из списка` + (settings.ankiDeleteOnRemove ? ` (карточка удалится из Anki через ${X.ankiDeleteSec} с)` : ' (карточка в Anki остаётся)') }),
      ...items.slice(0, 400).map((e) => {
        const del = svgBtn('ytam-sdel', 'trash', 'Убрать', () => {
          if (e.t === 'p') {
            scheduleAnkiDelete(e.k);
            const c = S.cues.find((x) => `p:${S.videoId}:${x.start.toFixed(1)}` === e.k);
            if (c) { S.saved.delete(savedKey(c)); markRow(c, 'ytam-saved', false); }
          } else setWordStatus(e.k, 0);
        });
        return h('div', { class: 'ytam-sitem' },
          h('span', { class: 'ytam-badge ' + e.t, text: e.t === 'p' ? 'p' : e.t === 'x' ? 'x' : 'w' }),
          h('span', { class: 'ytam-stext' + (e.t === 'p' ? '' : ' ytam-learning'), text: e.text }),
          del);
      }));
  }

  // ---------- developer menu (🛠 tab): every internal number, live ----------

  let devSaveTimer = 0;
  const devInputs = {};
  function setDev(vals) {
    Object.assign(X, vals);
    syncDev();
    clearTimeout(devSaveTimer);
    devSaveTimer = setTimeout(() => chrome.storage.local.set({ dev: { ...X } }), 300);
  }

  function syncDev() {
    for (const [k, set] of Object.entries(devInputs)) set(X[k]);
  }

  function renderDevTab() {
    if (ui.devPane.dataset.built) { syncDev(); return; }
    ui.devPane.dataset.built = '1';
    const info = h('div', { class: 'ytam-dev-info', text: 'Меняйте значения — применяются сразу. «▶ Клип» — прослушать, как будет звучать карточка текущей фразы.' });
    const btn = (text, onclick, title) => h('button', { class: 'ytam-dbtn', text, onclick, title });
    const top = h('div', { class: 'ytam-dev-top' },
      btn('▶ Клип текущей фразы', () => testClip(info)),
      btn('Помощник yt-dlp', () => pingHelper(info)),
      btn('Экспорт', () => { navigator.clipboard.writeText(JSON.stringify(X, null, 1)); info.textContent = 'Параметры скопированы в буфер обмена (JSON).'; }),
      btn('Импорт', () => {
        const t = prompt('Вставьте JSON с параметрами');
        if (!t) return;
        try { setDev(JSON.parse(t)); info.textContent = 'Импортировано.'; } catch (e) { info.textContent = 'Ошибка JSON: ' + e.message; }
      }),
      btn('Сбросить всё', () => { if (confirm('Вернуть все параметры по умолчанию?')) setDev({ ...self.YTAM_DEV_DEFAULTS }); }));
    const groups = self.YTAM_DEV_SCHEMA.map((g) => {
      const det = h('details', { class: 'ytam-dev-group', open: true }, h('summary', { text: g.title }));
      for (const f of g.fields) {
        const range = h('input', { type: 'range', min: f.min, max: f.max, step: f.step });
        const num = h('input', { type: 'number', min: f.min, max: f.max, step: f.step });
        const reset = h('button', { class: 'ytam-dev-reset', title: 'По умолчанию: ' + f.def, text: '↺' });
        const set = (v) => { range.value = v; num.value = v; reset.style.visibility = +v === f.def ? 'hidden' : 'visible'; };
        devInputs[f.k] = set;
        range.addEventListener('input', () => setDev({ [f.k]: +range.value }));
        num.addEventListener('change', () => { const v = Math.min(f.max, Math.max(f.min, +num.value)); if (!isNaN(v)) setDev({ [f.k]: v }); });
        num.addEventListener('keydown', (e) => e.stopPropagation());
        reset.addEventListener('click', () => setDev({ [f.k]: f.def }));
        det.append(h('div', { class: 'ytam-dev-row' },
          h('div', { class: 'ytam-dev-label' }, h('span', { text: f.label }), f.unit ? h('small', { text: f.unit }) : null, f.hint ? h('small', { text: ' · ' + f.hint }) : null),
          h('div', { class: 'ytam-dev-ctl' }, range, num, reset)));
      }
      return det;
    });
    ui.devPane.replaceChildren(top, info, ...groups);
    syncDev();
  }

  async function testClip(info) {
    const i = S.shown >= 0 ? S.shown : S.active;
    const cue = S.cues[i];
    if (!cue) { info.textContent = 'Нет текущей фразы.'; return; }
    info.textContent = 'Готовлю клип…';
    try {
      const item = { videoId: S.videoId, cue, shift: X.subShift };
      const ext = await clipAudio(item);
      if (!ext || ext.cov < 0.05) { info.textContent = 'Нет звука: фраза ещё не звучала, а помощник yt-dlp не запущен.'; return; }
      const pcm = trimClip(ext, cue.start + item.shift, cue.end + item.shift);
      const last = trimClip.last;
      const b64 = encodeMp3(pcm, ext.rate);
      new Audio('data:audio/mpeg;base64,' + b64).play();
      const f = (t) => t.toFixed(2);
      info.textContent = `Источник: ${ext.src} · фраза YouTube ${f(cue.start)}–${f(cue.end)} · клип ${f(last.start)}–${f(last.end)} ` +
        `(${(last.end - last.start).toFixed(2)} с, ${last.how}) · MP3 ${Math.round((b64.length * 0.75) / 1024)} КБ` +
        (ext.cov < 0.99 ? ` · звука записано ${Math.round(ext.cov * 100)}%` : '');
    } catch (e) {
      info.textContent = 'Ошибка: ' + e.message;
    }
  }

  async function pingHelper(info) {
    info.textContent = 'Проверяю помощник…';
    try {
      const r = await bg({ type: 'helperPing', url: settings.helperUrl });
      info.textContent = `Помощник работает · yt-dlp ${r.ytdlp || 'НЕ УСТАНОВЛЕН'} · ffmpeg ${r.ffmpeg ? 'есть' : 'НЕТ'} · это видео: ${S.helper.state}` +
        (S.helper.state === 'downloading' ? ` ${Math.round(S.helper.progress * 100)}%` : '') + (S.helper.error ? ' · ' + S.helper.error : '');
    } catch (e) {
      info.textContent = `Помощник не отвечает (${settings.helperUrl}): ${e.message}. Запустите helper/start-helper.bat.`;
    }
  }

  // Debug HUD on the video.
  let hud = null;
  function updateHud(v, t, a) {
    if (!X.debugHud) { if (hud) { hud.remove(); hud = null; } return; }
    const player = document.getElementById('movie_player');
    if (!player) return;
    if (!hud) hud = h('div', { class: 'ytam-hud' });
    if (hud.parentNode !== player) player.append(hud);
    const c = S.cues[a];
    const buf = Tap.blocks.reduce((sum, b) => sum + (b.t1 - b.t0), 0);
    hud.textContent = [
      `t ${v.currentTime.toFixed(2)} (субтитры ${t.toFixed(2)})`,
      c ? `фраза #${a}: ${c.start.toFixed(2)}–${c.end.toFixed(2)}` : 'фраза —',
      `запись в памяти ${Math.round(buf)} с · проходов ${Tap.pass}`,
      `помощник: ${S.helper.state}${S.helper.state === 'downloading' ? ' ' + Math.round(S.helper.progress * 100) + '%' : ''}`,
      `ждут аудио: ${S.pending.length} · словарь в очереди: ${dictQueue.length}`,
      `речь/фон: ${Tap.reliable ? 'ясно' : 'неясно'} (перепад ${Tap.contrast.toFixed(0)} дБ) · тишина ${Math.round(Tap.quietMs)} мс`,
    ].join('\n');
  }

  // ---------- settings dialog (opened from the player button) ----------

  let modal = null;
  function previewSetting(k, v, kind) {
    if (RELOAD_KEYS.includes(k)) return; // applied when saved (reloads subtitles)
    settings[k] = v;
    applySettings();
    if (kind === 'pos') flashPos();
    if (RERENDER_KEYS.includes(k)) { renderList(); renderOverlay(); }
  }

  function openSettings() {
    if (modal) return;
    const ankiStatus = h('span', { class: 'ytam-m-status' });
    const checkAnki = () => {
      ankiStatus.textContent = '…';
      bg({ type: 'ankiStatus' }).then((r) => {
        ankiStatus.textContent = '✓ AnkiConnect v' + r.version;
        ankiStatus.className = 'ytam-m-status ok';
        const dl = document.getElementById('decks') || h('datalist', { id: 'decks' });
        dl.replaceChildren(...r.decks.map((d) => h('option', { value: d })));
        if (!dl.parentNode) modal.append(dl);
      }, (e) => { ankiStatus.textContent = e.message; ankiStatus.className = 'ytam-m-status err'; });
    };
    const form = self.YTAM_buildSettings({
      onPreview: previewSetting,
      extra: { anki: h('div', { class: 'ytam-m-extra' }, h('button', { class: 'ytam-m-btn', text: 'Проверить связь с Anki', onclick: checkAnki }), ankiStatus) },
    });
    const keyRow = (label, key) => h('div', { class: 'ytam-m-key' }, h('span', { text: label }), h('kbd', { text: key }));
    const close = () => {
      form.ytamDispose();
      modal.remove();
      modal = null;
    };
    modal = h('div', { class: 'ytam-modal-bg', onclick: (e) => { if (e.target === modal) close(); } },
      h('div', { class: 'ytam-modal' },
        h('div', { class: 'ytam-modal-head' }, h('span', { text: 'YT → Anki — настройки' }), h('button', { class: 'ytam-x', text: '✕', onclick: close })),
        h('div', { class: 'ytam-modal-main' },
          h('div', { class: 'ytam-modal-left' },
            h('div', { class: 'ytam-m-title', text: 'Горячие клавиши' }),
            keyRow('Предыдущая', 'A'), keyRow('Повтор', 'S'), keyRow('Следующая', 'D'), keyRow('Пауза', 'Space'),
            keyRow('Автопауза', 'Q'), keyRow('Сохранить фразу', 'R'), keyRow('Копировать фразу', 'Ctrl + C'),
            keyRow('Словарь', 'Клик'), keyRow('Отметить слово', 'ПКМ'), keyRow('Статус при наведении', '1 / 2 / 3 / 0'),
            h('button', { class: 'ytam-m-link', text: 'Мой словарь и импорт →', onclick: () => bg({ type: 'openOptions' }) })),
          form),
        h('div', { class: 'ytam-modal-foot' }, h('button', { class: 'ytam-m-close', text: 'Закрыть', onclick: close }))));
    for (const type of ['keydown', 'keyup', 'keypress']) modal.addEventListener(type, (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    layer().append(modal);
  }

  // Button in the YouTube control bar: logo + ON/OFF + settings (LR style).
  function mountPlayerButton() {
    const bar = document.querySelector('#movie_player .ytp-left-controls');
    if (!bar || location.pathname !== '/watch') return;
    let btn = bar.querySelector('.ytam-ytbtn');
    if (!btn) {
      const logo = h('button', { class: 'ytam-yb-logo', title: 'YT → Anki — включить/выключить', text: 'YA', onclick: () => chrome.storage.sync.set({ enabled: !settings.enabled }) });
      const onoff = h('span', { class: 'ytam-yb-on', onclick: () => chrome.storage.sync.set({ enabled: !settings.enabled }) });
      btn = h('div', { class: 'ytam-ytbtn' }, logo, onoff, svgBtn('ytam-yb-gear', 'gear', 'Настройки YT → Anki', () => openSettings()));
      bar.append(btn);
    }
    btn.classList.toggle('off', !settings.enabled);
    btn.querySelector('.ytam-yb-on').textContent = settings.enabled ? 'ON' : 'OFF';
  }
  setInterval(mountPlayerButton, 1000);

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

  // Hover/click lookups: jump the queue; fall back to the plain word translation; failures are
  // never cached, so the next hover simply tries again.
  const hiPending = new Map();
  function getDictHi(w) {
    const d = dict.get(w);
    if (d && !(d instanceof Promise)) return Promise.resolve(d);
    if (hiPending.has(w)) return hiPending.get(w);
    const tl = settings.targetLang;
    const p = bg({ type: 'lookup', word: w, tl, prio: 1 })
      .then((r) => { if (tl === settings.targetLang) dict.set(w, r); return r; })
      .catch(() => null)
      .then(async (r) => {
        if (r || S.wordTr.has(w)) return r;
        try {
          const res = await bg({ type: 'translateWords', words: [w], tl, prio: 1 });
          if (res[w]) S.wordTr.set(w, res[w]);
        } catch (_) {}
        return null;
      })
      .finally(() => hiPending.delete(w));
    hiPending.set(w, p);
    return p;
  }

  function prefetchAround(a) {
    const words = [];
    for (let i = Math.max(0, a); i < Math.min(S.cues.length, a + X.dictAhead); i++) {
      for (const w of tokensOf(S.cues[i].text)) if (!dict.has(w) && w.length > 1 && !/^\d/.test(w)) words.push(w);
    }
    words.sort((x, y) => isKnown(x) - isKnown(y)); // unknown words first
    for (const w of words) if (!dictQueue.includes(w)) dictQueue.push(w);
    pumpDict();
  }

  function pumpDict() {
    while (dictBusy < X.dictConc && dictQueue.length) {
      const w = dictQueue.shift();
      if (dict.has(w)) continue;
      dictBusy++;
      Promise.resolve(getDict(w)).finally(() => { dictBusy--; setTimeout(pumpDict, X.dictDelayMs); });
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

  // ---------- floating boxes anchored to a word ----------
  // Above the word the box is anchored by its bottom edge, so content that
  // loads later grows upwards and the arrow stays on the word.

  function anchorTo(el, anchor, gap, preferAbove = 200) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    el.style.left = left + 'px';
    const above = r.top > preferAbove || r.top > innerHeight - r.bottom;
    if (above) { el.style.top = 'auto'; el.style.bottom = (innerHeight - r.top + gap) + 'px'; } else { el.style.bottom = 'auto'; el.style.top = (r.bottom + gap) + 'px'; }
    el.classList.toggle('below', !above);
    el.style.setProperty('--arrow-x', Math.max(14, Math.min(w - 14, r.left + r.width / 2 - left)) + 'px');
    el.style.maxHeight = (above ? r.top - gap - 8 : innerHeight - r.bottom - gap - 8) + 'px';
  }

  // ---------- hover tooltip (LR style) ----------

  let tipEl = null, tipFor = null, tipHideTimer = 0;

  function scheduleHideTip() {
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => {
      if (tipEl && tipEl.matches(':hover')) return;
      hideTip();
      scheduleResume();
    }, X.tipHideMs);
  }

  function hideTip() {
    tipFor = null;
    if (!tipEl) return;
    tipEl.classList.remove('show');
    const el = tipEl;
    setTimeout(() => { if (!tipFor && el === tipEl) el.remove(); }, +settings.tipAnim || 0);
  }

  function exprsAt(i, ti) {
    const c = S.cues[i];
    return c && ti >= 0 ? cueExpr(c).filter((e) => e.idx.includes(ti)) : [];
  }

  function showTip(span, i) {
    clearTimeout(tipHideTimer);
    if (!tipEl) {
      tipEl = h('div', { class: 'ytam-tip' });
      tipEl.addEventListener('mouseleave', scheduleHideTip);
      for (const type of ['mousedown', 'click', 'contextmenu']) tipEl.addEventListener(type, (e) => e.stopPropagation());
    }
    const w = span.dataset.w;
    const wasShown = !!tipFor && tipEl.isConnected;
    tipFor = span;
    const exprs = exprsAt(i, +span.dataset.ti).slice(0, 2);
    const n = Math.max(1, +settings.tipVariants || 3);

    const fill = () => {
      if (tipFor !== span) return;
      const vars = variants(w).slice(0, n);
      const varsEl = (list) => h('div', { class: 'ytam-tip-vars' }, list.length ? list.map((t) => h('div', { text: t })) : h('div', { class: 'ytam-dim', text: '…' }));
      const kids = [];
      for (const e of exprs) {
        const save = svgBtn('ytam-tip-xsave' + (S.vocab[e.key] === 1 ? ' on' : ''), S.vocab[e.key] === 1 ? 'bookClock' : 'book', 'Сохранить выражение в Anki', () => {
          if (S.vocab[e.key] === 1) return;
          setWordStatus(e.key, 1);
          queueCard(i, { word: e.p, meaning: exprTr(e), expr: true, hl: e.surf });
          fill();
        });
        kids.push(h('div', { class: 'ytam-tip-head' }, h('span', { text: e.surf || e.p }), save), varsEl(exprTr(e) ? [exprTr(e)] : []));
      }
      if (exprs.length) kids.push(h('div', { class: 'ytam-tip-head' }, h('span', { text: span.textContent })));
      kids.push(varsEl(vars));
      if (settings.showStageButtons) {
        const learning = S.vocab[w] === 1;
        kids.push(h('div', { class: 'ytam-tip-btns' },
          svgBtn('ytam-tb known' + (isKnown(w) ? ' on' : ''), 'check', 'Знаю', () => { setWordStatus(w, 2); fill(); }),
          svgBtn('ytam-tb learn' + (learning ? ' on' : ''), learning ? 'bookClock' : 'book', 'Изучаю — в Anki', () => {
            if (S.vocab[w] === 1) return;
            setWordStatus(w, 1);
            if (settings.ankiOnLearning && i >= 0) queueCard(i, { word: w, meaning: variants(w).slice(0, 3).join(', ') }, true);
            toast(`${w}: изучаю`);
            fill();
          })));
      }
      tipEl.replaceChildren(...kids);
      anchorTo(tipEl, span, X.tipGap, 160);
    };

    layer().append(tipEl);
    fill();
    if (!wasShown) {
      tipEl.classList.remove('show');
      void tipEl.offsetWidth; // restart the fade-in
    }
    tipEl.classList.add('show');
    getDictHi(w).then(fill);
    for (const e of exprs) {
      if (!exprTr(e)) bg({ type: 'translateWords', words: [e.key], tl: settings.targetLang, prio: 1 }).then((r) => { if (r[e.key]) { S.wordTr.set(e.key, r[e.key]); fill(); } }).catch(() => {});
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

  function dictLinks() {
    const custom = String(settings.customDicts || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length === 2 && /^https?:/.test(p[1]))
      .map(([name, url]) => [name.slice(0, 3), name, (w) => url.replace(/WORD/g, encodeURIComponent(w))]);
    return [...DICT_LINKS, ...custom];
  }

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
    out.replaceChildren(h('span', { class: 'ytam-spin small' }));
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
    scheduleResume();
  }

  function openWord(span, i) {
    // Second click on the same word closes the popup (LR behaviour).
    if (pop && pop.span === span) { closePop(); return; }
    closePop();
    hideTip();
    const word = span.textContent;
    const w = span.dataset.w;
    const cue = S.cues[i] || { text: word, start: 0, end: 0 };
    const v = getVideo();
    if (v && !v.paused) { v.pause(); S.hoverPaused = true; }
    if (settings.speakOnClick) speak(word);

    // The popup opens at once at its final size; translation and dictionary fill in place.
    const el = h('div', { class: 'ytam-pop' });
    for (const type of ['mousedown', 'click', 'contextmenu', 'keydown']) el.addEventListener(type, (e) => e.stopPropagation());
    layer().append(el);
    span.classList.add('ytam-w-sel');
    pop = { el, span };
    const parts = popContent(span, i, word, w, cue, el);
    el.replaceChildren(...parts.nodes);
    anchorTo(el, span, X.popGap, X.popAboveMin);
    parts.load(() => !!pop && pop.el === el);
  }

  function popContent(span, i, word, w, cue, el) {
    const exprs = exprsAt(i, +span.dataset.ti);
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
      if (e.key === 'Enter' && ask.value.trim()) {
        tabBtns.forEach((b) => b.classList.remove('on'));
        streamAI({ kind: 'ask', word, sentence: cue.text, question: ask.value.trim(), tl: settings.targetLang }, aiOut);
        ask.value = '';
      }
    });

    const dictBox = h('div', { class: 'ytam-pop-dict' });
    const trEl = h('div', { class: 'ytam-pop-tr' });
    const fillDict = () => {
      const d = dict.get(w);
      trEl.textContent = variants(w).slice(0, 3).join(', ') || '…';
      if (d && !(d instanceof Promise)) {
        dictBox.replaceChildren(h('div', { class: 'ytam-dict-word', text: word }),
          ...(d.dict.length ? d.dict.map((e) => h('div', {}, h('i', { text: `(${e.pos}) ` }), e.terms.join(', '))) : [h('div', { text: d.translation })]));
      } else {
        dictBox.replaceChildren(h('div', { class: 'ytam-dim', text: S.wordTr.get(w) ? S.wordTr.get(w) : '…' }));
      }
    };
    fillDict();
    const exprEls = exprs.map((e) => {
      const tr = h('span', { text: ' — ' + (exprTr(e) || '…') });
      return { e, tr };
    });

    const examples = S.cues.map((c, k) => k).filter((k) => k !== i && tokensOf(S.cues[k].text).includes(w)).slice(0, 4);
    const statusBtn = (st, icon, title) => {
      const b = svgBtn('ytam-sb', icon, title, () => {
        if (st === 1 && S.vocab[w] !== 1 && settings.ankiOnLearning && i >= 0) queueCard(i, { word, meaning: variants(w).slice(0, 3).join(', ') }, true);
        setWordStatus(w, S.vocab[w] === st ? 0 : st);
        setPill();
        el.querySelectorAll('.ytam-sb[data-st]').forEach((x) => x.classList.toggle('on', +x.dataset.st === (S.vocab[w] || 0)));
      });
      b.dataset.st = String(st);
      b.classList.toggle('on', (S.vocab[w] || 0) === st);
      return b;
    };
    const tabBar = h('div', { class: 'ytam-tabs' }, tabBtns);
    const out = [
      h('div', { class: 'ytam-pop-head' },
        pill,
        h('div', { class: 'ytam-pop-title' }, h('div', { class: 'ytam-pop-word', text: word }), trEl),
        h('button', { class: 'ytam-x', title: 'Произнести', text: '🔊', onclick: () => speak(word) }),
        h('button', { class: 'ytam-x', title: 'Закрыть', text: '✕', onclick: closePop })),
      exprs.length ? h('div', { class: 'ytam-pop-exprs' }, exprEls.map(({ e, tr }) => h('div', {},
        h('span', { class: 'ytam-tip-phrase', text: e.surf || e.p }), tr,
        svgBtn('ytam-tip-xsave' + (S.vocab[e.key] === 1 ? ' on' : ''), 'book', 'Выражение в Anki', (ev) => {
          setWordStatus(e.key, 1);
          queueCard(i, { word: e.p, meaning: exprTr(e), expr: true, hl: e.surf });
          ev.currentTarget.classList.add('on');
        })))) : null,
      tabBar, aiOut, ask, dictBox,
      examples.length ? h('div', { class: 'ytam-pop-ex' },
        h('div', { class: 'ytam-ex-head', text: 'Примеры из этого видео' }),
        examples.map((k) => h('div', { class: 'ytam-ex', onclick: () => { closePop(); seekCue(k, true); } }, wordsNode(S.cues[k].text, 'x', k)))) : null,
      h('div', { class: 'ytam-pop-links' }, dictLinks().map(([abbr, title, url]) =>
        h('a', { href: url(word, settings.targetLang), target: '_blank', rel: 'noopener', title, text: abbr }))),
      h('div', { class: 'ytam-pop-actions' },
        statusBtn(2, 'check', 'Знаю'),
        statusBtn(1, 'book', 'Изучаю — карточка в Anki'),
        statusBtn(3, 'ban', 'Не учить'),
        h('button', { class: 'ytam-sb star', text: STAR, title: 'Только фраза в Anki', onclick: () => { queueCard(i, null); closePop(); } })),
    ];
    setTimeout(() => tabBtns[0].click(), 0);
    return {
      nodes: out.filter(Boolean),
      load(alive) {
        getDictHi(w).then(() => { if (alive()) fillDict(); });
        for (const { e, tr } of exprEls) {
          if (exprTr(e)) continue;
          bg({ type: 'translateWords', words: [e.key], tl: settings.targetLang, prio: 1 })
            .then((r) => { if (r[e.key]) { S.wordTr.set(e.key, r[e.key]); if (alive()) tr.textContent = ' — ' + r[e.key]; } }).catch(() => {});
        }
      },
    };
  }

  let speakAudio = null;
  function speakBrowser(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  // Google Cloud voice (cached on disk, so each word is paid for once) with the browser voice as fallback.
  function speak(text) {
    if (settings.ttsProvider === 'browser') return speakBrowser(text);
    bg({ type: 'speakCloud', text }).then((r) => {
      try { if (speakAudio) speakAudio.pause(); } catch (_) {}
      speakAudio = new Audio('data:audio/mpeg;base64,' + r.b64);
      speakAudio.play().catch(() => speakBrowser(text));
    }).catch(() => { if (settings.ttsProvider !== 'cloud') speakBrowser(text); });
  }

  document.addEventListener('mousedown', (e) => {
    if (!pop || pop.el.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.ytam-w') === pop.span) return; // handled by the click toggle
    closePop();
  }, true);

  // ---------- speech-aware pauses (music under the voice does not fool them) ----------
  // Levels are measured in the speech band only. A pause is a stretch quieter than a threshold placed
  // between the background level (silence OR music) and the speech level, so a steady music bed does not
  // hide the gaps between phrases. If speech is not clearly louder than the background we say so
  // ("unreliable") and the callers fall back to YouTube's own timings.

  function biquad(type, fc, fs) {
    const q = 0.7071, w = (2 * Math.PI * fc) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    const b0 = type === 'hp' ? (1 + c) / 2 : (1 - c) / 2;
    const b1 = type === 'hp' ? -(1 + c) : 1 - c;
    const a0 = 1 + al;
    return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  }
  const makeBand = (fs) => [biquad('hp', X.vadLoHz, fs), biquad('hp', X.vadLoHz, fs), biquad('lp', Math.min(X.vadHiHz, fs * 0.45), fs)];
  function bandStep(filters, x) {
    for (const f of filters) {
      const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
      f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
      x = y;
    }
    return x;
  }
  const levelOf = (e) => 10 * Math.log10(e + 1);
  function bandLevels(data, rate, frame) {
    const filters = makeBand(rate);
    const nF = Math.floor(data.length / frame);
    const L = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
      let e = 0;
      for (let i = f * frame; i < (f + 1) * frame; i++) { const y = bandStep(filters, data[i]); e += y * y; }
      L[f] = levelOf(e / frame);
    }
    return L;
  }
  function pctOf(arr, p) {
    const a = Float32Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
  }
  function speechThreshold(L) {
    const floorL = pctOf(L, X.vadFloorPct), peakL = pctOf(L, X.vadPeakPct);
    const contrast = peakL - floorL;
    // midway between background and speech, but never stricter than the classic "−18 dB below speech"
    const thr = Math.max(floorL + X.vadMix * contrast, peakL + 20 * Math.log10(X.trimThrFactor));
    return { thr, floorL, peakL, contrast, reliable: contrast >= X.vadMinContrast };
  }

  // ---------- background audio capture ----------
  // While the video plays we keep the last few minutes of its sound in memory
  // (tagged with video time). Saving a phrase cuts it from there — playback
  // is never interrupted.

  const Tap = { v: null, stream: null, ctx: null, proc: null, src: null, srcIds: '', blocks: [], pass: 0, lastEnd: null, quietMs: 0, reliable: false, ring: [], band: null, bandRate: 0, contrast: 0 };

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
    const t1 = v.currentTime + X.tapOffset;
    const t0 = t1 - (n / sr) * v.playbackRate;
    if (Tap.lastEnd == null || Math.abs(t0 - Tap.lastEnd) > 0.25) { Tap.pass++; Tap.ring = []; Tap.quietMs = 0; }
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
    // Live pause detector (speech band, adaptive): stops playback at the real end of a phrase.
    const rate = sr / f;
    if (!Tap.band || Tap.bandRate !== rate) { Tap.band = makeBand(rate); Tap.bandRate = rate; Tap.ring = []; }
    let e2 = 0;
    for (let i = 0; i < out.length; i++) { const y = bandStep(Tap.band, out[i]); e2 += y * y; }
    const lvl = levelOf(e2 / Math.max(1, out.length));
    Tap.ring.push(lvl);
    if (Tap.ring.length > 64) Tap.ring.shift();
    const th = speechThreshold(Tap.ring);
    Tap.contrast = th.contrast;
    Tap.reliable = Tap.ring.length >= 16 && th.reliable;
    Tap.quietMs = lvl < th.thr ? Tap.quietMs + (n / sr) * 1000 : 0;
    Tap.blocks.push({ t0, t1, pass: Tap.pass, rate: sr / f, data: out });
    const maxBlocks = Math.ceil((X.tapMinutes * 60 * sr) / n);
    if (Tap.blocks.length > maxBlocks) Tap.blocks.splice(0, Tap.blocks.length - maxBlocks);
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

  // Finds the clip edges: snaps to nearby pauses (YouTube timings are often off by half a second).
  // endFound = a long enough pause after the phrase is already in the audio, so nothing more must be waited for.
  function edgesOf(ext, cueStart, cueEnd) {
    const { data, rate } = ext;
    const frame = Math.max(1, Math.round((rate * X.trimFrameMs) / 1000));
    const nF = Math.floor(data.length / frame);
    const fAt = (t) => Math.max(0, Math.min(nF - 1, Math.round(((t - ext.t0) / (ext.t1 - ext.t0)) * data.length / frame)));
    let sF = fAt(cueStart - settings.padStart), eF = fAt(cueEnd + settings.padEnd);
    let how = 'запас', endFound = false;

    let reliable = true;
    if (settings.smartTrim && nF > 10) {
      const L = bandLevels(data, rate, frame);
      const th = speechThreshold(L);
      reliable = th.reliable;
      const quiet = (f) => L[f] < th.thr;
      const keepS = Math.round(X.startKeepMs / X.trimFrameMs), keepE = Math.round(X.endKeepMs / X.trimFrameMs);
      const need = Math.max(1, Math.round(X.silenceMs / X.trimFrameMs));
      if (!reliable) {
        how = 'без анализа (фон громкий)';
      } else {
        // start: walk back from the cue start to the first quiet spot
        for (let f = fAt(cueStart), lim = fAt(cueStart - X.trimBack); f > lim; f--) {
          if (quiet(f) && quiet(f - 1)) { sF = Math.max(0, f - keepS); how = 'по паузам'; break; }
        }
        // end: walk forward from the cue end to the first long enough quiet run
        const fEnd = fAt(cueEnd + X.trimFwd);
        let run = 0, f = fAt(cueEnd - X.trimEndFrom);
        for (; f <= fEnd; f++) {
          run = quiet(f) ? run + 1 : 0;
          if (run >= need) { eF = Math.min(nF, f - run + 1 + keepE); how = 'по паузам'; endFound = true; break; }
        }
        // The recording simply stops in a pause (playback was paused right after the speech).
        if (!endFound && fEnd >= nF - 1 && run >= 3) { eF = Math.min(nF, nF - run + keepE); how = 'до тишины'; endFound = true; }
      }
    }
    return { frame, nF, sF, eF, how, endFound, reliable, tAt: (f) => ext.t0 + ((f * frame) / data.length) * (ext.t1 - ext.t0) };
  }

  // Returns PCM; trimClip.last holds the chosen edges (video time) for the dev menu.
  function trimClip(ext, cueStart, cueEnd) {
    const { data, rate } = ext;
    const { frame, sF, eF, how, tAt } = edgesOf(ext, cueStart, cueEnd);
    const out = data.slice(sF * frame, Math.max(sF + 1, eF) * frame);
    const fade = Math.min(out.length >> 1, Math.round((rate * X.fadeMs) / 1000));
    for (let i = 0; i < fade; i++) {
      out[i] = (out[i] * i) / fade;
      out[out.length - 1 - i] = (out[out.length - 1 - i] * i) / fade;
    }
    trimClip.last = { start: tAt(sF), end: tAt(Math.max(sF + 1, eF)), how };
    return out;
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function encodeMp3(pcm, rate) {
    const enc = new lamejs.Mp3Encoder(1, rate, X.mp3Kbps);
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
      const scale = Math.min(1, X.imgWidth / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', X.jpegQuality).split(',')[1];
    } catch (_) {
      return null;
    }
  }

  // ---------- audio source: yt-dlp helper (clean) or in-page capture (fallback) ----------

  const helperUsable = (videoId) => settings.audioSource !== 'capture' && videoId === S.videoId &&
    (S.helper.state === 'ready' || S.helper.state === 'downloading');

  function audioSpan(item) {
    const from = Math.max(0, item.cue.start + item.shift - X.clipLead);
    return { from, to: item.cue.end + item.shift + X.clipTail };
  }

  // Window of audio around the phrase: { data: Int16Array, rate, t0, t1, cov, src }
  async function clipAudio(item) {
    const { from, to } = audioSpan(item);
    if (settings.audioSource !== 'capture' && (helperUsable(item.videoId) || settings.audioSource === 'helper')) {
      try {
        const r = await bg({ type: 'helperPcm', url: settings.helperUrl, v: item.videoId, start: from, end: to, rate: X.helperRate, wait: X.helperWaitSec });
        const bytes = Uint8Array.from(atob(r.b64), (ch) => ch.charCodeAt(0));
        const data = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
        if (data.length) return { data, rate: r.rate, t0: from, t1: from + data.length / r.rate, cov: 1, src: 'yt-dlp' };
      } catch (e) {
        S.helper.error = e.message;
        if (settings.audioSource === 'helper') throw new Error('помощник yt-dlp: ' + e.message);
      }
    }
    const ext = tapExtract(from, to);
    if (ext) ext.src = 'запись с видео';
    return ext;
  }

  // Ask the helper to download this video's audio as soon as the video opens.
  async function helperPrepare(videoId, token) {
    S.helper = { state: 'off', progress: 0, error: '' };
    if (settings.audioSource === 'capture' || !settings.includeAudio) return;
    for (let i = 0; i < 600; i++) {
      let r;
      try {
        r = await bg({ type: 'helperPrepare', url: settings.helperUrl, v: videoId });
      } catch (e) {
        if (token !== S.token) return;
        S.helper = { state: 'off', progress: 0, error: e.message };
        if (settings.audioSource === 'helper') setStatus('🎵 Помощник yt-dlp не отвечает — запустите helper/start-helper.bat');
        return;
      }
      if (token !== S.token) return;
      S.helper = { state: r.state, progress: r.progress || 0, error: r.error || '' };
      if (r.state !== 'downloading') {
        if (r.state === 'error') setStatus('🎵 yt-dlp не смог скачать аудио: ' + r.error.slice(0, 160) + (settings.audioSource === 'helper' ? '' : ' Использую запись с видео.'));
        return;
      }
      await sleep(1500);
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
    const key = wordInfo ? norm(wordInfo.word) : `p:${S.videoId}:${cue.start.toFixed(1)}`;
    if (S.pending.some((p) => p.key === key && p.cue.start === cue.start)) return;
    if (!wordInfo) logSaved({ k: key, t: 'p', text: cue.text });
    const v = getVideo();
    const near = v && v.currentTime > cue.start - 1 && v.currentTime < cue.end + 1.5;
    S.pending.push({
      key,
      videoId: S.videoId,
      title: S.title,
      cue: { start: cue.start, end: cue.end, text: cue.text },
      shift: X.subShift, // audio times = cue times + shift
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

  // Share of the phrase itself (not the padding) that is present in an audio window.
  function coreCoverage(ext, cs, ce) {
    if (!ext || ce <= cs) return 0;
    return Math.max(0, Math.min(ext.t1, ce) - Math.max(ext.t0, cs)) / (ce - cs);
  }

  function processPending(force) {
    if (!S.pending.length) return;
    const v = getVideo();
    for (const item of [...S.pending]) {
      const age = Date.now() - item.queuedAt;
      // With the yt-dlp launcher the audio does not depend on playback: ready at once.
      let ready = force || !settings.includeAudio || helperUsable(item.videoId);
      if (!ready) {
        // Capture path: the phrase itself must have been heard. Its tail is waited for only while
        // playback runs; on pause (hover, popup) we go with what we have after a moment.
        const a = audioSpan(item);
        const cs = item.cue.start + item.shift, ce = item.cue.end + item.shift;
        const ext = tapExtract(a.from, a.to);
        if (ext && coreCoverage(ext, cs, ce) >= X.minCov) {
          const idle = !v || v.paused;
          ready = ext.t1 >= a.to - 0.05 || edgesOf(ext, cs, ce).endFound || (idle && age > X.pausedWaitMs) || age > 8000;
        } else if (v && !v.paused && item.videoId === S.videoId && (v.currentTime > ce + 5 || v.currentTime < cs - 30)) {
          ready = age > 3000; // played past it / jumped away without hearing it
        } else {
          ready = age > X.giveUpSec * 1000;
        }
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
        const ext = await clipAudio(item);
        if (ext && coreCoverage(ext, cue.start + item.shift, cue.end + item.shift) >= Math.min(X.minCov, 0.9)) audio = encodeMp3(trimClip(ext, cue.start + item.shift, cue.end + item.shift), ext.rate);
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
      const res = await bg({
        type: 'addCard',
        card: {
          key: item.key,
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
      if (res.queued) {
        toast(`⏳ Anki не отвечает — карточка сохранена в очереди (${res.count}). Откройте Anki или нажмите ⟳`, 'warn', 6000);
      } else {
        await addNoteId(item.key, res.noteId);
      }
      // Status changed while the card was being made → remove it again.
      if (!item.key.startsWith('p:') && S.vocab[item.key] !== 1) leftLearning(item.key, S.vocab[item.key]);
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
    v.currentTime = Math.max(0, c.start + X.subShift - X.seekLead);
    if (play) v.play();
  }

  let pendingTick = 0;
  function tick() {
    if (!S.videoId) return;
    const v = getVideo();
    if (!v) return;
    tapEnsure(v);
    if (++pendingTick % 5 === 0) processPending(false);
    if (!ui) return;
    mountOverlay();
    if (!S.cues.length) return;
    const t = v.currentTime - X.subShift;
    const a = cueIndexAt(t);
    updateHud(v, t, a);
    if (a !== S.active) { setActiveRow(a); S.active = a; prefetchAround(a); }
    const c = S.cues[a];
    const next = S.cues[a + 1];
    const endT = c ? Math.max(c.start + 0.3, Math.min(c.end, next ? next.start : Infinity) - X.autoPauseEarly) : 0;
    // Stop at the real end of the speech: after YouTube's end, wait (a little) for actual silence.
    const hardT = c ? Math.min(endT + X.endWaitMax, next ? next.start - 0.02 : Infinity) : 0;
    const speaking = !!Tap.src && Tap.reliable && Tap.quietMs < X.endQuietMs;
    if (!v.paused || S.holdCue !== a) S.holdCue = -1;
    // The subtitle stays while the phrase is still being spoken, and while we hold playback at its end.
    const shown = c && (t <= c.end + X.showTail || (!v.paused && speaking && t <= hardT) || S.holdCue === a) ? a : -1;
    if (shown !== S.shown) { S.shown = shown; renderOverlay(); }

    if (c && !v.paused) {
      const atEnd = t >= endT && (t >= hardT || !Tap.src || !Tap.reliable || Tap.quietMs >= X.endQuietMs);
      if (settings.autoPause && atEnd && S.lastAutoPause !== a) {
        S.lastAutoPause = a;
        S.holdCue = a;
        v.pause();
      }
      // Hover mode 'end': the pointer is on the subtitles/tooltip — stop when the phrase has finished.
      if (settings.pauseOnHover && settings.hoverPauseMode === 'end' && !S.posEdit && hoverActive() && atEnd) {
        S.holdCue = a;
        v.pause();
        S.hoverPaused = true;
      }
    }

    // AP switch turns red while playback is held (AP on + paused, or paused by hover).
    const held = (settings.autoPause && v.paused) || S.hoverPaused;
    if (held) S.heldSince = S.heldSince || Date.now(); else S.heldSince = 0;
    const red = held && Date.now() - S.heldSince >= X.apRedMs;
    if (red !== S.apRed) {
      S.apRed = red;
      const ap = ui.sideR.querySelector('.ytam-ap');
      if (ap) ap.classList.toggle('held', red);
    }
  }

  const hoverActive = () => S.hoverIn || !!(tipEl && tipEl.isConnected && tipEl.matches(':hover'));
  (function loop() { try { tick(); } catch (e) { console.warn('[ytam]', e); } setTimeout(loop, X.tickMs); })();

  document.addEventListener('pointerdown', () => {
    if (Tap.ctx && Tap.ctx.state === 'suspended') Tap.ctx.resume().catch(() => {});
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && pop) { closePop(); return; }
    if (!S.cues.length || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const cur = Math.max(0, S.active);

    if (e.ctrlKey) {
      // Ctrl+C with nothing selected copies the current phrase.
      if (e.code === 'KeyC' && !String(getSelection())) {
        const c = S.cues[S.shown >= 0 ? S.shown : cur];
        if (c) { navigator.clipboard.writeText(c.text).then(() => toast('Фраза скопирована')).catch(() => {}); e.preventDefault(); }
      }
      return;
    }

    // Status hotkeys while hovering a word: 1 learning, 2 known, 3 don't learn, 0 reset.
    if (S.hoverWord && /^Digit[0-3]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      const st = +e.code.slice(5);
      const w = S.hoverWord.el.dataset.w;
      if (st === 1 && S.vocab[w] !== 1 && settings.ankiOnLearning) queueCard(S.hoverWord.i, { word: w, meaning: variants(w).slice(0, 3).join(', ') }, true);
      setWordStatus(w, st);
      toast(`${w}: ${['новое', 'изучаю', 'знаю', 'не учить'][st]}`);
      if (tipFor) showTip(tipFor, S.hoverWord.i);
      return;
    }

    const actions = {
      KeyA: () => seekCue(Math.max(0, cur - 1), true),
      KeyD: () => seekCue(Math.min(S.cues.length - 1, cur + 1), true),
      KeyS: () => seekCue(cur, true),
      KeyQ: () => {
        chrome.storage.sync.set({ autoPause: !settings.autoPause });
        toast(!settings.autoPause ? 'Автопауза включена' : 'Автопауза выключена');
      },
      KeyR: () => queueCard(S.shown >= 0 ? S.shown : cur, null),
      KeyE: () => queueCard(S.shown >= 0 ? S.shown : cur, null),
    };
    if (settings.arrowKeys) {
      actions.ArrowLeft = actions.KeyA;
      actions.ArrowRight = actions.KeyD;
    }
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
    S.posDrag = false;
    hidePosRect();
    setProgress(null);
    document.documentElement.classList.remove('ytam-hidebar');
    if (ui) { ui.panel.remove(); ui.overlay.remove(); ui.sideL.remove(); ui.sideR.remove(); }
  }

  async function start(videoId) {
    teardown();
    const token = S.token;
    S.videoId = videoId;
    if (!ui) { ui = createUI(); setTab('subs'); }
    applySettings();
    chrome.storage.local.get({ saved: [] }).then((r) => { S.savedList = r.saved; refreshSideTabs(); });
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
    helperPrepare(videoId, token);
    if (!S.tracks.length) {
      if (settings.aiMode !== 'audio') return setStatus('У этого видео нет субтитров. Включите режим «ИИ слушает видео» — он создаст их сам.');
      S.track = { languageCode: 'ai', kind: 'ai', name: 'ИИ', baseUrl: '' };
      setStatus('');
      setProgress('🎧 ИИ слушает видео', null);
      try {
        const cues = await aiVideoProcess([], token);
        if (token === S.token) setProgress(null);
        if (token !== S.token || !cues) return;
        document.documentElement.classList.add('ytam-hide-native');
        setCues(cues);
        setStatus('');
        prefetchWords(token);
      } catch (e) {
        if (token === S.token) { setProgress(null); setStatus('ИИ не смог создать субтитры: ' + e.message); }
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

  Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get({ vocab: {}, dev: {}, outbox: [] })]).then(([s, l]) => {
    settings = { ...DEFAULTS, ...s };
    Object.assign(X, l.dev || {});
    S.vocab = l.vocab || {};
    renderOutbox((l.outbox || []).length);
    applySettings();
    onNavigate();
  });

  const RELOAD_KEYS = ['aiMode', 'aiProvider', 'aiBaseUrl', 'aiModel', 'maxWords', 'targetLang'];
  const RERENDER_KEYS = ['vocabSize', 'suggestedRatio', 'hlKnown', 'hlLearning', 'hlLearnText', 'hlNext', 'hlRare', 'builtinExpr'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.saved) { S.savedList = changes.saved.newValue || []; refreshSideTabs(); }
      if (changes.outbox) renderOutbox((changes.outbox.newValue || []).length);
      if (changes.dev) { Object.assign(X, self.YTAM_DEV_DEFAULTS, changes.dev.newValue || {}); syncDev(); }
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
    if ((changes.audioSource || changes.helperUrl || changes.includeAudio) && S.videoId) helperPrepare(S.videoId, S.token);
    if (changes.ankiSync || changes.ankiMatureDays || changes.ankiAutoKnown || changes.ankiGradient) { if (changes.ankiSync && !settings.ankiSync) S.progress = {}; syncAnki().catch(() => {}); }
    if (changes.enabled) { if (!settings.enabled) teardown(); onNavigate(); }
    if (reload && S.track && S.words.length) { S.token++; loadTrack(S.track, S.token); }
  });
})();
