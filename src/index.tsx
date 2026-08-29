import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { renderer } from './renderer'

type Bindings = {
  LIVEKIT_URL: string        // wss://livekit.185.199.199.114.nip.io
  LIVEKIT_HTTP_URL: string   // https://livekit.185.199.199.114.nip.io
  LIVEKIT_API_KEY: string
  LIVEKIT_API_SECRET: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings; Variables: { user: { id: number; username: string } } }>()

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
  await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, display_name TEXT, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)')
  // Миграция для баз созданных до появления display_name - D1 не поддерживает "ADD COLUMN IF NOT EXISTS", поэтому просто глушим ошибку "duplicate column", если колонка уже есть
  try { await db.exec('ALTER TABLE users ADD COLUMN display_name TEXT') } catch {}
  await db.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL)')
}

// ---------- Система пользователей (регистрация/вход) - см. подробное объяснение в
// vps-backend-deployed-copy/src/server.js. Здесь то же самое, но на D1 (вместо node:sqlite) и
// Web Crypto (PBKDF2, доступен нативно в Cloudflare Workers runtime, в отличие от node:crypto scrypt). ----------
const SESSION_COOKIE = 'zvonki_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 дней
// См. подробное объяснение в vps-backend-deployed-copy/src/server.js: username - только ASCII (для входа/будущего
// добавления в друзья), display_name - любой язык (показывается везде в интерфейсе).
const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/
const DISPLAY_NAME_RE = /^[\p{L}\p{N}_\- ]{1,40}$/u
const PBKDF2_ITERATIONS = 100_000

function bufToHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBuf(hex: string) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

async function hashPassword(password: string) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = bufToHex(saltBytes.buffer)
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256)
  return { hash: bufToHex(bits), salt }
}

async function verifyPassword(password: string, hash: string, salt: string) {
  const saltBytes = hexToBuf(salt)
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256)
  const testHex = bufToHex(bits)
  // Сравнение строк одинаковой длины через === в JS не является строго constant-time, но для
  // hex-представления криптографического хэша (не пароля напрямую) риск timing-атаки признан
  // практически незначимым в большинстве угроз-моделей; здесь это осознанный трейд-офф ради
  // простоты в среде Workers, где node:crypto.timingSafeEqual недоступен.
  return testHex === hash
}

async function createSession(db: D1Database, userId: number) {
  const token = bufToHex(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expiresAt).run()
  return token
}

async function getUserByToken(db: D1Database, token: string | undefined) {
  if (!token) return null
  const row = await db.prepare(
    'SELECT u.id as id, u.username as username, u.display_name as displayName, s.expires_at as expiresAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first<{ id: number; username: string; displayName: string | null; expiresAt: string }>()
  if (!row) return null
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
    return null
  }
  return { id: row.id, username: row.username, displayName: row.displayName || row.username }
}

function setSessionCookie(c: any, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  })
}

// Требуем авторизацию на всех /api/* маршрутах, КРОМЕ /api/auth/*
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/')) return next()
  await ensureSchema(c.env.DB)
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserByToken(c.env.DB, token)
  if (!user) return c.json({ error: 'unauthenticated', message: 'Требуется авторизация' }, 401)
  c.set('user', user)
  await next()
})

// ---------- API: регистрация ----------
app.post('/api/auth/register', async (c) => {
  const { env } = c
  await ensureSchema(env.DB)
  const body = await c.req.json<{ username?: string; displayName?: string; password?: string }>().catch(() => ({}))
  const username = (body.username || '').trim()
  const displayName = (body.displayName || '').trim() || username
  const password = typeof body.password === 'string' ? body.password : ''

  if (!USERNAME_RE.test(username)) {
    return c.json({ error: 'invalid_username', message: 'Жюзернейм: 3-24 символа, только англ. буквы/цифры/_/-' }, 400)
  }
  if (!DISPLAY_NAME_RE.test(displayName)) {
    return c.json({ error: 'invalid_display_name', message: 'Имя: 1-40 символов (буквы любого языка, цифры, пробел, _/-)' }, 400)
  }
  if (password.length < 6 || password.length > 100) {
    return c.json({ error: 'invalid_password', message: 'Пароль должен быть от 6 до 100 символов' }, 400)
  }

  const usernameLower = username.toLowerCase()
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username_lower = ?').bind(usernameLower).first()
  if (existing) {
    return c.json({ error: 'username_taken', message: 'Этот юзернейм уже занят' }, 409)
  }

  const { hash, salt } = await hashPassword(password)
  let userId: number
  try {
    const info = await env.DB.prepare(
      'INSERT INTO users (username, username_lower, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)'
    ).bind(username, usernameLower, displayName, hash, salt).run()
    userId = info.meta.last_row_id as number
  } catch {
    return c.json({ error: 'username_taken', message: 'Этот юзернейм уже занят' }, 409)
  }

  const token = await createSession(env.DB, userId)
  setSessionCookie(c, token)
  return c.json({ user: { id: userId, username, displayName } })
})

// ---------- API: вход ----------
app.post('/api/auth/login', async (c) => {
  const { env } = c
  await ensureSchema(env.DB)
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}))
  const username = (body.username || '').trim()
  const password = typeof body.password === 'string' ? body.password : ''

  if (!username || !password) {
    return c.json({ error: 'invalid_credentials', message: 'Введите логин и пароль' }, 400)
  }

  const usernameLower = username.toLowerCase()
  const row = await env.DB.prepare('SELECT id, username, display_name, password_hash, password_salt FROM users WHERE username_lower = ?')
    .bind(usernameLower).first<{ id: number; username: string; display_name: string | null; password_hash: string; password_salt: string }>()
  if (!row) {
    return c.json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }, 401)
  }

  const ok = await verifyPassword(password, row.password_hash, row.password_salt)
  if (!ok) {
    return c.json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }, 401)
  }

  const token = await createSession(env.DB, row.id)
  setSessionCookie(c, token)
  return c.json({ user: { id: row.id, username: row.username, displayName: row.display_name || row.username } })
})

// ---------- API: выход ----------
app.post('/api/auth/logout', async (c) => {
  const { env } = c
  await ensureSchema(env.DB)
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    try { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run() } catch {}
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ success: true })
})

// ---------- API: текущий пользователь ----------
app.get('/api/auth/me', async (c) => {
  const { env } = c
  await ensureSchema(env.DB)
  const token = getCookie(c, SESSION_COOKIE)
  const user = await getUserByToken(env.DB, token)
  if (!user) return c.json({ error: 'unauthenticated' }, 401)
  return c.json({ user })
})

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

  const body = await c.req.json<{ roomCode?: string }>().catch(() => ({}))
  let roomCode = (body.roomCode || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  // Имя участника берём из авторизованной сессии (см. middleware выше), а не из тела запроса.
  // Показываем displayName (может быть на любом языке), а не технический username.
  const authUser = c.get('user')
  const displayName = sanitizeName((authUser as any)?.displayName || authUser?.username || '', 'Гость')

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
