import { jsxRenderer } from 'hono/jsx-renderer'

export const renderer = jsxRenderer(({ children, title }) => {
  return (
    <html lang="ru">
      <head>
        <meta charset="UTF-8" />
        {/* viewport-fit=cover — интерфейс на всю высоту экрана iPhone,
            безопасные зоны уже учтены в style.css через env(safe-area-inset-*) */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <title>{title || 'Voice Lobby'}</title>
        {/* Внешние веб-шрифты не грузим: текст — системные --font / --mono,
            заголовки — --font-display из typography.css (без CDN). */}
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#0f1115" />
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
        <script src="https://cdn.jsdelivr.net/npm/livekit-client@2.22.1/dist/livekit-client.umd.min.js"></script>
        <link href="/static/style.css" rel="stylesheet" />
        {/* Заголовочная гарнитура */}
        <link href="/static/typography.css" rel="stylesheet" />
        {/* Высота окна и переполнение: подключается после style.css */}
        <link href="/static/layout-fit.css" rel="stylesheet" />
      </head>
      <body>
        {children}
        {/* Качество демонстрации экрана: строго ДО app.js, чтобы обёртка над
            getDisplayMedia и патч публикации LiveKit были готовы к первому запуску */}
        <script src="/static/media-quality.js"></script>
        <script src="/static/app.js"></script>
        {/* Слой микровзаимодействий (кнопки/поля/курсор) — навешивается поверх готового DOM */}
        <script src="/static/anker.js"></script>
        {/* Раскрытие плитки на весь экран — FLIP из текущего положения */}
        <script src="/static/fullscreen-flip.js"></script>
        {/* Зеркало своего превью только для фронтальной камеры */}
        <script src="/static/camera-mirror.js"></script>
      </body>
    </html>
  )
})
