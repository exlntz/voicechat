// ===================== Профиль: юзернейм и «был в сети» =====================
// Юзернейм хранится без «@» (по нему входят в аккаунт); «@» дорисовывает интерфейс.
// Смена юзернейма сразу видна друзьям и собеседникам: им уходит событие user.update.
import { publicUser, rateLimit } from './db.js'

const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/

export function cleanUsername(raw) {
  return String(raw || '').trim().replace(/^@+/, '')
}

export function registerProfileRoutes(app, { db, hub }) {
  const q = {
    user: db.prepare('SELECT id, username, display_name, show_last_seen FROM users WHERE id = ?'),
    byLower: db.prepare('SELECT id FROM users WHERE username_lower = ?'),
    setUsername: db.prepare('UPDATE users SET username = ?, username_lower = ? WHERE id = ?'),
    setShowLastSeen: db.prepare('UPDATE users SET show_last_seen = ? WHERE id = ?'),
    // Кому сообщить о смене: друзья, заявки и все, с кем есть личка
    audience: db.prepare(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = ? OR user_b = ?
      UNION SELECT m2.user_id FROM conversation_members m1 JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
      WHERE m1.user_id = ? AND m2.user_id != ?`)
  }

  function profileOf(id) {
    const row = q.user.get(id)
    if (!row) return null
    return { user: publicUser(row), settings: { showLastSeen: !!row.show_last_seen } }
  }

  // Проверка юзернейма: формат и свободен ли (свой текущий — «свободен»)
  function check(me, raw) {
    const username = cleanUsername(raw)
    if (!USERNAME_RE.test(username)) {
      return { valid: false, available: false, username, message: '3–24 символа: английские буквы, цифры, _ и -' }
    }
    const taken = q.byLower.get(username.toLowerCase())
    if (taken && Number(taken.id) !== me) return { valid: true, available: false, username, message: 'Этот юзернейм уже занят' }
    return { valid: true, available: true, username, message: 'Свободен' }
  }

  app.get('/api/profile', (c) => {
    const me = Number(c.get('user').id)
    return c.json(profileOf(me))
  })

  app.get('/api/users/check', (c) => {
    const me = Number(c.get('user').id)
    if (!rateLimit(`ucheck:${me}`, 60, 60000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    return c.json(check(me, c.req.query('username')))
  })

  app.patch('/api/profile', async (c) => {
    const me = Number(c.get('user').id)
    const body = await c.req.json().catch(() => ({}))
    let changedUser = false

    if (body.username !== undefined) {
      const res = check(me, body.username)
      if (!res.valid) return c.json({ error: 'invalid_username', message: res.message }, 400)
      if (!res.available) return c.json({ error: 'username_taken', message: res.message }, 409)
      const current = q.user.get(me)
      if (current && current.username !== res.username) {
        if (!rateLimit(`uname:${me}`, 5, 60 * 60 * 1000)) {
          return c.json({ error: 'rate_limited', message: 'Юзернейм можно менять не чаще 5 раз в час' }, 429)
        }
        try {
          q.setUsername.run(res.username, res.username.toLowerCase(), me)
        } catch {
          return c.json({ error: 'username_taken', message: 'Этот юзернейм уже занят' }, 409)
        }
        changedUser = true
      }
    }

    if (typeof body.showLastSeen === 'boolean') {
      q.setShowLastSeen.run(body.showLastSeen ? 1 : 0, me)
    }

    const profile = profileOf(me)
    if (changedUser) {
      const ids = q.audience.all(me, me, me, me, me).map((r) => Number(r.id))
      hub.publish([me, ...ids], 'user.update', { user: profile.user })
    }
    return c.json(profile)
  })
}
