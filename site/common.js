// Shared header/footer and small helpers.
(function () {
  const S = window.SITE;
  const page = location.pathname.split('/').pop() || 'index.html';
  const s = window.Auth && Auth.session();
  const link = (href, text, cls = '') => `<a href="${href}" class="${cls} ${page === href ? 'on' : ''}">${text}</a>`;
  document.querySelector('[data-nav]').outerHTML = `
  <header class="nav"><div class="wrap">
    <a class="brand" href="index.html"><i>YA</i>${S.name}</a>
    <nav>
      ${link('index.html#features', 'Возможности', 'hide-sm')}
      ${link('pricing.html', 'Тарифы')}
      ${link('legal.html', 'Условия', 'hide-sm')}
      ${s ? link('account.html', 'Кабинет') + `<a class="btn sm sec" href="#" id="logout">Выйти</a>` : `<a class="btn sm" href="login.html">Войти</a>`}
    </nav>
  </div></header>`;
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = (e) => { e.preventDefault(); Auth.logout(); location.href = 'index.html'; };
  const f = document.querySelector('[data-footer]');
  if (f) f.outerHTML = `<footer><div class="wrap"><span>© ${new Date().getFullYear()} ${S.name}. Все права защищены.</span><a href="legal.html">Условия и конфиденциальность</a><span>Не связано с YouTube, Google или Anki.</span></div></footer>`;
  document.title = document.title.replace('{name}', S.name);
})();
