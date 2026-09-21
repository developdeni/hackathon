// Post-processes the Expo web export (SPA `output`) for the Telegram Mini App and
// copies it into the FastAPI static dir. `+html.tsx` is ignored for SPA output,
// so the Mini App head (zoom lock, Telegram SDK, gesture blocking) is injected here.
//
// Run automatically by `npm run build:tma`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const DIST = path.join(MOBILE, 'dist');
const TARGET = path.resolve(MOBILE, '..', 'backend', 'app', 'static', 'dist');

const INJECT = `    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style id="tanap-tma-reset">
      html, body, #root { background-color: #EFEFF4; }
      html, body { touch-action: manipulation; }
      body {
        overflow: hidden;
        -webkit-user-select: none; user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
        overscroll-behavior: none;
      }
      * { -webkit-tap-highlight-color: transparent; }
      input, textarea { -webkit-user-select: text; user-select: text; }
      [role="button"]:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #1F7A4D; outline-offset: 2px; }
    </style>
    <script>
    (function () {
      try {
        var tg = window.Telegram && window.Telegram.WebApp;
        if (tg) {
          tg.ready(); tg.expand();
          if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
          try { tg.setHeaderColor && tg.setHeaderColor('#FFFFFF'); tg.setBackgroundColor && tg.setBackgroundColor('#EFEFF4'); } catch (e) {}
        }
      } catch (e) {}
      ['gesturestart','gesturechange','gestureend'].forEach(function (evt) {
        document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
      });
      document.addEventListener('touchmove', function (e) {
        if (e.touches && e.touches.length > 1) e.preventDefault();
      }, { passive: false });
      var lastTouchEnd = 0;
      document.addEventListener('touchend', function (e) {
        var now = Date.now();
        if (now - lastTouchEnd <= 320) e.preventDefault();
        lastTouchEnd = now;
      }, { passive: false });
      document.addEventListener('wheel', function (e) {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
      }, { passive: false });
    })();
    </script>
`;

async function main() {
  const indexPath = path.join(DIST, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');

  html = html.replace(
    /<meta name="viewport"[^>]*>/,
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, shrink-to-fit=no, viewport-fit=cover" />',
  );
  html = html.replace('<html lang="en">', '<html lang="ru">');

  if (!html.includes('tanap-tma-reset')) {
    html = html.replace('</head>', `${INJECT}  </head>`);
  }
  await fs.writeFile(indexPath, html);

  // Sync dist -> backend static dir.
  await fs.rm(TARGET, { recursive: true, force: true });
  await fs.cp(DIST, TARGET, { recursive: true });

  console.log('[inject-tma] done ->', TARGET);
}

main().catch((err) => {
  console.error('[inject-tma] failed:', err);
  process.exit(1);
});
