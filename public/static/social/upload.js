// ===================== Загрузка файлов: кусками, с прогрессом =====================
// Сервер принимает файл кусками по 768 КБ (лимит nginx — 1 МБ на запрос). Перед отправкой:
//  · большие фото (JPG/PNG/WebP) пережимаются в JPEG до 2560 px по длинной стороне — как в
//    мессенджерах; GIF и маленькие картинки уходят как есть;
//  · у фото и видео меряем размеры (чтобы лента не прыгала, пока картинка грузится),
//    у видео и голосовых — длительность.
import { ApiError } from './api.js'

const MAX_SIDE = 2560
const RECOMPRESS_OVER = 1.5 * 1024 * 1024

async function call(method, path, body, raw) {
  let res
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' },
      body: raw || JSON.stringify(body || {})
    })
  } catch { throw new ApiError(0, null) }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

// file: File/Blob; purpose: attachment | avatar | banner | wallpaper
// onProgress(0..1); signal — AbortSignal для отмены
export async function uploadFile(file, { purpose = 'attachment', name, voice = false, meta = null, onProgress, signal } = {}) {
  const fileName = name || file.name || 'file'
  const start = await call('POST', '/api/uploads', { purpose, size: file.size, name: fileName, mime: file.type || '', voice })
  const { uploadId, chunkSize } = start
  let sent = 0
  for (let i = 0; sent < file.size; i++) {
    if (signal && signal.aborted) throw new ApiError(0, { message: 'Загрузка отменена' })
    const part = file.slice(sent, sent + chunkSize)
    await call('PUT', `/api/uploads/${uploadId}/chunk?index=${i}`, null, part)
    sent += part.size
    if (onProgress) onProgress(sent / file.size)
  }
  const { file: saved } = await call('POST', `/api/uploads/${uploadId}/finish`, { meta: meta || {} })
  return saved
}

// ---------- Подготовка ----------
export function kindOf(file) {
  const t = file.type || ''
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  return 'file'
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

// Размеры и, если нужно, пережатие фото. Возвращает {file, meta}
export async function prepareImage(file, { maxSide = MAX_SIDE, force = false } = {}) {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    let w = img.naturalWidth
    let h = img.naturalHeight
    const isGif = file.type === 'image/gif'
    const big = Math.max(w, h) > maxSide
    if (isGif || (!force && !big && file.size < RECOMPRESS_OVER)) return { file, meta: { width: w, height: h } }
    const k = Math.min(1, maxSide / Math.max(w, h))
    w = Math.round(w * k)
    h = Math.round(h * k)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff' // прозрачный PNG в JPEG — на белом, а не на чёрном
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86))
    if (!blob || blob.size >= file.size) return { file, meta: { width: img.naturalWidth, height: img.naturalHeight } }
    const out = new File([blob], String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
    return { file: out, meta: { width: w, height: h } }
  } catch {
    return { file, meta: {} }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Квадратная аватарка 512×512 из середины картинки
export async function squareAvatar(file) {
  if (file.type === 'image/gif') return file // GIF-аватарка остаётся живой
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const size = Math.min(512, side)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
    return blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function probeMedia(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video')
    el.preload = 'metadata'
    el.muted = true
    const done = (meta) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(meta) }
    const timer = setTimeout(() => done({}), 5000)
    el.onloadedmetadata = () => {
      const meta = {}
      if (Number.isFinite(el.duration)) meta.duration = el.duration
      if (el.videoWidth) { meta.width = el.videoWidth; meta.height = el.videoHeight }
      done(meta)
    }
    el.onerror = () => done({})
    el.src = url
  })
}

// Файл из буфера/перетаскивания/выбора -> {file, kind, meta, previewUrl}
export async function prepareAttachment(file) {
  const kind = kindOf(file)
  if (kind === 'image') {
    const { file: out, meta } = await prepareImage(file)
    return { file: out, kind, meta, previewUrl: URL.createObjectURL(out) }
  }
  if (kind === 'video' || kind === 'audio') {
    const meta = await probeMedia(file)
    return { file, kind, meta, previewUrl: kind === 'video' ? URL.createObjectURL(file) : null }
  }
  return { file, kind, meta: {}, previewUrl: null }
}

// Форма волны голосового: 48 столбиков 0..1 по громкости
export async function waveformOf(blob, bars = 48) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    ctx.close().catch(() => {})
    const data = buf.getChannelData(0)
    const step = Math.max(1, Math.floor(data.length / bars))
    const out = []
    for (let i = 0; i < bars; i++) {
      let sum = 0
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) sum += data[j] * data[j]
      out.push(Math.sqrt(sum / step))
    }
    const max = Math.max(...out, 0.001)
    return { waveform: out.map((v) => Math.round((v / max) * 100) / 100), duration: buf.duration }
  } catch {
    return { waveform: [], duration: 0 }
  }
}
