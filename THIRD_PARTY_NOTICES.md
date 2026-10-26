# Third-party components

| Component | Where | License | What it means for you |
|---|---|---|---|
| [lamejs](https://github.com/zhuker/lamejs) (MP3 encoder) | `extension/lib/lame.min.js` | LGPL-3.0 | Keep the file separate and unmodified, keep the license text (`extension/lib/LAMEJS-LICENSE`), tell users they can replace it. Fine for commercial use. |
| [wordfreq](https://github.com/rspeer/wordfreq) word frequencies | `extension/data/freq_en.js` | CC BY-SA 4.0 (data) | Attribution is required; the *list itself* (and adaptations of it) must stay under CC BY-SA. Your own code can stay proprietary. For a paid product consider replacing it with a list you own. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | downloaded by the launcher at run time, not shipped | Unlicense | Not bundled. See the legal note in `docs/BUSINESS.md` about downloading YouTube content. |
| [FFmpeg](https://ffmpeg.org) builds (BtbN / yt-dlp) | downloaded by the launcher at run time, not shipped | GPL | Not bundled, so GPL does not apply to your code. Do not ship it inside your installer without taking the GPL terms. |
| Google Translate web endpoint | `extension/background.js` | **not licensed for apps** | Unofficial. Do not use in a paid product — use Gemini (or Cloud Translation) instead. |


## Wiktionary
Translations shown in the tooltip are read from English Wiktionary (https://en.wiktionary.org) through its public API and cached locally. Wiktionary content is available under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) and the GNU Free Documentation License; authors are listed in each entry's page history.
