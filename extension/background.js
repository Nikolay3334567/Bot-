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

// ---- Google Cloud (Translation Basic v2 + Text-to-Speech) with a hard monthly character guard ----

const monthKey = () => new Date().toISOString().slice(0, 7);

async function usageGet() {
  const { usage } = await chrome.storage.local.get('usage');
  return usage && usage.m === monthKey() ? usage : { m: monthKey(), tr: 0, tts: 0, fallbackTr: 0 };
}
async function usageAdd(kind, n) {
  const u = await usageGet();
  u[kind] = (u[kind] || 0) + n;
  await chrome.storage.local.set({ usage: u });
  return u;
}

async function cloudCfg() {
  const [sync, local] = await Promise.all([chrome.storage.sync.get(YTAM_DEFAULTS), chrome.storage.local.get(YTAM_LOCAL_DEFAULTS)]);
  return { ...sync, key: local.googleCloudKey || '' };
}

// Can this request be sent to Google Cloud (key present, provider allows it, under the monthly guard)?
async function cloudOk(kind, chars) {
  const c = await cloudCfg();
  if (!c.key) return false;
  const provider = kind === 'tr' ? c.trProvider : c.ttsProvider;
  if (provider === 'free' || provider === 'browser') return false;
  const u = await usageGet();
  const limit = kind === 'tr' ? c.cloudTrLimit : c.ttsLimit;
  if ((u[kind] || 0) + chars > limit) {
    if (kind === 'tr') await usageAdd('fallbackTr', 1);
    return false;
  }
  return true;
}

async function cloudFetch(url, body, label) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (_) { throw new Error(label + ': нет связи'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || 'HTTP ' + r.status;
    throw new Error(label + ': ' + String(m).slice(0, 240));
  }
  return j;
}

// Array in, aligned array out (no line-count guessing). ≤ 100 strings / ~20k characters per request.
async function cloudTranslate(texts, tl, sl) {
  const { key } = await cloudCfg();
  const out = [];
  let i = 0;
  while (i < texts.length) {
    const chunk = [];
    let chars = 0;
    while (i < texts.length && chunk.length < 100 && chars + texts[i].length < 20000) { chars += texts[i].length; chunk.push(texts[i++]); }
    if (!chunk.length) { chunk.push(texts[i++].slice(0, 20000)); chars = chunk[0].length; }
    const body = { q: chunk, target: tl, format: 'text' };
    if (sl && sl !== 'auto') body.source = sl;
    const j = await cloudFetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), body, 'Cloud Translation');
    const tr = (j.data && j.data.translations) || [];
    if (tr.length !== chunk.length) throw new Error('Cloud Translation: неожиданный ответ');
    await usageAdd('tr', chars);
    for (const t of tr) out.push(String(t.translatedText || '').trim());
  }
  return out;
}

const ttsCache = new Map();
async function cloudTts(text, voice, rate) {
  const { key } = await cloudCfg();
  const ck = voice + '|' + rate + '|' + text.toLowerCase();
  if (ttsCache.has(ck)) return ttsCache.get(ck);
  const stored = (await chrome.storage.local.get('ttsCache')).ttsCache || {};
  if (stored[ck]) { ttsCache.set(ck, stored[ck]); return stored[ck]; }
  const lang = String(voice).split('-').slice(0, 2).join('-') || 'en-US';
  const j = await cloudFetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
    input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: rate || 1 },
  }, 'Cloud Text-to-Speech');
  if (!j.audioContent) throw new Error('Cloud Text-to-Speech: пустой ответ');
  await usageAdd('tts', text.length);
  ttsCache.set(ck, j.audioContent);
  const keys = Object.keys(stored);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 399)) delete stored[k];
  stored[ck] = j.audioContent;
  await chrome.storage.local.set({ ttsCache: stored });
  return j.audioContent;
}

async function speakCloud({ text }) {
  const c = await cloudCfg();
  if (!(await cloudOk('tts', text.length))) throw new Error('озвучка Google недоступна (нет ключа, выключена или предел)');
  return { b64: await cloudTts(text, c.ttsVoice, c.ttsRate) };
}

// Key check for the settings page: translates one word and synthesises one short word.
async function cloudTest() {
  const out = { tr: null, tts: null };
  const c = await cloudCfg();
  if (!c.key) return { error: 'Ключ не задан' };
  try { out.tr = (await cloudTranslate(['hello'], c.targetLang, 'en'))[0]; } catch (e) { out.tr = '✗ ' + e.message; }
  try { await cloudTts('hello', c.ttsVoice, c.ttsRate); out.tts = 'ok'; } catch (e) { out.tts = '✗ ' + e.message; }
  out.usage = await usageGet();
  return out;
}

// ---- Google Translate access: one shared queue (hover requests first), spacing and retries,
// so a burst of prefetching can never lock us out and hover always gets an answer.

const gq = { hi: [], lo: [], active: 0, last: 0, pauseUntil: 0, timer: 0 };
const GQ_CONC = 3, GQ_GAP = 110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gqRun(fn, prio) {
  return new Promise((resolve, reject) => {
    (prio ? gq.hi : gq.lo).push({ fn, resolve, reject });
    gqPump();
  });
}

function gqPump() {
  clearTimeout(gq.timer);
  while (gq.active < GQ_CONC && (gq.hi.length || gq.lo.length)) {
    const now = Date.now();
    const wait = Math.max(gq.last + GQ_GAP - now, gq.hi.length ? 0 : gq.pauseUntil - now);
    if (wait > 0) { gq.timer = setTimeout(gqPump, wait); return; }
    gq.last = now;
    const job = gq.hi.shift() || gq.lo.shift();
    gq.active++;
    job.fn().then(job.resolve, job.reject).finally(() => { gq.active--; gqPump(); });
  }
}

async function gtxFetch(text, tl, dict) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dj=1&dt=t' +
    (dict ? '&dt=bd' : '') + '&tl=' + encodeURIComponent(tl);
  let status = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    let r = null;
    try {
      r = attempt % 2 === 1 && text.length < 1500
        ? await fetch(url + '&q=' + encodeURIComponent(text))
        : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'q=' + encodeURIComponent(text) });
    } catch (_) { r = null; }
    if (r && r.ok) return r.json();
    status = r ? r.status : 0;
    if (r && status !== 429 && status < 500) break; // not worth retrying
    gq.pauseUntil = Date.now() + 800 * (attempt + 1); // back off the background traffic too
    await sleep(350 * 2 ** attempt);
  }
  throw new Error(status ? 'Переводчик ответил HTTP ' + status : 'Нет связи с переводчиком');
}

const gtx = (text, tl, dict = false, prio = 0) => gqRun(() => gtxFetch(text, tl, dict), prio);

const joinTrans = (j) => (j.sentences || []).map((s) => s.trans || '').join('');

// Lines in, translated lines out. If Google merges/splits lines we bisect (a handful of
// requests) instead of translating every line separately.
async function translateLines(lines, tl, prio = 0, sl = 'auto') {
  if (!lines.length) return [];
  const chars = lines.reduce((n, l) => n + l.length, 0);
  if (await cloudOk('tr', chars)) {
    try { return await cloudTranslate(lines, tl, sl); } catch (e) { /* key/quota problem: fall back to the free endpoint */ }
  }
  return translateLinesFree(lines, tl, prio);
}

async function translateLinesFree(lines, tl, prio = 0) {
  if (lines.length === 1) return [joinTrans(await gtx(lines[0], tl, false, prio)).trim()];
  const parts = joinTrans(await gtx(lines.join('\n'), tl, false, prio)).split('\n').map((x) => x.trim());
  if (parts.length === lines.length) return parts;
  const mid = lines.length >> 1;
  return [...(await translateLinesFree(lines.slice(0, mid), tl, prio)), ...(await translateLinesFree(lines.slice(mid), tl, prio))];
}

// Persistent caches so hover translations are instant on every video.
const caches = {};
const dirtyCaches = new Set();
let saveTimer = 0;

async function getCache(name) {
  if (!caches[name]) caches[name] = (await chrome.storage.local.get(name))[name] || {};
  return caches[name];
}

function persistCache(name) {
  dirtyCaches.add(name);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const n of dirtyCaches) chrome.storage.local.set({ [n]: caches[n] });
    dirtyCaches.clear();
  }, 1500);
}

async function translateWords(words, tl, prio = 0, sl = 'auto') {
  const cache = await getCache('trc:' + tl);
  const missing = words.filter((w) => !(w in cache));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const out = await translateLines(chunk, tl, prio, sl);
    chunk.forEach((w, k) => { if (out[k]) cache[w] = out[k]; });
    persistCache('trc:' + tl);
  }
  const res = {};
  for (const w of words) if (cache[w]) res[w] = cache[w];
  return res;
}

async function lookup(word, tl, prio = 0, sl = 'auto') {
  const name = 'lkc:' + tl;
  const cache = await getCache(name);
  const key = word.toLowerCase();
  if (cache[key]) return cache[key];
  const c = await cloudCfg();
  let res;
  if (await cloudOk('tr', word.length)) {
    // Cloud gives one reliable translation at once; variants come from the free dictionary if it answers quickly.
    const variants = c.cloudVariants
      ? Promise.race([gtx(word, tl, true, prio).catch(() => null), sleep(1500).then(() => null)])
      : Promise.resolve(null);
    try {
      const [tr, j] = await Promise.all([cloudTranslate([word], tl, sl), variants]);
      res = {
        translation: tr[0] || (j ? joinTrans(j).trim() : ''),
        dict: j ? (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) })) : [],
      };
    } catch (_) { res = null; }
  }
  if (!res) {
    const j = await gtx(word, tl, true, prio);
    res = { translation: joinTrans(j).trim(), dict: (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) })) };
  }
  cache[key] = res;
  persistCache(name);
  return res;
}

// ---------- Gemini ----------

const LANGS = { ru: 'Russian', uk: 'Ukrainian', be: 'Belarusian', kk: 'Kazakh', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish', tr: 'Turkish', 'zh-CN': 'Chinese (Simplified)', ja: 'Japanese' };

// ---- provider-agnostic LLM calls: Gemini (default) or any OpenAI-compatible API ----

async function aiConfig() {
  const [sync, local] = await Promise.all([chrome.storage.sync.get(YTAM_DEFAULTS), chrome.storage.local.get(YTAM_LOCAL_DEFAULTS)]);
  return { ...sync, ...local };
}

const parseObj = (t, what) => {
  if (!t || !String(t).trim()) return {};
  try { return JSON.parse(t); } catch (_) { throw new Error(`«${what}»: неверный JSON`); }
};

function parseJsonLoose(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const i = Math.min(...['[', '{'].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
  const j = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (i < Infinity && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error('ИИ вернул не JSON');
}

const asLines = (j) => (Array.isArray(j) ? j : j && (j.lines || j.subtitles || j.items || j.result)) || [];

function openAiRequest(cfg, prompt, extra = {}) {
  const base = String(cfg.aiBaseUrl || '').replace(/\/+$/, '');
  const url = base + (cfg.aiChatPath || '/chat/completions');
  const headers = { 'Content-Type': 'application/json', ...parseObj(cfg.aiHeaders, 'Свои заголовки') };
  if (cfg.aiKey) headers.Authorization = 'Bearer ' + cfg.aiKey;
  const messages = [];
  if (cfg.aiSystem) messages.push({ role: 'system', content: cfg.aiSystem });
  messages.push({ role: 'user', content: prompt });
  return { url, init: (model, temperature, stream) => ({ method: 'POST', headers, body: JSON.stringify({ model, messages, temperature, stream: !!stream, ...parseObj(cfg.aiExtraBody, 'Доп. параметры'), ...extra }) }) };
}

async function httpError(r, label) {
  const j = await r.json().catch(() => ({}));
  const msg = (j.error && (j.error.message || j.error)) || j.message || 'HTTP ' + r.status;
  throw new Error(label + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300));
}

// Returns the text of the model's answer.
async function llm({ model, prompt, json, schema, temperature = 0.2, media }) {
  const cfg = await aiConfig();
  if (cfg.aiProvider === 'openai') {
    if (media) throw new Error('Режим «слушает видео» работает только с Gemini');
    const req = openAiRequest(cfg, prompt + (json ? '\n\nReturn ONLY valid JSON, without commentary or code fences.' : ''));
    let r;
    try { r = await fetch(req.url, req.init(model, temperature, false)); } catch (e) { throw new Error('Нет доступа к ' + req.url + ' — разрешите адрес в настройках расширения (страница настроек → ИИ) или проверьте его'); }
    if (!r.ok) await httpError(r, 'ИИ');
    const j = await r.json();
    return (((j.choices || [])[0] || {}).message || {}).content || '';
  }
  if (!cfg.geminiKey) throw new Error('Не задан ключ Gemini API (⚙ → ИИ)');
  const base = String(cfg.aiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const parts = [];
  if (media) parts.push(media);
  parts.push({ text: prompt });
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature, ...parseObj(cfg.aiExtraBody, 'Доп. параметры') } };
  if (cfg.aiSystem) body.systemInstruction = { parts: [{ text: cfg.aiSystem }] };
  if (json) { body.generationConfig.responseMimeType = 'application/json'; if (schema) body.generationConfig.responseSchema = schema; }
  if (media) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  let r;
  try {
    r = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey, ...parseObj(cfg.aiHeaders, 'Свои заголовки') },
      body: JSON.stringify(body),
    });
  } catch (e) { throw new Error('Нет доступа к ' + base + ' — разрешите адрес в настройках расширения'); }
  if (!r.ok) await httpError(r, 'Gemini');
  const j = await r.json();
  const out = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return out.map((p) => p.text || '').join('');
}

const EXPR_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { p: { type: 'STRING' }, t: { type: 'STRING' } }, required: ['p', 't'] },
};

const EXPR_RULE = (lang) => `- "x": idioms, phrasal verbs, fixed expressions and collocations in the line whose meaning is not obvious from the single words (e.g. "get along", "needs to be", "for the sake of", "doesn't cut it"). "p" must be copied exactly as it appears in the line, "t" is its meaning in ${lang}. Empty array if none.`;

async function aiSegment({ text, tl, maxWords, model, temperature = 0.2 }) {
  const lang = LANGS[tl] || tl;
  const prompt = `You are given a fragment of a YouTube transcript. It may lack punctuation and capitalization (auto-generated captions) or be split mid-sentence.

Task:
1. Restore correct punctuation and capitalization.
2. Split the text into subtitle lines. Each line is one complete sentence. If a sentence is longer than ${maxWords} words, split it at natural clause boundaries so every line has at most ${maxWords} words.
3. Translate each line into ${lang} naturally, using the surrounding context.

Strict rules:
- Keep EVERY word of the original in the original order. Do not add, remove, reorder, or paraphrase words. Only change punctuation and letter case.
- The fragment may start or end mid-sentence; keep those parts as their own lines.
- Return JSON array of {"s": original-language line, "t": translation, "x": expressions}.
${EXPR_RULE(lang)}

Transcript:
${text}`;
  const out = await llm({
    model, prompt, json: true, temperature,
    schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { s: { type: 'STRING' }, t: { type: 'STRING' }, x: EXPR_SCHEMA }, required: ['s', 't'] } },
  });
  return { lines: asLines(parseJsonLoose(out)) };
}

// "03:07.4", "1:02:03", "187.4" or 187.4 -> seconds
const parseTs = (v) => {
  if (typeof v === 'number') return v;
  const parts = String(v == null ? '' : v).trim().split(':').map(parseFloat);
  if (!parts.length || parts.some((x) => isNaN(x))) return NaN;
  return parts.reduce((a, x) => a * 60 + x, 0);
};

// Gemini watches/listens to the YouTube video itself (public videos only).
async function aiVideo({ videoId, from, to, tl, maxWords, model, fps = 0.2, temperature = 0.1 }) {
  const lang = LANGS[tl] || tl;
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const prompt = `Listen to the speech in this video from ${mmss(from)} to ${mmss(to)} and produce accurate subtitles.

Rules:
- Transcribe verbatim in the spoken language, with correct punctuation and capitalization. Do not summarize or skip anything said in that range. Ignore music and sound effects.
- One subtitle line = one complete sentence. If a sentence is longer than ${maxWords} words, split it at natural clause boundaries.
- "b" and "e": start and end of the line as a timestamp string "MM:SS.s" (e.g. "03:07.4", or "H:MM:SS.s" past one hour) measured from the BEGINNING OF THE WHOLE VIDEO (not of the range), precise to 0.1 s. "b" is when the first word of the line starts and "e" is when its last word actually ends.
- "t": natural translation of the line into ${lang} using context.
${EXPR_RULE(lang)}
Return JSON array of {"b","e","s","t","x"} ordered by time.`;
  const out = await llm({
    model, prompt, json: true, temperature,
    media: { fileData: { fileUri: 'https://www.youtube.com/watch?v=' + videoId }, videoMetadata: { startOffset: Math.floor(from) + 's', endOffset: Math.ceil(to) + 's', fps } },
    schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { b: { type: 'STRING' }, e: { type: 'STRING' }, s: { type: 'STRING' }, t: { type: 'STRING' }, x: EXPR_SCHEMA }, required: ['b', 'e', 's', 't'] } },
  });
  let lines = asLines(parseJsonLoose(out)).filter((l) => l && l.s)
    .map((l) => ({ ...l, b: parseTs(l.b), e: parseTs(l.e) }))
    .filter((l) => isFinite(l.b));
  lines.forEach((l) => { if (!isFinite(l.e) || l.e <= l.b) l.e = l.b + 2; });
  // Some answers count from the start of the range instead of the video.
  if (from > 30 && lines.length && lines[0].b < from - 20) lines = lines.map((l) => ({ ...l, b: l.b + from, e: l.e + from }));
  return { lines };
}

// Streaming explanations for the word popup (Объяснить / Примеры / Грамматика / вопрос).
function explainPrompt({ kind, word, sentence, question, tl }, cfg) {
  const lang = LANGS[tl] || tl;
  const base = `Фраза из видео: "${sentence}"\nСлово или выражение: "${word}"\nОтвечай на языке: ${lang}. Кратко (до 90 слов), простым текстом; можно **жирный** и списки через "- ".`;
  const fill = (t) => String(t || '').replace(/\{word\}/g, word).replace(/\{sentence\}/g, sentence);
  switch (kind) {
    case 'explain': return `${base}\n${fill(cfg.aiPromptExplain)}`;
    case 'examples': return `${base}\n${fill(cfg.aiPromptExamples)}`;
    case 'grammar': return `${base}\n${fill(cfg.aiPromptGrammar)}`;
    default: return `${base}\nВопрос ученика: ${question}`;
  }
}

async function readSse(r, onData) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { onData(JSON.parse(data)); } catch (_) {}
    }
  }
}

async function streamLlm(model, prompt, onDelta) {
  const cfg = await aiConfig();
  if (cfg.aiProvider === 'openai') {
    const req = openAiRequest(cfg, prompt);
    let r;
    try { r = await fetch(req.url, req.init(model, 0.4, true)); } catch (_) { throw new Error('Нет доступа к ' + req.url + ' — разрешите адрес в настройках расширения'); }
    if (!r.ok) await httpError(r, 'ИИ');
    await readSse(r, (j) => { const d = ((j.choices || [])[0] || {}).delta; if (d && d.content) onDelta(d.content); });
    return;
  }
  if (!cfg.geminiKey) throw new Error('Не задан ключ Gemini API (⚙ → ИИ)');
  const base = String(cfg.aiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 600, ...parseObj(cfg.aiExtraBody, 'Доп. параметры') } };
  if (cfg.aiSystem) body.systemInstruction = { parts: [{ text: cfg.aiSystem }] };
  const r = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey, ...parseObj(cfg.aiHeaders, 'Свои заголовки') },
    body: JSON.stringify(body),
  });
  if (!r.ok) await httpError(r, 'Gemini');
  await readSse(r, (j) => {
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.map((p) => p.text || '').join('');
    if (text) onDelta(text);
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ytam-ai') return;
  port.onMessage.addListener(async (msg) => {
    try {
      const cfg = await chrome.storage.sync.get(YTAM_DEFAULTS);
      await streamLlm(cfg.aiFastModel, explainPrompt(msg, cfg), (delta) => port.postMessage({ delta }));
      port.postMessage({ done: true });
    } catch (e) {
      try { port.postMessage({ error: e.message || String(e) }); } catch (_) {}
    }
  });
});

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

async function addCard(c) {  // writes one note to Anki (throws when Anki is unreachable)
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

// ---------- Anki outbox: cards made while Anki is closed are kept and sent later ----------

const OUTBOX = 'outbox';
const outboxGet = async () => (await chrome.storage.local.get({ [OUTBOX]: [] }))[OUTBOX];
const outboxSet = (box) => chrome.storage.local.set({ [OUTBOX]: box });
let flushing = null;

// Remember which Anki note belongs to a tracked word/phrase (so it can be removed later).
async function recordNote(key, id) {
  if (!key || !id) return;
  const { saved = [] } = await chrome.storage.local.get('saved');
  const e = saved.find((x) => x.k === key);
  if (!e) return;
  e.ids = [...new Set([...(e.ids || []), id])];
  await chrome.storage.local.set({ saved });
}

async function addCardOrQueue(card) {
  try {
    const noteId = await addCard(card);
    flushOutbox().catch(() => {}); // Anki is up: send whatever has been waiting
    return { noteId, queued: false };
  } catch (e) {
    const box = await outboxGet();
    box.push({ ...card, queuedAt: Date.now(), error: e.message });
    await outboxSet(box);
    return { queued: true, error: e.message, count: box.length };
  }
}

async function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    let box = await outboxGet();
    if (!box.length) return { sent: 0, left: 0 };
    try { await anki('version'); } catch (e) { return { sent: 0, left: box.length, error: e.message }; }
    let sent = 0, error = '';
    const keep = [];
    for (const card of box) {
      try {
        const id = await addCard(card);
        await recordNote(card.key, id);
        sent++;
      } catch (e) {
        error = e.message;
        card.error = e.message;
        keep.push(card);
        if (/Нет связи/.test(e.message)) { keep.push(...box.slice(box.indexOf(card) + 1)); break; }
      }
    }
    await outboxSet(keep);
    return { sent, left: keep.length, error };
  })().finally(() => { flushing = null; });
  return flushing;
}

chrome.alarms.create('ytam-outbox', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ytam-outbox') flushOutbox().catch(() => {}); });
flushOutbox().catch(() => {});

// ---------- Anki progress (word -> best card interval, days) ----------

const unHtml = (t) => String(t || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim().toLowerCase();

async function ankiProgress() {
  const noteIds = await anki('findNotes', { query: 'tag:yt-anki-miner' });
  const words = {};
  for (let i = 0; i < noteIds.length; i += 400) {
    const infos = await anki('notesInfo', { notes: noteIds.slice(i, i + 400) });
    const byCard = new Map();
    for (const n of infos) {
      const w = unHtml(n.fields && n.fields.Word && n.fields.Word.value);
      if (!w) continue;
      (words[w] = words[w] || { ivl: 0, reps: 0, notes: [] }).notes.push(n.noteId);
      for (const c of n.cards || []) byCard.set(c, w);
    }
    const cards = [...byCard.keys()];
    if (!cards.length) continue;
    const cinfo = await anki('cardsInfo', { cards });
    for (const c of cinfo) {
      const w = byCard.get(c.cardId);
      if (!w) continue;
      words[w].ivl = Math.max(words[w].ivl, c.interval > 0 ? c.interval : 0);
      words[w].reps = Math.max(words[w].reps, c.reps || 0);
    }
  }
  return words;
}

// ---------- Local yt-dlp helper (helper/ytam_helper.py) ----------

async function helperFetch(base, path) {
  let r;
  try {
    r = await fetch(String(base || YTAM_DEFAULTS.helperUrl).replace(/\/+$/, '') + path, { cache: 'no-store' });
  } catch (_) {
    throw new Error('помощник не запущен');
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'помощник: HTTP ' + r.status);
  }
  return r;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function helperPcm({ url, v, start, end, rate, wait = 20 }) {
  const q = `/pcm?v=${encodeURIComponent(v)}&start=${start.toFixed(3)}&end=${end.toFixed(3)}&rate=${rate}&wait=${wait}`;
  const buf = new Uint8Array(await (await helperFetch(url, q)).arrayBuffer());
  return { b64: bytesToB64(buf), rate };
}

// ---------- Messaging ----------

async function handle(msg) {
  switch (msg.type) {
    case 'translateLines': return translateLines(msg.lines, msg.tl, msg.prio, msg.sl);
    case 'translateWords': return translateWords(msg.words, msg.tl, msg.prio, msg.sl);
    case 'lookup': return lookup(msg.word, msg.tl, msg.prio, msg.sl);
    case 'speakCloud': return speakCloud(msg);
    case 'cloudTest': return cloudTest();
    case 'usage': return usageGet();
    case 'aiSegment': return aiSegment(msg);
    case 'aiVideo': return aiVideo(msg);
    case 'addCard': return addCardOrQueue(msg.card);
    case 'syncNow': return flushOutbox();
    case 'outboxClear': return outboxSet([]);
    case 'helperPing': return (await helperFetch(msg.url, '/ping')).json();
    case 'helperPrepare': return (await helperFetch(msg.url, '/prepare?v=' + encodeURIComponent(msg.v))).json();
    case 'helperPcm': return helperPcm(msg);
    case 'ankiProgress': return ankiProgress();
    case 'deleteNotes': return anki('deleteNotes', { notes: msg.ids });
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
