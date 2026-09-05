// ===================== Звонки: standalone Node.js backend (без Cloudflare) =====================
// Запускается напрямую на VPS через PM2. Хранилище — встроенный node:sqlite (файл на диске).
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const scrypt = promisify(scryptCb)

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
// Миграция: добавляем колонки создателя комнаты (может уже существовать в старой БД - игнорируем ошибку)
try { db.exec('ALTER TABLE rooms ADD COLUMN creator_identity TEXT') } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN host_secret TEXT') } catch {}

// ---------- Система пользователей (регистрация/вход) ----------
// Простая собственная реализация без внешних зависимостей: пароли хешируются scrypt'ом (встроен в
// node:crypto) со случайной солью на каждого пользователя, сессии - случайный токен в httpOnly-cookie,
// сама сессия хранится в SQLite (а не JWT), чтобы можно было мгновенно \"убить\" сессию через logout.
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`)
// Миграция: отображаемое имя (может быть на любом языке, включая кириллицу) отдельно от
// юзернейма (который используется для входа/будущего добавления в друзья и должен быть
// только латиница+цифры+_/-). У пользователей, зарегистрированных до этого поля, display_name
// будет NULL - в таком случае на бэкенде подставляем username как фолбэк (см. ниже).
try { db.exec('ALTER TABLE users ADD COLUMN display_name TEXT') } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
)`)

const SESSION_COOKIE = 'zvonki_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 дней
// Юзернейм - технический идентификатор для входа (и в будущем - добавления в друзья), поэтому
// строго ASCII: латинские буквы, цифры, _ и -. Отображаемое имя (display_name) - отдельное поле,
// его пользователь видит везде в интерфейсе (тайлы участников, юзербар), и оно может быть на
// любом языке, включая кириллицу (та же логика разрешённых символов, что раньше была у логина).
const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/
const DISPLAY_NAME_RE = /^[\p{L}\p{N}_\- ]{1,40}$/u

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = (await scrypt(password, salt, 64)).toString('hex')
  return { hash, salt }
}

async function verifyPassword(password, hash, salt) {
  const hashBuf = Buffer.from(hash, 'hex')
  const testBuf = await scrypt(password, salt, 64)
  if (hashBuf.length !== testBuf.length) return false
  return timingSafeEqual(hashBuf, testBuf)
}

function createSession(userId) {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt)
  return token
}

function getUserByToken(token) {
  if (!token) return null
  const row = db.prepare(
    'SELECT u.id as id, u.username as username, u.display_name as displayName, s.expires_at as expiresAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token)
  if (!row) return null
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }
  // У пользователей, зарегистрированных до появления display_name, поле будет NULL - подставляем username
  return { id: row.id, username: row.username, displayName: row.displayName || row.username }
}

function setSessionCookie(c, token) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  })
}

// Требует авторизации - навешивается на все /api/* маршруты, кроме /api/auth/*
async function requireAuth(c, next) {
  const token = getCookie(c, SESSION_COOKIE)
  const user = getUserByToken(token)
  if (!user) return c.json({ error: 'unauthenticated', message: 'Требуется авторизация' }, 401)
  c.set('user', user)
  await next()
}

const app = new Hono()

app.use('/api/*', cors())
// Все /api/* маршруты требуют авторизации, КРОМЕ /api/auth/* (иначе войти было бы невозможно)
app.use('/api/*', (c, next) => {
  if (c.req.path.startsWith('/api/auth/')) return next()
  return requireAuth(c, next)
})
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
  // ВАЖНО (\"баг: русские ники не отображаются\"): \w в JS regex матчит ТОЛЬКО ASCII-буквы [A-Za-z0-9_],
  // поэтому старый /[^\w\- ]/g вырезал вообще все кириллические символы из имени - \"Иван\" превращался
  // в пустую строку и заменялся на \"Гость-XXXX\". Явно разрешаем диапазон кириллицы (а также латиницу
  // с диакритикой \u00C0-\u017F на всякий случай) в дополнение к \w.
  const cleaned = (input || '').trim().slice(0, 40).replace(/[^\w\u0400-\u04FF\u00C0-\u017F\- ]/g, '')
  return cleaned || `${fallbackPrefix}-${randomId(4)}`
}

const svc = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

// ---------- API: регистрация ----------
app.post('/api/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || '').trim()
  // displayName необязателен - если не передан (или пуст), используем username как отображаемое имя
  const displayName = (body.displayName || '').trim() || username
  const password = typeof body.password === 'string' ? body.password : ''

  if (!USERNAME_RE.test(username)) {
    return c.json({ error: 'invalid_username', message: 'Юзернейм: 3-24 символа, только англ. буквы/цифры/_/-' }, 400)
  }
  if (!DISPLAY_NAME_RE.test(displayName)) {
    return c.json({ error: 'invalid_display_name', message: 'Имя: 1-40 символов (буквы любого языка, цифры, пробел, _/-)' }, 400)
  }
  if (password.length < 6 || password.length > 100) {
    return c.json({ error: 'invalid_password', message: 'Пароль должен быть от 6 до 100 символов' }, 400)
  }

  const usernameLower = username.toLowerCase()
  const existing = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(usernameLower)
  if (existing) {
    return c.json({ error: 'username_taken', message: 'Этот юзернейм уже занят' }, 409)
  }

  const { hash, salt } = await hashPassword(password)
  let userId
  try {
    const info = db.prepare(
      'INSERT INTO users (username, username_lower, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)'
    ).run(username, usernameLower, displayName, hash, salt)
    userId = info.lastInsertRowid
  } catch {
    return c.json({ error: 'username_taken', message: 'Этот юзернейм уже занят' }, 409)
  }

  const token = createSession(userId)
  setSessionCookie(c, token)
  return c.json({ user: { id: userId, username, displayName } })
})

// ---------- API: вход ----------
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || '').trim()
  const password = typeof body.password === 'string' ? body.password : ''

  if (!username || !password) {
    return c.json({ error: 'invalid_credentials', message: 'Введите логин и пароль' }, 400)
  }

  const usernameLower = username.toLowerCase()
  const row = db.prepare('SELECT id, username, display_name as displayName, password_hash, password_salt FROM users WHERE username_lower = ?').get(usernameLower)
  if (!row) {
    return c.json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }, 401)
  }

  const ok = await verifyPassword(password, row.password_hash, row.password_salt)
  if (!ok) {
    return c.json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }, 401)
  }

  const token = createSession(row.id)
  setSessionCookie(c, token)
  return c.json({ user: { id: row.id, username: row.username, displayName: row.displayName || row.username } })
})

// ---------- API: выход ----------
app.post('/api/auth/logout', (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token) } catch {}
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ success: true })
})

// ---------- API: текущий пользователь (проверка авторизации на фронте) ----------
app.get('/api/auth/me', (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  const user = getUserByToken(token)
  if (!user) return c.json({ error: 'unauthenticated' }, 401)
  return c.json({ user })
})

// ---------- API: создать новую комнату ----------
app.post('/api/rooms', (c) => {
  const code = randomId(6)
  db.prepare('INSERT INTO rooms (code) VALUES (?)').run(code)
  return c.json({ roomCode: code })
})

// ---------- API: войти в комнату (создаёт если не существует), возвращает LiveKit токен ----------
// Создатель комнаты (первый, кто вошёл с этим кодом) получает роль хоста и секрет hostSecret,
// которым может управлять участниками (выгонять). Секрет хранится в БД и возвращается только хосту;
// при повторном входе с тем же hostSecret (например, после обновления страницы) права хоста подтверждаются.
app.post('/api/join', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let roomCode = (body.roomCode || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  // Имя участника берём из аккаунта авторизованного пользователя (requireAuth уже отработал
  // для всех /api/* кроме /api/auth/*), а не из тела запроса - раньше можно было представиться
  // произвольным именем, теперь имя жёстко привязано к аккаунту. Показываем displayName
  // (может быть на любом языке), а не технический username.
  const authUser = c.get('user')
  const displayName = sanitizeName(authUser?.displayName || authUser?.username || '', 'Гость')
  const providedHostSecret = typeof body.hostSecret === 'string' && body.hostSecret ? body.hostSecret : null

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

  const identity = randomId(6)
  const existingRoom = db.prepare('SELECT creator_identity, host_secret FROM rooms WHERE code = ?').get(roomCode)

  let isHost = false
  let hostSecret = null

  if (!existingRoom) {
    // Комнаты с таким кодом ещё не было - создающий её становится хостом
    hostSecret = randomId(20)
    isHost = true
    db.prepare('INSERT INTO rooms (code, creator_identity, host_secret) VALUES (?, ?, ?)').run(roomCode, identity, hostSecret)
  } else {
    db.prepare('UPDATE rooms SET last_active = CURRENT_TIMESTAMP WHERE code = ?').run(roomCode)
    if (providedHostSecret && existingRoom.host_secret && providedHostSecret === existingRoom.host_secret) {
      // Создатель переподключается (например, обновил страницу/переподключение) - подтверждаем права хоста
      isHost = true
      hostSecret = existingRoom.host_secret
      db.prepare('UPDATE rooms SET creator_identity = ? WHERE code = ?').run(identity, roomCode)
    }
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: displayName,
    ttl: '12h',
    metadata: JSON.stringify({ isHost })
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
    maxScreenShares: MAX_SCREEN_SHARES,
    isHost,
    hostSecret: isHost ? hostSecret : null
  })
})

// ---------- API: выгнать участника из комнаты (только для хоста-создателя) ----------
app.post('/api/rooms/:code/kick', async (c) => {
  const code = c.req.param('code')
  const body = await c.req.json().catch(() => ({}))
  const targetIdentity = (body.targetIdentity || '').trim()
  const hostSecret = typeof body.hostSecret === 'string' ? body.hostSecret : ''

  if (!targetIdentity || !hostSecret) {
    return c.json({ error: 'bad_request', message: 'targetIdentity и hostSecret обязательны' }, 400)
  }

  const room = db.prepare('SELECT host_secret FROM rooms WHERE code = ?').get(code)
  if (!room || !room.host_secret || room.host_secret !== hostSecret) {
    return c.json({ error: 'forbidden', message: 'Недостаточно прав для удаления участника' }, 403)
  }

  try {
    await svc.removeParticipant(code, targetIdentity)
    return c.json({ success: true })
  } catch (e) {
    return c.json({ error: 'remove_failed', message: 'Не удалось удалить участника' }, 500)
  }
})

// ---------- API: текущее число демонстраций экрана в комнате ----------
// ВАЖНО (\"баг: 4 демонстрации экрана копятся, некорректно завершаются\"): раньше здесь считались
// ТРЕКИ (t.source === SCREEN_SHARE), а не УЧАСТНИКИ. При нестабильной сети LiveKit-клиент делает
// full-reconnect (\"resuming RTC session\", видно в логах livekit по частым channel congestion) -
// на протяжении небольшого окна на сервере может существовать одновременно СТАРЫЙ трек демки
// (ещё не отменённый публикацией) и НОВЫЙ (уже переопубликованный при восстановлении соединения)
// от одного и того же участника. Подсчёт по трекам в этот момент даёт двойной (а при нескольких
// реконнектах - кратный) счёт, из-за чего лимит MAX_SCREEN_SHARES быстро \"забивается\" фантомными
// демками, которые физически никто не показывает, и /api/rooms/:code/screen-shares начинает
// отдавать available: 0 всем, хотя реально идёт 0-1 демка. Считаем по УНИКАЛЬНЫМ УЧАСТНИКАМ
// (Set по identity) - у одного человека не может быть больше одной \"живой\" демонстрации экрана
// с точки зрения бизнес-логики приложения, даже если временно существует 2 трека при reconnect.
app.get('/api/rooms/:code/screen-shares', async (c) => {
  const code = c.req.param('code')
  try {
    const participants = await svc.listParticipants(code)
    const sharingIdentities = new Set()
    for (const p of participants) {
      for (const t of p.tracks) {
        if (t.source === 3 && !t.muted) { sharingIdentities.add(p.identity); break } // TrackSource.SCREEN_SHARE === 3
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

// ---------- API: принудительно снять \"зависшие\" публикации демонстрации экрана участника ----------
// Вызывается клиентом (см. app.js) сразу после того, как ОН САМ успешно (пере)опубликовал свой
// screen-share трек - если у этого же участника (identity) на сервере остались от предыдущего
// (некорректно завершённого / оборванного по сети) сеанса демонстрации другие ScreenShare/
// ScreenShareAudio публикации с ДРУГИМ trackSid, они принудительно отписываются через
// RoomServiceClient.mutePublishedTrack + updateParticipant не поддерживают удаление чужого трека
// напрямую, поэтому используем самый надёжный API LiveKit для этого - removeParticipant есть,
// но выгонять самого себя не нужно; вместо этого мьютим неактуальные старые треки, чтобы серверный
// счётчик /screen-shares перестал их учитывать (t.muted проверяется в подсчёте выше).
app.post('/api/rooms/:code/screen-shares/reconcile', async (c) => {
  const code = c.req.param('code')
  const body = await c.req.json().catch(() => ({}))
  const identity = (body.identity || '').trim()
  const keepTrackSid = (body.keepTrackSid || '').trim()
  if (!identity) return c.json({ error: 'bad_request' }, 400)
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
  } catch (e) {
    return c.json({ error: 'reconcile_failed' }, 500)
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
  return `<!DOCTYPE html><html lang=\"ru\"><head><meta charset=\"UTF-8\"/><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover\"/><meta name=\"mobile-web-app-capable\" content=\"yes\"/><meta name=\"apple-mobile-web-app-capable\" content=\"yes\"/><meta name=\"theme-color\" content=\"#0a0a0f\"/><title>${title}</title><link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"/><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin/><link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\"/><link href=\"https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css\" rel=\"stylesheet\"/><script src=\"https://cdn.jsdelivr.net/npm/livekit-client@2.22.1/dist/livekit-client.umd.min.js\"></script><link href=\"/static/style.css\" rel=\"stylesheet\"/></head><body><div id=\"app-root\"></div><script src=\"/static/app.js\"></script><script src=\"/static/annotate.js\"></script></body></html>`
}

app.get('/', (c) => c.html(renderPage('Звонки — Главная')))
app.get('/room/:code', (c) => c.html(renderPage('Звонки — Комната')))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Zvonki backend listening on http://127.0.0.1:${info.port}`)
})
