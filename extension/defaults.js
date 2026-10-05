// Shared defaults and settings schema (content script, popup, options page, service worker).
self.YTAM_DEFAULTS = {
  enabled: true,
  // Anki
  deck: 'English::YouTube',
  includeAudio: true,
  includeImage: true,
  smartTrim: true,
  padStart: 0.15,
  padEnd: 0.3,
  ankiOnLearning: true,
  ankiDelete: 'drop',
  // Translation & subtitles
  targetLang: 'ru',
  showTranslation: true,
  hideSubs: 'off',
  maxWords: 18,
  // Controls
  autoPause: false,
  pauseOnHover: true,
  hoverTranslate: true,
  showStageButtons: true,
  rightClick: 'toggle',
  speakOnClick: true,
  arrowKeys: false,
  // Look
  fontFamily: 'default',
  fontSize: 26,
  fontWeight: 600,
  trScale: 80,
  subBgOpacity: 60,
  subPos: 12,
  twoLines: false,
  showSubControls: true,
  showSideControls: true,
  hidePlaybar: false,
  showPanel: true,
  panelFontSize: 16,
  tipFontSize: 16,
  tipAnim: 160,
  tipVariants: 3,
  popWidth: 330,
  popFontSize: 13,
  // Word colors (Language Reactor scheme)
  vocabSize: 3000,
  suggestedRatio: 1,
  hlKnown: true,
  hlNext: true,
  hlLearnText: false,
  hlLearning: true,
  hlRare: true,
  colorKnown: '#a0f8d0',
  colorNext: '#f8bc82',
  colorLearning: '#c98a4b',
  colorRare: '#b490c0',
  builtinExpr: true,
  // AI (Gemini): 'off' | 'text' | 'audio'
  aiMode: 'off',
  aiModel: 'gemini-2.5-flash-lite',
  aiFastModel: 'gemini-2.5-flash-lite',
  aiPromptExplain: 'Объясни, что значит «{word}» именно в этой фразе и что значит вся фраза. Укажи оттенок значения или стиль, если важно.',
  aiPromptExamples: 'Приведи до 5 коротких естественных примеров с «{word}» в том же значении, после каждого — перевод в скобках.',
  aiPromptGrammar: 'Объясни грамматику этой фразы: время, конструкцию, порядок слов, почему «{word}» стоит в этой форме.',
  customDicts: '',
};

// Stored only on this computer (not synced).
self.YTAM_LOCAL_DEFAULTS = {
  geminiKey: '',
};

const LANG_OPTIONS = [['ru', 'Русский'], ['uk', 'Українська'], ['be', 'Беларуская'], ['kk', 'Қазақша'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['zh-CN', '中文'], ['ja', '日本語']];

// type: toggle | range | select | color | text | password | textarea | number
// color: optional color key shown next to a toggle; local: stored in chrome.storage.local
self.YTAM_SCHEMA = [
  {
    id: 'view', title: 'Вид', fields: [
      { k: 'fontFamily', label: 'Шрифт', type: 'select', options: [['default', 'По умолчанию (Roboto)'], ['Arial', 'Arial'], ['Verdana', 'Verdana'], ['"Segoe UI"', 'Segoe UI'], ['"Open Sans"', 'Open Sans'], ['"Trebuchet MS"', 'Trebuchet MS'], ['Georgia', 'Georgia']] },
      { k: 'fontSize', label: 'Размер субтитров', type: 'range', min: 12, max: 60, step: 1, unit: 'px' },
      { k: 'fontWeight', label: 'Насыщенность шрифта', type: 'select', options: [['400', 'Обычный'], ['500', 'Средний'], ['600', 'Полужирный'], ['700', 'Жирный']] },
      { k: 'trScale', label: 'Размер перевода', type: 'range', min: 50, max: 110, step: 5, unit: '%' },
      { k: 'subBgOpacity', label: 'Непрозрачность подложки', type: 'range', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'subPos', label: 'Высота субтитров от низа видео', type: 'range', min: 0, max: 70, step: 1, unit: '%', preview: 'pos' },
      { k: 'twoLines', label: 'Режим двух строк', type: 'toggle', hint: 'Длинная фраза переносится на две ровные строки' },
      { k: 'showSubControls', label: 'Кнопки у субтитров (▶ ☆)', type: 'toggle' },
      { k: 'showSideControls', label: 'Кнопки по бокам видео (‹ ↻ › AP)', type: 'toggle' },
      { k: 'hidePlaybar', label: 'Прятать полосу YouTube (видна при наведении)', type: 'toggle' },
      { k: 'showPanel', label: 'Боковая панель со списком', type: 'toggle' },
      { k: 'panelFontSize', label: 'Текст в боковой панели', type: 'range', min: 11, max: 26, step: 1, unit: 'px' },
      { k: 'tipFontSize', label: 'Текст подсказки при наведении', type: 'range', min: 10, max: 26, step: 1, unit: 'px', preview: 'tip' },
      { k: 'tipVariants', label: 'Вариантов перевода в подсказке', type: 'range', min: 1, max: 6, step: 1 },
      { k: 'tipAnim', label: 'Плавность появления подсказки', type: 'range', min: 0, max: 500, step: 10, unit: 'мс' },
      { k: 'popWidth', label: 'Ширина окна слова', type: 'range', min: 260, max: 520, step: 10, unit: 'px' },
      { k: 'popFontSize', label: 'Текст окна слова', type: 'range', min: 11, max: 18, step: 1, unit: 'px' },
    ],
  },
  {
    id: 'words', title: 'Слова', fields: [
      { k: 'vocabSize', label: 'Мой словарный запас', type: 'range', min: 0, max: 20000, step: 250, unit: 'слов', hint: 'Частотный словарь 50 000 слов. A2 ≈ 1500 · B1 ≈ 3000 · B2 ≈ 5000 · C1 ≈ 8000 · C2 ≈ 12000' },
      { k: 'suggestedRatio', label: 'Рекомендованных слов к известным', type: 'select', options: [['0.5', '0.5x'], ['1', '1.0x (рекомендуется)'], ['1.5', '1.5x'], ['2', '2.0x'], ['3', '3.0x']] },
      { k: 'hlKnown', color: 'colorKnown', label: 'Известные слова', type: 'toggle' },
      { k: 'hlNext', color: 'colorNext', label: 'Рекомендованные слова', type: 'toggle' },
      { k: 'hlLearnText', label: 'Изучаю — цветом текста', type: 'toggle' },
      { k: 'hlLearning', color: 'colorLearning', label: 'Изучаю — рамкой', type: 'toggle' },
      { k: 'hlRare', color: 'colorRare', label: 'Не учить / редкие', type: 'toggle' },
      { k: 'builtinExpr', label: 'Встроенный словарь выражений', type: 'toggle', hint: '~350 фразовых глаголов и идиом; ИИ-режим находит выражения по контексту' },
    ],
  },
  {
    id: 'controls', title: 'Управление', fields: [
      { k: 'hoverTranslate', label: 'Мини-словарь при наведении', type: 'toggle' },
      { k: 'showStageButtons', label: 'Кнопки ✓ / 📖 в подсказке', type: 'toggle' },
      { k: 'rightClick', label: 'Правая кнопка мыши', type: 'select', options: [['toggle', 'Знаю ⇄ Изучаю (рекомендуется)'], ['dict', 'Открыть словарь'], ['none', 'Обычное меню браузера']] },
      { k: 'speakOnClick', label: 'Произносить слово при клике', type: 'toggle' },
      { k: 'pauseOnHover', label: 'Пауза при наведении на субтитры', type: 'toggle' },
      { k: 'autoPause', label: 'Автопауза после каждой фразы', type: 'toggle' },
      { k: 'arrowKeys', label: 'Стрелки ← → — предыдущая / следующая фраза', type: 'toggle' },
    ],
  },
  {
    id: 'subs', title: 'Перевод', fields: [
      { k: 'targetLang', label: 'Язык перевода', type: 'select', options: LANG_OPTIONS },
      { k: 'showTranslation', label: 'Показывать перевод фразы', type: 'toggle' },
      { k: 'hideSubs', label: 'Скрывать субтитры', type: 'select', options: [['off', 'Нет'], ['tr', 'Размыть перевод (виден при наведении)'], ['orig', 'Размыть оригинал'], ['both', 'Размыть оба']] },
      { k: 'maxWords', label: 'Макс. слов во фразе', type: 'range', min: 6, max: 40, step: 1 },
    ],
  },
  {
    id: 'anki', title: 'Anki', fields: [
      { k: 'deck', label: 'Колода', type: 'text', list: 'decks' },
      { k: 'ankiOnLearning', label: '«Изучаю» сразу создаёт карточку', type: 'toggle' },
      { k: 'ankiDelete', label: 'Удалять карточку из Anki (через 30 с)', type: 'select', options: [['drop', 'Когда слово убрано / «не учить»'], ['all', 'Также когда отмечено «знаю»'], ['never', 'Никогда']] },
      { k: 'includeAudio', label: 'Аудио фразы (MP3)', type: 'toggle' },
      { k: 'includeImage', label: 'Кадр из видео', type: 'toggle' },
      { k: 'smartTrim', label: 'Подгонять края аудио по паузам', type: 'toggle' },
      { k: 'padStart', label: 'Запас до фразы', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 'с' },
      { k: 'padEnd', label: 'Запас после фразы', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 'с' },
    ],
  },
  {
    id: 'ai', title: 'ИИ', fields: [
      { k: 'aiMode', label: 'Обработка субтитров', type: 'select', options: [['off', 'Выключена'], ['text', 'Текст: пунктуация, предложения, перевод'], ['audio', '🎧 ИИ слушает видео']] },
      { k: 'geminiKey', label: 'Ключ Gemini API', type: 'password', local: true, hint: 'Хранится только на этом компьютере · aistudio.google.com/apikey' },
      { k: 'aiModel', label: 'Модель для субтитров', type: 'text', list: 'ytam-models' },
      { k: 'aiFastModel', label: 'Модель для разбора слова', type: 'text', list: 'ytam-models' },
      { k: 'aiPromptExplain', label: 'Промпт «Объяснить»', type: 'textarea', hint: '{word} — слово, {sentence} — фраза' },
      { k: 'aiPromptExamples', label: 'Промпт «Примеры»', type: 'textarea' },
      { k: 'aiPromptGrammar', label: 'Промпт «Грамматика»', type: 'textarea' },
      { k: 'customDicts', label: 'Свои словари', type: 'textarea', hint: 'По одному в строке: Название | https://site.com/?q=WORD' },
    ],
  },
];
