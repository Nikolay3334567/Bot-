// Service worker: translation (Google Translate, no key), Gemini, AnkiConnect.
importScripts('defaults.js');
try { importScripts('lib/lame.min.js'); } catch (_) {}
try { importScripts('data/freq_en.js'); } catch (_) {} // word list (also used to build the offline dictionary) // MP3 encoder (kept off the page's main thread)

const MODEL = 'YT Anki Miner';
const FIELDS = ['Sentence', 'Translation', 'Word', 'WordMeaning', 'Audio', 'Image', 'Source', 'AudioAI', 'Examples'];

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

// What every translation source did last time — shown in the settings and under the tooltip ("transparent").
const SRC = {
  cloud: { name: 'Google Cloud', ok: 0, fail: 0, last: '', at: 0 },
  google: { name: 'Google (бесплатный)', ok: 0, fail: 0, last: '', at: 0 },
  azure: { name: 'Microsoft Azure', ok: 0, fail: 0, last: '', at: 0 },
  edge: { name: 'Microsoft Edge', ok: 0, fail: 0, last: '', at: 0 },
  wikt: { name: 'Wiktionary', ok: 0, fail: 0, last: '', at: 0 },
  mymem: { name: 'MyMemory', ok: 0, fail: 0, last: '', at: 0 },
  ai: { name: 'ИИ (Gemini)', ok: 0, fail: 0, last: '', at: 0 },
};
function mark(src, ok, info) {
  const s = SRC[src];
  if (!s) return;
  if (ok) { s.ok++; s.last = 'ok'; } else { s.fail++; s.last = String(info || 'ошибка').slice(0, 120); }
  s.at = Date.now();
}

async function cloudFetch(url, body, label) {
  let r;
  try { r = await fetchT(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 15000); }
  catch (_) { mark('cloud', false, 'нет связи'); throw new Error(label + ': нет связи'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || 'HTTP ' + r.status;
    mark('cloud', false, m);
    throw new Error(label + ': ' + String(m).slice(0, 240));
  }
  mark('cloud', true);
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
async function cloudTts(text, voice, rate, noCache) {
  const { key } = await cloudCfg();
  const ck = voice + '|' + rate + '|' + text.toLowerCase();
  const stored = noCache ? {} : ((await chrome.storage.local.get('ttsCache')).ttsCache || {});
  if (!noCache) {
    if (ttsCache.has(ck)) return ttsCache.get(ck);
    if (stored[ck]) { ttsCache.set(ck, stored[ck]); return stored[ck]; }
  }
  const lang = String(voice).split('-').slice(0, 2).join('-') || 'en-US';
  const j = await cloudFetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
    input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: rate || 1 },
  }, 'Cloud Text-to-Speech');
  if (!j.audioContent) throw new Error('Cloud Text-to-Speech: пустой ответ');
  await usageAdd('tts', text.length);
  if (noCache) return j.audioContent;
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

const gq = { hi: [], mid: [], lo: [], active: 0, last: 0, pauseUntil: 0, timer: 0, fails: 0, downUntil: 0 };
const GQ_CONC = 3, GQ_GAP = 110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch that cannot hang forever (a stuck request would hold a queue slot and delay every hover).
async function fetchT(url, init = {}, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(timer); }
}

function gqRun(fn, prio) {
  return new Promise((resolve, reject) => {
    (prio >= 1 ? gq.hi : prio > 0 ? gq.mid : gq.lo).push({ fn, resolve, reject }); // hover > subtitle lines > prefetch
    gqPump();
  });
}

function gqPump() {
  clearTimeout(gq.timer);
  // Background (prefetch) jobs never take the last slot: a hover request always finds a free one.
  while (gq.active < GQ_CONC && (gq.hi.length || ((gq.mid.length || gq.lo.length) && gq.active < GQ_CONC - 1))) {
    const now = Date.now();
    const wait = Math.max(gq.last + GQ_GAP - now, gq.hi.length ? 0 : gq.pauseUntil - now);
    if (wait > 0) { gq.timer = setTimeout(gqPump, wait); return; }
    gq.last = now;
    const job = gq.hi.shift() || gq.mid.shift() || gq.lo.shift();
    gq.active++;
    job.fn().then(job.resolve, job.reject).finally(() => { gq.active--; gqPump(); });
  }
}

async function gtxFetch(text, tl, dict, attempts = 4) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dj=1&dt=t' +
    (dict ? '&dt=bd' : '') + '&tl=' + encodeURIComponent(tl);
  let status = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let r = null;
    try {
      r = attempt % 2 === 1 && text.length < 1500
        ? await fetchT(url + '&q=' + encodeURIComponent(text), {}, dict ? 5000 : 9000)
        : await fetchT(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'q=' + encodeURIComponent(text) }, dict ? 5000 : 9000);
    } catch (_) { r = null; }
    if (r && r.ok) { mark('google', true); return r.json(); }
    status = r ? r.status : 0;
    mark('google', false, status ? 'HTTP ' + status + (status === 429 ? ' (слишком много запросов)' : '') : 'нет связи');
    if (r && status !== 429 && status < 500) break; // not worth retrying
    gq.pauseUntil = Date.now() + 800 * (attempt + 1); // back off the background traffic too
    await sleep(350 * 2 ** attempt);
  }
  throw new Error(status ? 'Переводчик ответил HTTP ' + status : 'Нет связи с переводчиком');
}

const gtx = (text, tl, dict = false, prio = 0, attempts = 4) => gqRun(() => gtxFetch(text, tl, dict, attempts), prio);

const joinTrans = (j) => (j.sentences || []).map((s) => s.trans || '').join('');

// ---- Second translator, Microsoft's: the official Azure Translator when a key is given (free: 2M characters a month),
// otherwise the one built into Edge (unofficial, needs no key). Both offer translation and a dictionary with variants.
const MS_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', he: 'he', iw: 'he' };
const msLang = (tl) => MS_LANG[tl] || tl;
const ms = { token: '', at: 0 };

async function msAuth() {
  if (ms.token && Date.now() - ms.at < 8 * 60000) return ms.token;
  const r = await fetchT('https://edge.microsoft.com/translate/auth', { cache: 'no-store' }, 6000);
  if (!r.ok) throw new Error('Edge auth HTTP ' + r.status);
  ms.token = (await r.text()).trim();
  ms.at = Date.now();
  return ms.token;
}

async function azureKey() {
  const l = await chrome.storage.local.get({ azureKey: '', azureRegion: '' });
  return { key: (l.azureKey || '').trim(), region: (l.azureRegion || '').trim() };
}

// Returns { j, via } — via is 'azure' or 'edge'.
async function msCall(path, body, only) {
  const az = await azureKey();
  if (only === 'azure' && !az.key) throw new Error('ключ Azure не задан');
  if (az.key && only !== 'edge') {
    try {
      const r = await fetchT('https://api.cognitive.microsofttranslator.com' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': az.key, ...(az.region ? { 'Ocp-Apim-Subscription-Region': az.region } : {}) },
        body: JSON.stringify(body),
      }, 9000);
      if (!r.ok) throw new Error('Azure HTTP ' + r.status + (r.status === 401 ? ' (ключ или регион не подходят)' : r.status === 429 ? ' (лимит)' : ''));
      mark('azure', true);
      ms.lastVia = 'azure';
      return { j: await r.json(), via: 'azure' };
    } catch (e) { mark('azure', false, e.message); if (only === 'azure') throw e; /* the free Edge translator still can answer */ }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchT('https://api-edge.cognitive.microsofttranslator.com' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await msAuth()) }, body: JSON.stringify(body),
      }, 9000);
      if (r.status === 401 && attempt === 0) { ms.token = ''; continue; } // token expired
      if (!r.ok) throw new Error('Edge HTTP ' + r.status);
      mark('edge', true);
      ms.lastVia = 'edge';
      return { j: await r.json(), via: 'edge' };
    } catch (e) { if (attempt === 1 || !/401/.test(e.message)) { mark('edge', false, e.message); throw e; } }
  }
  throw new Error('Edge: нет ответа');
}

async function msTranslate(lines, tl) {
  const out = [];
  for (let i = 0; i < lines.length; i += 100) {
    const chunk = lines.slice(i, i + 100);
    const { j } = await msCall(`/translate?to=${encodeURIComponent(msLang(tl))}&api-version=3.0`, chunk.map((Text) => ({ Text })));
    if (!Array.isArray(j) || j.length !== chunk.length) throw new Error('MS: неожиданный ответ');
    for (const it of j) out.push(String(((it.translations || [])[0] || {}).text || '').trim());
  }
  return out;
}

const MS_POS = { NOUN: 'noun', VERB: 'verb', ADJ: 'adjective', ADV: 'adverb', PRON: 'pronoun', PREP: 'preposition', CONJ: 'conjunction', DET: 'determiner', MODAL: 'modal', OTHER: 'other' };
async function msDict(word, tl) {
  const { j, via } = await msCall(`/dictionary/lookup?from=en&to=${encodeURIComponent(msLang(tl))}&api-version=3.0`, [{ Text: word }]);
  const by = new Map();
  for (const t of (((j || [])[0] || {}).translations) || []) {
    const pos = MS_POS[t.posTag] || String(t.posTag || '').toLowerCase();
    if (!by.has(pos)) by.set(pos, []);
    const terms = by.get(pos);
    if (t.displayTarget && !terms.includes(t.displayTarget) && terms.length < 6) terms.push(t.displayTarget);
  }
  const dict = [...by].map(([pos, terms]) => ({ pos, terms }));
  dict.via = via;
  return dict;
}

// Lines in, translated lines out: Google Cloud (if allowed) → Google free → Edge. If Google merges/splits
// lines we bisect (a handful of requests) instead of translating every line separately.
async function translateLines(lines, tl, prio = 0, sl = 'auto') {
  if (!lines.length) return [];
  const chars = lines.reduce((n, l) => n + l.length, 0);
  if (await cloudOk('tr', chars)) {
    try { return await cloudTranslate(lines, tl, sl); } catch (e) { /* key/quota problem: fall back to the free endpoints */ }
  }
  // Google's free endpoint failed repeatedly just now: go straight to the second translator for a while.
  const googleDown = Date.now() < gq.downUntil;
  const viaMs = async () => { const o = await msTranslate(lines, tl); if (o.every(Boolean)) return o; throw new Error('MS: пустой перевод'); };
  if (googleDown) { try { return await viaMs(); } catch (_) { /* try Google anyway */ } }
  try {
    // Google struggles → two tries at most, then the second translator answers instead of making the user wait.
    const out = await translateLinesFree(lines, tl, prio, gq.fails > 0 ? 1 : 2);
    gq.fails = 0;
    return out;
  } catch (e) {
    if (++gq.fails >= 3) gq.downUntil = Date.now() + 60000;
    try { return await viaMs(); } catch (_) { throw e; }
  }
}

async function translateLinesFree(lines, tl, prio = 0, attempts = 4) {
  if (lines.length === 1) return [joinTrans(await gtx(lines[0], tl, false, prio, attempts)).trim()];
  const parts = joinTrans(await gtx(lines.join('\n'), tl, false, prio, attempts)).split('\n').map((x) => x.trim());
  if (parts.length === lines.length) return parts;
  const mid = lines.length >> 1;
  return [...(await translateLinesFree(lines.slice(0, mid), tl, prio, attempts)), ...(await translateLinesFree(lines.slice(mid), tl, prio, attempts))];
}

// Persistent caches so hover translations are instant on every video.
const caches = {};
const dirtyCaches = new Set();
let saveTimer = 0;

async function getCache(name) {
  if (!caches[name]) caches[name] = (await chrome.storage.local.get(name))[name] || {};
  return caches[name];
}

// Writes are throttled, not debounced: busy caches (the offline dictionary grows for an hour) must still reach the
// disk regularly, and a big cache is not rewritten every second.
function persistCache(name) {
  dirtyCaches.add(name);
  if (saveTimer) return;
  const size = Object.keys(caches[name] || {}).length;
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    for (const n of [...dirtyCaches]) chrome.storage.local.set({ [n]: caches[n] });
    dirtyCaches.clear();
  }, size > 3000 ? 15000 : 1500);
}

async function translateWords(words, tl, prio = 0, sl = 'auto') {
  const cache = await getCache('trc:' + tl);
  const srcMap = await getCache('trs:' + tl);
  const missing = words.filter((w) => !(w in cache));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const before = { cloud: SRC.cloud.ok, google: SRC.google.ok, azure: SRC.azure.ok, edge: SRC.edge.ok };
    const out = await translateLines(chunk, tl, prio, sl);
    const who = SRC.cloud.ok > before.cloud ? 'cloud' : SRC.azure.ok > before.azure ? 'azure' : SRC.edge.ok > before.edge ? 'edge' : 'google';
    chunk.forEach((w, k) => { if (out[k]) { cache[w] = out[k]; srcMap[w] = who; } });
    persistCache('trc:' + tl);
    persistCache('trs:' + tl);
  }
  const res = {};
  for (const w of words) if (cache[w]) res[w] = cache[w];
  return res;
}

// ---- Wiktionary: free, official MediaWiki API; translations per sense and part of speech, no key, generous limits.
// Variants for a word are read from the English entry's translation tables and cached for good.
const WIKT_CODES = { 'zh-CN': ['cmn', 'zh'], 'zh-TW': ['cmn', 'zh'], iw: ['he'], he: ['he'] };
const WIKT_POS = { Noun: 'noun', 'Proper noun': 'noun', Verb: 'verb', Adjective: 'adjective', Adverb: 'adverb', Preposition: 'preposition', Conjunction: 'conjunction',
  Pronoun: 'pronoun', Interjection: 'interjection', Determiner: 'determiner', Article: 'determiner', Particle: 'particle', Numeral: 'numeral', Phrase: 'phrase', Prefix: 'prefix', Suffix: 'suffix' };
const wikt = { active: 0, queue: [] };

async function wiktApi(params) {
  const url = 'https://en.wiktionary.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', redirects: '1', ...params });
  const r = await fetchT(url, { headers: { 'Api-User-Agent': 'YT-Anki-Miner browser extension (language learning)' } }, 9000);
  if (!r.ok) { mark('wikt', false, 'HTTP ' + r.status); throw new Error('Wiktionary HTTP ' + r.status); }
  const j = await r.json();
  if (j.error) throw new Error((j.error.code || 'error') + ': ' + (j.error.info || ''));   // e.g. missingtitle
  return j;
}

// translation terms of one wikitext block, grouped by part of speech (first sense first)
function parseWikt(text, codes) {
  const groups = [];
  let pos = '', lemma = null, lemmaPos = '';
  const alt = codes.map((c) => c.replace(/[^\w-]/g, '')).join('|');
  const reTerm = new RegExp('\\{\\{tt?\\+?\\|(?:' + alt + ')\\|([^|}]+)', 'g');
  for (const ln of text.split('\n')) {
    const h = /^={3,5}\s*([^=]+?)\s*={3,5}\s*$/.exec(ln);
    if (h) { if (WIKT_POS[h[1].trim()]) pos = WIKT_POS[h[1].trim()]; continue; }
    if (!lemma) {
      const m = /\{\{((?:[\w -]+ of|inflection of))\|en\|([^|}=]+)/.exec(ln) || /\{\{(en-[\w -]+ of)\|([^|}=]+)/.exec(ln);
      if (m) {
        lemma = m[2].replace(/[\[\]]/g, '').trim();
        const kind = m[1].toLowerCase();   // "past participle of", "plural of", ... say which part of speech the lemma is wanted as
        lemmaPos = /past|participle|third-person|present|gerund|simple/.test(kind) ? 'verb' : /plural/.test(kind) ? 'noun' : /comparative|superlative/.test(kind) ? 'adjective' : '';
      }
    }
    if (!/^\*+\s*[^:{]+:/.test(ln)) continue;
    const terms = [];
    for (const m of ln.matchAll(reTerm)) {
      const t = m[1].replace(/\[\[|\]\]/g, '').replace(/\u0301/g, '').trim();
      if (t && !terms.includes(t)) terms.push(t);
    }
    if (!terms.length) continue;
    let g = groups.find((x) => x.pos === (pos || 'other'));
    if (!g) groups.push((g = { pos: pos || 'other', terms: [] }));
    for (const t of terms) if (!g.terms.includes(t) && g.terms.length < 8) g.terms.push(t);
  }
  return { dict: groups.filter((g) => g.terms.length), lemma, lemmaPos };
}

async function wiktFetchWord(word, tl, depth = 0) {
  const codes = WIKT_CODES[tl] || [tl.split('-')[0]];
  let sec;
  try {
    const s = await wiktApi({ action: 'parse', page: word, prop: 'sections' });
    sec = ((s.parse || {}).sections || []).find((x) => x.line === 'English' && String(x.toclevel) === '1');
  } catch (e) { if (/missingtitle|doesn.t exist/i.test(e.message)) return { dict: [], miss: true }; throw e; }
  if (!sec) return { dict: [], miss: true };
  const t = await wiktApi({ action: 'parse', page: word, prop: 'wikitext', section: sec.index });
  let text = (t.parse || {}).wikitext || '';
  // very long entries keep their translations on a subpage
  if (/\{\{see translation subpage/i.test(text) || /\{\{trans-see\|/i.test(text)) {
    try { const sub = await wiktApi({ action: 'parse', page: word + '/translations', prop: 'wikitext' }); text += '\n' + ((sub.parse || {}).wikitext || ''); } catch (_) { /* optional */ }
  }
  const out = parseWikt(text, codes);
  if (!out.dict.length && out.lemma && out.lemma.toLowerCase() !== word && depth < 1) {
    const base = await wiktFetchWord(out.lemma.toLowerCase(), tl, depth + 1);
    // "figured" is a verb form: the verb meanings of "figure" go first, not its noun meanings
    if (out.lemmaPos) base.dict.sort((x, y) => (y.pos === out.lemmaPos) - (x.pos === out.lemmaPos));
    return { ...base, lemma: out.lemma };
  }
  return out;
}

// Cached for good (misses are retried after a week). Never more than 4 requests at once.
async function wiktVariants(word, tl) {
  const cache = await getCache('wkt:' + tl);
  const hit = cache[word];
  if (hit && (!hit.miss || Date.now() - hit.at < 7 * 86400000)) return hit;
  while (wikt.active >= 4) await new Promise((r) => wikt.queue.push(r));
  wikt.active++;
  try {
    const out = await wiktFetchWord(word, tl);
    cache[word] = { dict: out.dict.map((g) => ({ pos: g.pos, terms: g.terms.slice(0, 6) })), lemma: out.lemma || '', miss: !out.dict.length, at: Date.now() };
    persistCache('wkt:' + tl);
    if (out.dict.length) mark('wikt', true);
    return cache[word];
  } finally {
    wikt.active--;
    const next = wikt.queue.shift();
    if (next) next();
  }
}

// Warm-up: all words of the video, in order of appearance, quietly in the background — hover is then instant.
const warm = { running: false, todo: [], tl: '' };
async function warmVariants(words, tl) {
  const cache = await getCache('wkt:' + tl);
  const seen = new Set(warm.todo);
  for (const w of words) if (!seen.has(w) && !(cache[w] && !cache[w].miss) && /^[a-z][a-z'-]*$/.test(w)) warm.todo.push(w);
  warm.tl = tl;
  if (warm.running) return warm.todo.length;
  warm.running = true;
  (async () => {
    try {
      const pump = async () => { while (warm.todo.length) { const w = warm.todo.shift(); try { await wiktVariants(w, warm.tl); } catch (_) { await sleep(400); } } };
      await Promise.all([pump(), pump(), pump()]);
    } finally { warm.running = false; }
  })();
  return warm.todo.length;
}


// ---- Offline dictionary: the N most frequent English words with their Wiktionary translations, collected once in
// the background (official API, a few requests at a time) and kept in storage. Afterwards those words need no network.
const offline = { running: false, done: 0, total: 0, tl: '', stop: false };
async function offlineBuild(n, tl) {
  if (offline.running) return offline;
  const list = String(self.YTAM_FREQ || '').split('\n').slice(0, Math.max(100, Math.min(60000, +n || 10000))).filter((w) => /^[a-z][a-z'-]*$/.test(w));
  const cache = await getCache('wkt:' + tl);
  const todo = list.filter((w) => !(cache[w] && (!cache[w].miss || Date.now() - cache[w].at < 7 * 86400000)));
  Object.assign(offline, { running: true, stop: false, done: list.length - todo.length, total: list.length, tl });
  await chrome.storage.local.set({ offlineJob: { n, tl } });
  (async () => {
    try {
      const worker = async () => {
        while (todo.length && !offline.stop) {
          const w = todo.shift();
          try { await wiktVariants(w, tl); offline.done++; } catch (_) { todo.push(w); await sleep(1500); }   // failed: try again later
          await sleep(40);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      offline.running = false;
      if (!offline.stop && !todo.length) { await chrome.storage.local.remove('offlineJob'); await chrome.storage.local.set({ offlineDone: { n, tl, at: Date.now() } }); }
      persistCache('wkt:' + tl);
    }
  })();
  return offline;
}

async function offlineStatus() {
  const cache = await getCache('wkt:' + (offline.tl || (await cloudCfg()).targetLang));
  const { offlineDone } = await chrome.storage.local.get('offlineDone');
  return { ...offline, cached: Object.keys(cache).filter((w) => !cache[w].miss).length, finished: offlineDone || null };
}

// the service worker may be stopped by Chrome during a long job: an alarm brings the job back
chrome.alarms.create('ytam-offline', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'ytam-offline' || offline.running) return;
  const { offlineJob } = await chrome.storage.local.get('offlineJob');
  if (offlineJob) offlineBuild(offlineJob.n, offlineJob.tl).catch(() => {});
});

// MyMemory: free translation-memory service; several candidate translations (quality varies, so only good ones).
async function myMemoryVariants(word, tl) {
  const r = await fetchT(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|${encodeURIComponent(tl.split('-')[0])}`, {}, 7000);
  if (!r.ok) { mark('mymem', false, 'HTTP ' + r.status); throw new Error('MyMemory HTTP ' + r.status); }
  const j = await r.json();
  const seen = new Set();
  const terms = [];
  const cand = [{ translation: (j.responseData || {}).translatedText, quality: 100, match: 1 }, ...(j.matches || [])];
  cand.sort((a, b) => (+b.match || 0) - (+a.match || 0));
  for (const m of cand) {
    const t = String(m.translation || '').trim().replace(/[.!?]+$/, '');
    if (!t || t.length > 40 || t.split(/\s+/).length > 3 || t.toLowerCase() === word.toLowerCase() || +m.quality < 60) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); terms.push(t); }
    if (terms.length >= 4) break;
  }
  if (terms.length) mark('mymem', true);
  return terms.length ? [{ pos: '', terms }] : [];
}

// Dictionary variants (several meanings by part of speech): Google's free dictionary, then Microsoft's (Azure with a
// key, else Edge), then — if allowed — the AI. Returns the variants and who gave them (or why nobody did).
async function aiVariants(word, sentence, tl, cfg) {
  const lang = LANGS[tl] || tl;
  const prompt = `Translate the English word or phrase "${word}" into ${lang}.${sentence ? ` It was met in: "${sentence}".` : ''}
Give the 2-3 most common meanings grouped by part of speech, the most likely for this context first.
Return JSON: [{"pos": "noun|verb|adjective|adverb|preposition|conjunction|pronoun|other", "terms": ["...", "..."]}]. At most 3 terms per part of speech; single words or short phrases in ${lang}.`;
  const out = await llm({ model: cfg.aiFastModel, prompt, json: true, temperature: 0.2,
    schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { pos: { type: 'STRING' }, terms: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['pos', 'terms'] } } });
  return asLines(parseJsonLoose(out)).filter((x) => x && Array.isArray(x.terms) && x.terms.length).slice(0, 4).map((x) => ({ pos: String(x.pos || ''), terms: x.terms.slice(0, 4).map(String) }));
}

async function fetchVariants(word, tl, prio, sentence) {
  const cfg = await cloudCfg();
  const why = [];
  const sources = [];
  const merged = [];           // [{pos, terms}] — first source first, the next ones only fill up
  const add = (dict, src) => {
    let used = false;
    for (const g of dict) {
      let tg = merged.find((x) => x.pos === g.pos) || (g.pos ? null : merged[0]);
      if (!tg) merged.push((tg = { pos: g.pos, terms: [] }));
      for (const t of g.terms) if (!merged.some((m) => m.terms.some((x) => x.toLowerCase() === t.toLowerCase())) && tg.terms.length < 6) { tg.terms.push(t); used = true; }
    }
    if (used && !sources.includes(src)) sources.push(src);
  };
  const total = () => merged.reduce((n, g) => n + g.terms.length, 0);
  const want = Math.max(3, +cfg.tipVariants || 3);
  const googleDown = gq.fails > 0 || Date.now() < gq.downUntil;
  const steps = [
    ['wikt', 'Wiktionary', async () => { const w = await wiktVariants(word, tl); if (!w.dict.length) throw new Error('нет'); return w.dict; }],
    ['google', 'Google', async () => {
      const j = await gtx(word, tl, true, prio, 1);
      const dict = (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) }));
      if (!dict.length) throw new Error('пусто');
      return dict;
    }],
    ['ms', 'Microsoft', async () => { const d = await msDict(word, tl); if (!d.length) throw new Error('пусто'); merged.viaMs = d.via; return d; }],
    ['mymem', 'MyMemory', async () => { if (cfg.variantsMyMemory === false || prio < 1) throw new Error('только при наведении'); const d = await myMemoryVariants(word, tl); if (!d.length) throw new Error('пусто'); return d; }],
  ];
  if (googleDown) steps.splice(1, 0, steps.splice(2, 1)[0]); // Google struggles: Microsoft goes first
  for (const [id, name, fn] of steps) {
    if (total() >= want) break;
    try { add(await fn(), id === 'ms' ? (merged.viaMs || 'edge') : id); } catch (e) { why.push(`${name}: ${String(e.message).replace(/^Переводчик ответил /, '').slice(0, 40)}`); }
  }
  let aiPending = false;
  if (!total() && prio < 1 && (cfg.variantsAI !== 'off' || cfg.variantsMyMemory !== false)) aiPending = true; // background prefetch never spends MyMemory / AI quota; a hover will
  if (!total() && cfg.variantsAI !== 'off' && prio >= 1) {
    try {
      const dict = await aiVariants(word, sentence, tl, await aiConfig());
      if (dict.length) { mark('ai', true); add(dict, 'ai'); }
    } catch (e) { mark('ai', false, e.message); why.push('ИИ: ' + e.message.slice(0, 40)); }
  }
  return { dict: merged, src: sources.join('+') || null, why: why.join(' · '), aiPending };
}

const variantJobs = new Map();

// Fast path: the translation is returned at once (Google Cloud is ~150 ms); the variants are collected in the
// background and picked up by a second call (phase 'dict'), so a slow dictionary never delays the tooltip.
async function lookup(word, tl, prio = 0, sl = 'auto', phase = 'fast', sentence = '') {
  const name = 'lkc:' + tl;
  const cache = await getCache(name);
  const key = word.toLowerCase();
  const c = await cloudCfg();
  const hit = cache[key];
  const complete = (h) => h && ((h.dict && h.dict.length) || !c.cloudVariants || (h.dt && Date.now() - h.dt < 600000 && !h.partial && !(h.aiPending && prio >= 1)));
  if (complete(hit)) return hit;

  let res = hit || null;
  if (res && res.aiPending && prio >= 1) res.partial = true;
  // Already translated in bulk when the video loaded? Then no request at all.
  if (!res) {
    const trc = await getCache('trc:' + tl);
    if (trc[key]) res = { translation: trc[key], dict: [], dt: Date.now(), partial: !!c.cloudVariants, src: { tr: (await getCache('trs:' + tl))[key] || 'google', dict: null } };
  }
  if (!res && await cloudOk('tr', word.length)) {
    try {
      const tr = await cloudTranslate([word], tl, sl);
      res = { translation: tr[0] || '', dict: [], dt: Date.now(), partial: !!c.cloudVariants, src: { tr: 'cloud', dict: null } };
    } catch (_) { res = null; }
  }
  if (!res) {
    // No cloud: one free call gives the translation and the variants together.
    try {
      const j = await gtx(word, tl, true, prio, gq.fails > 0 ? 1 : 2);
      const dict = (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) }));
      res = { translation: joinTrans(j).trim(), dict, dt: Date.now(), src: { tr: 'google', dict: dict.length ? 'google' : null } };
      if (!dict.length && c.cloudVariants) res.partial = true;
    } catch (e) {
      try { const o = await msTranslate([word], tl); res = { translation: o[0] || '', dict: [], dt: Date.now(), partial: true, src: { tr: ms.lastVia || 'edge', dict: null } }; } catch (_) { throw e; }
    }
  }
  // Variants already warmed up (Wiktionary cache)? Then the answer is complete right now.
  if (res.partial) {
    const wk = (await getCache('wkt:' + tl))[key];
    if (wk && wk.dict && wk.dict.length) { res.dict = wk.dict; res.partial = false; res.dt = Date.now(); res.src = { ...(res.src || {}), dict: 'wikt', why: '' }; }
  }
  cache[key] = res;
  persistCache(name);
  if (!res.partial) return res;

  let job = variantJobs.get(key + '|' + tl);
  if (!job) {
    job = fetchVariants(word, tl, prio, sentence).then((v) => {
      const cur = cache[key] || res;
      cur.dict = v.dict;
      cur.partial = false;
      cur.dt = Date.now();
      cur.src = { ...(cur.src || {}), dict: v.src, why: v.why || '' };
      cur.aiPending = !!v.aiPending;
      if (!cur.translation && v.translation) cur.translation = v.translation;
      cache[key] = cur;
      persistCache(name);
      return cur;
    }).catch(() => res).finally(() => variantJobs.delete(key + '|' + tl));
    variantJobs.set(key + '|' + tl, job);
  }
  if (phase !== 'dict') return res;
  return Promise.race([job, sleep(25000).then(() => res)]);
}

// Every source tried on one word, separately: the settings page shows who works and who does not.
async function translatorTest(word = 'but') {
  const c = await cloudCfg();
  const tl = c.targetLang;
  const rows = [];
  const run = async (id, fn) => {
    const t0 = performance.now();
    try { const text = await fn(); rows.push({ id, name: SRC[id].name, ok: true, ms: Math.round(performance.now() - t0), text }); mark(id, true); }
    catch (e) { rows.push({ id, name: SRC[id].name, ok: false, ms: Math.round(performance.now() - t0), text: e.message }); }
  };
  if (!c.key) rows.push({ id: 'cloud', name: SRC.cloud.name, ok: false, text: 'ключ не задан (вкладка «Перевод»)', ms: 0 });
  else await run('cloud', async () => (await cloudTranslate([word], tl, 'en'))[0] + ' — один вариант (так устроен официальный API)');
  await run('google', async () => {
    const j = await gtxFetch(word, tl, true, 1);
    const d = (j.dict || []).flatMap((x) => x.terms || []).slice(0, 5);
    if (!d.length) return joinTrans(j).trim() + ' (вариантов нет)';
    return joinTrans(j).trim() + ' · ' + d.join(', ');
  });
  const az = await azureKey();
  if (az.key) await run('azure', async () => { const { j } = await msCall(`/dictionary/lookup?from=en&to=${msLang(tl)}&api-version=3.0`, [{ Text: word }], 'azure'); return (((j[0] || {}).translations) || []).slice(0, 5).map((t) => t.displayTarget).join(', ') || 'пусто'; });
  else rows.push({ id: 'azure', name: SRC.azure.name, ok: false, text: 'ключ не задан — необязательно', ms: 0 });
  await run('edge', async () => { const { j } = await msCall(`/dictionary/lookup?from=en&to=${msLang(tl)}&api-version=3.0`, [{ Text: word }], 'edge'); return (((j[0] || {}).translations) || []).slice(0, 5).map((t) => t.displayTarget).join(', ') || 'пусто'; });
  const ai = await aiConfig();
  if (ai.geminiKey || ai.aiKey) await run('ai', async () => (await aiVariants(word, '', tl, ai)).map((x) => x.terms.join(', ')).join(' | ') || 'пусто');
  else rows.push({ id: 'ai', name: SRC.ai.name, ok: false, text: 'ключ ИИ не задан — необязательно', ms: 0 });
  return { word, tl, rows };
}

function translatorStatus() {
  const g = SRC.google;
  return { sources: SRC, googleDownUntil: gq.downUntil, googleFails: gq.fails, order: 'Cloud (перевод) → Google (варианты) → Azure/Edge → ИИ', now: Date.now(), g };
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

// Gemini 2.5 / 3.x models may "think" before answering — seconds of silence before the first word. For quick
// answers (word explanations, translations, short JSON) we switch that off. Models disagree about the parameter,
// so the first rejected one is replaced by the next, and the working variant is remembered per model.
const THINK_LADDER = [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, null];
const thinkStep = {}; // model → index in THINK_LADDER that works (kept in storage: found once, used forever)
chrome.storage.local.get({ thinkStep: {} }).then((r) => Object.assign(thinkStep, r.thinkStep)).catch(() => {});

async function geminiFetch(url, body, cfg, model, { think = true } = {}) {
  const useThink = think && cfg.aiThinking !== 'model' && !/gemini-1\./.test(model);
  for (let guard = 0; guard < THINK_LADDER.length + 1; guard++) {
    const step = thinkStep[model] || 0;
    const tc = useThink ? THINK_LADDER[step] : null;
    const gc = { ...body.generationConfig };
    delete gc.thinkingConfig;
    if (tc) gc.thinkingConfig = tc;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey, ...parseObj(cfg.aiHeaders, 'Свои заголовки') },
      body: JSON.stringify({ ...body, generationConfig: gc }),
    });
    // Any 400 while a thinking parameter was sent: that parameter is the suspect ("Request contains an invalid
    // argument" does not even name it). Take the next step of the ladder; the last step sends none.
    if (r.status === 400 && tc) {
      thinkStep[model] = Math.min(THINK_LADDER.length - 1, step + 1);
      chrome.storage.local.set({ thinkStep }).catch(() => {});
      continue;
    }
    return r;
  }
  throw new Error('Gemini: не удалось подобрать параметры запроса');
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
    r = await geminiFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, body, cfg, model, { think: !media });
  } catch (e) { if (/подобрать/.test(e.message)) throw e; throw new Error('Нет доступа к ' + base + ' — разрешите адрес в настройках расширения'); }
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

// Shortest self-contained excerpt of a long sentence that still contains the target word (for a flash card).
async function aiTrim({ sentence, word, max, tl, model }) {
  const lang = LANGS[tl] || tl;
  const prompt = `Flash-card trimming. The sentence below is too long for a language-learning card.
Pick ONE contiguous excerpt of the sentence that:
- has at most ${max} words,
- is grammatically complete and makes sense on its own (ideally a full clause),
- ${word ? `contains the target "${word}"` : 'keeps the most important part'},
- copies the words EXACTLY as written, in the original order (no paraphrasing, no added or removed words).
Also translate the excerpt into ${lang}. Return JSON: {"s": excerpt, "t": translation}.

Sentence: ${sentence}`;
  const out = await llm({ model: model || (await aiConfig()).aiFastModel, prompt, json: true, temperature: 0.1,
    schema: { type: 'OBJECT', properties: { s: { type: 'STRING' }, t: { type: 'STRING' } }, required: ['s', 't'] } });
  const j = parseJsonLoose(out);
  return { s: String(j.s || ''), t: String(j.t || '') };
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
  const r = await geminiFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, body, cfg, model);
  if (!r.ok) await httpError(r, 'Gemini');
  await readSse(r, (j) => {
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    // thought summaries (if any) are not part of the answer
    const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (text) onDelta(text);
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ytam-ai') return;
  port.onMessage.addListener(async (msg) => {
    try {
      const cfg = await chrome.storage.sync.get(YTAM_DEFAULTS);
      const t0 = performance.now();
      let first = 0;
      await streamLlm(cfg.aiFastModel, explainPrompt(msg, cfg), (delta) => { if (!first) first = performance.now() - t0; port.postMessage({ delta }); });
      port.postMessage({ done: true, meta: { model: cfg.aiFastModel, first: Math.round(first), total: Math.round(performance.now() - t0), think: cfg.aiThinking === 'model' || !THINK_LADDER[thinkStep[cfg.aiFastModel] || 0] ? 'размышления по умолчанию модели' : 'без размышлений' } });
    } catch (e) {
      try { port.postMessage({ error: e.message || String(e) }); } catch (_) {}
    }
  });
});

// ---------- AnkiConnect ----------

// Resilient AnkiConnect client. Works with old and new AnkiConnect releases:
//  • tries the configured URL, 127.0.0.1 and localhost (a stray "localhost → ::1" never breaks it),
//  • asks Anki for permission (requestPermission) when the extension origin is not whitelisted,
//  • sends the optional API key, retries while the collection is busy,
//  • falls back to the local launcher, which relays the call without an Origin header (no CORS rules apply).
let ankiRoute = null; // the route that worked last time

const ANKI_BUSY = /collection is not available|not ready|busy|database is locked|profile/i;

async function ankiRoutes() {
  const c = await chrome.storage.sync.get({ ankiUrl: 'http://127.0.0.1:8765', helperUrl: 'http://127.0.0.1:8766' });
  const { ankiRouteOk } = await chrome.storage.local.get({ ankiRouteOk: '' });
  const direct = [];
  const add = (u) => { u = String(u || '').trim().replace(/\/+$/, ''); if (u && !direct.includes(u)) direct.push(u); };
  // The configured address first, then the usual alternatives (AnkiConnect may have been moved off 8765,
  // e.g. when Windows reserves that port: "WinError 10013").
  add(c.ankiUrl);
  for (const p of [8765, 18765, 28765]) add(`http://127.0.0.1:${p}`);
  add('http://localhost:8765');
  const list = direct.map((url) => ({ kind: 'direct', url }));
  const proxy = String(c.helperUrl || '').trim().replace(/\/+$/, '');
  if (proxy) list.push({ kind: 'proxy', url: proxy + '/anki', port: (/:(\d+)\/?$/.exec(c.ankiUrl || '') || [])[1] || '' });
  const first = ankiRoute || ankiRouteOk;
  if (first) {
    const i = list.findIndex((r) => r.url === first);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}

class AnkiHttpError extends Error { constructor(status, text) { super(`HTTP ${status}`); this.status = status; this.text = text; } }

async function ankiPost(route, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = route.kind === 'proxy' ? { 'X-YTAM': '1', ...(route.port && route.port !== '8765' ? { 'X-Anki-Port': route.port } : {}) } : {};
    const r = await fetch(route.url, { method: 'POST', body, headers, signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new AnkiHttpError(r.status, await r.text().catch(() => ''));
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function anki(action, params = {}, opts = {}) {
  const { ankiKey } = await chrome.storage.local.get({ ankiKey: '' });
  const timeoutMs = opts.timeout || (action === 'storeMediaFile' ? 60000 : 15000);
  const body = JSON.stringify({ action, version: 6, params, ...(ankiKey ? { key: ankiKey } : {}) });
  let lastErr = null, reached = false;
  const routes = await ankiRoutes();
  for (let ri = 0; ri < routes.length; ri++) {
    const route = routes[ri];
    for (let attempt = 0; attempt < 4; attempt++) {
      let j;
      try {
        j = await ankiPost(route, body, ri === 0 ? timeoutMs : Math.min(timeoutMs, 4000));
      } catch (e) {
        lastErr = e;
        if (e instanceof AnkiHttpError) {
          reached = true;
          // 403: AnkiConnect refuses this origin — ask for permission once, then retry; else try the next route.
          if (e.status === 403 && action !== 'requestPermission' && attempt === 0 && route.kind === 'direct') {
            try {
              const p = await ankiPost(route, JSON.stringify({ action: 'requestPermission', version: 6, params: {} }), 60000);
              if (p && p.result && p.result.permission === 'granted') continue;
            } catch (_) {}
          }
        }
        break; // network error / refused → next route
      }
      reached = true;
      const err = j && typeof j === 'object' && 'error' in j ? j.error : null;
      if (err) {
        if (/valid api key|api key/i.test(err)) throw new Error('Anki: нужен ключ AnkiConnect — впишите его в настройках (вкладка Anki → «Ключ AnkiConnect»)');
        if (ANKI_BUSY.test(err) && attempt < 3) { await sleep(700 * (attempt + 1)); continue; }
        throw new Error('Anki: ' + err);
      }
      if (ankiRoute !== route.url) { ankiRoute = route.url; chrome.storage.local.set({ ankiRouteOk: route.url }).catch(() => {}); }
      return j && typeof j === 'object' && 'result' in j ? j.result : j; // very old AnkiConnect returns the bare result
    }
  }
  if (reached && lastErr instanceof AnkiHttpError) {
    const origin = chrome.runtime.getURL('').replace(/\/$/, '');
    throw new Error(`Anki отклонил запрос (HTTP ${lastErr.status}). В Anki: Инструменты → Дополнения → AnkiConnect → Config → в "webCorsOriginList" добавьте "${origin}" (или "*"), перезапустите Anki. Либо запустите лончер — он обходит это ограничение.`);
  }
  throw new Error('Нет связи с Anki. Откройте Anki и проверьте, что установлен AnkiConnect (код 2055492159). Если при запуске Anki появляется окно «WinError 10013» — запустите лончер и на его странице нажмите «Исправить порт AnkiConnect».');
}

// Step-by-step connection report for the settings screen.
async function ankiDiagnose() {
  const out = [];
  const routes = await ankiRoutes();
  const { ankiKey } = await chrome.storage.local.get({ ankiKey: '' });
  let ok = false, version = null, decks = [];
  for (const route of routes) {
    try {
      const j = await ankiPost(route, JSON.stringify({ action: 'version', version: 6, params: {}, ...(ankiKey ? { key: ankiKey } : {}) }), 6000);
      const err = j && j.error;
      out.push(`${route.kind === 'proxy' ? 'через лончер' : route.url}: ${err ? 'ошибка — ' + err : 'ответ получен, версия API ' + j.result}`);
      if (!err) { ok = true; version = j.result; ankiRoute = route.url; break; }
    } catch (e) {
      out.push(`${route.kind === 'proxy' ? 'через лончер' : route.url}: ${e instanceof AnkiHttpError ? 'HTTP ' + e.status + (e.status === 403 ? ' (источник не разрешён в webCorsOriginList)' : '') : 'нет ответа'}`);
    }
  }
  if (ok) { try { decks = await anki('deckNames'); } catch (e) { out.push('deckNames: ' + e.message); ok = false; } }
  return { ok, version, decks, steps: out, origin: chrome.runtime.getURL('').replace(/\/$/, '') };
}

const CSS = `.card{font-family:Arial,sans-serif;font-size:22px;text-align:center;color:#1d1d1f;background:#fafafa}
.nightMode.card,.night_mode .card{color:#eee;background:#222}
.img img{max-width:100%;max-height:45vh;border-radius:8px}
.sentence{margin:14px 0;line-height:1.4}
.sentence b{color:#1a73e8}
.word{font-size:18px;color:#888}
.tr{font-size:20px;color:#b06d00;margin:10px 0}
.meaning{font-size:17px;margin:8px 0}
.ex{margin:14px auto 0;max-width:34em;text-align:left;font-size:16px}
.ex ul{margin:4px 0;padding-left:1.2em}
.ex li{margin:6px 0}
.ex .t{color:#b06d00;font-size:14px}
.ex .h{color:#888;font-size:13px}
.src{margin-top:22px;font-size:14px;color:#888}
.src a{display:inline-block;padding:6px 14px;border-radius:16px;background:#ff0033;color:#fff;text-decoration:none;font-weight:bold}
.src .title{margin-top:6px;font-size:12px}`;

const FRONT = `<div class="img">{{Image}}</div>
<div class="sentence">{{Sentence}}</div>
{{#Word}}<div class="word">{{Word}}</div>{{/Word}}
{{Audio}}{{AudioAI}}`;

const BACK = `{{FrontSide}}
<hr id="answer">
<div class="tr">{{Translation}}</div>
{{#WordMeaning}}<div class="meaning"><b>{{Word}}</b> — {{WordMeaning}}</div>{{/WordMeaning}}
{{#Examples}}<div class="ex">{{Examples}}</div>{{/Examples}}
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
    // Older versions of the note type lack newer fields (AudioAI): add them.
    try {
      const have = await anki('modelFieldNames', { modelName: MODEL });
      for (const f of FIELDS) if (!have.includes(f)) await anki('modelFieldAdd', { modelName: MODEL, fieldName: f });
    } catch (_) {}
    // Keep the note type in sync with the current templates.
    try {
      await anki('updateModelTemplates', { model: { name: MODEL, templates: { YouTube: { Front: FRONT, Back: BACK } } } });
      await anki('updateModelStyling', { model: { name: MODEL, css: CSS } });
    } catch (_) {}
  }
  modelReady = true;
}

async function addCard(c) {  // writes one note to Anki (throws when Anki is unreachable)
  for (let attempt = 0; ; attempt++) {
    try { return await addCardOnce(c); } catch (e) {
      // The note type / deck was removed or changed in Anki while we were running: rebuild and retry once.
      if (attempt === 0 && /model|note type|deck|field/i.test(e.message) && !/Нет связи/.test(e.message)) { modelReady = false; continue; }
      throw e;
    }
  }
}

const examplesHtml = (list) => (Array.isArray(list) && list.length
  ? `<div class="h">Ещё примеры</div><ul>${list.map((e) => `<li>${esc(e.s)}${e.t ? `<br><span class="t">${esc(e.t)}</span>` : ''}</li>`).join('')}</ul>` : '');

// More sentences with the word (same meaning, similar style) — one phrase from a video is not enough to learn a word.
async function aiExamples({ word, sentence, n, tl, model }) {
  const lang = LANGS[tl] || tl;
  const prompt = `A learner of English is studying the word or phrase "${word}", met in this sentence from a video:
"${sentence}"

Write ${n} NEW example sentences that use "${word}" in the SAME meaning (and part of speech), in the same register and of similar difficulty.
Rules: natural, everyday English; different situations; each at most 14 words; the target must appear exactly (a grammatical form is fine); do not copy the original sentence.
Return a JSON array of {"s": sentence, "t": translation into ${lang}}.`;
  const out = await llm({ model: model || (await aiConfig()).aiFastModel, prompt, json: true, temperature: 0.7,
    schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { s: { type: 'STRING' }, t: { type: 'STRING' } }, required: ['s', 't'] } } });
  return asLines(parseJsonLoose(out)).filter((x) => x && x.s).slice(0, n).map((x) => ({ s: String(x.s), t: String(x.t || '') }));
}

const deckMade = new Set();
async function addCardOnce(c) {
  await ensureModel();
  if (!deckMade.has(c.deck)) { await anki('createDeck', { deck: c.deck }); deckMade.add(c.deck); }
  const base = `ytam_${c.videoId}_${Math.round(c.start * 1000)}_${Date.now().toString(36)}`;
  const store = async (name, data) => `${await anki('storeMediaFile', { filename: name, data }) || name}`;
  let audio = '', audioAI = '', image = '';
  if (c.audio) audio = `[sound:${await store(base + '.mp3', c.audio)}]`;
  if (c.audioAI) audioAI = `[sound:${await store(base + '_ai.mp3', c.audioAI)}]`;
  if (c.image) image = `<img src="${await store(base + '.jpg', c.image)}">`;
  const link = `https://youtu.be/${c.videoId}?t=${Math.floor(c.start)}`;
  const fields = {
    Sentence: c.sentenceHtml,
    Translation: esc(c.translation),
    Word: esc(c.word),
    WordMeaning: esc(c.wordMeaning),
    Audio: audio,
    AudioAI: audioAI,
    Examples: examplesHtml(c.examples),
    Image: image,
    Source: `<a href="${link}">▶ Смотреть на YouTube · ${fmtTime(c.start)}</a><div class="title">${esc(c.title)}</div>`,
  };
  // Only fields the note type really has (the user may have edited it).
  try {
    const have = await anki('modelFieldNames', { modelName: MODEL });
    if (Array.isArray(have) && have.length) for (const k of Object.keys(fields)) if (!have.includes(k)) delete fields[k];
  } catch (_) {}
  return anki('addNote', {
    note: { deckName: c.deck, modelName: MODEL, fields, options: { allowDuplicate: true }, tags: ['youtube', 'yt-anki-miner'] },
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

// Whole-deck scan: every note of the deck (also those added from elsewhere) → word → progress.
// `own` = ids of notes made by this extension (tag yt-anki-miner), `other` = count of foreign notes.
async function ankiDeck(deck) {
  const decks = await anki('deckNames');
  const q = String(deck || '').replace(/"/g, '');
  if (!q || !decks.includes(q)) return { ok: false, words: {} };
  const ownSet = new Set(await anki('findNotes', { query: 'tag:yt-anki-miner' }));
  const noteIds = await anki('findNotes', { query: `deck:"${q}"` });
  const words = {};
  for (let i = 0; i < noteIds.length; i += 400) {
    const infos = await anki('notesInfo', { notes: noteIds.slice(i, i + 400) });
    const byCard = new Map();
    for (const n of infos) {
      const fields = Object.entries(n.fields || {});
      if (!fields.length) continue;
      // Our note type has "Word"; foreign ones: field "Word"/"Front"/"Expression" or simply the first field.
      const pick = fields.find(([k]) => /^(word|front|expression|term)$/i.test(k)) || fields.sort((a, b) => a[1].order - b[1].order)[0];
      const w = unHtml(String(pick[1].value || '').replace(/\[sound:[^\]]*\]/g, ''));
      if (!w || w.length > 60 || w.split(/\s+/).length > 5 || /[\n<]/.test(w)) continue;
      const e = (words[w] = words[w] || { ivl: 0, reps: 0, own: [], other: 0 });
      if (ownSet.has(n.noteId)) e.own.push(n.noteId); else e.other++;
      for (const c of n.cards || []) byCard.set(c, w);
    }
    const cards = [...byCard.keys()];
    if (!cards.length) continue;
    for (const c of await anki('cardsInfo', { cards })) {
      const w = byCard.get(c.cardId);
      if (!w) continue;
      words[w].ivl = Math.max(words[w].ivl, c.interval > 0 ? c.interval : 0);
      words[w].reps = Math.max(words[w].reps, c.reps || 0);
    }
  }
  return { ok: true, words, ownTotal: ownSet.size };
}

// Only notes made by the extension may ever be deleted (the user's own cards are protected).
async function deleteOwnNotes(ids) {
  if (!ids || !ids.length) return 0;
  const infos = await anki('notesInfo', { notes: ids });
  const ours = infos.filter((n) => n && (n.tags || []).includes('yt-anki-miner')).map((n) => n.noteId);
  if (ours.length) await anki('deleteNotes', { notes: ours });
  return ours.length;
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

// PCM (Int16 LE, base64) → MP3 (base64). Runs here so the video page never stalls while a card is made.
function encodeMp3Bg({ pcm, rate, kbps }) {
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) throw new Error('lamejs unavailable');
  const bin = atob(pcm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const enc = new lamejs.Mp3Encoder(1, rate, kbps || 96);
  const parts = [];
  for (let i = 0; i < samples.length; i += 1152) {
    const out = enc.encodeBuffer(samples.subarray(i, i + 1152));
    if (out.length) parts.push(out);
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  const mp3 = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { mp3.set(new Uint8Array(p.buffer, p.byteOffset, p.length), o); o += p.length; }
  return { b64: bytesToB64(mp3) };
}

async function handle(msg) {
  switch (msg.type) {
    case 'encodeMp3': return encodeMp3Bg(msg);
    case 'clearCaches': { // used by the settings page ("Сбросить кэш переводов") and by tests
      for (const k of Object.keys(caches)) delete caches[k];
      dirtyCaches.clear(); ttsCache.clear(); ms.token = ''; gq.fails = 0; gq.downUntil = 0;
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => /^(trc|trs|lkc|wkt):/.test(k)));
      return true;
    }
    case 'cardVoice': {
      const c = await cloudCfg();
      const text = String(msg.text || '').slice(0, 600);
      if (!(await cloudOk('tts', text.length))) throw new Error('нет ключа Google Cloud, озвучка выключена или достигнут предел');
      return { b64: await cloudTts(text, msg.voice || c.ttsVoice, c.ttsRate, true) };
    }
    case 'aiTrim': return aiTrim(msg);
    case 'aiExamples': return aiExamples(msg);
    case 'warmVariants': return warmVariants(msg.words || [], msg.tl);
    case 'offlineStart': return offlineBuild(msg.n, msg.tl);
    case 'offlineStop': { offline.stop = true; await chrome.storage.local.remove('offlineJob'); return true; }
    case 'offlineStatus': return offlineStatus();
    case 'translateLines': return translateLines(msg.lines, msg.tl, msg.prio, msg.sl);
    case 'translateWords': return translateWords(msg.words, msg.tl, msg.prio, msg.sl);
    case 'lookup': return lookup(msg.word, msg.tl, msg.prio, msg.sl, msg.phase, msg.sentence);
    case 'translatorTest': return translatorTest(msg.word);
    case 'translatorStatus': return translatorStatus();
    case 'speakCloud': return speakCloud(msg);
    case 'cloudTest': return cloudTest();
    case 'usage': return usageGet();
    case 'aiSegment': return aiSegment(msg);
    case 'aiVideo': return aiVideo(msg);
    case 'addCard': return addCardOrQueue(msg.card);
    case 'syncNow': return flushOutbox();
    case 'outboxClear': return outboxSet([]);
    case 'outboxRemove': { const box = await outboxGet(); const keep = box.filter((c) => c.key !== msg.key); if (keep.length !== box.length) await outboxSet(keep); return box.length - keep.length; }
    case 'helperPing': return (await helperFetch(msg.url, '/ping')).json();
    case 'helperPrepare': return (await helperFetch(msg.url, '/prepare?v=' + encodeURIComponent(msg.v))).json();
    case 'helperPcm': return helperPcm(msg);
    case 'helperProgress': return (await helperFetch(msg.url, `/progress?v=${encodeURIComponent(msg.v)}&t=${Math.round((msg.t || 0) * 10) / 10}&title=${encodeURIComponent(String(msg.title || '').slice(0, 150))}`)).json();
    case 'ankiProgress': return ankiProgress();
    case 'deleteNotes': return deleteOwnNotes(msg.ids);
    case 'ankiDeck': return ankiDeck(msg.deck);
    case 'ankiStatus': {
      const d = await ankiDiagnose();
      if (!d.ok) throw new Error(d.steps.join(' · ') + (d.steps.some((x) => /403/.test(x)) ? ` — добавьте "${d.origin}" в webCorsOriginList AnkiConnect или запустите лончер` : ''));
      return { version: d.version, decks: d.decks, steps: d.steps };
    }
    case 'ankiDiagnose': return ankiDiagnose();
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
