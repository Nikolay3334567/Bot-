// Local demo auth. In production this must be a real backend:
//  - verify the Google ID token on the server (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
//  - keep sessions in httpOnly cookies, never in localStorage
(function () {
  const KEY = 'ytam_session';
  const Auth = {
    session() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; } },
    save(s) { localStorage.setItem(KEY, JSON.stringify(s)); return s; },
    logout() { localStorage.removeItem(KEY); },
    require() { const s = Auth.session(); if (!s) location.href = 'login.html'; return s; },
    loginLocal(user, pass) {
      const d = window.SITE.devLogin;
      if (d && d.enabled && user === d.user && pass === d.password) {
        return Auth.save({ provider: 'local', name: 'Администратор', email: 'admin@local', plan: 'max', admin: true, ts: Date.now() });
      }
      throw new Error('Неверный логин или пароль');
    },
    loginGoogle(credential) {
      const p = JSON.parse(decodeURIComponent(escape(atob(credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
      const prev = Auth.session();
      return Auth.save({ provider: 'google', name: p.name || p.email, email: p.email, picture: p.picture, plan: prev && prev.email === p.email ? prev.plan : 'free', admin: false, ts: Date.now() });
    },
    setPlan(plan) { const s = Auth.session(); if (s) { s.plan = plan; Auth.save(s); } },
  };
  window.Auth = Auth;
})();
