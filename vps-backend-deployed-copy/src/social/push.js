// ===================== Push-уведомления (сайт на экране «Домой» iPhone, Android, ПК) =====================
// Когда человека нет на сайте (закрыт/свёрнут — нет живого реалтайм-соединения) или он «Отошёл»,
// сервер отправляет push через службу браузера (Apple / Google / Mozilla). Сервис-воркер
// (public/static/sw.js) показывает уведомление, нажатие открывает нужный чат.
// Ключи VAPID создаются один раз и хранятся в базе (или задаются VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).
import webpush from 'web-push'
import { rateLimit } from './db.js'

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:push@voicelobby.app'

export function createPush({ db, hub }) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)')

  // Ключи: из окружения, иначе из базы, иначе создать и сохранить
  const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  const setSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
  let publicKey = process.env.VAPID_PUBLIC_KEY
  let privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    const saved = getSetting.get('vapid')
    if (saved) ({ publicKey, privateKey } = JSON.parse(saved.value))
    else {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys())
      setSetting.run('vapid', JSON.stringify({ publicKey, privateKey }))
    }
  }
  webpush.setVapidDetails(SUBJECT, publicKey, privateKey)

  const q = {
    upsert: db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    remove: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    removeOwn: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'),
    ofUser: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
  }

  // Человек «не здесь»: сайт нигде не открыт или он давно не трогал клавиатуру/экран
  function isAway(userId) {
    if (!hub.isOnline(userId)) return true
    return hub.presenceOf(userId).status === 'idle'
  }

  // payload: {title, body, tag, url}
  function send(userId, payload, { force = false } = {}) {
    if (!force && !isAway(userId)) return
    const subs = q.ofUser.all(Number(userId))
    if (!subs.length) return
    const data = JSON.stringify(payload)
    for (const s of subs) {
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data, { TTL: 6 * 3600, urgency: 'high' })
        .catch((e) => {
          // Подписка умерла (удалили приложение, отозвали разрешение) — забываем её
          if (e && (e.statusCode === 404 || e.statusCode === 410)) q.remove.run(s.endpoint)
          else console.error('[push]', e && (e.statusCode || e.message))
        })
    }
  }

  function mount(app) {
    app.get('/api/push/key', (c) => c.json({ publicKey }))
    app.post('/api/push/subscribe', async (c) => {
      const me = Number(c.get('user').id)
      if (!rateLimit(`pushsub:${me}`, 20, 60000)) return c.json({ error: 'rate_limited', message: 'Слишком часто' }, 429)
      const body = await c.req.json().catch(() => ({}))
      const sub = body.subscription || {}
      const endpoint = String(sub.endpoint || '')
      const keys = sub.keys || {}
      if (!/^https:\/\/[^\s]{8,}$/.test(endpoint) || endpoint.length > 1024 || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
        return c.json({ error: 'bad_subscription', message: 'Неверная подписка' }, 400)
      }
      q.upsert.run(endpoint, me, keys.p256dh, keys.auth, Date.now())
      return c.json({ ok: true })
    })
    app.post('/api/push/unsubscribe', async (c) => {
      const me = Number(c.get('user').id)
      const body = await c.req.json().catch(() => ({}))
      if (body.endpoint) q.removeOwn.run(String(body.endpoint), me)
      return c.json({ ok: true })
    })
  }

  return { send, mount, isAway, publicKey }
}

// Текст уведомления о сообщении: как в списке чатов
const KIND_LABEL = { image: 'Фото', video: 'Видео', voice: 'Голосовое сообщение', audio: 'Аудио', file: 'Файл' }
export function messagePushText(message) {
  if (message.kind === 'call') return 'Звонок'
  const text = String(message.body || '').replace(/\s+/g, ' ').trim()
  const files = message.attachments || []
  if (!files.length) return text.slice(0, 160) || 'Сообщение'
  const first = files[0]
  const label = files.length > 1 ? `${KIND_LABEL[first.kind] || 'Файл'} ×${files.length}` : (first.kind === 'file' ? first.name : (KIND_LABEL[first.kind] || 'Файл'))
  return (label + (text ? ' · ' + text : '')).slice(0, 160)
}
