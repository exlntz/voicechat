// ===================== Друзья: заявки, принятие, удаление, блокировка =====================
// Одна строка на пару (user_a < user_b). Как это выглядит для каждой стороны:
//   pending, requested_by = я      -> у меня «исходящая», у него «входящая»
//   accepted                       -> друзья у обоих
//   blocked, requested_by = я      -> у меня в «Заблокированных»; у него связи нет вовсе
//                                     (заблокированный не должен узнать о блокировке)
import { publicUser, getUserById, pairKey, toInt, rateLimit, USER_COLS } from './db.js'

export function registerFriendRoutes(app, { db, hub, push }) {
  const getRow = db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?')
  const insertRow = db.prepare('INSERT INTO friendships (user_a, user_b, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const updateRow = db.prepare('UPDATE friendships SET status = ?, requested_by = ?, updated_at = ? WHERE user_a = ? AND user_b = ?')
  const deleteRow = db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?')
  const listRows = db.prepare(`SELECT f.*, u.id AS uid, u.username, u.display_name, u.avatar_file, u.banner_file, u.banner_kind, u.banner_crop
    FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
    WHERE f.user_a = ? OR f.user_b = ?`)
  const byUsername = db.prepare(`SELECT ${USER_COLS} FROM users WHERE username_lower = ?`)

  function row(me, other) {
    const [a, b] = pairKey(me, other)
    return getRow.get(a, b)
  }

  // Как связь выглядит со стороны me. null — связи нет (или меня заблокировали).
  function relationFor(me, r) {
    if (!r) return null
    if (r.status === 'accepted') return 'friend'
    if (r.status === 'pending') return Number(r.requested_by) === me ? 'outgoing' : 'incoming'
    if (r.status === 'blocked') return Number(r.requested_by) === me ? 'blocked' : null
    return null
  }

  function entryFor(me, other, r) {
    const status = relationFor(me, r)
    if (!status) return null
    const user = typeof other === 'object' ? other : getUserById(db, other)
    if (!user) return null
    return {
      user,
      status,
      since: Number(r.updated_at),
      presence: status === 'friend' ? hub.presenceOf(user.id) : { status: 'offline', inCall: false }
    }
  }

  // Разослать обеим сторонам их взгляд на связь (или удаление)
  function notifyBoth(me, other) {
    const r = row(me, other)
    for (const [viewer, target] of [[me, other], [other, me]]) {
      const entry = entryFor(viewer, target, r)
      if (entry) hub.publish([viewer], 'friend.update', entry)
      else hub.publish([viewer], 'friend.remove', { userId: target })
    }
  }

  // Используется чатами: можно ли этим двоим писать друг другу
  function isBlockedBetween(x, y) {
    const r = row(x, y)
    return !!r && r.status === 'blocked'
  }
  function areFriends(x, y) {
    const r = row(x, y)
    return !!r && r.status === 'accepted'
  }

  app.get('/api/friends', (c) => {
    const me = Number(c.get('user').id)
    const friends = []
    for (const r of listRows.all(me, me, me)) {
      const entry = entryFor(me, publicUser({ ...r, id: r.uid }), r)
      if (entry) friends.push(entry)
    }
    return c.json({ friends })
  })

  app.post('/api/friends/request', async (c) => {
    const me = Number(c.get('user').id)
    const body = await c.req.json().catch(() => ({}))
    const username = String(body.username || '').trim().replace(/^@/, '')
    if (!username) return c.json({ error: 'bad_request', message: 'Введите юзернейм' }, 400)
    if (!rateLimit(`friendreq:${me}`, 20, 10 * 60 * 1000)) {
      return c.json({ error: 'rate_limited', message: 'Слишком много заявок, попробуйте позже' }, 429)
    }
    const target = publicUser(byUsername.get(username.toLowerCase()))
    // Одинаковый ответ для «нет такого» и «он вас заблокировал» — блокировку не раскрываем
    const notFound = () => c.json({ error: 'not_found', message: 'Не получилось. Проверьте юзернейм — регистр букв не важен.' }, 404)
    if (!target) return notFound()
    if (target.id === me) return c.json({ error: 'self', message: 'Нельзя добавить в друзья самого себя' }, 400)

    const [a, b] = pairKey(me, target.id)
    const r = getRow.get(a, b)
    const now = Date.now()
    if (r) {
      const rel = relationFor(me, r)
      if (rel === 'friend') return c.json({ error: 'already_friends', message: 'Вы уже друзья' }, 409)
      if (rel === 'outgoing') return c.json({ error: 'already_requested', message: 'Заявка уже отправлена' }, 409)
      if (rel === 'blocked') return c.json({ error: 'blocked', message: 'Сначала разблокируйте пользователя' }, 409)
      if (rel === null) return notFound() // заблокировал он
      if (rel === 'incoming') {
        // Встречная заявка — сразу друзья
        updateRow.run('accepted', r.requested_by, now, a, b)
        notifyBoth(me, target.id)
        hub.broadcastPresence(me)
        hub.broadcastPresence(target.id)
        return c.json({ ok: true, friend: entryFor(me, target, getRow.get(a, b)) })
      }
    }
    insertRow.run(a, b, 'pending', me, now, now)
    if (push) { const who = getUserById(db, me); push.send(target.id, { title: 'Заявка в друзья', body: `${who ? who.displayName : 'Кто-то'} (@${who ? who.username : ''}) хочет добавить вас в друзья`, tag: 'friend-' + me, url: '/friends?tab=pending' }) }
    notifyBoth(me, target.id)
    return c.json({ ok: true, friend: entryFor(me, target, getRow.get(a, b)) })
  })

  app.post('/api/friends/:id/accept', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    const r = other && row(me, other)
    if (!r || relationFor(me, r) !== 'incoming') return c.json({ error: 'not_found', message: 'Заявка не найдена' }, 404)
    const [a, b] = pairKey(me, other)
    updateRow.run('accepted', r.requested_by, Date.now(), a, b)
    notifyBoth(me, other)
    // Теперь друзья видят статусы друг друга
    hub.broadcastPresence(me)
    hub.broadcastPresence(other)
    return c.json({ ok: true, friend: entryFor(me, other, getRow.get(a, b)) })
  })

  // Отклонить входящую или отменить свою исходящую
  app.post('/api/friends/:id/decline', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    const r = other && row(me, other)
    const rel = relationFor(me, r)
    if (rel !== 'incoming' && rel !== 'outgoing') return c.json({ error: 'not_found', message: 'Заявка не найдена' }, 404)
    deleteRow.run(...pairKey(me, other))
    notifyBoth(me, other)
    return c.json({ ok: true })
  })

  // Удалить из друзей (или отменить заявку)
  app.delete('/api/friends/:id', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    const r = other && row(me, other)
    const rel = relationFor(me, r)
    if (rel !== 'friend' && rel !== 'incoming' && rel !== 'outgoing') return c.json({ error: 'not_found', message: 'Пользователь не в друзьях' }, 404)
    deleteRow.run(...pairKey(me, other))
    notifyBoth(me, other)
    return c.json({ ok: true })
  })

  app.post('/api/friends/:id/block', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    if (!other || other === me || !getUserById(db, other)) return c.json({ error: 'not_found', message: 'Пользователь не найден' }, 404)
    const [a, b] = pairKey(me, other)
    const r = getRow.get(a, b)
    const now = Date.now()
    if (r && r.status === 'blocked') {
      // Уже заблокирован (мной или мной в ответ) — оставляем как есть
      return c.json({ ok: true })
    }
    if (r) updateRow.run('blocked', me, now, a, b)
    else insertRow.run(a, b, 'blocked', me, now, now)
    notifyBoth(me, other)
    return c.json({ ok: true })
  })

  app.delete('/api/friends/:id/block', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    const r = other && row(me, other)
    if (relationFor(me, r) !== 'blocked') return c.json({ error: 'not_found', message: 'Пользователь не заблокирован' }, 404)
    deleteRow.run(...pairKey(me, other))
    notifyBoth(me, other)
    return c.json({ ok: true })
  })

  // Карточка профиля (открывается из чата и списка друзей): видна, если есть связь
  // (друг, заявка) или общая личка. Для заблокировавшего — как будто пользователя нет.
  const sharedConv = db.prepare(`SELECT 1 FROM conversation_members a JOIN conversation_members b
    ON b.conversation_id = a.conversation_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`)
  app.get('/api/users/:id{[0-9]+}', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    const user = other && getUserById(db, other)
    if (!user) return c.json({ error: 'not_found', message: 'Пользователь не найден' }, 404)
    if (other === me) return c.json({ user, status: 'self', since: null, presence: hub.presenceOf(me) })
    const r = row(me, other)
    const status = relationFor(me, r)
    if (r && r.status === 'blocked' && status === null) return c.json({ error: 'not_found', message: 'Пользователь не найден' }, 404)
    if (!status && !sharedConv.get(me, other)) return c.json({ error: 'not_found', message: 'Пользователь не найден' }, 404)
    return c.json({
      user,
      status: status || 'none',
      since: status === 'friend' ? Number(r.updated_at) : null,
      presence: status === 'friend' ? hub.presenceOf(other) : { status: 'offline', inCall: false }
    })
  })

  return { isBlockedBetween, areFriends }
}
