// Site configuration. Edit before going live.
window.SITE = {
  name: 'YT → Anki Miner',                // working name — rename before launch
  // Google sign-in: create an OAuth Client ID (type "Web application") in Google Cloud Console →
  // APIs & Services → Credentials, add http://localhost:8766 to "Authorized JavaScript origins".
  googleClientId: '',
  // Dev-only login. REMOVE for production (see docs/BUSINESS.md).
  devLogin: { enabled: true, user: 'admin', password: 'admin' },
};
