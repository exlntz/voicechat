import { jsxRenderer } from 'hono/jsx-renderer'

export const renderer = jsxRenderer(({ children, title }) => {
  return (
    <html lang="ru">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title || 'Звонки'}</title>
        {/* Веб-шрифты не грузим: типографика собрана на локальных гарнитурах
            (Impact / Constantia / Consolas и их аналоги на macOS и Linux) —
            см. --dsp / --srf / --mno в style.css. Это и быстрее, и без внешних зависимостей. */}
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#0f0d0b" />
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
        <script src="https://cdn.jsdelivr.net/npm/livekit-client@2.22.1/dist/livekit-client.umd.min.js"></script>
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body>
        {children}
        <script src="/static/app.js"></script>
        {/* Слой микровзаимодействий (кнопки/поля/курсор/часы) — навешивается поверх готового DOM */}
        <script src="/static/anker.js"></script>
      </body>
    </html>
  )
})
