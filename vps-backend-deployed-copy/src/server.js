// ===================== Звонки: standalone Node.js backend (без Cloudflare) =====================
// Запускается напрямую на VPS через PM2. Хранилище — встроенный node:sqlite (файл на диске).
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- Конфигурация из окружения ----------
const PORT = Number(process.env.PORT || 3001)
const LIVEKIT_URL = process.env.LIVEKIT_URL // wss://livekit.185.199.199.114.nip.io
const LIVEKIT_HTTP_URL = process.env.LIVEKIT_HTTP_URL // https://livekit.185.199.199.114.nip.io
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'rooms.sqlite')

if (!LIVEKIT_URL || !LIVEKIT_HTTP_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Missing required env vars: LIVEKIT_URL, LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET')
  process.exit(1)
}

// ---------- SQLite (встроенный в Node.js, без нативных зависимостей) ----------
const db = new DatabaseSync(DB_PATH)
db.exec('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_active DATETIME DEFAULT CURRENT_TIMESTAMP)')

const app = new Hono()

app.use('/api/*', cors())
// Статика фронтенда (HTML отдаём вручную ниже, а /static/* — файлы напрямую)
app.use('/static/*', serveStatic({ root: join(__dirname, '..', 'public') }))

// ---------- Константы бизнес-правил ----------
const MAX_PARTICIPANTS = 5
const MAX_SCREEN_SHARES = 2

// ---------- Хелперы ----------
function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length]
  return out
}

function sanitizeName(input, fallbackPrefix) {
  const cleaned = (input || '').trim().slice(0, 40).replace(/[^\w\- ]/g, '')
  return cleaned || `${fallbackPrefix}-${randomId(4)}`
}

const svc = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

// ---------- API: создать новую комнату ----------
app.post('/api/rooms', (c) => {
  const code = randomId(6)
  db.prepare('INSERT INTO rooms (code) VALUES (?)').run(code)
  return c.json({ roomCode: code })
})

// ---------- API: войти в комнату (создаёт если не существует), возвращает LiveKit токен ----------
app.post('/api/join', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let roomCode = (body.roomCode || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const displayName = sanitizeName(body.displayName || '', 'Гость')

  if (!roomCode) roomCode = randomId(6)

  let currentCount = 0
  try {
    const participants = await svc.listParticipants(roomCode)
    currentCount = participants.length
  } catch {
    currentCount = 0
  }

  if (currentCount >= MAX_PARTICIPANTS) {
    return c.json({ error: 'room_full', message: `В комнате уже максимум участников (${MAX_PARTICIPANTS})` }, 403)
  }

  db.prepare(
    'INSERT INTO rooms (code) VALUES (?) ON CONFLICT(code) DO UPDATE SET last_active = CURRENT_TIMESTAMP'
  ).run(roomCode)

  const identity = randomId(6)

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: displayName,
    ttl: '12h'
  })

  at.addGrant({
    room: roomCode,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: [
      TrackSource.CAMERA,
      TrackSource.MICROPHONE,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO
    ]
  })

  const token = await at.toJwt()

  return c.json({
    token,
    url: LIVEKIT_URL,
    roomCode,
    identity,
    displayName,
    maxParticipants: MAX_PARTICIPANTS,
    maxScreenShares: MAX_SCREEN_SHARES
  })
})

// ---------- API: текущее число демонстраций экрана в комнате ----------
app.get('/api/rooms/:code/screen-shares', async (c) => {
  const code = c.req.param('code')
  try {
    const participants = await svc.listParticipants(code)
    let screenShareCount = 0
    for (const p of participants) {
      for (const t of p.tracks) {
        if (t.source === 3 && !t.muted) screenShareCount++ // TrackSource.SCREEN_SHARE === 3
      }
    }
    return c.json({
      current: screenShareCount,
      max: MAX_SCREEN_SHARES,
      available: Math.max(0, MAX_SCREEN_SHARES - screenShareCount)
    })
  } catch {
    return c.json({ current: 0, max: MAX_SCREEN_SHARES, available: MAX_SCREEN_SHARES })
  }
})

// ---------- API: информация о комнате ----------
app.get('/api/rooms/:code', async (c) => {
  const code = c.req.param('code')
  try {
    const participants = await svc.listParticipants(code)
    return c.json({
      exists: true,
      participantCount: participants.length,
      maxParticipants: MAX_PARTICIPANTS,
      participants: participants.map((p) => ({ identity: p.identity, name: p.name }))
    })
  } catch {
    return c.json({ exists: false, participantCount: 0, maxParticipants: MAX_PARTICIPANTS, participants: [] })
  }
})

// ---------- HTML страницы ----------
function renderPage(title) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${title}</title><link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/><script src="https://cdn.jsdelivr.net/npm/livekit-client@2.22.1/dist/livekit-client.umd.min.js"></script><link href="/static/style.css" rel="stylesheet"/></head><body><div id="app-root"></div><script src="/static/app.js"></script></body></html>`
}

app.get('/', (c) => c.html(renderPage('Звонки — Главная')))
app.get('/room/:code', (c) => c.html(renderPage('Звонки — Комната')))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Zvonki backend listening on http://127.0.0.1:${info.port}`)
})
