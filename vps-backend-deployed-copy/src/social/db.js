// ===================== Друзья и чаты: схема SQLite и общие хелперы =====================
// Таблицы создаются при старте сервера (CREATE ... IF NOT EXISTS), поэтому отдельной миграции
// на VPS запускать не нужно. Время в этих таблицах — миллисекунды Unix (INTEGER), а не
// DATETIME-строки, как у rooms/users: клиенту так проще сравнивать и сортировать.

export const MESSAGE_MAX_LENGTH = 4000
export const PAGE_SIZE = 50

export function initSocialSchema(db) {
  // Пара пользователей хранится одной строкой: user_a < user_b. requested_by — кто отправил
  // заявку (для pending) или кто заблокировал (для blocked).
  db.exec(`CREATE TABLE IF NOT EXISTS friendships (
    user_a INTEGER NOT NULL,
    user_b INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
    requested_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b)')

  // dm_key = "меньший_id:больший_id" — у пары пользователей ровно одна личка
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'dm' CHECK (type IN ('dm', 'group')),
    title TEXT,
    dm_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    last_message_id INTEGER,
    last_message_at INTEGER
  )`)

  // last_read_id — последнее прочитанное сообщение: непрочитанные = всё, что после него.
  // hidden — личка «закрыта» в списке слева (как крестик в Дискорде); новое сообщение её возвращает.
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id)')

  // kind: text — обычное сообщение, call — карточка звонка (meta: roomCode, status),
  // system — служебная строка. client_id — метка клиента для «мгновенной» отправки:
  // по ней клиент узнаёт своё сообщение, пришедшее по SSE, и не рисует его дважды.
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'call', 'system')),
    body TEXT NOT NULL DEFAULT '',
    meta TEXT,
    reply_to INTEGER,
    client_id TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
  )`)
  // История листается по (чат, id): и «последние 50», и «50 до такого-то» идут по индексу
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)')
}

// Публичный вид пользователя — без хешей и прочего
export function publicUser(row) {
  if (!row) return null
  return { id: Number(row.id), username: row.username, displayName: row.display_name || row.displayName || row.username }
}

export function getUserById(db, id) {
  return publicUser(db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(id))
}

export function pairKey(a, b) {
  const x = Number(a)
  const y = Number(b)
  return x < y ? [x, y] : [y, x]
}

export function toInt(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

// ---- Ограничение частоты: скользящее окно в памяти процесса ----
// Сервер один (PM2, fork), поэтому общий Map в памяти — достаточно. Ключ — строка вида
// "msg:42"; limit событий за windowMs. Возвращает true, если действие разрешено.
const buckets = new Map()
export function rateLimit(key, limit, windowMs) {
  const now = Date.now()
  let list = buckets.get(key)
  if (!list) { list = []; buckets.set(key, list) }
  while (list.length && list[0] <= now - windowMs) list.shift()
  if (list.length >= limit) return false
  list.push(now)
  return true
}
// Раз в 10 минут выкидываем пустые окна, чтобы Map не рос бесконечно
setInterval(() => {
  const now = Date.now()
  for (const [key, list] of buckets) {
    if (!list.length || list[list.length - 1] < now - 10 * 60 * 1000) buckets.delete(key)
  }
}, 10 * 60 * 1000).unref()
