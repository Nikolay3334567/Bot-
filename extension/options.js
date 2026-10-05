const grantBtn = Object.assign(document.createElement('button'), { className: 'ytam-set-reset', textContent: 'Разрешить доступ к адресу API' });
const grantNote = document.createElement('span');
grantNote.style.cssText = 'margin-left:10px;font-size:12px;color:#9a9a9a';
grantBtn.onclick = async () => {
  const { aiBaseUrl } = await chrome.storage.sync.get(YTAM_DEFAULTS);
  try {
    const ok = await chrome.permissions.request({ origins: [new URL(aiBaseUrl).origin + '/*'] });
    grantNote.textContent = ok ? '✓ доступ разрешён' : 'доступ не выдан';
  } catch (e) { grantNote.textContent = 'неверный адрес: ' + e.message; }
};
const grantBox = document.createElement('div');
grantBox.append(grantBtn, grantNote);
document.getElementById('settings').append(YTAM_buildSettings({ extra: { ai: grantBox } }));
const $ = (id) => document.getElementById(id);
const STATUS = { 1: 'Изучаю', 2: 'Знаю', 3: 'Не учить' };
let vocab = {};

$('test').onclick = () => ytamCheckAnki($('status'), $('decks'));
ytamCheckAnki($('status'), $('decks'));

async function loadVocab() {
  vocab = (await chrome.storage.local.get({ vocab: {} })).vocab;
  render();
}

function render() {
  const all = Object.entries(vocab);
  const learning = all.filter(([, s]) => s === 1).length;
  $('counts').textContent = `Изучаю: ${learning} · Знаю: ${all.length - learning}`;
  const q = $('filter').value.trim().toLowerCase();
  const show = $('show').value;
  const rows = all
    .filter(([w, s]) => (show === 'all' || String(s) === show) && (!q || w.includes(q)))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 500);
  $('list').replaceChildren(...rows.map(([w, s]) => {
    const sel = document.createElement('select');
    for (const [v, label] of [['1', 'Изучаю'], ['2', 'Знаю'], ['3', 'Не учить'], ['0', 'Удалить']]) sel.append(new Option(label, v, false, String(s) === v));
    sel.onchange = () => setStatus(w, +sel.value);
    const row = document.createElement('div');
    row.className = 'w';
    row.append(w, sel);
    return row;
  }));
}

async function setStatus(w, st) {
  if (st) vocab[w] = st; else delete vocab[w];
  await chrome.storage.local.set({ vocab });
  render();
}

$('filter').oninput = render;
$('show').onchange = render;

function parseWords(text) {
  return text.split(/\r?\n/)
    .map((line) => line.split(/[,;\t]/)[0].replace(/^["']|["']$/g, '').trim().toLowerCase().replace(/’/g, "'"))
    .filter((w) => w && w.length < 60 && /\p{L}/u.test(w));
}

$('importFile').onchange = async () => {
  const f = $('importFile').files[0];
  if (f) $('importText').value = await f.text();
};

$('importBtn').onclick = async () => {
  const words = parseWords($('importText').value);
  if (!words.length) return alert('Нет слов для импорта');
  const st = +$('importStatus').value;
  vocab = (await chrome.storage.local.get({ vocab: {} })).vocab;
  for (const w of words) vocab[w] = st;
  await chrome.storage.local.set({ vocab });
  $('importText').value = '';
  render();
  alert(`Импортировано слов: ${words.length} (${STATUS[st]})`);
};

$('exportBtn').onclick = () => {
  const csv = 'word,status\n' + Object.entries(vocab).map(([w, s]) => `"${w}",${STATUS[s]}`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'yt-anki-vocab.csv';
  a.click();
};

$('clearBtn').onclick = async () => {
  if (!confirm('Удалить все слова из словаря?')) return;
  vocab = {};
  await chrome.storage.local.set({ vocab });
  render();
};

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.vocab) { vocab = ch.vocab.newValue || {}; render(); }
});

loadVocab();
