// Runs in the page (MAIN world). YouTube now signs subtitle requests with a
// one-time token, so we watch the player's own /api/timedtext requests and
// hand their URLs to the content script. Also exposes the player response.
(() => {
  if (window.__ytamHooked) return;
  window.__ytamHooked = true;

  const isTimedText = (u) => typeof u === 'string' && u.includes('/api/timedtext');
  const post = (url, body) => {
    try {
      window.postMessage({ __ytam: true, type: 'timedtext', url: new URL(url, location.href).href, body }, '*');
    } catch (_) {}
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ytamUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (isTimedText(this.__ytamUrl)) {
      this.addEventListener('load', () => {
        const textual = this.responseType === '' || this.responseType === 'text';
        post(this.__ytamUrl, textual ? this.responseText : null);
      });
    }
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    const p = origFetch.apply(this, arguments);
    if (isTimedText(url)) {
      p.then((r) => r.clone().text()).then((t) => post(url, t)).catch(() => {});
    }
    return p;
  };


  // ---- click-free pause / play (the pop you hear when sound is cut at a non-zero level) ----
  // Our fades change video.volume for a few ms; YouTube must neither notice nor save that. The content script
  // marks such moments in <html data-ytam-q> and we swallow the volumechange events of that window.
  const nowAbs = () => performance.timeOrigin + performance.now();
  window.addEventListener('volumechange', (e) => {
    const q = +document.documentElement.dataset.ytamQ;
    if (q && nowAbs() < q && e.target && e.target.tagName === 'VIDEO') e.stopImmediatePropagation();
  }, true);

  const DCms = () => +document.documentElement.dataset.ytamDc || 0;    // 0 = off
  const isMainVideo = (v) => v && v.tagName === 'VIDEO' && /html5-main-video/.test(v.className);
  const quiet = (v, x) => { document.documentElement.dataset.ytamQ = String(nowAbs() + 150); v.volume = Math.max(0, Math.min(1, x)); };
  const ramp = (v, to, ms) => new Promise((res) => {
    const from = v.volume, steps = Math.max(1, Math.round(ms / 5));
    let i = 0;
    const t = setInterval(() => { i++; quiet(v, from + (to - from) * Math.min(1, i / steps)); if (i >= steps) { clearInterval(t); res(); } }, 5);
  });
  const nativePause = HTMLMediaElement.prototype.pause;
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.pause = function () {
    const v = this, ms = DCms();
    if (!ms || !isMainVideo(v) || v.paused || v.__ytamFade) return nativePause.apply(v, arguments);
    v.__ytamFade = { vol: v.volume, cancel: false };
    ramp(v, 0, ms).then(() => {
      const f = v.__ytamFade;
      if (f && !f.cancel) nativePause.call(v);
      quiet(v, f ? f.vol : v.volume);
      v.__ytamFade = null;
    });
  };
  HTMLMediaElement.prototype.play = function () {
    const v = this, ms = DCms();
    if (v.__ytamFade) { v.__ytamFade.cancel = true; return nativePlay.apply(v, arguments); } // play() during the fade-out: keep playing
    if (!ms || !isMainVideo(v) || !v.paused) return nativePlay.apply(v, arguments);
    const vol0 = v.volume;
    quiet(v, 0);
    const p = nativePlay.apply(v, arguments);
    const up = () => ramp(v, vol0, ms);
    if (p && p.then) p.then(up, () => quiet(v, vol0)); else up();
    return p;
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ytamReq !== 'playerResponse') return;
    let pr = null;
    try {
      const player = document.getElementById('movie_player');
      pr = (player && player.getPlayerResponse && player.getPlayerResponse()) || window.ytInitialPlayerResponse || null;
    } catch (_) {}
    const tracks = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    window.postMessage({
      __ytam: true,
      type: 'playerResponse',
      id: e.data.id,
      videoId: pr && pr.videoDetails && pr.videoDetails.videoId,
      title: (pr && pr.videoDetails && pr.videoDetails.title) || document.title,
      tracks: tracks.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || '',
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || t.languageCode,
      })),
    }, '*');
  });
})();
