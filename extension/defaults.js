// Shared defaults (content script, popup, options page, service worker).
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
  // Subtitles
  targetLang: 'ru',
  maxWords: 18,
  autoPause: false,
  pauseOnHover: true,
  showTranslation: true,
  blurTranslation: false,
  hoverTranslate: true,
  fontSize: 26,
  // Highlighting
  vocabSize: 3000,
  nextSize: 3000,
  hlKnown: true,
  hlLearning: true,
  hlNext: true,
  hlRare: true,
  colorKnown: '#a0f8d0',
  colorLearning: '#c98a4b',
  colorNext: '#f8bc82',
  colorRare: '#b490c0',
  builtinExpr: true,
  // AI (Gemini): 'off' | 'text' (fix existing subtitles) | 'audio' (Gemini listens to the video)
  aiMode: 'off',
  aiModel: 'gemini-2.5-flash-lite',
  aiFastModel: 'gemini-2.5-flash-lite',
};

// Stored only on this computer (not synced).
self.YTAM_LOCAL_DEFAULTS = {
  geminiKey: '',
};
