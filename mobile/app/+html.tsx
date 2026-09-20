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
          content="width=device-width, initial-scale=1, shrink-to-fit=no, user-scalable=no, viewport-fit=cover"
        />
        <title>Tanap AI — Мобильный терминал агронома</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: customWebStyles }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const customWebStyles = `
html, body, #root {
  height: 100%;
  background-color: #07080B;
}
body {
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
`;
