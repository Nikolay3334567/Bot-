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
  hlLearning: true,
  hlNext: true,
  hlRare: true,
  colorLearning: '#ffc400',
  colorNext: '#66c2ff',
  colorRare: '#c792ea',
  // AI (Gemini)
  aiEnabled: false,
  aiModel: 'gemini-2.5-flash-lite',
};

// Stored only on this computer (not synced).
self.YTAM_LOCAL_DEFAULTS = {
  geminiKey: '',
};
