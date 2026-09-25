// ===================== Вложения в ленте: фото, видео, голосовые, файлы; просмотрщик =====================
import { h, icon, fmtSize, fmtClock } from './ui.js'

// ---------- Одно проигрывание за раз (голосовые и аудио) ----------
let playing = null // {audio, stop}
function claimPlayback(entry) {
  if (playing && playing !== entry) playing.stop()
  playing = entry
}

// Голосовое: кнопка, волна (закрашивается по мере проигрывания), время. Клик по волне — перемотка.
export function voicePlayer(file, { mine = false } = {}) {
  const meta = file.meta || {}
  const bars = (meta.waveform && meta.waveform.length ? meta.waveform : fallbackWave(file.id)).slice(0, 48)
  const btn = h('button', { type: 'button', class: 'vl-voice__btn', 'aria-label': 'Воспроизвести' }, [icon('play')])
  const wave = h('div', { class: 'vl-voice__wave', role: 'slider', 'aria-label': 'Перемотка', 'aria-valuemin': '0', 'aria-valuemax': '100', tabindex: '0' },
    bars.map((v) => h('i', { style: { height: Math.max(12, Math.round(v * 100)) + '%' } })))
  const time = h('span', { class: 'vl-voice__time' }, fmtClock(meta.duration || 0))
  const node = h('div', { class: `vl-voice${mine ? ' is-mine' : ''}`, style: { '--p': '0' } }, [btn, h('div', { class: 'vl-voice__body' }, [wave, time])])
  let audio = null
  let raf = 0
  const entry = { stop }
  function ensure() {
    if (audio) return audio
    audio = new Audio(file.url)
    audio.preload = 'auto'
    audio.addEventListener('ended', () => { setPlaying(false); node.style.setProperty('--p', '0'); time.textContent = fmtClock(meta.duration || audio.duration) })
    audio.addEventListener('pause', () => setPlaying(false))
    audio.addEventListener('play', () => setPlaying(true))
    return audio
  }
  function tick() {
    if (!audio) return
    const d = audio.duration || meta.duration || 1
    node.style.setProperty('--p', String(Math.min(1, audio.currentTime / d)))
    time.textContent = fmtClock(audio.currentTime)
    if (!audio.paused) raf = requestAnimationFrame(tick)
  }
  function setPlaying(on) {
    node.classList.toggle('is-playing', on)
    btn.replaceChildren(icon(on ? 'pause' : 'play'))
    btn.setAttribute('aria-label', on ? 'Пауза' : 'Воспроизвести')
    cancelAnimationFrame(raf)
    if (on) raf = requestAnimationFrame(tick)
  }
  function stop() { if (audio) audio.pause() }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const a = ensure()
    if (a.paused) { claimPlayback(entry); a.play().catch(() => {}) } else a.pause()
  })
  function seek(frac) {
    const a = ensure()
    const d = a.duration || meta.duration
    if (!d) return
    a.currentTime = Math.max(0, Math.min(d, d * frac))
    tick()
  }
  wave.addEventListener('click', (e) => {
    e.stopPropagation()
    const r = wave.getBoundingClientRect()
    seek((e.clientX - r.left) / r.width)
  })
  wave.addEventListener('keydown', (e) => {
    if (!audio) return
    if (e.key === 'ArrowRight') { audio.currentTime += 3; tick() }
    if (e.key === 'ArrowLeft') { audio.currentTime -= 3; tick() }
  })
  return node
}
// Если волну не прислали — стабильная «псевдоволна» по id, чтобы не прыгала между перерисовками
function fallbackWave(seed) {
  let x = 0
  for (const ch of String(seed || 'x')) x = (x * 31 + ch.charCodeAt(0)) >>> 0
  return Array.from({ length: 40 }, () => { x = (x * 1103515245 + 12345) >>> 0; return 0.25 + ((x >>> 16) % 70) / 100 })
}

// Файл: значок, имя, размер; клик — скачать
export function fileCard(file) {
  const ext = (String(file.name).match(/\.([a-z0-9]{1,5})$/i) || [, ''])[1].toUpperCase()
  return h('a', { class: 'vl-filecard', href: file.url + '?download=1', download: file.name, title: 'Скачать ' + file.name, onclick: (e) => e.stopPropagation() }, [
    h('span', { class: 'vl-filecard__ico' }, [icon('file'), ext ? h('b', {}, ext) : null]),
    h('span', { class: 'vl-filecard__text' }, [h('span', { class: 'vl-filecard__name' }, file.name), h('span', { class: 'vl-filecard__size' }, fmtSize(file.size))]),
    h('span', { class: 'vl-filecard__dl' }, [icon('download')])
  ])
}

// Аудиофайл (музыка): как файл, но с плеером
function audioCard(file, mine) {
  return h('div', { class: 'vl-audiocard' }, [voicePlayer({ ...file, meta: { ...(file.meta || {}), waveform: [] } }, { mine }), h('span', { class: 'vl-audiocard__name' }, file.name)])
}

// Размер одиночного фото/видео: по пропорциям, в пределах 360×360 (не меньше 140 по ширине)
function boxSize(meta, maxW = 360, maxH = 360) {
  const w = Number(meta && meta.width) || 320
  const hh = Number(meta && meta.height) || 240
  const k = Math.min(maxW / w, maxH / hh, 1)
  return { w: Math.max(140, Math.round(w * k)), h: Math.max(90, Math.round(hh * k)) }
}

// Все вложения сообщения. onOpen(index) — открыть фото/видео в просмотрщике.
export function renderAttachments(files, { mine = false, onOpen, uploading = null } = {}) {
  const visual = files.filter((f) => f.kind === 'image' || f.kind === 'video')
  const others = files.filter((f) => f.kind !== 'image' && f.kind !== 'video')
  const out = []
  if (visual.length) {
    const grid = h('div', { class: `vl-media-grid n-${Math.min(visual.length, 4)}` })
    visual.forEach((f, i) => {
      const cell = h('button', { type: 'button', class: 'vl-media-cell', 'aria-label': f.kind === 'video' ? 'Открыть видео' : 'Открыть фото' })
      if (visual.length === 1) {
        const { w, h: hh } = boxSize(f.meta)
        cell.style.width = w + 'px'
        cell.style.aspectRatio = `${w} / ${hh}`
      }
      const src = f.previewUrl || f.url
      if (f.kind === 'image') {
        cell.appendChild(h('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }))
      } else {
        // Первый кадр вместо обложки; значок и длительность поверх
        cell.appendChild(h('video', { src: src + (f.previewUrl ? '' : '#t=0.1'), muted: true, playsinline: true, preload: 'metadata' }))
        cell.appendChild(h('span', { class: 'vl-media-cell__play' }, [icon('play')]))
        if (f.meta && f.meta.duration) cell.appendChild(h('span', { class: 'vl-media-cell__dur' }, fmtClock(f.meta.duration)))
      }
      if (visual.length > 4 && i === 3) cell.appendChild(h('span', { class: 'vl-media-cell__more' }, '+' + (visual.length - 4)))
      if (i > 3) cell.hidden = true
      cell.addEventListener('click', (e) => { e.stopPropagation(); if (onOpen && !uploading) onOpen(i) })
      grid.appendChild(cell)
    })
    out.push(grid)
  }
  for (const f of others) {
    if (f.kind === 'voice') out.push(voicePlayer(f, { mine }))
    else if (f.kind === 'audio' && !f.previewUrl && f.url) out.push(audioCard(f, mine))
    else out.push(f.url ? fileCard(f) : pendingCard(f))
  }
  if (uploading) {
    out.push(h('div', { class: 'vl-upload-progress' }, [h('i', { style: { width: Math.round(uploading.progress * 100) + '%' } })]))
  }
  return out
}
function pendingCard(f) {
  return h('div', { class: 'vl-filecard is-pending' }, [
    h('span', { class: 'vl-filecard__ico' }, [icon(f.kind === 'voice' ? 'microphone' : 'file')]),
    h('span', { class: 'vl-filecard__text' }, [h('span', { class: 'vl-filecard__name' }, f.name || 'Файл'), h('span', { class: 'vl-filecard__size' }, fmtSize(f.size))])
  ])
}

// ---------- Просмотрщик фото и видео ----------
export function openLightbox(items, index = 0, { caption = '' } = {}) {
  let i = Math.max(0, Math.min(index, items.length - 1))
  const stage = h('div', { class: 'vl-lightbox__stage' })
  const counter = h('span', { class: 'vl-lightbox__count' })
  const dl = h('a', { class: 'vl-round is-glass', title: 'Скачать', 'aria-label': 'Скачать' }, [icon('download')])
  const close = h('button', { type: 'button', class: 'vl-round is-glass', title: 'Закрыть', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const prev = h('button', { type: 'button', class: 'vl-round is-glass vl-lightbox__nav is-prev', 'aria-label': 'Предыдущее' }, [icon('chevron-left')])
  const next = h('button', { type: 'button', class: 'vl-round is-glass vl-lightbox__nav is-next', 'aria-label': 'Следующее' }, [icon('chevron-right')])
  const cap = h('div', { class: 'vl-lightbox__caption' }, caption)
  const overlay = h('div', { class: 'vl-lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Просмотр' }, [
    h('div', { class: 'vl-lightbox__bar' }, [counter, h('span', { class: 'vl-lightbox__spacer' }), dl, close]),
    stage, prev, next, caption ? cap : null
  ])
  function show() {
    const f = items[i]
    stage.querySelectorAll('video').forEach((v) => v.pause())
    const media = f.kind === 'video'
      ? h('video', { src: f.url, controls: true, autoplay: true, playsinline: true })
      : h('img', { src: f.url, alt: '', draggable: 'false' })
    stage.replaceChildren(media)
    counter.textContent = items.length > 1 ? `${i + 1} из ${items.length}` : ''
    dl.href = f.url + '?download=1'
    dl.setAttribute('download', f.name || '')
    prev.hidden = i === 0
    next.hidden = i >= items.length - 1
  }
  function done() {
    document.removeEventListener('keydown', onKey, true)
    stage.querySelectorAll('video').forEach((v) => v.pause())
    overlay.classList.add('is-leaving')
    setTimeout(() => overlay.remove(), 160)
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done() }
    if (e.key === 'ArrowLeft' && i > 0) { i--; show() }
    if (e.key === 'ArrowRight' && i < items.length - 1) { i++; show() }
  }
  prev.addEventListener('click', () => { if (i > 0) { i--; show() } })
  next.addEventListener('click', () => { if (i < items.length - 1) { i++; show() } })
  close.addEventListener('click', done)
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === stage) done() })
  // Телефон: смахнуть влево/вправо — листать, вниз — закрыть
  let sx = 0, sy = 0
  overlay.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY }, { passive: true })
  overlay.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx
    const dy = e.changedTouches[0].clientY - sy
    if (Math.abs(dy) > 90 && Math.abs(dy) > Math.abs(dx)) done()
    else if (dx < -60 && i < items.length - 1) { i++; show() } else if (dx > 60 && i > 0) { i--; show() }
  }, { passive: true })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  show()
  close.focus()
}
