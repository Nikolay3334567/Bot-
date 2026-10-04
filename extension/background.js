// Service worker: translation (Google Translate, no key), Gemini, AnkiConnect.
importScripts('defaults.js');

const MODEL = 'YT Anki Miner';
const FIELDS = ['Sentence', 'Translation', 'Word', 'WordMeaning', 'Audio', 'Image', 'Source'];

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
};

// ---------- Google Translate ----------

async function gtx(text, tl, dict = false) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dj=1&dt=t' +
    (dict ? '&dt=bd' : '') + '&tl=' + encodeURIComponent(tl);
  let r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!r.ok && text.length < 1500) r = await fetch(url + '&q=' + encodeURIComponent(text));
  if (!r.ok) throw new Error('Переводчик ответил HTTP ' + r.status);
  return r.json();
}

const joinTrans = (j) => (j.sentences || []).map((s) => s.trans || '').join('');

async function translateLines(lines, tl) {
  try {
    const parts = joinTrans(await gtx(lines.join('\n'), tl)).split('\n').map((s) => s.trim());
    if (parts.length === lines.length) return parts;
  } catch (e) {
    if (lines.length === 1) throw e;
  }
  // Line count got mangled — translate one by one, 4 at a time.
  const out = new Array(lines.length).fill('');
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < lines.length) {
      const i = next++;
      try { out[i] = joinTrans(await gtx(lines[i], tl)).trim(); } catch (_) {}
    }
  }));
  return out;
}

// Single-word translations, cached on disk so hovering is instant.
const wordCache = {};
const dirtyCaches = new Set();
let saveTimer = 0;

async function getWordCache(tl) {
  if (!wordCache[tl]) {
    const key = 'trc:' + tl;
    wordCache[tl] = (await chrome.storage.local.get(key))[key] || {};
  }
  return wordCache[tl];
}

function persistWordCache(tl) {
  dirtyCaches.add(tl);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const lang of dirtyCaches) chrome.storage.local.set({ ['trc:' + lang]: wordCache[lang] });
    dirtyCaches.clear();
  }, 1500);
}

async function translateWords(words, tl) {
  const cache = await getWordCache(tl);
  const missing = words.filter((w) => !(w in cache));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const out = await translateLines(chunk, tl);
    chunk.forEach((w, k) => { if (out[k]) cache[w] = out[k]; });
    persistWordCache(tl);
  }
  const res = {};
  for (const w of words) if (cache[w]) res[w] = cache[w];
  return res;
}

const lookupCache = new Map();
async function lookup(word, tl) {
  const key = tl + ':' + word.toLowerCase();
  if (lookupCache.has(key)) return lookupCache.get(key);
  const j = await gtx(word, tl, true);
  const res = {
    translation: joinTrans(j).trim(),
    dict: (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) })),
  };
  lookupCache.set(key, res);
  return res;
}

// ---------- Gemini ----------

const LANGS = { ru: 'Russian', uk: 'Ukrainian', be: 'Belarusian', kk: 'Kazakh', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish', tr: 'Turkish', 'zh-CN': 'Chinese (Simplified)', ja: 'Japanese' };

async function aiSegment({ text, tl, maxWords, model }) {
  const { geminiKey } = await chrome.storage.local.get(YTAM_LOCAL_DEFAULTS);
  if (!geminiKey) throw new Error('Не задан ключ Gemini API (Настройки → ИИ)');
  const prompt = `You are given a fragment of a YouTube transcript. It may lack punctuation and capitalization (auto-generated captions) or be split mid-sentence.

Task:
1. Restore correct punctuation and capitalization.
2. Split the text into subtitle lines. Each line is one complete sentence. If a sentence is longer than ${maxWords} words, split it at natural clause boundaries so every line has at most ${maxWords} words.
3. Translate each line into ${LANGS[tl] || tl} naturally, using the surrounding context.

Strict rules:
- Keep EVERY word of the original in the original order. Do not add, remove, reorder, or paraphrase words. Only change punctuation and letter case.
- The fragment may start or end mid-sentence; keep those parts as their own lines.
- Return JSON: an array of objects {"s": original-language line, "t": translation}.

Transcript:
${text}`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { s: { type: 'STRING' }, t: { type: 'STRING' } }, required: ['s', 't'] },
        },
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gemini: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
  const out = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const lines = JSON.parse(out.map((p) => p.text || '').join(''));
  return { lines, usage: j.usageMetadata || null };
}

// ---------- AnkiConnect ----------

async function anki(action, params = {}) {
  const { ankiUrl } = await chrome.storage.sync.get({ ankiUrl: 'http://127.0.0.1:8765' });
  let r;
  try {
    r = await fetch(ankiUrl, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
  } catch (_) {
    throw new Error('Нет связи с Anki. Откройте Anki и проверьте, что установлен AnkiConnect.');
  }
  const j = await r.json();
  if (j.error) throw new Error('Anki: ' + j.error);
  return j.result;
}

const CSS = `.card{font-family:Arial,sans-serif;font-size:22px;text-align:center;color:#1d1d1f;background:#fafafa}
.nightMode.card,.night_mode .card{color:#eee;background:#222}
.img img{max-width:100%;max-height:45vh;border-radius:8px}
.sentence{margin:14px 0;line-height:1.4}
.sentence b{color:#1a73e8}
.word{font-size:18px;color:#888}
.tr{font-size:20px;color:#b06d00;margin:10px 0}
.meaning{font-size:17px;margin:8px 0}
.src{margin-top:22px;font-size:14px;color:#888}
.src a{display:inline-block;padding:6px 14px;border-radius:16px;background:#ff0033;color:#fff;text-decoration:none;font-weight:bold}
.src .title{margin-top:6px;font-size:12px}`;

const FRONT = `<div class="img">{{Image}}</div>
<div class="sentence">{{Sentence}}</div>
{{#Word}}<div class="word">{{Word}}</div>{{/Word}}
{{Audio}}`;

const BACK = `{{FrontSide}}
<hr id="answer">
<div class="tr">{{Translation}}</div>
{{#WordMeaning}}<div class="meaning"><b>{{Word}}</b> — {{WordMeaning}}</div>{{/WordMeaning}}
<div class="src">{{Source}}</div>`;

let modelReady = false;
async function ensureModel() {
  if (modelReady) return;
  const names = await anki('modelNames');
  if (!names.includes(MODEL)) {
    await anki('createModel', {
      modelName: MODEL,
      inOrderFields: FIELDS,
      css: CSS,
      isCloze: false,
      cardTemplates: [{ Name: 'YouTube', Front: FRONT, Back: BACK }],
    });
  } else {
    // Keep the note type in sync with the current templates.
    try {
      await anki('updateModelTemplates', { model: { name: MODEL, templates: { YouTube: { Front: FRONT, Back: BACK } } } });
      await anki('updateModelStyling', { model: { name: MODEL, css: CSS } });
    } catch (_) {}
  }
  modelReady = true;
}

async function addCard(c) {
  await ensureModel();
  await anki('createDeck', { deck: c.deck });
  const base = `ytam_${c.videoId}_${Math.round(c.start * 1000)}_${Date.now().toString(36)}`;
  let audio = '', image = '';
  if (c.audio) {
    const fn = await anki('storeMediaFile', { filename: base + '.mp3', data: c.audio });
    audio = `[sound:${fn || base + '.mp3'}]`;
  }
  if (c.image) {
    const fn = await anki('storeMediaFile', { filename: base + '.jpg', data: c.image });
    image = `<img src="${fn || base + '.jpg'}">`;
  }
  const link = `https://youtu.be/${c.videoId}?t=${Math.floor(c.start)}`;
  return anki('addNote', {
    note: {
      deckName: c.deck,
      modelName: MODEL,
      fields: {
        Sentence: c.sentenceHtml,
        Translation: esc(c.translation),
        Word: esc(c.word),
        WordMeaning: esc(c.wordMeaning),
        Audio: audio,
        Image: image,
        Source: `<a href="${link}">▶ Смотреть на YouTube · ${fmtTime(c.start)}</a><div class="title">${esc(c.title)}</div>`,
      },
      options: { allowDuplicate: true },
      tags: ['youtube', 'yt-anki-miner'],
    },
  });
}

// ---------- Messaging ----------

async function handle(msg) {
  switch (msg.type) {
    case 'translateLines': return translateLines(msg.lines, msg.tl);
    case 'translateWords': return translateWords(msg.words, msg.tl);
    case 'lookup': return lookup(msg.word, msg.tl);
    case 'aiSegment': return aiSegment(msg);
    case 'addCard': return addCard(msg.card);
    case 'ankiStatus': {
      const version = await anki('version');
      const decks = await anki('deckNames');
      return { version, decks };
    }
    case 'openOptions': return chrome.runtime.openOptionsPage();
    default: throw new Error('Unknown message ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    (result) => sendResponse({ result }),
    (e) => sendResponse({ error: (e && e.message) || String(e) }),
  );
  return true;
});
