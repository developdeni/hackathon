import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="ru">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, shrink-to-fit=no, viewport-fit=cover"
        />
        <title>Tanap AI — Мобильный терминал агронома</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: customWebStyles }} />
        <script dangerouslySetInnerHTML={{ __html: telegramMiniAppBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const customWebStyles = `
html, body, #root {
  height: 100%;
  background-color: #EFEFF4;
}
html, body {
  /* Disable browser gesture zoom / double-tap zoom and the 300ms tap delay */
  touch-action: manipulation;
}
body {
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;
}
* {
  -webkit-tap-highlight-color: transparent;
}
/* Allow text selection only inside real inputs */
input, textarea {
  user-select: text;
  -webkit-user-select: text;
}
[role="button"]:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid #1F7A4D;
  outline-offset: 2px;
}
`;

// Runs on the raw HTML (web / Telegram Mini App only — never bundled into native).
const telegramMiniAppBootstrap = `
(function () {
  try {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
      try {
        tg.setHeaderColor && tg.setHeaderColor('#FFFFFF');
        tg.setBackgroundColor && tg.setBackgroundColor('#EFEFF4');
      } catch (e) {}
    }
  } catch (e) {}

  // Block pinch-zoom (iOS Safari / WKWebView ignore user-scalable=no).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
  });
  // Block multi-touch pinch.
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  // Block double-tap-to-zoom.
  var lastTouchEnd = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 320) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  // Block ctrl/cmd + wheel zoom on desktop.
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, { passive: false });
})();
`;
