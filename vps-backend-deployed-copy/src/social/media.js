// ===================== Файлы: загрузка кусками и раздача =====================
// Загрузка идёт кусками по 768 КБ: у nginx по умолчанию лимит тела запроса 1 МБ, и так его
// конфиг трогать не нужно. Порядок: POST /api/uploads (что и сколько) -> PUT .../chunk?index=N
// (куски по порядку) -> POST .../finish. Тип файла сервер определяет сам по первым байтам,
// а не по имени или заявленному типу: картинкой считается только то, что ею является.
//
// Раздача: GET /api/files/:id — с поддержкой Range (перемотка видео и голосовых). Аватарки,
// фоны профиля и обои видны всем вошедшим; вложения — только участникам чата, где они лежат.
// Всё, что не картинка/видео/аудио, отдаётся как скачивание (application/octet-stream),
// с nosniff и запрещающим CSP — открыть загруженный HTML/SVG как страницу сайта нельзя.
import { randomBytes } from 'node:crypto'
import { mkdirSync, appendFileSync, writeFileSync, statSync, renameSync, unlinkSync, openSync, readSync, closeSync, createReadStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { rateLimit, fileUrl } from './db.js'

export const CHUNK_SIZE = 768 * 1024
const MB = 1024 * 1024
const LIMITS = { attachment: 64 * MB, avatar: 5 * MB, banner: 30 * MB, wallpaper: 10 * MB }
const ALLOWED_KINDS = {
  attachment: null, // любые
  avatar: ['image'],
  banner: ['image', 'video'],
  wallpaper: ['image']
}
const UPLOAD_TTL_MS = 60 * 60 * 1000

// Что это за файл на самом деле — по сигнатуре в начале
export function sniff(head, declared = '') {
  const s = (a, b) => head.subarray(a, b).toString('latin1')
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' }
  if (head[0] === 0x89 && s(1, 4) === 'PNG') return { kind: 'image', mime: 'image/png' }
  if (s(0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' }
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' }
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' }
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12)
    if (declared.startsWith('audio/') || brand === 'M4A ' || brand === 'M4B ') return { kind: 'audio', mime: 'audio/mp4' }
    return { kind: 'video', mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' }
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return declared.startsWith('audio/') ? { kind: 'audio', mime: 'audio/webm' } : { kind: 'video', mime: 'video/webm' }
  }
  if (s(0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg' }
  if (s(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg' }
  return { kind: 'file', mime: 'application/octet-stream' }
}

function cleanName(raw) {
  const name = String(raw || 'file').replace(/[\u0000-\u001f\u007f/\\]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120)
  return name || 'file'
}

function num(v, max) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : undefined
}

export function registerMediaRoutes(app, { db, dataDir, profile }) {
  const tmpDir = join(dataDir, 'uploads', 'tmp')
  const filesDir = join(dataDir, 'uploads', 'files')
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(filesDir, { recursive: true })

  const q = {
    insert: db.prepare('INSERT INTO files (id, owner_id, purpose, kind, name, mime, size, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    file: db.prepare('SELECT * FROM files WHERE id = ?'),
    inChatOf: db.prepare(`SELECT 1 FROM message_files mf JOIN messages m ON m.id = mf.message_id
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE mf.file_id = ? LIMIT 1`),
    setAvatar: db.prepare('UPDATE users SET avatar_file = ? WHERE id = ?'),
    setBanner: db.prepare('UPDATE users SET banner_file = ?, banner_kind = ? WHERE id = ?')
  }
  const uploads = new Map() // uploadId -> {userId, purpose, name, mime, size, voice, received, next, path, createdAt}

  function fileView(row) {
    if (!row) return null
    let meta = null
    try { meta = row.meta ? JSON.parse(row.meta) : null } catch {}
    return { id: row.id, kind: row.kind, name: row.name, mime: row.mime, size: Number(row.size), url: fileUrl(row.id), meta }
  }

  function dropUpload(id) {
    const u = uploads.get(id)
    uploads.delete(id)
    if (u) try { unlinkSync(u.path) } catch {}
  }
  setInterval(() => {
    const now = Date.now()
    for (const [id, u] of uploads) if (now - u.createdAt > UPLOAD_TTL_MS) dropUpload(id)
  }, 10 * 60 * 1000).unref()

  // Начать загрузку
  app.post('/api/uploads', async (c) => {
    const me = Number(c.get('user').id)
    const body = await c.req.json().catch(() => ({}))
    const purpose = String(body.purpose || 'attachment')
    if (!(purpose in LIMITS)) return c.json({ error: 'bad_purpose', message: 'Неизвестный тип загрузки' }, 400)
    const size = Math.floor(Number(body.size) || 0)
    if (size <= 0) return c.json({ error: 'empty', message: 'Пустой файл' }, 400)
    if (size > LIMITS[purpose]) return c.json({ error: 'too_big', message: `Файл больше ${Math.round(LIMITS[purpose] / MB)} МБ` }, 413)
    if (!rateLimit(`upload:${me}`, 60, 10 * 60 * 1000)) return c.json({ error: 'rate_limited', message: 'Слишком много загрузок, подождите' }, 429)
    const id = randomBytes(12).toString('hex')
    const path = join(tmpDir, id)
    writeFileSync(path, Buffer.alloc(0))
    uploads.set(id, {
      userId: me, purpose, size, voice: !!body.voice,
      name: cleanName(body.name), mime: String(body.mime || '').slice(0, 100),
      received: 0, next: 0, path, createdAt: Date.now()
    })
    return c.json({ uploadId: id, chunkSize: CHUNK_SIZE })
  })

  // Очередной кусок (строго по порядку)
  app.put('/api/uploads/:id/chunk', async (c) => {
    const me = Number(c.get('user').id)
    const u = uploads.get(c.req.param('id'))
    if (!u || u.userId !== me) return c.json({ error: 'not_found', message: 'Загрузка не найдена' }, 404)
    const index = Number(c.req.query('index'))
    if (index !== u.next) return c.json({ error: 'bad_index', message: 'Куски пришли не по порядку', expected: u.next }, 409)
    const buf = Buffer.from(await c.req.arrayBuffer())
    if (!buf.length || buf.length > CHUNK_SIZE) return c.json({ error: 'bad_chunk', message: 'Неверный размер куска' }, 400)
    if (u.received + buf.length > u.size) { dropUpload(c.req.param('id')); return c.json({ error: 'too_big', message: 'Файл больше заявленного' }, 413) }
    appendFileSync(u.path, buf)
    u.received += buf.length
    u.next += 1
    return c.json({ ok: true, received: u.received })
  })

  // Завершить: проверить, определить тип, сохранить
  app.post('/api/uploads/:id/finish', async (c) => {
    const me = Number(c.get('user').id)
    const uploadId = c.req.param('id')
    const u = uploads.get(uploadId)
    if (!u || u.userId !== me) return c.json({ error: 'not_found', message: 'Загрузка не найдена' }, 404)
    if (u.received !== u.size) return c.json({ error: 'incomplete', message: 'Файл загружен не полностью' }, 400)
    const body = await c.req.json().catch(() => ({}))
    const head = Buffer.alloc(64)
    const fd = openSync(u.path, 'r')
    try { readSync(fd, head, 0, 64, 0) } finally { closeSync(fd) }
    let { kind, mime } = sniff(head, u.mime)
    const allowed = ALLOWED_KINDS[u.purpose]
    if (allowed && !allowed.includes(kind)) {
      dropUpload(uploadId)
      const what = u.purpose === 'banner' ? 'картинку, GIF или видео' : 'картинку (JPG, PNG, GIF, WebP)'
      return c.json({ error: 'bad_type', message: `Нужна ${what}` }, 400)
    }
    if (u.purpose === 'attachment' && u.voice && kind === 'audio') kind = 'voice'
    const meta = {}
    const m = body.meta || {}
    if (num(m.width, 20000)) meta.width = Math.round(num(m.width, 20000))
    if (num(m.height, 20000)) meta.height = Math.round(num(m.height, 20000))
    if (num(m.duration, 24 * 3600)) meta.duration = Math.round(num(m.duration, 24 * 3600) * 10) / 10
    if (Array.isArray(m.waveform)) meta.waveform = m.waveform.slice(0, 64).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))

    const fileId = randomBytes(16).toString('hex')
    renameSync(u.path, join(filesDir, fileId))
    uploads.delete(uploadId)
    q.insert.run(fileId, me, u.purpose, kind, u.name, mime, u.size, Object.keys(meta).length ? JSON.stringify(meta) : null, Date.now())

    if (u.purpose === 'avatar') { q.setAvatar.run(fileId, me); profile.broadcastUser(me) }
    if (u.purpose === 'banner') { q.setBanner.run(fileId, kind === 'video' ? 'video' : 'image', me); profile.broadcastUser(me) }
    return c.json({ file: fileView(q.file.get(fileId)) })
  })

  app.delete('/api/profile/avatar', (c) => {
    const me = Number(c.get('user').id)
    q.setAvatar.run(null, me)
    profile.broadcastUser(me)
    return c.json(profile.profileOf(me))
  })
  app.delete('/api/profile/banner', (c) => {
    const me = Number(c.get('user').id)
    q.setBanner.run(null, null, me)
    profile.broadcastUser(me)
    return c.json(profile.profileOf(me))
  })

  // Раздача
  app.get('/api/files/:id', (c) => {
    const me = Number(c.get('user').id)
    const id = String(c.req.param('id') || '')
    const row = /^[0-9a-f]{32}$/.test(id) ? q.file.get(id) : null
    const path = row && join(filesDir, row.id)
    const deny = () => c.json({ error: 'not_found', message: 'Файл не найден' }, 404)
    if (!row || !existsSync(path)) return deny()
    if (row.purpose === 'attachment' && Number(row.owner_id) !== me && !q.inChatOf.get(me, id)) return deny()

    const size = statSync(path).size
    const media = row.kind !== 'file'
    const download = !media || c.req.query('download') === '1'
    const headers = {
      'Content-Type': media ? row.mime : 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.name)}`
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('Range') || '')
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      start = Math.max(0, start)
      end = Math.min(end, size - 1)
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      const stream = Readable.toWeb(createReadStream(path, { start, end }))
      return new Response(stream, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } })
    }
    return new Response(Readable.toWeb(createReadStream(path)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  })

  return {
    fileView,
    // Файл можно прикрепить к сообщению: свой, для вложений, ещё ни к чему не прикреплён
    claimable: db.prepare(`SELECT * FROM files WHERE id = ? AND owner_id = ? AND purpose = 'attachment'
      AND NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = files.id)`),
    getFile: (id) => q.file.get(id),
    // Файл больше нигде не прикреплён — удалить с диска (после «удалить у всех»)
    removeIfOrphan(id) {
      if (db.prepare('SELECT 1 FROM message_files WHERE file_id = ? LIMIT 1').get(id)) return
      db.prepare("DELETE FROM files WHERE id = ? AND purpose = 'attachment'").run(id)
      try { unlinkSync(join(filesDir, id)) } catch {}
    }
  }
}
