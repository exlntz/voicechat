// ===================== Чаты: лички, «Избранное», сообщения, вложения, закрепы, поиск, звонок из чата =====================
// Что видит конкретный пользователь, решается при каждом запросе: сообщения после его
// cleared_before (очистил историю «у себя»), не скрытые им (message_hidden — «удалить у меня»)
// и не удалённые у всех (deleted_at). «Избранное» — обычная личка с одним участником и
// dm_key = "saved:<id>": в списке появляется только после первого сообщения.
import { getUserById, pairKey, toInt, rateLimit, MESSAGE_MAX_LENGTH, PAGE_SIZE } from './db.js'
import { randomBytes } from 'node:crypto'
import { messagePushText } from './push.js'

const CALL_RING_MS = 45000 // столько звонит входящий, потом «пропущенный»
const MAX_ATTACHMENTS = 10
const MAX_PINS = 50
const SEARCH_SCAN = 20000 // сколько последних сообщений просматривает поиск
const WALLPAPER_RE = /^(p:[a-z0-9-]{1,24}|file:[0-9a-f]{32})$/
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi

export function registerChatRoutes(app, { db, hub, friends, media, push, createCallRoom }) {
  const VISIBLE = `m.conversation_id = ? AND m.id > ? AND m.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = ? AND h.message_id = m.id)`
  const q = {
    conv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    convByKey: db.prepare('SELECT * FROM conversations WHERE dm_key = ?'),
    insertConv: db.prepare("INSERT INTO conversations (type, dm_key, created_at) VALUES ('dm', ?, ?)"),
    member: db.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'),
    members: db.prepare('SELECT * FROM conversation_members WHERE conversation_id = ?'),
    insertMember: db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, hidden, joined_at) VALUES (?, ?, ?, ?)'),
    myConvs: db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ? AND hidden = 0'),
    setHidden: db.prepare('UPDATE conversation_members SET hidden = ? WHERE conversation_id = ? AND user_id = ?'),
    setMuted: db.prepare('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?'),
    setPinned: db.prepare('UPDATE conversation_members SET pinned_at = ? WHERE conversation_id = ? AND user_id = ?'),
    setWallpaper: db.prepare('UPDATE conversation_members SET wallpaper = ? WHERE conversation_id = ? AND user_id = ?'),
    clearFor: db.prepare('UPDATE conversation_members SET cleared_before = ?, hidden = 1, pinned_at = NULL WHERE conversation_id = ? AND user_id = ?'),
    setRead: db.prepare('UPDATE conversation_members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?'),
    setDelivered: db.prepare('UPDATE conversation_members SET last_delivered_id = ? WHERE conversation_id = ? AND user_id = ? AND last_delivered_id < ?'),
    undelivered: db.prepare(`SELECT cm.conversation_id AS cid, (SELECT MAX(id) FROM messages m WHERE m.conversation_id = cm.conversation_id AND m.author_id != cm.user_id) AS top
      FROM conversation_members cm WHERE cm.user_id = ?`),
    unread: db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${VISIBLE} AND m.id > ? AND m.author_id != ?`),
    lastMessage: db.prepare(`SELECT * FROM messages m WHERE ${VISIBLE} ORDER BY m.id DESC LIMIT 1`),
    maxId: db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?'),
    message: db.prepare('SELECT * FROM messages WHERE id = ?'),
    isHidden: db.prepare('SELECT 1 FROM message_hidden WHERE user_id = ? AND message_id = ?'),
    hide: db.prepare('INSERT OR IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)'),
    pageLatest: db.prepare(`SELECT * FROM messages m WHERE ${VISIBLE} ORDER BY m.id DESC LIMIT ?`),
    pageBefore: db.prepare(`SELECT * FROM messages m WHERE ${VISIBLE} AND m.id < ? ORDER BY m.id DESC LIMIT ?`),
    pageAfter: db.prepare(`SELECT * FROM messages m WHERE ${VISIBLE} AND m.id > ? ORDER BY m.id ASC LIMIT ?`),
    pageAround: db.prepare(`SELECT * FROM messages m WHERE ${VISIBLE} AND m.id >= ? ORDER BY m.id ASC LIMIT ?`),
    recentCalls: db.prepare(`SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE cm.hidden = 0 AND m.kind = 'call' AND m.deleted_at IS NULL AND m.id > cm.cleared_before
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = cm.user_id AND h.message_id = m.id)
      ORDER BY m.id DESC LIMIT 30`),
    searchScan: db.prepare(`SELECT m.id, m.body FROM messages m WHERE ${VISIBLE} AND m.body != '' ORDER BY m.id DESC LIMIT ${SEARCH_SCAN}`),
    insertMessage: db.prepare('INSERT INTO messages (conversation_id, author_id, kind, body, meta, reply_to, client_id, created_at, forward) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    touchConv: db.prepare('UPDATE conversations SET last_message_id = ?, last_message_at = ? WHERE id = ?'),
    editMessage: db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?'),
    deleteMessage: db.prepare("UPDATE messages SET body = '', meta = NULL, deleted_at = ? WHERE id = ?"),
    setMeta: db.prepare('UPDATE messages SET meta = ? WHERE id = ?'),
    // Вложения
    files: db.prepare('SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY mf.position'),
    firstFile: db.prepare('SELECT f.kind, f.name FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY mf.position LIMIT 1'),
    fileCount: db.prepare('SELECT COUNT(*) AS n FROM message_files WHERE message_id = ?'),
    linkFile: db.prepare('INSERT OR IGNORE INTO message_files (message_id, file_id, position) VALUES (?, ?, ?)'),
    unlinkFiles: db.prepare('DELETE FROM message_files WHERE message_id = ?'),
    fileIdsOf: db.prepare('SELECT file_id FROM message_files WHERE message_id = ?'),
    mediaPage: db.prepare(`SELECT m.id AS mid, m.author_id, m.created_at AS mcreated, f.* FROM messages m
      JOIN message_files mf ON mf.message_id = m.id JOIN files f ON f.id = mf.file_id
      WHERE ${VISIBLE} AND m.id < ? AND f.kind IN (SELECT value FROM json_each(?))
      ORDER BY m.id DESC, mf.position DESC LIMIT ?`),
    linkScan: db.prepare(`SELECT m.id, m.author_id, m.created_at, m.body FROM messages m
      WHERE ${VISIBLE} AND m.id < ? AND (m.body LIKE '%http://%' OR m.body LIKE '%https://%') ORDER BY m.id DESC LIMIT ?`),
    // Закрепы
    pins: db.prepare('SELECT p.message_id FROM pins p WHERE p.conversation_id = ? ORDER BY p.created_at DESC'),
    pinCount: db.prepare('SELECT COUNT(*) AS n FROM pins WHERE conversation_id = ?'),
    addPin: db.prepare('INSERT OR IGNORE INTO pins (conversation_id, message_id, pinned_by, created_at) VALUES (?, ?, ?, ?)'),
    removePin: db.prepare('DELETE FROM pins WHERE conversation_id = ? AND message_id = ?'),
    // Удалить чат у всех
    convMessageIds: db.prepare('SELECT id FROM messages WHERE conversation_id = ?'),
    convFileIds: db.prepare('SELECT DISTINCT mf.file_id FROM message_files mf JOIN messages m ON m.id = mf.message_id WHERE m.conversation_id = ?'),
    dropConvFiles: db.prepare('DELETE FROM message_files WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)'),
    dropConvHidden: db.prepare('DELETE FROM message_hidden WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)'),
    dropConvPins: db.prepare('DELETE FROM pins WHERE conversation_id = ?'),
    dropConvMessages: db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
    resetConv: db.prepare('UPDATE conversations SET last_message_id = NULL, last_message_at = NULL WHERE id = ?'),
    resetMembers: db.prepare('UPDATE conversation_members SET hidden = 1, pinned_at = NULL, last_read_id = 0, last_delivered_id = 0, cleared_before = 0 WHERE conversation_id = ?'),
    wallpaperFile: db.prepare("SELECT 1 FROM files WHERE id = ? AND owner_id = ? AND purpose = 'wallpaper'")
  }

  const isSaved = (conv) => !!conv && typeof conv.dm_key === 'string' && conv.dm_key.startsWith('saved:')

  // ---------- Представления ----------
  function parseMeta(raw) {
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  // Видно ли сообщение этому пользователю
  function visibleTo(r, me) {
    if (!r || r.deleted_at) return false
    const mine = q.member.get(r.conversation_id, me)
    if (!mine || Number(r.id) <= Number(mine.cleared_before)) return false
    return !q.isHidden.get(me, r.id)
  }

  function replyPreview(id) {
    const r = id ? q.message.get(id) : null
    if (!r) return null
    const first = r.deleted_at ? null : q.firstFile.get(r.id)
    return {
      id: Number(r.id),
      authorId: Number(r.author_id),
      kind: r.kind,
      body: r.deleted_at ? '' : String(r.body).slice(0, 200),
      attachment: first ? { kind: first.kind, name: first.name } : null,
      deleted: !!r.deleted_at
    }
  }

  function messageView(r) {
    if (!r) return null
    const deleted = !!r.deleted_at
    return {
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      authorId: Number(r.author_id),
      kind: r.kind,
      body: deleted ? '' : r.body,
      meta: deleted ? null : parseMeta(r.meta),
      attachments: deleted ? [] : q.files.all(r.id).map(media.fileView),
      forward: deleted ? null : parseMeta(r.forward),
      replyTo: r.reply_to ? Number(r.reply_to) : null,
      reply: r.reply_to ? replyPreview(r.reply_to) : null,
      clientId: r.client_id || null,
      createdAt: Number(r.created_at),
      editedAt: r.edited_at ? Number(r.edited_at) : null,
      deletedAt: deleted ? Number(r.deleted_at) : null
    }
  }

  function memberIds(convId) {
    return q.members.all(convId).map((m) => Number(m.user_id))
  }

  function pinsFor(convId, me) {
    const out = []
    for (const p of q.pins.all(convId)) {
      const r = q.message.get(p.message_id)
      if (visibleTo(r, me)) out.push(messageView(r))
    }
    return out
  }

  function summary(convId, me) {
    const conv = q.conv.get(convId)
    const mine = conv && q.member.get(convId, me)
    if (!conv || !mine) return null
    const saved = isSaved(conv)
    const members = q.members.all(convId)
    const users = members.map((m) => getUserById(db, m.user_id)).filter(Boolean)
    const others = members.filter((m) => Number(m.user_id) !== me)
    const cleared = Number(mine.cleared_before) || 0
    const last = q.lastMessage.get(convId, cleared, me)
    return {
      id: Number(conv.id),
      type: saved ? 'saved' : conv.type,
      title: saved ? 'Избранное' : (conv.title || null),
      members: users,
      // для личек: собеседник (для шапки и списка слева)
      peer: conv.type === 'dm' && !saved ? (users.find((u) => u.id !== me) || null) : null,
      lastMessage: last ? messageView(last) : null,
      lastMessageAt: last ? Number(last.created_at) : (conv.last_message_at ? Number(conv.last_message_at) : Number(conv.created_at)),
      lastReadId: Number(mine.last_read_id),
      // до какого сообщения дочитал собеседник — для отметки «прочитано»
      peerLastReadId: saved ? Number.MAX_SAFE_INTEGER : (others.length ? Math.min(...others.map((m) => Number(m.last_read_id))) : 0),
      // до какого сообщения приложение собеседника его получило — ✓✓ (прочитанное тоже доставлено)
      peerLastDeliveredId: saved ? Number.MAX_SAFE_INTEGER : (others.length ? Math.min(...others.map((m) => Math.max(Number(m.last_delivered_id) || 0, Number(m.last_read_id)))) : 0),
      unread: q.unread.get(convId, cleared, me, Number(mine.last_read_id), me).n,
      muted: !!mine.muted,
      hidden: !!mine.hidden,
      pinned: !!mine.pinned_at,
      pinnedAt: mine.pinned_at ? Number(mine.pinned_at) : null,
      wallpaper: mine.wallpaper || null,
      pins: pinsFor(convId, me)
    }
  }

  function publishSummary(convId, userIds) {
    for (const id of userIds) hub.publish([id], 'conversation.update', summary(convId, Number(id)))
  }

  // Участник ли я чата. Возвращает строку участника или отвечает 404.
  function requireMember(c) {
    const me = Number(c.get('user').id)
    const convId = toInt(c.req.param('id'))
    const conv = convId && q.conv.get(convId)
    const mine = conv && q.member.get(convId, me)
    if (!mine) return { error: c.json({ error: 'not_found', message: 'Чат не найден' }, 404) }
    return { me, convId, conv, mine, cleared: Number(mine.cleared_before) || 0 }
  }

  // В личке нельзя писать/звонить, если один заблокировал другого
  function dmBlocked(convId, me) {
    const conv = q.conv.get(convId)
    if (!conv || conv.type !== 'dm') return false
    return memberIds(convId).some((id) => id !== me && friends.isBlockedBetween(me, id))
  }

  function readBody(raw, { allowEmpty = false } = {}) {
    const body = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '') : ''
    if (!body.trim() && !allowEmpty) return { error: 'empty', message: 'Пустое сообщение' }
    if (body.length > MESSAGE_MAX_LENGTH) return { error: 'too_long', message: `Сообщение длиннее ${MESSAGE_MAX_LENGTH} символов` }
    return { body: body.trim() ? body : '' }
  }

  // Доставлено: отметить у получателя и сообщить участникам (у автора ✓ станет ✓✓)
  function markDelivered(convId, userId, messageId) {
    if (q.setDelivered.run(messageId, convId, userId, messageId).changes) {
      hub.publish(memberIds(convId), 'delivered', { conversationId: convId, userId, lastDeliveredId: messageId })
    }
  }
  // Пользователь подключился: всё, что пришло ему, пока его не было, — доставлено
  function markDeliveredAll(userId) {
    for (const r of q.undelivered.all(userId)) if (r.top) markDelivered(Number(r.cid), userId, Number(r.top))
  }
  hub.setOnConnect(markDeliveredAll)

  // Новое сообщение: запись, поднять чат в списке, вернуть скрытые лички, разослать участникам
  function postMessage(convId, authorId, { kind = 'text', body = '', meta = null, replyTo = null, clientId = null, fileIds = [], forward = null }) {
    const now = Date.now()
    const info = q.insertMessage.run(convId, authorId, kind, body, meta ? JSON.stringify(meta) : null, replyTo, clientId, now, forward ? JSON.stringify(forward) : null)
    const id = Number(info.lastInsertRowid)
    fileIds.forEach((fid, i) => q.linkFile.run(id, fid, i))
    q.touchConv.run(id, now, convId)
    q.setRead.run(id, convId, authorId) // своё сообщение прочитано автоматически
    const members = q.members.all(convId)
    for (const m of members) {
      if (m.hidden) {
        q.setHidden.run(0, convId, m.user_id)
        hub.publish([m.user_id], 'conversation.update', summary(convId, Number(m.user_id)))
      }
    }
    const message = messageView(q.message.get(id))
    hub.publish(members.map((m) => m.user_id), 'message.new', { message })
    // Получатель в сети (открыт реалтайм) — сообщение ему уже доставлено
    for (const m of members) {
      const uid = Number(m.user_id)
      if (uid !== authorId && hub.isOnline(uid)) markDelivered(convId, uid, id)
    }
    // Кого нет на сайте — push на телефон/компьютер (кроме чатов «без звука» и звонков: у них свой push)
    if (push && kind !== 'call') {
      for (const m of members) {
        const uid = Number(m.user_id)
        if (uid === authorId || m.muted) continue
        push.send(uid, { title: nameFor(uid, authorId), body: messagePushText(message), tag: 'conv-' + convId, url: '/dm/' + convId })
      }
    }
    return message
  }
  // Как получатель видит автора: своё имя-контакт или имя из профиля
  let contactStmt = null
  function nameFor(viewerId, userId) {
    try {
      if (!contactStmt) contactStmt = db.prepare('SELECT name FROM contacts WHERE owner_id = ? AND user_id = ?')
      const r = contactStmt.get(viewerId, userId)
      if (r) return r.name
    } catch {}
    const u = getUserById(db, userId)
    return u ? u.displayName : 'Сообщение'
  }

  function updateMessageMeta(messageId, patch) {
    const r = q.message.get(messageId)
    if (!r || r.deleted_at) return
    const meta = { ...(parseMeta(r.meta) || {}), ...patch }
    q.setMeta.run(JSON.stringify(meta), messageId)
    const message = messageView(q.message.get(messageId))
    hub.publish(memberIds(Number(r.conversation_id)), 'message.updated', { message })
  }

  function publishPins(convId) {
    for (const id of memberIds(convId)) hub.publish([id], 'pins.update', { conversationId: convId, pins: pinsFor(convId, id) })
  }

  // Удалить сообщение у всех: текст, вложения (файл стирается, если больше нигде не прикреплён), закреп
  function deleteForAll(convId, mid) {
    const fileIds = q.fileIdsOf.all(mid).map((r) => r.file_id)
    q.deleteMessage.run(Date.now(), mid)
    q.unlinkFiles.run(mid)
    for (const fid of fileIds) media.removeIfOrphan(fid)
    const wasPinned = q.removePin.run(convId, mid).changes > 0
    hub.publish(memberIds(convId), 'message.deleted', { conversationId: convId, id: mid })
    if (wasPinned) publishPins(convId)
  }

  // ---------- Чаты ----------
  app.get('/api/conversations', (c) => {
    const me = Number(c.get('user').id)
    const list = q.myConvs.all(me).map((r) => summary(Number(r.conversation_id), me)).filter(Boolean)
    // Закреплённые — сверху (последний закреплённый первым), остальные — по свежести
    list.sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0) || b.lastMessageAt - a.lastMessageAt)
    return c.json({ conversations: list })
  })

  // Открыть личку с пользователем (создаёт, если её ещё не было)
  app.post('/api/conversations/dm', async (c) => {
    const me = Number(c.get('user').id)
    const body = await c.req.json().catch(() => ({}))
    const other = toInt(body.userId)
    if (!other || other === me || !getUserById(db, other)) return c.json({ error: 'not_found', message: 'Пользователь не найден' }, 404)
    if (friends.isBlockedBetween(me, other)) return c.json({ error: 'blocked', message: 'Нельзя написать этому пользователю' }, 403)
    const key = pairKey(me, other).join(':')
    let conv = q.convByKey.get(key)
    if (!conv) {
      // Новую личку можно начать только с другом; старую — открыть всегда
      if (!friends.areFriends(me, other)) return c.json({ error: 'not_friends', message: 'Сначала добавьте пользователя в друзья' }, 403)
      const now = Date.now()
      const info = q.insertConv.run(key, now)
      conv = q.conv.get(Number(info.lastInsertRowid))
      // Собеседник увидит личку у себя, только когда в ней появится первое сообщение
      q.insertMember.run(conv.id, me, 0, now)
      q.insertMember.run(conv.id, other, 1, now)
    } else {
      q.setHidden.run(0, conv.id, me)
    }
    const s = summary(Number(conv.id), me)
    hub.publish([me], 'conversation.update', s)
    return c.json({ conversation: s })
  })

  // «Избранное»: создаётся по запросу, но скрыто, пока в нём нет ни одного сообщения
  app.post('/api/conversations/saved', (c) => {
    const me = Number(c.get('user').id)
    const key = `saved:${me}`
    let conv = q.convByKey.get(key)
    if (!conv) {
      const now = Date.now()
      const info = q.insertConv.run(key, now)
      conv = q.conv.get(Number(info.lastInsertRowid))
      q.insertMember.run(conv.id, me, 1, now)
    }
    return c.json({ conversation: summary(Number(conv.id), me) })
  })

  app.get('/api/conversations/:id', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    return c.json({ conversation: summary(ctx.convId, ctx.me) })
  })

  // Настройки чата: без звука, скрыть из списка, закрепить сверху — для себя;
  // обои — по умолчанию у обоих участников (forBoth: false — только у себя)
  app.patch('/api/conversations/:id', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.muted === 'boolean') q.setMuted.run(body.muted ? 1 : 0, ctx.convId, ctx.me)
    if (typeof body.hidden === 'boolean') q.setHidden.run(body.hidden ? 1 : 0, ctx.convId, ctx.me)
    if (typeof body.pinned === 'boolean') q.setPinned.run(body.pinned ? Date.now() : null, ctx.convId, ctx.me)
    if (body.wallpaper !== undefined) {
      const w = body.wallpaper === null || body.wallpaper === '' ? null : String(body.wallpaper)
      if (w && !WALLPAPER_RE.test(w)) return c.json({ error: 'bad_wallpaper', message: 'Неизвестные обои' }, 400)
      if (w && w.startsWith('file:') && !q.wallpaperFile.get(w.slice(5), ctx.me)) return c.json({ error: 'bad_wallpaper', message: 'Картинка не найдена' }, 400)
      const targets = body.forBoth === false ? [ctx.me] : memberIds(ctx.convId)
      for (const id of targets) q.setWallpaper.run(w, ctx.convId, id)
      // Собеседнику — свежая карточка чата, если личка у него не скрыта
      for (const id of targets) {
        if (id === ctx.me) continue
        const m = q.member.get(ctx.convId, id)
        if (m && !m.hidden) hub.publish([id], 'conversation.update', summary(ctx.convId, id))
      }
    }
    const s = summary(ctx.convId, ctx.me)
    hub.publish([ctx.me], 'conversation.update', s)
    return c.json({ conversation: s })
  })

  // Удалить чат: ?for=me — очистить историю у себя и убрать из списка;
  // ?for=all — стереть переписку у обоих (личка останется пустой и скрытой)
  app.delete('/api/conversations/:id', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const forAll = c.req.query('for') === 'all' || isSaved(ctx.conv)
    if (!rateLimit(`convdel:${ctx.me}`, 10, 60000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    if (!forAll) {
      const maxId = Number(q.maxId.get(ctx.convId).id) || 0
      q.clearFor.run(maxId, ctx.convId, ctx.me)
      hub.publish([ctx.me], 'conversation.remove', { conversationId: ctx.convId })
      return c.json({ ok: true })
    }
    const fileIds = q.convFileIds.all(ctx.convId).map((r) => r.file_id)
    const audience = memberIds(ctx.convId)
    db.exec('BEGIN')
    try {
      q.dropConvFiles.run(ctx.convId)
      q.dropConvHidden.run(ctx.convId)
      q.dropConvPins.run(ctx.convId)
      q.dropConvMessages.run(ctx.convId)
      q.resetConv.run(ctx.convId)
      q.resetMembers.run(ctx.convId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    for (const fid of fileIds) media.removeIfOrphan(fid)
    hub.publish(audience, 'conversation.remove', { conversationId: ctx.convId, forAll: true })
    return c.json({ ok: true })
  })

  // ---------- Сообщения ----------
  // ?before=ID — 50 сообщений до ID (прокрутка вверх); ?after=ID — после ID (догрузка после обрыва);
  // ?around=ID — страница, начинающаяся чуть раньше ID (переход к найденному/закреплённому);
  // без параметров — последние 50. Всегда по возрастанию id.
  app.get('/api/conversations/:id/messages', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const limit = Math.min(Math.max(toInt(c.req.query('limit')) || PAGE_SIZE, 1), 100)
    const before = toInt(c.req.query('before'))
    const after = toInt(c.req.query('after'))
    const around = toInt(c.req.query('around'))
    const v = [ctx.convId, ctx.cleared, ctx.me]
    let rows
    let hasMore
    let hasNewer = false
    if (around) {
      // 20 до и остальное после — сообщение окажется ближе к верху страницы
      const older = q.pageBefore.all(...v, around, 20).reverse()
      const newer = q.pageAround.all(...v, around, limit)
      rows = [...older, ...newer]
      hasMore = older.length === 20
      hasNewer = newer.length === limit
    } else if (after) {
      rows = q.pageAfter.all(...v, after, limit)
      hasMore = false
      hasNewer = rows.length === limit
    } else {
      rows = before ? q.pageBefore.all(...v, before, limit) : q.pageLatest.all(...v, limit)
      rows.reverse()
      hasMore = rows.length === limit
    }
    return c.json({ messages: rows.map(messageView), hasMore, hasNewer })
  })

  app.post('/api/conversations/:id/messages', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    if (!rateLimit(`msg:${ctx.me}`, 8, 5000) || !rateLimit(`msgm:${ctx.me}`, 60, 60000)) {
      return c.json({ error: 'rate_limited', message: 'Слишком часто. Подождите пару секунд.' }, 429)
    }
    if (dmBlocked(ctx.convId, ctx.me)) return c.json({ error: 'blocked', message: 'Нельзя написать этому пользователю' }, 403)
    const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : null

    // Пересылка: копия текста и ссылки на те же файлы; «переслано от» — автор оригинала
    const forwardFrom = toInt(body.forwardFrom)
    if (forwardFrom) {
      const src = q.message.get(forwardFrom)
      if (!visibleTo(src, ctx.me) || src.kind !== 'text') return c.json({ error: 'not_found', message: 'Сообщение не найдено' }, 404)
      const orig = parseMeta(src.forward)
      const author = orig && orig.userId ? orig : { userId: Number(src.author_id) }
      const u = getUserById(db, author.userId)
      const forward = { userId: Number(author.userId), name: u ? u.displayName : (author.name || 'Пользователь'), messageId: Number(src.id) }
      const fileIds = q.fileIdsOf.all(src.id).map((r) => r.file_id)
      const message = postMessage(ctx.convId, ctx.me, { body: src.body, clientId, fileIds, forward })
      return c.json({ message })
    }

    // Вложения: только свои, только что загруженные, ещё ни к чему не прикреплённые
    const ids = Array.isArray(body.attachments) ? [...new Set(body.attachments.map(String))] : []
    if (ids.length > MAX_ATTACHMENTS) return c.json({ error: 'too_many', message: `Не больше ${MAX_ATTACHMENTS} файлов в сообщении` }, 400)
    for (const id of ids) {
      if (!media.claimable.get(id, ctx.me)) return c.json({ error: 'bad_attachment', message: 'Файл не найден — загрузите его заново' }, 400)
    }
    const parsed = readBody(body.body, { allowEmpty: ids.length > 0 })
    if (parsed.error) return c.json(parsed, 400)
    let replyTo = toInt(body.replyTo) || null
    if (replyTo) {
      const target = q.message.get(replyTo)
      if (!target || Number(target.conversation_id) !== ctx.convId) replyTo = null
    }
    const message = postMessage(ctx.convId, ctx.me, { body: parsed.body, replyTo, clientId, fileIds: ids })
    return c.json({ message })
  })

  function findMessage(c, ctx) {
    const mid = toInt(c.req.param('mid'))
    const r = mid && q.message.get(mid)
    if (!r || Number(r.conversation_id) !== ctx.convId || !visibleTo(r, ctx.me)) return { error: c.json({ error: 'not_found', message: 'Сообщение не найдено' }, 404) }
    return { r, mid }
  }

  function ownMessage(c, ctx) {
    const found = findMessage(c, ctx)
    if (found.error) return found
    if (Number(found.r.author_id) !== ctx.me) return { error: c.json({ error: 'forbidden', message: 'Можно менять только свои сообщения' }, 403) }
    return found
  }

  app.patch('/api/conversations/:id/messages/:mid', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const own = ownMessage(c, ctx)
    if (own.error) return own.error
    if (own.r.kind !== 'text' || own.r.forward) return c.json({ error: 'forbidden', message: 'Это сообщение нельзя изменить' }, 403)
    const body = await c.req.json().catch(() => ({}))
    const parsed = readBody(body.body, { allowEmpty: q.fileCount.get(own.mid).n > 0 })
    if (parsed.error) return c.json(parsed, 400)
    if (!rateLimit(`edit:${ctx.me}`, 20, 10000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    if (parsed.body !== own.r.body) q.editMessage.run(parsed.body, Date.now(), own.mid)
    const message = messageView(q.message.get(own.mid))
    hub.publish(memberIds(ctx.convId), 'message.updated', { message })
    return c.json({ message })
  })

  // ?for=me — скрыть у себя (любое сообщение); ?for=all (по умолчанию) — удалить у всех (только своё)
  app.delete('/api/conversations/:id/messages/:mid', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const found = findMessage(c, ctx)
    if (found.error) return found.error
    if (c.req.query('for') === 'me' && !isSaved(ctx.conv)) {
      q.hide.run(ctx.me, found.mid)
      hub.publish([ctx.me], 'message.deleted', { conversationId: ctx.convId, id: found.mid })
      hub.publish([ctx.me], 'pins.update', { conversationId: ctx.convId, pins: pinsFor(ctx.convId, ctx.me) })
      return c.json({ ok: true })
    }
    if (Number(found.r.author_id) !== ctx.me) return c.json({ error: 'forbidden', message: 'Удалить у всех можно только своё сообщение' }, 403)
    deleteForAll(ctx.convId, found.mid)
    return c.json({ ok: true })
  })

  // ---------- Закреплённые сообщения (общие для чата) ----------
  app.post('/api/conversations/:id/pins', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    const mid = toInt(body.messageId)
    const r = mid && q.message.get(mid)
    if (!r || Number(r.conversation_id) !== ctx.convId || !visibleTo(r, ctx.me)) return c.json({ error: 'not_found', message: 'Сообщение не найдено' }, 404)
    if (q.pinCount.get(ctx.convId).n >= MAX_PINS) return c.json({ error: 'too_many', message: `Можно закрепить не больше ${MAX_PINS} сообщений` }, 400)
    if (!rateLimit(`pin:${ctx.me}`, 20, 60000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    q.addPin.run(ctx.convId, mid, ctx.me, Date.now())
    publishPins(ctx.convId)
    return c.json({ ok: true, pins: pinsFor(ctx.convId, ctx.me) })
  })

  app.delete('/api/conversations/:id/pins/:mid', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const mid = toInt(c.req.param('mid'))
    if (mid) q.removePin.run(ctx.convId, mid)
    publishPins(ctx.convId)
    return c.json({ ok: true, pins: pinsFor(ctx.convId, ctx.me) })
  })

  // ---------- Поиск по чату ----------
  // SQLite lower()/LIKE не знают кириллицы, поэтому сравниваем в JS: последние 20 000 сообщений
  // с текстом — это миллисекунды.
  app.get('/api/conversations/:id/search', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const needle = String(c.req.query('q') || '').trim().toLocaleLowerCase('ru').slice(0, 100)
    if (!needle) return c.json({ messages: [] })
    if (!rateLimit(`search:${ctx.me}`, 30, 10000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    const hits = []
    for (const r of q.searchScan.all(ctx.convId, ctx.cleared, ctx.me)) {
      if (String(r.body).toLocaleLowerCase('ru').includes(needle)) {
        hits.push(Number(r.id))
        if (hits.length >= 100) break
      }
    }
    return c.json({ messages: hits.map((id) => messageView(q.message.get(id))) })
  })

  // ---------- Поиск по всем чатам (поле «Найти друга или сообщение» слева) ----------
  // Те же правила видимости, что и в чате; самые свежие совпадения первыми.
  app.get('/api/search', (c) => {
    const me = Number(c.get('user').id)
    const needle = String(c.req.query('q') || '').trim().toLocaleLowerCase('ru').slice(0, 100)
    if (needle.length < 2) return c.json({ messages: [] })
    if (!rateLimit(`search:${me}`, 30, 10000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    const hits = []
    for (const r of q.myConvs.all(me)) {
      const convId = Number(r.conversation_id)
      const mine = q.member.get(convId, me)
      if (!mine) continue
      let n = 0
      for (const m of q.searchScan.all(convId, Number(mine.cleared_before) || 0, me)) {
        if (String(m.body).toLocaleLowerCase('ru').includes(needle)) {
          hits.push(Number(m.id))
          if (++n >= 20) break
        }
      }
    }
    hits.sort((a, b) => b - a)
    return c.json({ messages: hits.slice(0, 40).map((id) => messageView(q.message.get(id))) })
  })

  // Недавние звонки для вкладки «Звонки»: карточки звонков из всех своих чатов, новые сверху
  app.get('/api/calls/recent', (c) => {
    const me = Number(c.get('user').id)
    return c.json({ calls: q.recentCalls.all(me).map(messageView) })
  })

  // ---------- Медиа, файлы, голосовые, ссылки (как вкладки профиля в Телеграме) ----------
  const MEDIA_KINDS = { media: ['image', 'video'], files: ['file', 'audio'], voice: ['voice'] }
  app.get('/api/conversations/:id/media', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const type = String(c.req.query('type') || 'media')
    const before = toInt(c.req.query('before')) || Number.MAX_SAFE_INTEGER
    const limit = Math.min(Math.max(toInt(c.req.query('limit')) || 60, 1), 120)
    const v = [ctx.convId, ctx.cleared, ctx.me]
    if (type === 'links') {
      const items = []
      let lastId = before
      let scanned = 0
      while (items.length < limit && scanned < 2000) {
        const rows = q.linkScan.all(...v, lastId, 200)
        if (!rows.length) break
        for (const r of rows) {
          scanned++
          lastId = Number(r.id)
          const urls = String(r.body).match(URL_RE) || []
          for (const url of [...new Set(urls)]) items.push({ messageId: Number(r.id), authorId: Number(r.author_id), createdAt: Number(r.created_at), url, body: String(r.body).slice(0, 200) })
          if (items.length >= limit) break
        }
        if (rows.length < 200) { lastId = 0; break }
      }
      return c.json({ items, next: items.length >= limit && lastId ? lastId : null })
    }
    const kinds = MEDIA_KINDS[type]
    if (!kinds) return c.json({ error: 'bad_type', message: 'Неизвестный раздел' }, 400)
    const rows = q.mediaPage.all(...v, before, JSON.stringify(kinds), limit)
    const items = rows.map((r) => ({ messageId: Number(r.mid), authorId: Number(r.author_id), createdAt: Number(r.mcreated), file: media.fileView(r) }))
    return c.json({ items, next: rows.length === limit ? Number(rows[rows.length - 1].mid) : null })
  })

  app.post('/api/conversations/:id/read', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    const maxId = Number(q.maxId.get(ctx.convId).id) || 0
    const upTo = Math.min(toInt(body.messageId) || maxId, maxId)
    if (upTo > Number(ctx.mine.last_read_id)) {
      q.setRead.run(upTo, ctx.convId, ctx.me)
      q.setDelivered.run(upTo, ctx.convId, ctx.me, upTo)
      // Себе (другие вкладки/устройства сбросят счётчик) и собеседнику (отметка «прочитано»)
      hub.publish(memberIds(ctx.convId), 'read', { conversationId: ctx.convId, userId: ctx.me, lastReadId: upTo })
    }
    return c.json({ ok: true, lastReadId: Math.max(upTo, Number(ctx.mine.last_read_id)) })
  })

  app.post('/api/conversations/:id/typing', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    // Клиент шлёт не чаще раза в 3 с; сервер дополнительно не пропускает чаще раза в 2 с
    if (rateLimit(`typing:${ctx.me}:${ctx.convId}`, 1, 2000) && !dmBlocked(ctx.convId, ctx.me) && !isSaved(ctx.conv)) {
      hub.publish(memberIds(ctx.convId).filter((id) => id !== ctx.me), 'typing', { conversationId: ctx.convId, userId: ctx.me })
    }
    return c.json({ ok: true })
  })

  // ---------- Звонок из чата ----------
  // Звонящий сразу попадает в комнату (как в Дискорде: сидишь в звонке и ждёшь), собеседнику
  // приходит call.incoming. Состояние вызова — в памяти; в чате остаётся карточка-сообщение
  // (kind: 'call'), у которой меняется meta.status: ringing -> accepted | declined | missed.
  const calls = new Map() // callId -> call

  function callView(call) {
    return {
      callId: call.id,
      conversationId: call.conversationId,
      from: getUserById(db, call.callerId),
      roomCode: call.roomCode,
      messageId: call.messageId,
      createdAt: call.createdAt
    }
  }

  function endCall(call, status) {
    clearTimeout(call.timer)
    calls.delete(call.id)
    updateMessageMeta(call.messageId, { status, endedAt: Date.now() })
  }

  function findCall(c) {
    const call = calls.get(String(c.req.param('callId') || ''))
    return call || null
  }

  hub.setHelloExtras((userId) => ({
    calls: [...calls.values()].filter((call) => call.calleeIds.has(userId)).map(callView)
  }))

  app.post('/api/conversations/:id/call', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    if (dmBlocked(ctx.convId, ctx.me)) return c.json({ error: 'blocked', message: 'Нельзя позвонить этому пользователю' }, 403)
    if (!rateLimit(`call:${ctx.me}`, 6, 60000)) return c.json({ error: 'rate_limited', message: 'Слишком много звонков подряд' }, 429)

    // Уже идёт вызов в этом чате: если звонят мне — это «принять», если звоню я — вернуть тот же
    const existing = [...calls.values()].find((call) => call.conversationId === ctx.convId)
    if (existing) {
      if (existing.calleeIds.has(ctx.me)) {
        acceptCall(existing, ctx.me)
        return c.json({ callId: existing.id, roomCode: existing.roomCode, hostSecret: null, accepted: true })
      }
      return c.json({ callId: existing.id, roomCode: existing.roomCode, hostSecret: existing.hostSecret })
    }

    const { roomCode, hostSecret } = createCallRoom()
    const calleeIds = new Set(memberIds(ctx.convId).filter((id) => id !== ctx.me))
    if (!calleeIds.size) return c.json({ error: 'no_callee', message: 'Здесь некому звонить' }, 400)
    const call = {
      id: randomBytes(8).toString('hex'),
      conversationId: ctx.convId,
      callerId: ctx.me,
      calleeIds,
      roomCode,
      hostSecret,
      createdAt: Date.now(),
      messageId: 0,
      timer: null
    }
    const message = postMessage(ctx.convId, ctx.me, { kind: 'call', meta: { callId: call.id, roomCode, status: 'ringing' } })
    call.messageId = message.id
    calls.set(call.id, call)
    call.timer = setTimeout(() => {
      if (!calls.has(call.id)) return
      endCall(call, 'missed')
      hub.publish([call.callerId], 'call.timeout', { callId: call.id })
      hub.publish([...call.calleeIds], 'call.cancel', { callId: call.id, reason: 'timeout' })
    }, CALL_RING_MS)
    hub.publish([...calleeIds], 'call.incoming', callView(call))
    if (push) for (const uid of calleeIds) push.send(uid, { title: nameFor(uid, ctx.me), body: 'Входящий звонок — нажмите, чтобы ответить', tag: 'call-' + call.id, url: '/dm/' + ctx.convId, call: true })
    return c.json({ callId: call.id, roomCode, hostSecret, message })
  })

  function acceptCall(call, userId) {
    endCall(call, 'accepted')
    hub.publish([call.callerId], 'call.accepted', { callId: call.id, by: userId })
    // Остальные устройства принявшего (и другие участники) перестают звонить
    hub.publish([...call.calleeIds], 'call.cancel', { callId: call.id, reason: 'answered', by: userId })
  }

  app.post('/api/calls/:callId/accept', (c) => {
    const me = Number(c.get('user').id)
    const call = findCall(c)
    if (!call || !call.calleeIds.has(me)) return c.json({ error: 'not_found', message: 'Звонок уже завершён' }, 404)
    acceptCall(call, me)
    return c.json({ ok: true, roomCode: call.roomCode, conversationId: call.conversationId })
  })

  app.post('/api/calls/:callId/decline', (c) => {
    const me = Number(c.get('user').id)
    const call = findCall(c)
    if (!call || !call.calleeIds.has(me)) return c.json({ ok: true })
    endCall(call, 'declined')
    hub.publish([call.callerId], 'call.declined', { callId: call.id, by: me })
    hub.publish([...call.calleeIds], 'call.cancel', { callId: call.id, reason: 'declined' })
    return c.json({ ok: true })
  })

  // Звонящий передумал (положил трубку до ответа)
  app.post('/api/calls/:callId/cancel', (c) => {
    const me = Number(c.get('user').id)
    const call = findCall(c)
    if (!call || call.callerId !== me) return c.json({ ok: true })
    endCall(call, 'missed')
    hub.publish([...call.calleeIds], 'call.cancel', { callId: call.id, reason: 'cancelled' })
    return c.json({ ok: true })
  })

  return { stats: () => ({ ringingCalls: calls.size }) }
}
