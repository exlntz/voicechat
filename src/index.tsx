import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { renderer } from './renderer'

type Bindings = {
  LIVEKIT_URL: string        // wss://livekit.185.199.199.114.nip.io
  LIVEKIT_HTTP_URL: string   // https://livekit.185.199.199.114.nip.io
  LIVEKIT_API_KEY: string
  LIVEKIT_API_SECRET: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())
app.use(renderer)

// ---------- Constants (business rules) ----------
const MAX_PARTICIPANTS = 5
const MAX_SCREEN_SHARES = 2 // одновременных демонстраций экрана в комнате

// ---------- Helpers ----------
function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length]
  return out
}

function sanitizeName(input: string, fallbackPrefix: string) {
  // См. подробное объяснение в vps-backend-deployed-copy/src/server.js - \w матчит только ASCII,
  // кириллица без явного разрешения диапазона вырезалась целиком ("баг: русские ники не отображаются").
  const cleaned = (input || '').trim().slice(0, 40).replace(/[^\w\u0400-\u04FF\u00C0-\u017F\- ]/g, '')
  return cleaned || `${fallbackPrefix}-${randomId(4)}`
}

// ---------- Ensure schema exists (D1) ----------
async function ensureSchema(db: D1Database) {
  // db.exec() в D1 разбивает запрос по символу новой строки, поэтому весь statement должен быть в одну строку
  await db.exec('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_active DATETIME DEFAULT CURRENT_TIMESTAMP)')
}

// ---------- API: create a new room ----------
app.post('/api/rooms', async (c) => {
  const { env } = c
  await ensureSchema(env.DB)

  const code = randomId(6)
  await env.DB.prepare('INSERT INTO rooms (code) VALUES (?)').bind(code).run()

  return c.json({ roomCode: code })
})

// ---------- API: join a room (creates it if it doesn't exist), returns LiveKit token ----------
app.post('/api/join', async (c) => {
  const { env } = c
  await ensureSchema(env.DB)

  const body = await c.req.json<{ roomCode?: string; displayName?: string }>().catch(() => ({}))
  let roomCode = (body.roomCode || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const displayName = sanitizeName(body.displayName || '', 'Гость')

  if (!roomCode) {
    roomCode = randomId(6)
  }

  // Проверка лимита участников через LiveKit RoomService (источник правды - сам SFU)
  const svc = new RoomServiceClient(env.LIVEKIT_HTTP_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)

  let currentCount = 0
  try {
    const participants = await svc.listParticipants(roomCode)
    currentCount = participants.length
  } catch {
    // комнаты еще нет на сервере - это нормально, будет 0 участников
    currentCount = 0
  }

  if (currentCount >= MAX_PARTICIPANTS) {
    return c.json({ error: 'room_full', message: `В комнате уже максимум участников (${MAX_PARTICIPANTS})` }, 403)
  }

  // Регистрируем/обновляем комнату в D1 (для истории/списка, не критично для работы звонка)
  await env.DB.prepare(
    'INSERT INTO rooms (code) VALUES (?) ON CONFLICT(code) DO UPDATE SET last_active = CURRENT_TIMESTAMP'
  ).bind(roomCode).run()

  const identity = `${randomId(6)}`

  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
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
    // Разрешенные источники публикации: камера, микрофон, экран (без ограничения по количеству треков здесь -
    // ограничение на MAX_SCREEN_SHARES контролируется клиентом + серверным webhook/периодической проверкой)
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
    url: env.LIVEKIT_URL,
    roomCode,
    identity,
    displayName,
    maxParticipants: MAX_PARTICIPANTS,
    maxScreenShares: MAX_SCREEN_SHARES
  })
})

// ---------- API: check current screen-share count in a room (клиент вызывает перед стартом демки) ----------
// ВАЖНО ("баг: 4 демонстрации экрана копятся, некорректно завершаются") - см. подробное объяснение
// в vps-backend-deployed-copy/src/server.js: считаем УНИКАЛЬНЫХ УЧАСТНИКОВ, а не треки, т.к. при
// reconnect по нестабильной сети сервер может временно видеть старый+новый трек одного участника.
app.get('/api/rooms/:code/screen-shares', async (c) => {
  const { env } = c
  const code = c.req.param('code')
  const svc = new RoomServiceClient(env.LIVEKIT_HTTP_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)

  try {
    const participants = await svc.listParticipants(code)
    const sharingIdentities = new Set<string>()
    for (const p of participants) {
      for (const t of p.tracks) {
        // TrackSource.SCREEN_SHARE === 3 в protobuf enum
        if (t.source === 3 && !t.muted) { sharingIdentities.add(p.identity); break }
      }
    }
    const screenShareCount = sharingIdentities.size
    return c.json({
      current: screenShareCount,
      max: MAX_SCREEN_SHARES,
      available: Math.max(0, MAX_SCREEN_SHARES - screenShareCount)
    })
  } catch {
    return c.json({ current: 0, max: MAX_SCREEN_SHARES, available: MAX_SCREEN_SHARES })
  }
})

// ---------- API: force-cleanup stale screen-share publications of a participant (см. app.js) ----------
app.post('/api/rooms/:code/screen-shares/reconcile', async (c) => {
  const { env } = c
  const code = c.req.param('code')
  const body = await c.req.json().catch(() => ({} as any))
  const identity = (body.identity || '').trim()
  const keepTrackSid = (body.keepTrackSid || '').trim()
  if (!identity) return c.json({ error: 'bad_request' }, 400)
  const svc = new RoomServiceClient(env.LIVEKIT_HTTP_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
  try {
    const participants = await svc.listParticipants(code)
    const me = participants.find((p) => p.identity === identity)
    if (!me) return c.json({ success: true, cleaned: 0 })
    let cleaned = 0
    for (const t of me.tracks) {
      const isScreen = t.source === 3 || t.source === 4 // SCREEN_SHARE=3, SCREEN_SHARE_AUDIO=4
      if (isScreen && t.sid !== keepTrackSid && !t.muted) {
        try { await svc.mutePublishedTrack(code, identity, t.sid, true); cleaned++ } catch {}
      }
    }
    return c.json({ success: true, cleaned })
  } catch {
    return c.json({ error: 'reconcile_failed' }, 500)
  }
})

// ---------- API: room info (participant count) ----------
app.get('/api/rooms/:code', async (c) => {
  const { env } = c
  const code = c.req.param('code')
  const svc = new RoomServiceClient(env.LIVEKIT_HTTP_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)

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

// ---------- Frontend ----------
app.get('/', (c) => {
  return c.render(<div id="app-root"></div>, { title: 'Звонки — Главная' })
})

app.get('/room/:code', (c) => {
  return c.render(<div id="app-root"></div>, { title: 'Звонки — Комната' })
})

export default app
