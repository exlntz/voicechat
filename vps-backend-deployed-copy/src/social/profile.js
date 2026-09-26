// ===================== Профиль: отображаемое имя, юзернейм и «был в сети» =====================
// Юзернейм хранится без «@» (по нему входят в аккаунт); «@» дорисовывает интерфейс.
// Смена юзернейма сразу видна друзьям и собеседникам: им уходит событие user.update.
import { publicUser, rateLimit, USER_COLS, USERNAME_RE, USERNAME_HINT } from './db.js'

const DISPLAY_NAME_RE = /^[\p{L}\p{N}_\- ]{1,40}$/u

export function cleanUsername(raw) {
  return String(raw || '').trim().replace(/^@+/, '')
}

export function registerProfileRoutes(app, { db, hub }) {
  const q = {
    user: db.prepare(`SELECT ${USER_COLS}, show_last_seen, created_at FROM users WHERE id = ?`),
    byLower: db.prepare('SELECT id FROM users WHERE username_lower = ?'),
    setUsername: db.prepare('UPDATE users SET username = ?, username_lower = ? WHERE id = ?'),
    setShowLastSeen: db.prepare('UPDATE users SET show_last_seen = ? WHERE id = ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    // Кому сообщить о смене: друзья, заявки и все, с кем есть личка
    audience: db.prepare(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = ? OR user_b = ?
      UNION SELECT m2.user_id FROM conversation_members m1 JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
      WHERE m1.user_id = ? AND m2.user_id != ?`)
  }

  function profileOf(id) {
    const row = q.user.get(id)
    if (!row) return null
    // createdAt — только в своём профиле (дата регистрации, SQLite хранит её в UTC)
    return { user: publicUser(row), settings: { showLastSeen: !!row.show_last_seen, createdAt: row.created_at ? String(row.created_at).replace(' ', 'T') + 'Z' : null } }
  }

  // Проверка юзернейма: формат и свободен ли (свой текущий — «свободен»)
  function check(me, raw) {
    const username = cleanUsername(raw)
    if (!USERNAME_RE.test(username)) {
      return { valid: false, available: false, username, message: USERNAME_HINT }
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

    // Отображаемое имя: 1–40 символов (буквы любого языка, цифры, пробел, _ и -), как при регистрации
    if (body.displayName !== undefined) {
      const name = String(body.displayName || '').replace(/\s+/g, ' ').trim()
      if (!DISPLAY_NAME_RE.test(name)) return c.json({ error: 'invalid_display_name', message: 'Имя: 1–40 символов — буквы, цифры, пробел, _ и -' }, 400)
      const current = q.user.get(me)
      if (current && current.display_name !== name) {
        if (!rateLimit(`dname:${me}`, 20, 60 * 60 * 1000)) return c.json({ error: 'rate_limited', message: 'Имя можно менять не чаще 20 раз в час' }, 429)
        q.setDisplayName.run(name, me)
        changedUser = true
      }
    }

    if (typeof body.showLastSeen === 'boolean') {
      q.setShowLastSeen.run(body.showLastSeen ? 1 : 0, me)
    }

    if (changedUser) broadcastUser(me)
    return c.json(profileOf(me))
  })

  // Разослать свежий вид пользователя (юзернейм, аватарка, фон) ему самому, друзьям и собеседникам
  function broadcastUser(userId) {
    const profile = profileOf(userId)
    if (!profile) return
    const ids = q.audience.all(userId, userId, userId, userId, userId).map((r) => Number(r.id))
    hub.publish([userId, ...ids], 'user.update', { user: profile.user })
  }

  return { broadcastUser, profileOf }
}
