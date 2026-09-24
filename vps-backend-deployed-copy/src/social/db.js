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

  // Профиль: когда пользователь последний раз был в сети и показывать ли это друзьям.
  // ALTER падает, если колонка уже есть, — это нормально при повторном запуске.
  try { db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER') } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN show_last_seen INTEGER NOT NULL DEFAULT 1') } catch {}

  // Аватарка и фон профиля (картинка, GIF или видео) — ссылки на files.id
  try { db.exec('ALTER TABLE users ADD COLUMN avatar_file TEXT') } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN banner_file TEXT') } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN banner_kind TEXT') } catch {}

  // Настройки чата для себя: закреплён в списке (время закрепления), история очищена до id,
  // обои (id готовых или file:<id> своей картинки)
  try { db.exec('ALTER TABLE conversation_members ADD COLUMN pinned_at INTEGER') } catch {}
  try { db.exec('ALTER TABLE conversation_members ADD COLUMN cleared_before INTEGER NOT NULL DEFAULT 0') } catch {}
  try { db.exec('ALTER TABLE conversation_members ADD COLUMN wallpaper TEXT') } catch {}
  // Пересланное: {userId, name} автора оригинала
  try { db.exec('ALTER TABLE messages ADD COLUMN forward TEXT') } catch {}

  // Загруженные файлы. purpose: attachment | avatar | banner | wallpaper;
  // kind: image | video | audio | voice | file. Файл лежит на диске под своим id.
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  )`)
  // Вложения сообщения (одно сообщение — до 10 файлов; при пересылке файл не копируется)
  db.exec(`CREATE TABLE IF NOT EXISTS message_files (
    message_id INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, file_id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files(file_id)')
  // «Удалить у меня»: сообщение остаётся у собеседника, но не показывается этому пользователю
  db.exec(`CREATE TABLE IF NOT EXISTS message_hidden (
    user_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  )`)
  // Закреплённые сообщения чата (общие для обоих собеседников)
  db.exec(`CREATE TABLE IF NOT EXISTS pins (
    conversation_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, message_id)
  )`)

  fixLegacyUsernames(db)
}

// Юзернейм начинается с буквы. Старые, начинающиеся с цифры, «_» или «-», получают приставку
// user_ (при совпадении — ещё и номер). Выполняется при каждом старте, но меняет только такие.
export const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,23}$/
export const USERNAME_HINT = '3–24 символа: английские буквы, цифры, _ и -, первая — буква'
function fixLegacyUsernames(db) {
  // Старое имя запоминаем: по нему по-прежнему можно войти
  try { db.exec('ALTER TABLE users ADD COLUMN legacy_username_lower TEXT') } catch {}
  const bad = db.prepare("SELECT id, username FROM users WHERE substr(username, 1, 1) NOT GLOB '[A-Za-z]'").all()
  if (!bad.length) return
  const exists = db.prepare('SELECT 1 FROM users WHERE username_lower = ?')
  const update = db.prepare('UPDATE users SET username = ?, username_lower = ?, legacy_username_lower = ? WHERE id = ?')
  for (const row of bad) {
    let next = 'user_' + row.username
    let n = 1
    while (exists.get(next.toLowerCase())) next = `user_${row.username}_${++n}`
    update.run(next, next.toLowerCase(), String(row.username).toLowerCase(), row.id)
    console.log(`[social] юзернейм ${row.username} -> ${next}`)
  }
}

// Публичный вид пользователя — без хешей и прочего
export const USER_COLS = 'id, username, display_name, avatar_file, banner_file, banner_kind'
export function fileUrl(id) {
  return id ? `/api/files/${id}` : null
}
export function publicUser(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name || row.displayName || row.username,
    avatarUrl: fileUrl(row.avatar_file),
    bannerUrl: fileUrl(row.banner_file),
    bannerKind: row.banner_file ? (row.banner_kind || 'image') : null
  }
}

let userStmt = null
export function getUserById(db, id) {
  if (!userStmt) userStmt = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`)
  return publicUser(userStmt.get(id))
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
