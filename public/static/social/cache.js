// ===================== Кэш в IndexedDB: чат открывается мгновенно =====================
// Храним последние сообщения каждого чата и снимки списков (лички, друзья). При открытии чата
// сначала рисуем кэш, затем сверяемся с сервером. База своя у каждого пользователя
// (vl-social-<id>) и удаляется при выходе из аккаунта. Любая ошибка IndexedDB (приватный
// режим, квота) просто выключает кэш — всё продолжает работать по сети.

const KEEP_PER_CHAT = 120
let dbPromise = null
let dbName = null

function open(name) {
  return new Promise((resolve) => {
    let req
    try { req = indexedDB.open(name, 1) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: ['conversationId', 'id'] })
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

export function openCache(userId) {
  dbName = `vl-social-${userId}`
  dbPromise = open(dbName)
  return dbPromise
}

export async function dropCache() {
  const name = dbName
  const db = dbPromise && await dbPromise
  dbPromise = null
  dbName = null
  try { db && db.close() } catch {}
  if (name) try { indexedDB.deleteDatabase(name) } catch {}
}

function tx(db, store, mode, fn) {
  return new Promise((resolve) => {
    let result
    try {
      const t = db.transaction(store, mode)
      result = fn(t.objectStore(store))
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : result)
      t.onerror = () => resolve(null)
      t.onabort = () => resolve(null)
    } catch { resolve(null) }
  })
}

export async function getKV(key) {
  const db = dbPromise && await dbPromise
  if (!db) return null
  return tx(db, 'kv', 'readonly', (s) => s.get(key))
}

export async function setKV(key, value) {
  const db = dbPromise && await dbPromise
  if (!db) return
  await tx(db, 'kv', 'readwrite', (s) => s.put(value, key))
}

function range(convId) {
  return IDBKeyRange.bound([convId, 0], [convId, Number.MAX_SAFE_INTEGER])
}

// Последние сообщения чата по возрастанию id
export async function getMessages(convId) {
  const db = dbPromise && await dbPromise
  if (!db) return null
  const list = await tx(db, 'messages', 'readonly', (s) => s.getAll(range(convId)))
  return Array.isArray(list) ? list : null
}

// Записать актуальный хвост чата: всё, что вне последних KEEP_PER_CHAT, выбрасываем.
// messages — отсортированный список подтверждённых сервером сообщений (без черновиков).
export async function putMessages(convId, messages) {
  const db = dbPromise && await dbPromise
  if (!db) return
  const tail = messages.filter((m) => m.id).slice(-KEEP_PER_CHAT)
  await tx(db, 'messages', 'readwrite', (s) => {
    s.delete(range(convId))
    for (const m of tail) {
      const copy = { ...m }
      delete copy.pending
      delete copy.failed
      s.put(copy)
    }
  })
}
