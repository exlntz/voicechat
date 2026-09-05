// ===================== Аннотации: рисование поверх демонстрации экрана =====================
// Отдельный самодостаточный модуль (подключается в HTML после app.js). Ничего не требует от app.js:
// - сам находит тайлы демонстрации экрана в DOM (.screen-tile с id вида `tile-screen-<trackSid>`)
// - сам берёт текущую LiveKit-комнату из глобального `state` (объявлен в app.js через const в
//   глобальной лексической области - другой классический скрипт видит его по имени)
// - сам инжектит свои стили (чтобы не трогать style.css)
//
// Кто может рисовать: ТОЛЬКО тот, кто демонстрирует экран (репетитор). Остальные участники видят
// рисунок в реальном времени, но панель инструментов им не показывается.
//
// Транспорт: LiveKit data-сообщения (room.localParticipant.publishData) с topic 'ann.v1'.
// Координаты нормализованы (0..1) относительно ВИДИМОГО КОНТЕНТА видео (с учётом object-fit и
// чёрных полей), поэтому рисунок совпадает у всех, независимо от размера окна и полноэкранного режима.
(function () {
  'use strict'

  const LK = window.LivekitClient
  if (!LK) return

  const TOPIC = 'ann.v1'
  const PROTO = 1
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const COLORS = ['#ff3b30', '#ffd60a', '#32d74b', '#0a84ff', '#ffffff', '#111111']
  const WIDTHS = [2, 4, 8, 16]
  const LASER_TTL = 1300      // мс, сколько живёт след лазерной указки
  const FLUSH_MS = 50         // мс, как часто отправляем накопленные точки штриха
  const MAX_STROKES = 500     // защита от бесконечного накопления в длинных уроках

  const TOOLS = [
    { id: 'pen', icon: 'fas fa-pen', title: 'Карандаш (P)', key: 'p' },
    { id: 'marker', icon: 'fas fa-highlighter', title: 'Маркер (M)', key: 'm' },
    { id: 'arrow', icon: 'fas fa-arrow-right-long', title: 'Стрелка (A)', key: 'a' },
    { id: 'line', icon: 'fas fa-minus', title: 'Линия (L)', key: 'l' },
    { id: 'rect', icon: 'far fa-square', title: 'Прямоугольник (R)', key: 'r' },
    { id: 'ellipse', icon: 'far fa-circle', title: 'Овал (O)', key: 'o' },
    { id: 'text', icon: 'fas fa-font', title: 'Текст (T)', key: 't' },
    { id: 'laser', icon: 'fas fa-wand-magic-sparkles', title: 'Лазерная указка (K)', key: 'k' },
    { id: 'eraser', icon: 'fas fa-eraser', title: 'Ластик (E)', key: 'e' }
  ]

  // Общие настройки рисования (одни на все тайлы, запоминаются между сессиями)
  const prefs = {
    tool: localStorage.getItem('annTool') || 'pen',
    color: localStorage.getItem('annColor') || COLORS[0],
    width: Number(localStorage.getItem('annWidth')) || 4
  }

  const docs = new Map()      // trackSid -> { strokes: [], laser: Map(identity -> {x,y,t,color}) }
  const overlays = new Map()  // trackSid -> объект оверлея (tile, canvas, bar, ...)
  let boundRoom = null
  let dirty = true

  // ---------- Доступ к состоянию app.js ----------
  function getRoom() {
    try {
      if (typeof state !== 'undefined' && state && state.room) return state.room
    } catch (e) {}
    return null
  }

  function getShareInfo(sid) {
    try {
      if (typeof state !== 'undefined' && state && state.screenShares) return state.screenShares.get(sid) || null
    } catch (e) {}
    return null
  }

  // Является ли демонстрация с этим trackSid НАШЕЙ (то есть можем ли мы на ней рисовать)
  function isLocalShare(sid) {
    const room = getRoom()
    const info = getShareInfo(sid)
    if (!room || !room.localParticipant) return false
    if (info) return info.identity === room.localParticipant.identity
    // Фолбэк: сверяем trackSid с нашей публикацией демонстрации экрана
    try {
      const pub = room.localParticipant.getTrackPublication(LK.Track.Source.ScreenShare)
      return !!(pub && pub.trackSid === sid)
    } catch (e) {}
    return false
  }

  function toast(message, type) {
    try { if (typeof showToast === 'function') showToast(message, type) } catch (e) {}
  }

  function getDoc(sid) {
    let d = docs.get(sid)
    if (!d) { d = { strokes: [], laser: new Map() }; docs.set(sid, d) }
    return d
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  }

  // ---------- Стили (инжектим сами, чтобы не трогать style.css) ----------
  function injectStyles() {
    if (document.getElementById('ann-styles')) return
    const css = `
.ann-canvas{position:absolute;inset:0;z-index:20;pointer-events:none;touch-action:none}
.ann-canvas.ann-active{pointer-events:auto;cursor:crosshair}
.ann-bar{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:31;display:flex;align-items:center;gap:6px;padding:6px;border-radius:14px;background:rgba(18,18,24,.86);border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 26px rgba(0,0,0,.5);backdrop-filter:blur(12px);opacity:.28;transition:opacity .15s ease;max-width:calc(100% - 24px);flex-wrap:wrap;justify-content:center}
.tile:hover .ann-bar,.ann-bar.ann-open{opacity:1}
.ann-btn{width:32px;height:32px;border:none;border-radius:9px;background:rgba(255,255,255,.06);color:#e7e7ee;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s ease,color .12s ease}
.ann-btn:hover{background:rgba(255,255,255,.14)}
.ann-btn.ann-selected{background:#5865f2;color:#fff}
.ann-btn.ann-danger:hover{background:#d83c3e;color:#fff}
.ann-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center}
.ann-tools[hidden]{display:none}
.ann-sep{width:1px;height:22px;background:rgba(255,255,255,.12);margin:0 2px}
.ann-swatch{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0}
.ann-swatch.ann-selected{border-color:#fff;transform:scale(1.15)}
.ann-width{width:26px;height:26px;border:none;border-radius:8px;background:rgba(255,255,255,.06);cursor:pointer;display:flex;align-items:center;justify-content:center}
.ann-width.ann-selected{background:#5865f2}
.ann-width i{display:block;border-radius:50%;background:#fff}
.ann-hint{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);z-index:30;padding:4px 10px;border-radius:8px;background:rgba(18,18,24,.8);color:#c9c9d6;font-size:11px;pointer-events:none}
@media (max-width:640px){.ann-bar{gap:4px;padding:4px;top:6px}.ann-btn{width:28px;height:28px;font-size:12px}}
`
    const style = document.createElement('style')
    style.id = 'ann-styles'
    style.textContent = css
    document.head.appendChild(style)
  }

  // ---------- Геометрия: прямоугольник реально видимого видео внутри тайла ----------
  function contentRect(o) {
    const tileRect = o.tile.getBoundingClientRect()
    const video = o.tile.querySelector('video')
    if (!video) return { x: 0, y: 0, w: tileRect.width || 1, h: tileRect.height || 1 }
    const vr = video.getBoundingClientRect()
    const vw = video.videoWidth || 16
    const vh = video.videoHeight || 9
    let fit = 'contain'
    try { fit = window.getComputedStyle(video).objectFit || 'contain' } catch (e) {}
    const ew = vr.width || tileRect.width || 1
    const eh = vr.height || tileRect.height || 1
    const offX = vr.left - tileRect.left
    const offY = vr.top - tileRect.top
    if (fit === 'fill' || fit === 'none') return { x: offX, y: offY, w: ew, h: eh }
    const scale = fit === 'cover' ? Math.max(ew / vw, eh / vh) : Math.min(ew / vw, eh / vh)
    const w = vw * scale
    const h = vh * scale
    return { x: offX + (ew - w) / 2, y: offY + (eh - h) / 2, w: w, h: h }
  }

  function toNorm(o, clientX, clientY) {
    const tileRect = o.tile.getBoundingClientRect()
    const cr = contentRect(o)
    const x = (clientX - tileRect.left - cr.x) / (cr.w || 1)
    const y = (clientY - tileRect.top - cr.y) / (cr.h || 1)
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]
  }

  // ---------- Отрисовка ----------
  function drawStroke(ctx, s, cr) {
    if (!s || !s.pts || !s.pts.length) return
    const px = (p) => [cr.x + p[0] * cr.w, cr.y + p[1] * cr.h]
    const lw = Math.max(1, (s.width || 4) * (cr.w / 1000))
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = s.color || '#ff3b30'
    ctx.fillStyle = s.color || '#ff3b30'
    ctx.lineWidth = lw
    ctx.shadowColor = 'rgba(0,0,0,.45)'
    ctx.shadowBlur = lw * 0.6

    const first = px(s.pts[0])
    const last = px(s.pts[s.pts.length - 1])

    if (s.tool === 'text') {
      const size = Math.max(11, lw * 4)
      ctx.font = `600 ${size}px Inter, system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(String(s.text || ''), first[0], first[1])
      ctx.restore()
      return
    }

    if (s.tool === 'marker') {
      ctx.globalAlpha = 0.35
      ctx.lineWidth = lw * 2.6
      ctx.shadowBlur = 0
    }

    if (s.tool === 'rect') {
      ctx.strokeRect(first[0], first[1], last[0] - first[0], last[1] - first[1])
      ctx.restore()
      return
    }

    if (s.tool === 'ellipse') {
      const cx = (first[0] + last[0]) / 2
      const cy = (first[1] + last[1]) / 2
      const rx = Math.abs(last[0] - first[0]) / 2
      const ry = Math.abs(last[1] - first[1]) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
      return
    }

    if (s.tool === 'line' || s.tool === 'arrow') {
      ctx.beginPath()
      ctx.moveTo(first[0], first[1])
      ctx.lineTo(last[0], last[1])
      ctx.stroke()
      if (s.tool === 'arrow') {
        const angle = Math.atan2(last[1] - first[1], last[0] - first[0])
        const head = Math.max(8, lw * 4)
        ctx.beginPath()
        ctx.moveTo(last[0], last[1])
        ctx.lineTo(last[0] - head * Math.cos(angle - Math.PI / 7), last[1] - head * Math.sin(angle - Math.PI / 7))
        ctx.lineTo(last[0] - head * Math.cos(angle + Math.PI / 7), last[1] - head * Math.sin(angle + Math.PI / 7))
        ctx.closePath()
        ctx.fill()
      }
      ctx.restore()
      return
    }

    // pen / marker - свободная кривая
    ctx.beginPath()
    ctx.moveTo(first[0], first[1])
    for (let i = 1; i < s.pts.length; i++) {
      const p = px(s.pts[i])
      ctx.lineTo(p[0], p[1])
    }
    if (s.pts.length === 1) ctx.lineTo(first[0] + 0.01, first[1] + 0.01)
    ctx.stroke()
    ctx.restore()
  }

  function drawLaser(ctx, d, cr) {
    const now = Date.now()
    for (const [identity, l] of Array.from(d.laser.entries())) {
      const age = now - l.t
      if (age > LASER_TTL) { d.laser.delete(identity); continue }
      const alpha = Math.max(0, 1 - age / LASER_TTL)
      const x = cr.x + l.x * cr.w
      const y = cr.y + l.y * cr.h
      const r = Math.max(5, cr.w / 110)
      ctx.save()
      ctx.globalAlpha = alpha
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6)
      grad.addColorStop(0, l.color || '#ff3b30')
      grad.addColorStop(1, 'rgba(255,59,48,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, r * 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.globalAlpha = alpha * 0.9
      ctx.beginPath()
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  function renderOverlay(o) {
    const d = getDoc(o.sid)
    const rect = o.tile.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    const dpr = window.devicePixelRatio || 1
    if (o.canvas.width !== Math.round(w * dpr) || o.canvas.height !== Math.round(h * dpr)) {
      o.canvas.width = Math.round(w * dpr)
      o.canvas.height = Math.round(h * dpr)
      o.canvas.style.width = w + 'px'
      o.canvas.style.height = h + 'px'
    }
    const ctx = o.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cr = contentRect(o)
    for (const s of d.strokes) drawStroke(ctx, s, cr)
    if (d.laser.size) drawLaser(ctx, d, cr)
  }

  function hasLaser() {
    for (const d of docs.values()) if (d.laser.size) return true
    return false
  }

  function frame() {
    if (dirty || hasLaser()) {
      dirty = false
      for (const o of overlays.values()) {
        try { renderOverlay(o) } catch (e) {}
      }
    }
    requestAnimationFrame(frame)
  }

  // ---------- Сеть ----------
  function send(msg, destinationIdentities) {
    const room = getRoom()
    if (!room || !room.localParticipant) return
    try {
      const opts = { reliable: true, topic: TOPIC }
      if (destinationIdentities && destinationIdentities.length) opts.destinationIdentities = destinationIdentities
      room.localParticipant.publishData(encoder.encode(JSON.stringify(msg)), opts)
    } catch (e) {}
  }

  function onData(payload, participant, kind, topic) {
    if (topic && topic !== TOPIC) return
    let m = null
    try { m = JSON.parse(decoder.decode(payload)) } catch (e) { return }
    if (!m || m.v !== PROTO || !m.sid) return
    const d = getDoc(m.sid)
    if (m.t === 'begin' && m.stroke) {
      d.strokes.push(m.stroke)
      if (d.strokes.length > MAX_STROKES) d.strokes.splice(0, d.strokes.length - MAX_STROKES)
    } else if (m.t === 'pts') {
      const s = d.strokes.find((x) => x.id === m.id)
      if (s && Array.isArray(m.pts)) s.pts.push.apply(s.pts, m.pts)
    } else if (m.t === 'end') {
      const s = d.strokes.find((x) => x.id === m.id)
      if (s) {
        if (Array.isArray(m.pts) && m.pts.length) s.pts.push.apply(s.pts, m.pts)
        s.done = true
      }
    } else if (m.t === 'undo') {
      const i = d.strokes.findIndex((x) => x.id === m.id)
      if (i >= 0) d.strokes.splice(i, 1)
    } else if (m.t === 'clear') {
      d.strokes.length = 0
      d.laser.clear()
    } else if (m.t === 'laser') {
      d.laser.set(participant ? participant.identity : 'remote', { x: m.x, y: m.y, t: Date.now(), color: m.color })
    } else if (m.t === 'sync-req') {
      // Ответить полным состоянием может только автор демонстрации
      if (isLocalShare(m.sid) && participant) send({ v: PROTO, t: 'sync', sid: m.sid, strokes: d.strokes }, [participant.identity])
      return
    } else if (m.t === 'sync') {
      if (!isLocalShare(m.sid) && Array.isArray(m.strokes)) d.strokes = m.strokes
    } else {
      return
    }
    dirty = true
  }

  function bindRoom() {
    const room = getRoom()
    if (!room || room === boundRoom) return
    boundRoom = room
    try { room.on(LK.RoomEvent.DataReceived, onData) } catch (e) {}
  }

  // ---------- Панель инструментов (только для того, кто демонстрирует экран) ----------
  function buildBar(o) {
    const bar = document.createElement('div')
    bar.className = 'ann-bar'

    const toggle = document.createElement('button')
    toggle.className = 'ann-btn'
    toggle.title = 'Рисовать поверх демонстрации'
    toggle.innerHTML = '<i class="fas fa-pen-to-square"></i>'
    bar.appendChild(toggle)

    const tools = document.createElement('div')
    tools.className = 'ann-tools'
    tools.hidden = true
    bar.appendChild(tools)

    const toolBtns = {}
    TOOLS.forEach((t) => {
      const b = document.createElement('button')
      b.className = 'ann-btn'
      b.title = t.title
      b.innerHTML = '<i class="' + t.icon + '"></i>'
      b.addEventListener('click', (e) => { e.stopPropagation(); setTool(t.id) })
      tools.appendChild(b)
      toolBtns[t.id] = b
    })

    tools.appendChild(sep())

    const colorBtns = {}
    COLORS.forEach((c) => {
      const b = document.createElement('button')
      b.className = 'ann-swatch'
      b.style.background = c
      b.title = 'Цвет'
      b.addEventListener('click', (e) => { e.stopPropagation(); setColor(c) })
      tools.appendChild(b)
      colorBtns[c] = b
    })

    tools.appendChild(sep())

    const widthBtns = {}
    WIDTHS.forEach((w) => {
      const b = document.createElement('button')
      b.className = 'ann-width'
      b.title = 'Толщина ' + w
      const dot = document.createElement('i')
      const size = Math.max(4, Math.min(16, w))
      dot.style.width = size + 'px'
      dot.style.height = size + 'px'
      b.appendChild(dot)
      b.addEventListener('click', (e) => { e.stopPropagation(); setWidth(w) })
      tools.appendChild(b)
      widthBtns[w] = b
    })

    tools.appendChild(sep())

    const undoBtn = document.createElement('button')
    undoBtn.className = 'ann-btn'
    undoBtn.title = 'Отменить (Ctrl+Z)'
    undoBtn.innerHTML = '<i class="fas fa-rotate-left"></i>'
    undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undo(o) })
    tools.appendChild(undoBtn)

    const clearBtn = document.createElement('button')
    clearBtn.className = 'ann-btn ann-danger'
    clearBtn.title = 'Очистить всё'
    clearBtn.innerHTML = '<i class="fas fa-trash"></i>'
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearAll(o) })
    tools.appendChild(clearBtn)

    bar.addEventListener('click', (e) => e.stopPropagation())
    bar.addEventListener('dblclick', (e) => e.stopPropagation())
    bar.addEventListener('contextmenu', (e) => e.stopPropagation())
    bar.addEventListener('pointerdown', (e) => e.stopPropagation())

    toggle.addEventListener('click', (e) => { e.stopPropagation(); setDrawMode(o, !o.drawMode) })

    o.bar = bar
    o.tools = tools
    o.toggle = toggle
    o.toolBtns = toolBtns
    o.colorBtns = colorBtns
    o.widthBtns = widthBtns
    o.tile.appendChild(bar)
    syncBar()

    function sep() {
      const s = document.createElement('span')
      s.className = 'ann-sep'
      return s
    }
  }

  function syncBar() {
    for (const o of overlays.values()) {
      if (!o.bar) continue
      Object.keys(o.toolBtns).forEach((id) => o.toolBtns[id].classList.toggle('ann-selected', id === prefs.tool))
      Object.keys(o.colorBtns).forEach((c) => o.colorBtns[c].classList.toggle('ann-selected', c === prefs.color))
      Object.keys(o.widthBtns).forEach((w) => o.widthBtns[w].classList.toggle('ann-selected', Number(w) === prefs.width))
      o.toggle.classList.toggle('ann-selected', !!o.drawMode)
      o.tools.hidden = !o.drawMode
      o.bar.classList.toggle('ann-open', !!o.drawMode)
    }
  }

  function setTool(id) { prefs.tool = id; localStorage.setItem('annTool', id); syncBar() }
  function setColor(c) { prefs.color = c; localStorage.setItem('annColor', c); syncBar() }
  function setWidth(w) { prefs.width = w; localStorage.setItem('annWidth', String(w)); syncBar() }

  function setDrawMode(o, on) {
    o.drawMode = !!on
    o.canvas.classList.toggle('ann-active', o.drawMode)
    if (o.hint) o.hint.remove()
    if (o.drawMode) {
      const hint = document.createElement('div')
      hint.className = 'ann-hint'
      hint.textContent = 'Режим рисования · Esc - выйти, Ctrl+Z - отменить'
      o.tile.appendChild(hint)
      o.hint = hint
      setTimeout(() => { if (o.hint === hint) hint.remove() }, 3500)
    }
    syncBar()
  }

  // ---------- Действия ----------
  function undo(o) {
    const d = getDoc(o.sid)
    for (let i = d.strokes.length - 1; i >= 0; i--) {
      if (d.strokes[i].mine) {
        const id = d.strokes[i].id
        d.strokes.splice(i, 1)
        send({ v: PROTO, t: 'undo', sid: o.sid, id: id })
        dirty = true
        return
      }
    }
  }

  function clearAll(o) {
    const d = getDoc(o.sid)
    d.strokes.length = 0
    d.laser.clear()
    send({ v: PROTO, t: 'clear', sid: o.sid })
    dirty = true
  }

  function eraseAt(o, pt) {
    const d = getDoc(o.sid)
    const cr = contentRect(o)
    const tol = Math.max(0.008, 14 / (cr.w || 1))
    for (let i = d.strokes.length - 1; i >= 0; i--) {
      const s = d.strokes[i]
      const hit = (s.pts || []).some((p) => Math.abs(p[0] - pt[0]) < tol * 2 && Math.abs(p[1] - pt[1]) < tol * 2)
      if (hit) {
        const id = s.id
        d.strokes.splice(i, 1)
        send({ v: PROTO, t: 'undo', sid: o.sid, id: id })
        dirty = true
        return
      }
    }
  }

  // ---------- Ввод (рисование) ----------
  function attachPointer(o) {
    let active = null   // текущий штрих
    let pending = []    // точки, ещё не отправленные
    let flushTimer = null

    function flush(final) {
      if (!active) return
      if (pending.length) {
        send({ v: PROTO, t: 'pts', sid: o.sid, id: active.id, pts: pending })
        pending = []
      }
      if (final) send({ v: PROTO, t: 'end', sid: o.sid, id: active.id })
    }

    o.canvas.addEventListener('pointerdown', (e) => {
      if (!o.drawMode || !isLocalShare(o.sid)) return
      e.preventDefault()
      e.stopPropagation()
      const pt = toNorm(o, e.clientX, e.clientY)
      const d = getDoc(o.sid)

      if (prefs.tool === 'eraser') { eraseAt(o, pt); return }

      if (prefs.tool === 'laser') {
        d.laser.set('__me__', { x: pt[0], y: pt[1], t: Date.now(), color: prefs.color })
        send({ v: PROTO, t: 'laser', sid: o.sid, x: pt[0], y: pt[1], color: prefs.color })
        o.laserDown = true
        dirty = true
        try { o.canvas.setPointerCapture(e.pointerId) } catch (err) {}
        return
      }

      if (prefs.tool === 'text') {
        const text = window.prompt('Текст подписи:')
        if (!text) return
        const stroke = { id: uid(), tool: 'text', color: prefs.color, width: prefs.width, pts: [pt], text: text, done: true }
        d.strokes.push(stroke)
        stroke.mine = true
        send({ v: PROTO, t: 'begin', sid: o.sid, stroke: { id: stroke.id, tool: 'text', color: stroke.color, width: stroke.width, pts: [pt], text: text, done: true } })
        send({ v: PROTO, t: 'end', sid: o.sid, id: stroke.id })
        dirty = true
        return
      }

      active = { id: uid(), tool: prefs.tool, color: prefs.color, width: prefs.width, pts: [pt] }
      d.strokes.push(active)
      active.mine = true
      if (d.strokes.length > MAX_STROKES) d.strokes.splice(0, d.strokes.length - MAX_STROKES)
      send({ v: PROTO, t: 'begin', sid: o.sid, stroke: { id: active.id, tool: active.tool, color: active.color, width: active.width, pts: [pt] } })
      try { o.canvas.setPointerCapture(e.pointerId) } catch (err) {}
      dirty = true
      if (flushTimer) clearInterval(flushTimer)
      flushTimer = setInterval(() => flush(false), FLUSH_MS)
    })

    o.canvas.addEventListener('pointermove', (e) => {
      if (!o.drawMode) return
      const pt = toNorm(o, e.clientX, e.clientY)

      if (o.laserDown) {
        const d = getDoc(o.sid)
        d.laser.set('__me__', { x: pt[0], y: pt[1], t: Date.now(), color: prefs.color })
        send({ v: PROTO, t: 'laser', sid: o.sid, x: pt[0], y: pt[1], color: prefs.color })
        dirty = true
        return
      }

      if (!active) return
      e.preventDefault()
      const isShape = active.tool === 'line' || active.tool === 'arrow' || active.tool === 'rect' || active.tool === 'ellipse'
      if (isShape) {
        // У фигур храним ровно две точки: начало и текущий конец
        active.pts[1] = pt
        pending = [pt]
      } else {
        const last = active.pts[active.pts.length - 1]
        if (last && Math.abs(last[0] - pt[0]) < 0.002 && Math.abs(last[1] - pt[1]) < 0.002) return
        active.pts.push(pt)
        pending.push(pt)
      }
      dirty = true
    })

    function finish(e) {
      if (o.laserDown) { o.laserDown = false; return }
      if (!active) return
      const isShape = active.tool === 'line' || active.tool === 'arrow' || active.tool === 'rect' || active.tool === 'ellipse'
      if (isShape && pending.length) {
        send({ v: PROTO, t: 'pts', sid: o.sid, id: active.id, pts: [active.pts[1] || active.pts[0]] })
        pending = []
      }
      flush(true)
      active.done = true
      active = null
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
      dirty = true
    }

    o.canvas.addEventListener('pointerup', finish)
    o.canvas.addEventListener('pointercancel', finish)
    o.canvas.addEventListener('pointerleave', finish)
    o.canvas.addEventListener('dblclick', (e) => { if (o.drawMode) e.stopPropagation() })
    o.canvas.addEventListener('contextmenu', (e) => { if (o.drawMode) { e.preventDefault(); e.stopPropagation() } })
  }

  // ---------- Создание/удаление оверлея на тайле ----------
  function createOverlay(tile, sid) {
    const canvas = document.createElement('canvas')
    canvas.className = 'ann-canvas'
    tile.appendChild(canvas)
    const o = {
      sid: sid,
      tile: tile,
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      drawMode: false,
      isLocal: false,
      syncRequested: false
    }
    attachPointer(o)
    try {
      o.ro = new ResizeObserver(() => { dirty = true })
      o.ro.observe(tile)
    } catch (e) {}
    dirty = true
    return o
  }

  function destroyOverlay(o) {
    try { if (o.ro) o.ro.disconnect() } catch (e) {}
    if (o.canvas) o.canvas.remove()
    if (o.bar) o.bar.remove()
    if (o.hint) o.hint.remove()
  }

  function updateRole(o) {
    const local = isLocalShare(o.sid)
    if (local === o.isLocal && (local ? !!o.bar : true)) return
    o.isLocal = local
    if (local) {
      if (!o.bar) buildBar(o)
    } else {
      if (o.bar) { o.bar.remove(); o.bar = null }
      setDrawMode(o, false)
      if (!o.syncRequested) {
        o.syncRequested = true
        // Догнать уже нарисованное (мы могли подключиться к уроку позже)
        setTimeout(() => send({ v: PROTO, t: 'sync-req', sid: o.sid }), 400)
      }
    }
  }

  // ---------- Сканирование DOM ----------
  let scanTimer = null
  function scheduleScan() {
    if (scanTimer) return
    scanTimer = setTimeout(() => { scanTimer = null; scan() }, 120)
  }

  function scan() {
    injectStyles()
    bindRoom()
    const seen = new Set()
    document.querySelectorAll('.screen-tile').forEach((tile) => {
      const id = tile.id || ''
      if (id.indexOf('tile-screen-') !== 0) return
      const sid = id.slice('tile-screen-'.length)
      if (!sid) return
      seen.add(sid)
      let o = overlays.get(sid)
      if (o && o.tile !== tile) { destroyOverlay(o); overlays.delete(sid); o = null }
      if (!o) { o = createOverlay(tile, sid); overlays.set(sid, o) }
      updateRole(o)
    })
    for (const [sid, o] of Array.from(overlays.entries())) {
      if (!seen.has(sid)) {
        destroyOverlay(o)
        overlays.delete(sid)
        docs.delete(sid)
      }
    }
  }

  // ---------- Горячие клавиши ----------
  document.addEventListener('keydown', (e) => {
    const activeOverlay = Array.from(overlays.values()).find((o) => o.drawMode)
    if (!activeOverlay) return
    const tag = (e.target && e.target.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Escape') { setDrawMode(activeOverlay, false); return }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) {
      e.preventDefault()
      undo(activeOverlay)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const key = e.key.toLowerCase()
    const tool = TOOLS.find((t) => t.key === key)
    if (tool) { setTool(tool.id); e.preventDefault() }
  })

  window.addEventListener('resize', () => { dirty = true })
  document.addEventListener('fullscreenchange', () => { dirty = true; scheduleScan() })

  try {
    new MutationObserver(() => scheduleScan()).observe(document.documentElement, { childList: true, subtree: true })
  } catch (e) {}
  setInterval(scan, 1000)
  scan()
  requestAnimationFrame(frame)

  // Небольшое публичное API - на случай ручного управления из консоли/app.js
  window.Annotate = {
    scan: scan,
    clear: (sid) => { const o = overlays.get(sid); if (o) clearAll(o) },
    setTool: setTool,
    setColor: setColor,
    setWidth: setWidth
  }
})()
