// Plans and the cost model behind them (see docs/BUSINESS.md). Prices in USD.
window.PLANS = [
  {
    id: 'free', name: 'Free', price: 0, yearly: 0, tagline: 'Попробовать и пользоваться со своим ключом ИИ',
    features: ['Двойные субтитры, перевод по наведению', 'Подсветка слов по вашему уровню', 'Сохранение карточек в Anki (звук, кадр, ссылка)', 'Свой ключ Gemini / OpenAI-совместимый API', 'До 30 новых карточек в неделю'],
    quota: { listenHours: 0, explains: 0, cards: 30 },
  },
  {
    id: 'pro', name: 'Pro', price: 6.99, yearly: 59, tagline: 'Всё включено, без своих ключей', popular: true,
    features: ['Всё из Free без ограничений по карточкам', '12 часов «ИИ слушает видео» в месяц', '1 000 разборов слов и фраз в месяц', 'Синхронизация словаря и прогресса между устройствами', 'Лончер со звуком из yt-dlp'],
    quota: { listenHours: 12, explains: 1000, cards: Infinity },
  },
  {
    id: 'max', name: 'Max', price: 12.99, yearly: 109, tagline: 'Для тех, кто смотрит каждый день много',
    features: ['Всё из Pro', '25 часов «ИИ слушает видео» в месяц', '4 000 разборов слов и фраз в месяц', 'Выбор модели ИИ, приоритетная очередь', 'Ранний доступ к новым функциям'],
    quota: { listenHours: 25, explains: 4000, cards: Infinity },
  },
];

// Unit costs (USD). Gemini 2.5 Flash-Lite: $0.10 / $0.40 per 1M text tokens, $0.30 per 1M audio tokens.
window.COSTS = {
  listenPerHour: 0.054,   // 6 × 10-minute chunks: audio 19.2k tok × $0.30/M + frames ≈ 8k × $0.10/M + ≈5k output × $0.40/M
  textPerHour: 0.014,     // text-only processing of subtitles
  explain: 0.00015,       // one word/phrase explanation (~700 in + 200 out tokens)
  merchantPct: 5,         // Merchant of Record (Paddle / Lemon Squeezy / Polar): ≈5% + $0.50 incl. VAT handling
  merchantFixed: 0.5,
  infraMonthly: 15,       // backend + database + domain, fixed
};
