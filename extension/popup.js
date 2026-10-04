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

const inputs = document.querySelectorAll('[data-k]');
const status = document.getElementById('status');

chrome.storage.sync.get(DEFAULTS, (s) => {
  inputs.forEach((el) => {
    const v = s[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
});

inputs.forEach((el) => {
  el.addEventListener('change', () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = Number(v) || DEFAULTS[el.dataset.k];
    if (el.dataset.k === 'deck') v = String(v).trim() || DEFAULTS.deck;
    chrome.storage.sync.set({ [el.dataset.k]: v });
  });
});

async function checkAnki() {
  status.className = '';
  status.textContent = '…';
  chrome.runtime.sendMessage({ type: 'ankiStatus' }, (r) => {
    if (chrome.runtime.lastError || !r || r.error) {
      status.className = 'err';
      status.textContent = (r && r.error) || 'Нет связи с Anki';
      return;
    }
    status.className = 'ok';
    status.textContent = '✓ AnkiConnect v' + r.result.version;
    document.getElementById('decks').replaceChildren(...r.result.decks.map((d) => {
      const o = document.createElement('option');
      o.value = d;
      return o;
    }));
  });
}

document.getElementById('test').addEventListener('click', checkAnki);
checkAnki();
