// ===================== Чаты: лички, сообщения, прочитанное, «печатает…», звонок из чата =====================
import { getUserById, pairKey, toInt, rateLimit, MESSAGE_MAX_LENGTH, PAGE_SIZE } from './db.js'
import { randomBytes } from 'node:crypto'

const CALL_RING_MS = 45000 // столько звонит входящий, потом «пропущенный»

export function registerChatRoutes(app, { db, hub, friends, createCallRoom }) {
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
    setRead: db.prepare('UPDATE conversation_members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND author_id != ? AND deleted_at IS NULL'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1'),
    maxId: db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?'),
    message: db.prepare('SELECT * FROM messages WHERE id = ?'),
    pageLatest: db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?'),
    pageBefore: db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?'),
    pageAfter: db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id ASC LIMIT ?'),
    insertMessage: db.prepare('INSERT INTO messages (conversation_id, author_id, kind, body, meta, reply_to, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    touchConv: db.prepare('UPDATE conversations SET last_message_id = ?, last_message_at = ? WHERE id = ?'),
    editMessage: db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?'),
    deleteMessage: db.prepare("UPDATE messages SET body = '', meta = NULL, deleted_at = ? WHERE id = ?"),
    setMeta: db.prepare('UPDATE messages SET meta = ? WHERE id = ?')
  }

  // ---------- Представления ----------
  function parseMeta(raw) {
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  function replyPreview(id) {
    const r = id ? q.message.get(id) : null
    if (!r) return null
    return {
      id: Number(r.id),
      authorId: Number(r.author_id),
      kind: r.kind,
      body: r.deleted_at ? '' : String(r.body).slice(0, 200),
      deleted: !!r.deleted_at
    }
  }

  function messageView(r) {
    if (!r) return null
    return {
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      authorId: Number(r.author_id),
      kind: r.kind,
      body: r.deleted_at ? '' : r.body,
      meta: r.deleted_at ? null : parseMeta(r.meta),
      replyTo: r.reply_to ? Number(r.reply_to) : null,
      reply: r.reply_to ? replyPreview(r.reply_to) : null,
      clientId: r.client_id || null,
      createdAt: Number(r.created_at),
      editedAt: r.edited_at ? Number(r.edited_at) : null,
      deletedAt: r.deleted_at ? Number(r.deleted_at) : null
    }
  }

  function memberIds(convId) {
    return q.members.all(convId).map((m) => Number(m.user_id))
  }

  function summary(convId, me) {
    const conv = q.conv.get(convId)
    const mine = conv && q.member.get(convId, me)
    if (!conv || !mine) return null
    const members = q.members.all(convId)
    const users = members.map((m) => getUserById(db, m.user_id)).filter(Boolean)
    const others = members.filter((m) => Number(m.user_id) !== me)
    const last = q.lastMessage.get(convId)
    return {
      id: Number(conv.id),
      type: conv.type,
      title: conv.title || null,
      members: users,
      // для личек: собеседник (для шапки и списка слева)
      peer: conv.type === 'dm' ? (users.find((u) => u.id !== me) || null) : null,
      lastMessage: last ? messageView(last) : null,
      lastMessageAt: conv.last_message_at ? Number(conv.last_message_at) : Number(conv.created_at),
      lastReadId: Number(mine.last_read_id),
      // до какого сообщения дочитал собеседник — для отметки «прочитано»
      peerLastReadId: others.length ? Math.min(...others.map((m) => Number(m.last_read_id))) : 0,
      unread: q.unread.get(convId, Number(mine.last_read_id), me).n,
      muted: !!mine.muted,
      hidden: !!mine.hidden
    }
  }

  // Участник ли я чата. Возвращает строку участника или отвечает 404.
  function requireMember(c) {
    const me = Number(c.get('user').id)
    const convId = toInt(c.req.param('id'))
    const conv = convId && q.conv.get(convId)
    const mine = conv && q.member.get(convId, me)
    if (!mine) return { error: c.json({ error: 'not_found', message: 'Чат не найден' }, 404) }
    return { me, convId, conv, mine }
  }

  // В личке нельзя писать/звонить, если один заблокировал другого
  function dmBlocked(convId, me) {
    const conv = q.conv.get(convId)
    if (!conv || conv.type !== 'dm') return false
    return memberIds(convId).some((id) => id !== me && friends.isBlockedBetween(me, id))
  }

  function readBody(raw) {
    const body = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '') : ''
    if (!body.trim()) return { error: 'empty', message: 'Пустое сообщение' }
    if (body.length > MESSAGE_MAX_LENGTH) return { error: 'too_long', message: `Сообщение длиннее ${MESSAGE_MAX_LENGTH} символов` }
    return { body }
  }

  // Новое сообщение: запись, поднять чат в списке, вернуть скрытые лички, разослать участникам
  function postMessage(convId, authorId, { kind = 'text', body = '', meta = null, replyTo = null, clientId = null }) {
    const now = Date.now()
    const info = q.insertMessage.run(convId, authorId, kind, body, meta ? JSON.stringify(meta) : null, replyTo, clientId, now)
    const id = Number(info.lastInsertRowid)
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
    return message
  }

  function updateMessageMeta(messageId, patch) {
    const r = q.message.get(messageId)
    if (!r || r.deleted_at) return
    const meta = { ...(parseMeta(r.meta) || {}), ...patch }
    q.setMeta.run(JSON.stringify(meta), messageId)
    const message = messageView(q.message.get(messageId))
    hub.publish(memberIds(Number(r.conversation_id)), 'message.updated', { message })
  }

  // ---------- Чаты ----------
  app.get('/api/conversations', (c) => {
    const me = Number(c.get('user').id)
    const list = q.myConvs.all(me).map((r) => summary(Number(r.conversation_id), me)).filter(Boolean)
    list.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
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

  app.get('/api/conversations/:id', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    return c.json({ conversation: summary(ctx.convId, ctx.me) })
  })

  // Настройки чата для себя: без звука, закрыть из списка
  app.patch('/api/conversations/:id', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.muted === 'boolean') q.setMuted.run(body.muted ? 1 : 0, ctx.convId, ctx.me)
    if (typeof body.hidden === 'boolean') q.setHidden.run(body.hidden ? 1 : 0, ctx.convId, ctx.me)
    const s = summary(ctx.convId, ctx.me)
    hub.publish([ctx.me], 'conversation.update', s)
    return c.json({ conversation: s })
  })

  // ---------- Сообщения ----------
  // ?before=ID — 50 сообщений до ID (прокрутка вверх); ?after=ID — после ID (догрузка после обрыва);
  // без параметров — последние 50. Всегда по возрастанию id.
  app.get('/api/conversations/:id/messages', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const limit = Math.min(Math.max(toInt(c.req.query('limit')) || PAGE_SIZE, 1), 100)
    const before = toInt(c.req.query('before'))
    const after = toInt(c.req.query('after'))
    let rows
    if (after) {
      rows = q.pageAfter.all(ctx.convId, after, limit)
    } else {
      rows = before ? q.pageBefore.all(ctx.convId, before, limit) : q.pageLatest.all(ctx.convId, limit)
      rows.reverse()
    }
    return c.json({ messages: rows.map(messageView), hasMore: rows.length === limit })
  })

  app.post('/api/conversations/:id/messages', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    const parsed = readBody(body.body)
    if (parsed.error) return c.json(parsed, 400)
    if (!rateLimit(`msg:${ctx.me}`, 8, 5000) || !rateLimit(`msgm:${ctx.me}`, 60, 60000)) {
      return c.json({ error: 'rate_limited', message: 'Слишком часто. Подождите пару секунд.' }, 429)
    }
    if (dmBlocked(ctx.convId, ctx.me)) return c.json({ error: 'blocked', message: 'Нельзя написать этому пользователю' }, 403)
    let replyTo = toInt(body.replyTo) || null
    if (replyTo) {
      const target = q.message.get(replyTo)
      if (!target || Number(target.conversation_id) !== ctx.convId) replyTo = null
    }
    const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : null
    const message = postMessage(ctx.convId, ctx.me, { body: parsed.body, replyTo, clientId })
    return c.json({ message })
  })

  function ownMessage(c, ctx) {
    const mid = toInt(c.req.param('mid'))
    const r = mid && q.message.get(mid)
    if (!r || Number(r.conversation_id) !== ctx.convId || r.deleted_at) return { error: c.json({ error: 'not_found', message: 'Сообщение не найдено' }, 404) }
    if (Number(r.author_id) !== ctx.me) return { error: c.json({ error: 'forbidden', message: 'Можно менять только свои сообщения' }, 403) }
    return { r, mid }
  }

  app.patch('/api/conversations/:id/messages/:mid', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const own = ownMessage(c, ctx)
    if (own.error) return own.error
    if (own.r.kind !== 'text') return c.json({ error: 'forbidden', message: 'Это сообщение нельзя изменить' }, 403)
    const body = await c.req.json().catch(() => ({}))
    const parsed = readBody(body.body)
    if (parsed.error) return c.json(parsed, 400)
    if (!rateLimit(`edit:${ctx.me}`, 20, 10000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    if (parsed.body !== own.r.body) q.editMessage.run(parsed.body, Date.now(), own.mid)
    const message = messageView(q.message.get(own.mid))
    hub.publish(memberIds(ctx.convId), 'message.updated', { message })
    return c.json({ message })
  })

  app.delete('/api/conversations/:id/messages/:mid', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const own = ownMessage(c, ctx)
    if (own.error) return own.error
    q.deleteMessage.run(Date.now(), own.mid)
    hub.publish(memberIds(ctx.convId), 'message.deleted', { conversationId: ctx.convId, id: own.mid })
    return c.json({ ok: true })
  })

  app.post('/api/conversations/:id/read', async (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    const body = await c.req.json().catch(() => ({}))
    const maxId = Number(q.maxId.get(ctx.convId).id) || 0
    const upTo = Math.min(toInt(body.messageId) || maxId, maxId)
    if (upTo > Number(ctx.mine.last_read_id)) {
      q.setRead.run(upTo, ctx.convId, ctx.me)
      // Себе (другие вкладки/устройства сбросят счётчик) и собеседнику (отметка «прочитано»)
      hub.publish(memberIds(ctx.convId), 'read', { conversationId: ctx.convId, userId: ctx.me, lastReadId: upTo })
    }
    return c.json({ ok: true, lastReadId: Math.max(upTo, Number(ctx.mine.last_read_id)) })
  })

  app.post('/api/conversations/:id/typing', (c) => {
    const ctx = requireMember(c)
    if (ctx.error) return ctx.error
    // Клиент шлёт не чаще раза в 3 с; сервер дополнительно не пропускает чаще раза в 2 с
    if (rateLimit(`typing:${ctx.me}:${ctx.convId}`, 1, 2000) && !dmBlocked(ctx.convId, ctx.me)) {
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
