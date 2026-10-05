(function () {
  const s = Auth.require();
  if (!s) return;
  const $ = (id) => document.getElementById(id);
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(n).toFixed(2);

  // --- header / overview
  $('who').textContent = s.name;
  $('mail').textContent = s.email;
  $('avatar').innerHTML = s.picture ? `<img src="${s.picture}" width="48" height="48" alt="">` : (s.name || '?')[0].toUpperCase();
  $('prov').textContent = s.provider === 'google' ? 'Google' : 'Локальный (тест)';
  $('key').textContent = 'ytam_' + btoa(s.email + '|' + s.ts).replace(/=/g, '').slice(0, 32);
  if (s.admin) $('econTab').style.display = '';

  function overview() {
    const p = PLANS.find((x) => x.id === (Auth.session() || s).plan) || PLANS[0];
    $('curPlan').textContent = p.name;
    const used = { listen: 0.37, explain: 0.22, cards: 0.15 };
    const row = (name, frac, text) => `<div style="margin-bottom:12px"><div class="kv" style="border:0;padding:0"><span>${name}</span><b>${text}</b></div><div class="meter"><i style="width:${Math.round(frac * 100)}%"></i></div></div>`;
    $('usage').innerHTML = p.quota.listenHours
      ? row('ИИ слушает видео', used.listen, `${Math.round(used.listen * p.quota.listenHours)} / ${p.quota.listenHours} ч`) + row('Разборы слов', used.explain, `${Math.round(used.explain * p.quota.explains)} / ${p.quota.explains}`)
      : row('Новые карточки за неделю', 0.4, `12 / ${p.quota.cards}`) + '<small style="color:var(--mute)">Со своим ключом ИИ квоты не нужны.</small>';
  }

  function plans() {
    const cur = (Auth.session() || s).plan;
    $('plans').innerHTML = PLANS.map((p) => `<div class="card price ${p.popular ? 'pop' : ''}"><h3>${p.name}</h3><p>${p.tagline}</p>
      <div class="amount">$${p.price}<small> / мес</small></div><ul>${p.features.map((f) => `<li>${f}</li>`).join('')}</ul>
      <button class="btn ${cur === p.id ? 'sec' : ''}" data-plan="${p.id}" ${cur === p.id ? 'disabled' : ''}>${cur === p.id ? 'Текущий тариф' : 'Выбрать (тест)'}</button></div>`).join('');
  }
  $('plans').onclick = (e) => { const b = e.target.closest('[data-plan]'); if (!b) return; Auth.setPlan(b.dataset.plan); plans(); overview(); };
  const q = new URLSearchParams(location.search).get('plan');
  if (q && PLANS.some((p) => p.id === q)) Auth.setPlan(q);

  // --- tabs
  function tab(t) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== t; });
    if (t === 'econ') econ();
  }
  $('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) tab(b.dataset.t); };

  // --- economics calculator
  const MODELS = {
    'Gemini 2.5 Flash-Lite': { in: 0.10, out: 0.40, audio: 0.30 },
    'Gemini 3.1 Flash-Lite': { in: 0.25, out: 1.50, audio: 0.50 },
    'Gemini 3.5 Flash-Lite': { in: 0.30, out: 2.50, audio: 0.30 },
  };
  // Tokens per hour of video: audio 32 tok/s; frames at 0.2 fps × 66 tok; output ≈ 30k (text + translation + expressions).
  const TOK = { listen: { audio: 115200, frames: 47520, out: 30000 }, text: { in: 15000, out: 30000 }, explain: { in: 700, out: 200 } };
  const state = { model: 'Gemini 2.5 Flash-Lite', paying: 200, price: 6.99, yearlyShare: 40, yearlyPrice: 59, listenH: 10, textH: 4, explains: 600, freeNew: 300, freeTrialH: 1, mor: true, merchantPct: COSTS.merchantPct, merchantFixed: COSTS.merchantFixed, infra: COSTS.infraMonthly, support: 1.0 };
  let built = false;

  function calc() {
    const m = MODELS[state.model];
    const M = 1e6;
    const listenCost = (TOK.listen.audio * m.audio + TOK.listen.frames * m.in + TOK.listen.out * m.out) / M;
    const textCost = (TOK.text.in * m.in + TOK.text.out * m.out) / M;
    const explainCost = (TOK.explain.in * m.in + TOK.explain.out * m.out) / M;
    const aiUser = state.listenH * listenCost + state.textH * textCost + state.explains * explainCost;
    const y = state.yearlyShare / 100;
    const revUser = (1 - y) * state.price + y * (state.yearlyPrice / 12);
    const feeUser = state.mor ? revUser * state.merchantPct / 100 + ((1 - y) * state.merchantFixed + y * state.merchantFixed / 12) : 0;
    const contribution = revUser - feeUser - aiUser - state.support;
    const revenue = revUser * state.paying;
    const fees = feeUser * state.paying, ai = aiUser * state.paying, supp = state.support * state.paying;
    const trial = state.freeNew * state.freeTrialH * listenCost;
    const profit = revenue - fees - ai - supp - trial - state.infra;
    return { listenCost, textCost, explainCost, aiUser, revUser, feeUser, contribution, revenue, fees, ai, supp, trial, profit, margin: revenue ? profit / revenue : 0, breakEven: contribution > 0 ? Math.ceil(state.infra / contribution) : Infinity };
  }

  const FIELDS = [
    ['Платящих пользователей', 'paying', 1, 5000, 1], ['Цена Pro, $/мес', 'price', 1, 30, 0.01], ['Доля годовых подписок, %', 'yearlyShare', 0, 100, 1], ['Цена года, $', 'yearlyPrice', 10, 300, 1],
    ['«Слушает видео», часов в мес на человека', 'listenH', 0, 100, 1], ['Текстовая обработка, часов', 'textH', 0, 100, 1], ['Разборов слов в мес', 'explains', 0, 8000, 50],
    ['Новых бесплатных в мес', 'freeNew', 0, 5000, 10], ['Пробного ИИ на бесплатного, часов', 'freeTrialH', 0, 5, 0.25],
    ['Комиссия платёжного оператора, %', 'merchantPct', 0, 15, 0.1], ['Фикс. комиссия, $ за платёж', 'merchantFixed', 0, 2, 0.05], ['Сервер и инфраструктура, $/мес', 'infra', 0, 500, 1], ['Поддержка, $ на платящего', 'support', 0, 5, 0.1],
  ];

  function econ() {
    if (!built) {
      built = true;
      $('inputs').innerHTML = `<div class="econ-row"><span>Модель ИИ</span><select class="in" id="e_model" style="margin:0">${Object.keys(MODELS).map((k) => `<option>${k}</option>`).join('')}</select><span></span></div>` +
        FIELDS.map(([label, k, min, max, step]) => `<div class="econ-row"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" data-k="${k}"><input type="number" min="${min}" max="${max}" step="${step}" data-n="${k}"></div>`).join('');
      $('e_model').onchange = (e) => { state.model = e.target.value; econ(); };
      $('inputs').addEventListener('input', (e) => {
        const k = e.target.dataset.k || e.target.dataset.n;
        if (!k) return;
        state[k] = +e.target.value;
        econ();
      });
    }
    $('inputs').querySelectorAll('[data-k]').forEach((r) => { r.value = state[r.dataset.k]; });
    $('inputs').querySelectorAll('[data-n]').forEach((r) => { if (document.activeElement !== r) r.value = state[r.dataset.n]; });
    const r = calc();
    const kv = (a, b, cls = '') => `<div class="kv"><span>${a}</span><b class="${cls}">${b}</b></div>`;
    $('result').innerHTML = `<h3>Себестоимость 1 часа видео</h3>` +
      kv('«ИИ слушает видео»', money(r.listenCost)) + kv('Текстовая обработка', money(r.textCost)) + kv('Один разбор слова', '$' + r.explainCost.toFixed(5)) +
      `<h3 style="margin-top:18px">На одного платящего в месяц</h3>` +
      kv('Выручка (с учётом годовых)', money(r.revUser)) + kv('Комиссия оператора', '−' + money(r.feeUser)) + kv('Расходы на ИИ', '−' + money(r.aiUser)) + kv('Поддержка', '−' + money(state.support)) +
      kv('Вклад на человека', money(r.contribution), r.contribution >= 0 ? 'pos' : 'neg') +
      `<h3 style="margin-top:18px">Итого в месяц (${state.paying} платящих)</h3>` +
      kv('Выручка', money(r.revenue)) + kv('Комиссии', '−' + money(r.fees)) + kv('ИИ платящих', '−' + money(r.ai)) + kv('Поддержка', '−' + money(r.supp)) + kv('Пробный ИИ для бесплатных', '−' + money(r.trial)) + kv('Сервер', '−' + money(state.infra)) +
      kv('Прибыль', money(r.profit) + ` (${Math.round(r.margin * 100)}%)`, r.profit >= 0 ? 'pos' : 'neg') +
      kv('Точка безубыточности', isFinite(r.breakEven) ? r.breakEven + ' платящих' : 'не достижима');
  }

  overview(); plans();
  tab(q ? 'plan' : 'overview');
})();
