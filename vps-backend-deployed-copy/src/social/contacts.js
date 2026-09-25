// ===================== Контакты: своё имя для человека =====================
// Как в Телеграме: можно записать собеседника так, как удобно («Мама», «Саша работа»).
// Имя видно только тому, кто его задал, — в списке чатов, шапке, друзьях и уведомлениях.
// Другие устройства того же пользователя узнают о смене через событие contact.update.
import { getUserById, toInt, rateLimit } from './db.js'

export const CONTACT_NAME_MAX = 64

export function registerContactRoutes(app, { db, hub }) {
  db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    owner_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, user_id)
  )`)
  const q = {
    list: db.prepare('SELECT user_id, name FROM contacts WHERE owner_id = ?'),
    upsert: db.prepare(`INSERT INTO contacts (owner_id, user_id, name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`),
    remove: db.prepare('DELETE FROM contacts WHERE owner_id = ? AND user_id = ?')
  }

  app.get('/api/contacts', (c) => {
    const me = Number(c.get('user').id)
    return c.json({ contacts: q.list.all(me).map((r) => ({ userId: Number(r.user_id), name: r.name })) })
  })

  // {name} — записать; пустое имя — убрать из контактов
  app.put('/api/contacts/:id{[0-9]+}', async (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    if (!other || other === me || !getUserById(db, other)) return c.json({ error: 'not_found', message: 'Пользователь не найден' }, 404)
    if (!rateLimit(`contact:${me}`, 30, 60000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
    const body = await c.req.json().catch(() => ({}))
    const name = String(body.name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CONTACT_NAME_MAX)
    if (name) q.upsert.run(me, other, name, Date.now())
    else q.remove.run(me, other)
    hub.publish([me], 'contact.update', { userId: other, name: name || null })
    return c.json({ ok: true, userId: other, name: name || null })
  })

  app.delete('/api/contacts/:id{[0-9]+}', (c) => {
    const me = Number(c.get('user').id)
    const other = toInt(c.req.param('id'))
    if (other) q.remove.run(me, other)
    hub.publish([me], 'contact.update', { userId: other, name: null })
    return c.json({ ok: true })
  })
}
