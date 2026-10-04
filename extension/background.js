// Service worker: translation (Google Translate, no key) and AnkiConnect.

const MODEL = 'YT Anki Miner';
const FIELDS = ['Sentence', 'Translation', 'Word', 'WordMeaning', 'Audio', 'Image', 'Source'];

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
};

// ---------- Translation ----------

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

async function lookup(word, tl) {
  const j = await gtx(word, tl, true);
  return {
    translation: joinTrans(j).trim(),
    dict: (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) })),
  };
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
.src{font-size:13px;color:#888;margin-top:16px}
.src a{color:#888}`;

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
  }
  modelReady = true;
}

async function addCard(c) {
  await ensureModel();
  await anki('createDeck', { deck: c.deck });
  const base = `ytam_${c.videoId}_${Math.round(c.start * 1000)}_${Date.now().toString(36)}`;
  let audio = '', image = '';
  if (c.audio) {
    const fn = await anki('storeMediaFile', { filename: base + '.webm', data: c.audio });
    audio = `[sound:${fn || base + '.webm'}]`;
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
        Source: `<a href="${link}">${esc(c.title)}</a> · ${fmtTime(c.start)}`,
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
    case 'lookup': return lookup(msg.word, msg.tl);
    case 'addCard': return addCard(msg.card);
    case 'ankiStatus': {
      const version = await anki('version');
      const decks = await anki('deckNames');
      return { version, decks };
    }
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
