// ===================== Выбор области: аватарка (круг) и фон профиля (полоса 3:1) =====================
// Как в Телеграме: картинку или видео двигают пальцем/мышью под рамкой и приближают колёсиком,
// ползунком или щипком.
//  · обычная картинка — вырезается по рамке прямо в браузере (JPEG);
//  · видео и GIF — не режутся (иначе пропадёт движение): загружаются целиком, а выбранная
//    рамка сохраняется долями {x, y, w, h} и применяется при показе (см. bannerMedia в ui.js).
import { h, icon } from './ui.js'

const MARGIN = 24 // отступ рамки от краёв области
const MAX_ZOOM = 5

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}
function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.loop = true
    v.autoplay = true
    v.playsInline = true
    v.preload = 'auto'
    v.onloadeddata = () => resolve(v)
    v.onerror = reject
    v.src = url
    setTimeout(() => reject(new Error('timeout')), 15000)
  })
}

// Аватарка: File с вырезанным квадратом или null («Отмена»)
export async function cropAvatar(file) {
  const r = await openCropper(file, { aspect: 1, round: true, title: 'Аватарка', hint: 'Передвиньте картинку и выберите, что будет в кружке.', maxWidth: 1024, name: 'avatar.jpg' })
  return r ? r.file : null
}

// Фон профиля: {file, crop, meta} или null
export function cropBanner(file) {
  return openCropper(file, { aspect: 3, round: false, title: 'Фон профиля', hint: 'Выберите, какая часть будет видна в профиле.', maxWidth: 1800, name: 'banner.jpg' })
}

export async function openCropper(file, { aspect = 1, round = false, title, hint, maxWidth = 1024, name = 'image.jpg' }) {
  const url = URL.createObjectURL(file)
  const isVideo = (file.type || '').startsWith('video/')
  const keepWhole = isVideo || file.type === 'image/gif' // не режем — сохраняем рамку
  let media
  try {
    media = isVideo ? await loadVideo(url) : await loadImage(url)
  } catch {
    URL.revokeObjectURL(url)
    throw new Error(isVideo ? 'Не получилось открыть видео' : 'Не получилось открыть картинку')
  }
  const w = isVideo ? media.videoWidth : media.naturalWidth
  const hh = isVideo ? media.videoHeight : media.naturalHeight
  if (!w || !hh) { URL.revokeObjectURL(url); throw new Error('Не получилось открыть файл') }

  // Размер области: рамка во всю ширину окна (на телефоне — сколько влезает)
  const maxStage = aspect > 1 ? 480 : 320
  const stageW = Math.max(220, Math.min(maxStage, window.innerWidth - 80))
  const FW = stageW - MARGIN * 2 // рамка
  const FH = FW / aspect
  const stageH = FH + MARGIN * 2
  const base = Math.max(FW / w, FH / hh) // при zoom = 1 картинка ровно закрывает рамку
  let zoom = 1
  let x = 0
  let y = 0

  return new Promise((resolve) => {
    media.className = 'vl-crop__img'
    media.setAttribute('draggable', 'false')
    if (isVideo) media.play().catch(() => {})
    const stage = h('div', { class: 'vl-crop__stage', style: { width: stageW + 'px', height: stageH + 'px' }, tabindex: '0', 'aria-label': 'Область: двигайте, колёсико — приблизить' }, [
      media,
      h('div', { class: `vl-crop__ring${round ? '' : ' is-rect'}`, style: { left: MARGIN + 'px', top: MARGIN + 'px', width: FW + 'px', height: FH + 'px' } })
    ])
    const slider = h('input', { type: 'range', class: 'vl-crop__zoom', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', 'aria-label': 'Масштаб' })
    const cancel = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost' }, 'Отмена')
    const ok = h('button', { type: 'button', class: 'vl-btn vl-btn--primary' }, 'Готово')
    const card = h('div', { class: 'vl-modal vl-crop', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('h3', { class: 'vl-modal__title' }, title),
      h('p', { class: 'vl-modal__text' }, hint),
      stage,
      h('div', { class: 'vl-crop__bar' }, [icon('image', 'is-small'), slider, icon('image')]),
      h('div', { class: 'vl-modal__actions' }, [cancel, ok])
    ])
    const overlay = h('div', { class: 'vl-modal-overlay vl-crop-overlay' }, [card])

    const scale = () => base * zoom
    // Рамка всегда закрыта картинкой: край картинки не заходит внутрь рамки
    function clamp() {
      const s = scale()
      x = Math.min(MARGIN, Math.max(MARGIN + FW - w * s, x))
      y = Math.min(MARGIN, Math.max(MARGIN + FH - hh * s, y))
    }
    function paint() {
      media.style.width = w + 'px'
      media.style.height = hh + 'px'
      media.style.transform = `translate(${x}px, ${y}px) scale(${scale()})`
      slider.value = String(zoom)
    }
    // Приблизить вокруг точки (cx, cy) области — она остаётся на месте
    function setZoom(next, cx = stageW / 2, cy = stageH / 2) {
      const prev = scale()
      zoom = Math.max(1, Math.min(MAX_ZOOM, next))
      const k = scale() / prev
      x = cx - (cx - x) * k
      y = cy - (cy - y) * k
      clamp()
      paint()
    }
    // Старт: по центру
    x = (stageW - w * scale()) / 2
    y = (stageH - hh * scale()) / 2
    clamp()
    paint()

    // Перетаскивание и щипок (Pointer Events: мышь, палец, перо)
    const pointers = new Map()
    let pinch = null
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      stage.classList.add('is-dragging')
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
      }
    })
    stage.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId)
      if (!p) return
      const dx = e.clientX - p.x
      const dy = e.clientY - p.y
      p.x = e.clientX
      p.y = e.clientY
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()]
        const r = stage.getBoundingClientRect()
        setZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top)
        return
      }
      x += dx
      y += dy
      clamp()
      paint()
    })
    const up = (e) => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      if (!pointers.size) stage.classList.remove('is-dragging')
    }
    stage.addEventListener('pointerup', up)
    stage.addEventListener('pointercancel', up)
    stage.addEventListener('wheel', (e) => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }, { passive: false })
    stage.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 30 : 10
      if (e.key === 'ArrowLeft') x += step
      else if (e.key === 'ArrowRight') x -= step
      else if (e.key === 'ArrowUp') y += step
      else if (e.key === 'ArrowDown') y -= step
      else if (e.key === '+' || e.key === '=') { setZoom(zoom * 1.1); return }
      else if (e.key === '-') { setZoom(zoom / 1.1); return }
      else return
      e.preventDefault()
      clamp()
      paint()
    })
    slider.addEventListener('input', () => setZoom(Number(slider.value)))

    function close(result) {
      document.removeEventListener('keydown', onKey, true)
      if (isVideo) media.pause()
      overlay.classList.add('is-leaving')
      setTimeout(() => { overlay.remove(); URL.revokeObjectURL(url) }, 160)
      resolve(result)
    }
    async function done() {
      ok.disabled = true
      const s = scale()
      // Рамка в пикселях исходника
      const sx = (MARGIN - x) / s
      const sy = (MARGIN - y) / s
      const sw = FW / s
      const sh = FH / s
      if (keepWhole) {
        const crop = { x: sx / w, y: sy / hh, w: sw / w, h: sh / hh }
        const meta = { width: w, height: hh }
        if (isVideo && Number.isFinite(media.duration)) meta.duration = media.duration
        close({ file, crop, meta })
        return
      }
      const outW = Math.max(1, Math.min(maxWidth, Math.round(sw)))
      const outH = Math.max(1, Math.round(outW / aspect))
      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff' // прозрачный PNG — на белом
      ctx.fillRect(0, 0, outW, outH)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(media, sx, sy, sw, sh, 0, 0, outW, outH)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
      close(blob ? { file: new File([blob], name, { type: 'image/jpeg' }), crop: null, meta: { width: outW, height: outH } } : null)
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null) }
      if (e.key === 'Enter') { e.preventDefault(); done() }
    }
    cancel.addEventListener('click', () => close(null))
    ok.addEventListener('click', done)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null) })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    stage.focus({ preventScroll: true })
  })
}
