// ===================== Реалтайм: GET /api/events (Server-Sent Events) =====================
// Почему SSE, а не WebSocket: это обычный HTTP-ответ, который просто не заканчивается, поэтому
// текущий nginx проксирует его без правок конфига. Чтобы nginx не копил ответ в буфере, отдаём
// заголовок X-Accel-Buffering: no; чтобы соединение не рвал proxy_read_timeout (60 с по
// умолчанию), раз в 25 секунд шлём пинг-комментарий.
//
// Пропущенные события: у каждого события есть id вида "<запуск>-<номер>". Браузер после обрыва
// сам переподключается и присылает Last-Event-ID — отдаём из буфера всё, что было после него.
// Если сервер успел перезапуститься или буфер уже вытеснил нужное, шлём "resync", и клиент
// заново загружает списки (друзья, чаты, открытый чат).
//
// Онлайн = есть хотя бы одно открытое SSE-соединение. После закрытия последнего ждём несколько
// секунд (обновление страницы, смена сети), и только потом объявляем «не в сети».
import { streamSSE } from 'hono/streaming'
import { randomBytes } from 'node:crypto'

const PING_MS = 25000
const BUFFER_MAX = 300 // событий на пользователя
const BUFFER_TTL_MS = 15 * 60 * 1000
const OFFLINE_GRACE_MS = 6000
const STATUSES = new Set(['online', 'idle', 'dnd'])

// События, которые не имеет смысла доигрывать после обрыва: снимок присутствия и активных
// звонков и так приходит в "hello" при каждом подключении.
const TRANSIENT = new Set(['typing', 'presence', 'call.incoming', 'call.cancel', 'call.accepted', 'call.declined', 'call.timeout'])

export function createHub(db) {
  const bootId = randomBytes(4).toString('hex')
  let seq = 0
  const conns = new Map() // userId -> Set<conn>
  const buffers = new Map() // userId -> { items: [{seq, id, event, data, at}], dropped: seq }
  const presence = new Map() // userId -> { status, inCall, since }
  const offlineTimers = new Map()
  // Звонки живут в chats.js — hub спрашивает у него снимок для "hello"
  let helloExtras = () => ({})

  const lastSeenStmt = db.prepare('SELECT last_seen, show_last_seen FROM users WHERE id = ?')
  const setLastSeenStmt = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
  const friendIdsStmt = db.prepare(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id
    FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`)
  function friendIds(userId) {
    return friendIdsStmt.all(userId, userId, userId).map((r) => Number(r.id))
  }

  function bufferFor(userId) {
    let b = buffers.get(userId)
    if (!b) { b = { items: [], dropped: 0 }; buffers.set(userId, b) }
    return b
  }

  function writeTo(conn, event, data, id) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    // Последовательная очередь записи на соединение: порядок событий важен (new -> updated)
    conn.queue = conn.queue.then(() => conn.stream.writeSSE({ event, data: payload, id })).catch(() => {})
    return conn.queue
  }

  // Отправить событие пользователям (по всем их вкладкам/устройствам)
  function publish(userIds, event, data) {
    const now = Date.now()
    const payload = JSON.stringify(data)
    const transient = TRANSIENT.has(event)
    for (const raw of new Set(userIds)) {
      const userId = Number(raw)
      if (!userId) continue
      let id
      if (!transient) {
        seq += 1
        id = `${bootId}-${seq}`
        const b = bufferFor(userId)
        b.items.push({ seq, id, event, data: payload, at: now })
        while (b.items.length > BUFFER_MAX || (b.items.length && b.items[0].at < now - BUFFER_TTL_MS)) {
          b.dropped = b.items.shift().seq
        }
      }
      const set = conns.get(userId)
      if (set) for (const conn of set) writeTo(conn, event, payload, id)
    }
  }

  // Не в сети: lastSeen — время ухода (мс) или null, если человек скрыл его в профиле
  // («был(а) недавно»); hidden — скрыл ли.
  function presenceOf(userId) {
    const p = presence.get(Number(userId))
    if (p) return { status: p.status, inCall: !!p.inCall }
    const row = lastSeenStmt.get(Number(userId))
    const hidden = !!row && !row.show_last_seen
    return { status: 'offline', inCall: false, lastSeen: row && !hidden && row.last_seen ? Number(row.last_seen) : null, hidden }
  }

  function broadcastPresence(userId) {
    publish(friendIds(userId), 'presence', { userId, ...presenceOf(userId) })
  }

  function attach(userId, stream) {
    const conn = { userId, stream, queue: Promise.resolve() }
    let set = conns.get(userId)
    if (!set) { set = new Set(); conns.set(userId, set) }
    set.add(conn)
    const timer = offlineTimers.get(userId)
    if (timer) { clearTimeout(timer); offlineTimers.delete(userId) }
    if (!presence.has(userId)) {
      presence.set(userId, { status: 'online', inCall: null, since: Date.now() })
      // На случай перезапуска сервера без «ухода»: хотя бы время входа будет свежим
      try { setLastSeenStmt.run(Date.now(), userId) } catch {}
      broadcastPresence(userId)
    }
    return conn
  }

  function detach(conn) {
    const set = conns.get(conn.userId)
    if (!set || !set.delete(conn)) return
    if (set.size) return
    conns.delete(conn.userId)
    const userId = conn.userId
    offlineTimers.set(userId, setTimeout(() => {
      offlineTimers.delete(userId)
      if (conns.has(userId)) return
      presence.delete(userId)
      try { setLastSeenStmt.run(Date.now(), userId) } catch {}
      broadcastPresence(userId)
    }, OFFLINE_GRACE_MS))
  }

  // Доиграть пропущенное. true — получилось, false — нужен полный resync.
  function replay(conn, lastEventId) {
    if (!lastEventId) return true
    const [boot, rawSeq] = String(lastEventId).split('-')
    const lastSeq = Number(rawSeq)
    if (boot !== bootId || !Number.isFinite(lastSeq)) return false
    const b = buffers.get(conn.userId)
    if (!b) return true // этому пользователю ещё ничего не отправлялось
    if (lastSeq < b.dropped) return false
    for (const item of b.items) {
      if (item.seq > lastSeq) writeTo(conn, item.event, item.data, item.id)
    }
    return true
  }

  function setStatus(userId, status) {
    if (!STATUSES.has(status)) return false
    const p = presence.get(userId)
    if (!p) return false // нет открытого соединения — пользователь и так «не в сети»
    if (p.status === status) return true
    p.status = status
    broadcastPresence(userId)
    return true
  }

  // «В звонке» выставляет /api/join, снимает клиент при выходе (или обрыв последнего соединения)
  function setInCall(userId, roomCode) {
    const p = presence.get(userId)
    if (!p) return
    const next = roomCode || null
    if (p.inCall === next) return
    p.inCall = next
    broadcastPresence(userId)
  }

  function isOnline(userId) {
    return conns.has(Number(userId))
  }

  function mount(app) {
    app.get('/api/events', (c) => {
      const user = c.get('user')
      const userId = Number(user.id)
      const lastEventId = c.req.header('Last-Event-ID') || c.req.query('lastEventId') || ''
      c.header('X-Accel-Buffering', 'no')
      c.header('Cache-Control', 'no-cache, no-transform')
      let conn = null
      return streamSSE(c, async (stream) => {
        conn = attach(userId, stream)
        let finished = false
        const finish = () => { if (finished) return; finished = true; detach(conn) }
        stream.onAbort(finish)
        try { c.req.raw.signal.addEventListener('abort', () => { try { stream.abort() } catch {} finish() }) } catch {}

        // Первое событие — снимок: кто из друзей в сети, активные входящие звонки.
        // retry: браузер переподключается через 2 с после обрыва.
        // id у hello — текущая позиция: даже если дальше не придёт ни одного события, после
        // обрыва браузер пришлёт её в Last-Event-ID и получит всё пропущенное.
        // Всё ниже — синхронно, в одном тике: иначе событие, пришедшее между hello и replay,
        // ушло бы клиенту дважды.
        const friends = friendIds(userId)
        const snapshot = {}
        for (const id of friends) snapshot[id] = presenceOf(id)
        const hello = JSON.stringify({ bootId, me: presenceOf(userId), presence: snapshot, ...helloExtras(userId) })
        const helloId = `${bootId}-${seq}`
        conn.queue = conn.queue.then(() => stream.writeSSE({ event: 'hello', retry: 2000, id: helloId, data: hello })).catch(() => {})
        if (!replay(conn, lastEventId)) writeTo(conn, 'resync', {}, helloId)

        while (!finished && !stream.aborted && !stream.closed) {
          await stream.sleep(PING_MS)
          if (finished || stream.aborted) break
          // Комментарий SSE: клиенту он не виден, но держит соединение живым через nginx
          conn.queue = conn.queue.then(() => stream.write(': ping\n\n')).catch(() => {})
          await conn.queue
        }
        finish()
      }, async () => { if (conn) detach(conn) })
    })

    // Ручной статус («Не беспокоить») и автоматический «Отошёл» (простой клавиатуры/мыши)
    app.post('/api/presence', async (c) => {
      const user = c.get('user')
      const body = await c.req.json().catch(() => ({}))
      if (body.status !== undefined && !setStatus(Number(user.id), String(body.status))) {
        return c.json({ error: 'bad_status' }, 400)
      }
      // Клиент сообщает, что вышел из звонка (вход отмечает сам /api/join)
      if (body.inCall === false) setInCall(Number(user.id), null)
      return c.json({ ok: true, presence: presenceOf(user.id) })
    })
  }

  return {
    bootId,
    publish,
    presenceOf,
    broadcastPresence,
    setInCall,
    isOnline,
    friendIds,
    mount,
    setHelloExtras(fn) { helloExtras = fn },
    stats: () => ({ users: conns.size, connections: [...conns.values()].reduce((n, s) => n + s.size, 0) })
  }
}
