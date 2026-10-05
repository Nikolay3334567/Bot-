document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
ytamCheckAnki(document.getElementById('status'), document.getElementById('decks'));

const queueEl = document.getElementById('queue');
function showQueue(n) { queueEl.textContent = n ? `В очереди на отправку: ${n}` : 'Очередь пуста'; queueEl.style.color = n ? '#b06d00' : '#777'; }
chrome.storage.local.get({ outbox: [] }, (r) => showQueue(r.outbox.length));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.outbox) showQueue((ch.outbox.newValue || []).length); });
document.getElementById('sync').onclick = () => {
  queueEl.textContent = 'Отправляю…';
  chrome.runtime.sendMessage({ type: 'syncNow' }, (r) => {
    const res = r && r.result;
    if (!res) return (queueEl.textContent = (r && r.error) || 'Ошибка');
    queueEl.textContent = res.error && !res.sent ? 'Anki не отвечает: откройте Anki' : `Отправлено: ${res.sent}, в очереди: ${res.left}`;
  });
};
