// Binds every [data-k] input on the page to chrome.storage (sync, or local for data-local).
(() => {
  const D = self.YTAM_DEFAULTS, L = self.YTAM_LOCAL_DEFAULTS;
  const inputs = [...document.querySelectorAll('[data-k]')];

  const setValue = (el, v) => {
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  };

  chrome.storage.sync.get(D, (s) => inputs.filter((el) => !el.hasAttribute('data-local')).forEach((el) => setValue(el, s[el.dataset.k])));
  chrome.storage.local.get(L, (s) => inputs.filter((el) => el.hasAttribute('data-local')).forEach((el) => setValue(el, s[el.dataset.k])));

  for (const el of inputs) {
    el.addEventListener('change', () => {
      const k = el.dataset.k;
      const def = el.hasAttribute('data-local') ? L[k] : D[k];
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (typeof def === 'number') v = Number(v) >= 0 && el.value !== '' ? Number(v) : def;
      if (typeof v === 'string') v = v.trim() || def;
      setValue(el, v);
      (el.hasAttribute('data-local') ? chrome.storage.local : chrome.storage.sync).set({ [k]: v });
    });
  }

  const verEl = document.getElementById('ver');
  if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version;

  self.ytamCheckAnki = (statusEl, datalist) => {
    statusEl.className = '';
    statusEl.textContent = '…';
    chrome.runtime.sendMessage({ type: 'ankiStatus' }, (r) => {
      if (chrome.runtime.lastError || !r || r.error) {
        statusEl.className = 'err';
        statusEl.textContent = (r && r.error) || 'Нет связи с Anki';
        return;
      }
      statusEl.className = 'ok';
      statusEl.textContent = '✓ AnkiConnect v' + r.result.version;
      if (datalist) {
        datalist.replaceChildren(...r.result.decks.map((d) => {
          const o = document.createElement('option');
          o.value = d;
          return o;
        }));
      }
    });
  };
})();
