// ===================== Выбор области аватарки =====================
// Как в Телеграме: картинку двигают пальцем/мышью под круглой рамкой и приближают колёсиком,
// ползунком или щипком. «Готово» — вырезает квадрат под рамкой (до 1024×1024, JPEG).
import { h, icon } from './ui.js'

const MARGIN = 24 // отступ рамки от краёв области
const MAX_ZOOM = 5
const OUT_MAX = 1024

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

// Возвращает File с вырезанной областью или null, если нажали «Отмена»
export async function cropAvatar(file) {
  const url = URL.createObjectURL(file)
  let img
  try { img = await loadImage(url) } catch { URL.revokeObjectURL(url); throw new Error('Не получилось открыть картинку') }
  // Сторона области: 320 px, на узком телефоне — сколько влезает
  const STAGE = Math.max(220, Math.min(320, window.innerWidth - 80))
  const D = STAGE - MARGIN * 2 // диаметр рамки
  const w = img.naturalWidth
  const hh = img.naturalHeight
  const base = D / Math.min(w, hh) // при zoom = 1 картинка ровно закрывает рамку
  let zoom = 1
  let x = 0
  let y = 0

  return new Promise((resolve) => {
    const picture = h('img', { class: 'vl-crop__img', src: url, alt: '', draggable: 'false' })
    const stage = h('div', { class: 'vl-crop__stage', style: { width: STAGE + 'px', height: STAGE + 'px' }, tabindex: '0', 'aria-label': 'Область аватарки: двигайте картинку, колёсико — приблизить' }, [
      picture,
      h('div', { class: 'vl-crop__ring', style: { inset: MARGIN + 'px' } })
    ])
    const slider = h('input', { type: 'range', class: 'vl-crop__zoom', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', 'aria-label': 'Масштаб' })
    const cancel = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost' }, 'Отмена')
    const ok = h('button', { type: 'button', class: 'vl-btn vl-btn--primary' }, 'Готово')
    const card = h('div', { class: 'vl-modal vl-crop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Аватарка' }, [
      h('h3', { class: 'vl-modal__title' }, 'Аватарка'),
      h('p', { class: 'vl-modal__text' }, 'Передвиньте картинку и выберите, что будет в кружке.'),
      stage,
      h('div', { class: 'vl-crop__bar' }, [icon('image', 'is-small'), slider, icon('image')]),
      h('div', { class: 'vl-modal__actions' }, [cancel, ok])
    ])
    const overlay = h('div', { class: 'vl-modal-overlay vl-crop-overlay' }, [card])

    const scale = () => base * zoom
    // Рамка всегда закрыта картинкой: край картинки не заходит внутрь круга
    function clamp() {
      const s = scale()
      x = Math.min(MARGIN, Math.max(MARGIN + D - w * s, x))
      y = Math.min(MARGIN, Math.max(MARGIN + D - hh * s, y))
    }
    function paint() {
      picture.style.transform = `translate(${x}px, ${y}px) scale(${scale()})`
      slider.value = String(zoom)
    }
    // Приблизить вокруг точки (cx, cy) области — она остаётся на месте
    function setZoom(next, cx = STAGE / 2, cy = STAGE / 2) {
      const prev = scale()
      zoom = Math.max(1, Math.min(MAX_ZOOM, next))
      const k = scale() / prev
      x = cx - (cx - x) * k
      y = cy - (cy - y) * k
      clamp()
      paint()
    }
    // Старт: картинка по центру
    x = (STAGE - w * scale()) / 2
    y = (STAGE - hh * scale()) / 2
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
      overlay.classList.add('is-leaving')
      setTimeout(() => { overlay.remove(); URL.revokeObjectURL(url) }, 160)
      resolve(result)
    }
    async function done() {
      ok.disabled = true
      const s = scale()
      const sx = (MARGIN - x) / s
      const sy = (MARGIN - y) / s
      const side = D / s
      const out = Math.max(1, Math.min(OUT_MAX, Math.round(side)))
      const canvas = document.createElement('canvas')
      canvas.width = out
      canvas.height = out
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff' // прозрачный PNG — на белом
      ctx.fillRect(0, 0, out, out)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
      close(blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : null)
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
