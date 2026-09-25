// ===================== Уведомления: система, заголовок вкладки, значок на иконке =====================
// Сайт: Notification API + «(3) Voice Lobby» в заголовке + красный кружок на favicon +
// navigator.setAppBadge (установленное PWA). .exe: уведомления Windows, счётчик в трее и на
// панели задач — через window.electronAPI (есть только в новых сборках, поэтому всё проверяется).
import { store, on, userById, totalUnread, incomingCount } from './store.js'
import { displayName, messagePreview } from './ui.js'
import { enablePush, showLocalNotification } from './push.js'

const E = () => window.electronAPI || {}
const BASE_TITLE = 'Voice Lobby'
let navigateFn = () => {}
let baseTitle = BASE_TITLE

export function initNotifications({ navigate }) {
  navigateFn = navigate
  on('unread', updateBadge)
  on('friends', updateBadge)
  on('message-notify', onMessage)
  on('friend-request', (entry) => {
    notify({ title: 'Заявка в друзья', body: `${displayName(entry.user)} хочет добавить вас в друзья`, tag: 'friend-' + entry.user.id, route: '/friends?tab=pending' })
  })
  on('friend-accepted', (entry) => {
    notify({ title: 'Новый друг', body: `${displayName(entry.user)} принял(а) вашу заявку`, tag: 'friend-' + entry.user.id, route: '/friends' })
  })
  if (typeof E().onNavigate === 'function') E().onNavigate((route) => navigateFn(route))
  document.addEventListener('visibilitychange', updateBadge)
  updateBadge()
}

export function setBaseTitle(title) {
  baseTitle = title || BASE_TITLE
  updateBadge()
}

// Можно ли уведомлять о сообщении: не свой, чат не заглушён, не «Не беспокоить»,
// и пользователь прямо сейчас не смотрит в этот чат
function onMessage(m) {
  if (!store.me || m.authorId === store.me.id) return
  const conv = store.conversations.get(Number(m.conversationId))
  if (!conv || conv.muted || store.myStatus === 'dnd') return
  const looking = document.visibilityState === 'visible' && document.hasFocus() && store.activeConvId === conv.id
  if (looking) return
  const author = userById(m.authorId)
  playPing()
  notify({
    title: displayName(author),
    body: m.kind === 'call' ? 'Звонит вам' : messagePreview(m),
    tag: 'conv-' + conv.id,
    route: '/dm/' + conv.id
  })
}

export function notify({ title, body, tag, route }) {
  if (store.myStatus === 'dnd') return
  const e = E()
  if (typeof e.notify === 'function') {
    try { e.notify({ title, body, route }) } catch {}
    return
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  // Вкладка на экране и в фокусе — хватит звука и счётчика
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  showLocalNotification(title, { body, tag, icon: '/static/icon-192.png', badge: '/static/badge-96.png', renotify: !!tag, data: { url: route } }, () => { if (route) navigateFn(route) })
}

export function notificationsNeedPermission() {
  if (typeof E().notify === 'function') return false
  return 'Notification' in window && Notification.permission === 'default'
}

// Разрешение + подписка на push (уведомления и при закрытом сайте)
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'denied'
  let res = 'denied'
  try { res = await Notification.requestPermission() } catch {}
  if (res === 'granted') enablePush().catch(() => {})
  return res
}

// ---- Счётчик ----
let lastBadge = -1
function updateBadge() {
  const count = totalUnread() + incomingCount()
  document.title = count ? `(${count > 99 ? '99+' : count}) ${baseTitle}` : baseTitle
  if (count === lastBadge) return
  lastBadge = count
  try {
    if (navigator.setAppBadge) count ? navigator.setAppBadge(count) : navigator.clearAppBadge()
  } catch {}
  drawFavicon(count).then((iconWithBadge) => {
    if (count !== lastBadge) return // пока рисовали, счётчик уже сменился
    const e = E()
    // .exe: кружок с числом — на иконку панели задач, иконка с кружком — в трей
    if (typeof e.setBadge === 'function') {
      try { e.setBadge(count, count ? badgeImage(count, 32) : null, iconWithBadge) } catch {}
    }
  })
}

// Красный кружок с числом — картинка для favicon и для значка на панели задач Windows
function badgeImage(count, size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#d94a3d'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${Math.round(size * (count > 9 ? 0.5 : 0.62))}px -apple-system, "Segoe UI", Roboto, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 99 ? '99' : String(count), size / 2, size / 2 + size * 0.04)
  return c.toDataURL('image/png')
}

let faviconImg = null
let faviconReady = null
function loadFavicon() {
  if (faviconReady) return faviconReady
  faviconReady = new Promise((resolve) => {
    const img = new Image()
    img.onload = () => { faviconImg = img; resolve(img) }
    img.onerror = () => resolve(null)
    img.src = '/static/favicon.svg'
  })
  return faviconReady
}

// Возвращает data-URL иконки с кружком (или null без счётчика)
async function drawFavicon(count) {
  let link = document.querySelector('link[data-vl-badge]')
  if (!count) {
    if (link) link.remove()
    return null
  }
  await loadFavicon()
  const size = 64
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  if (faviconImg) ctx.drawImage(faviconImg, 0, 0, size, size)
  const r = size * 0.28
  ctx.fillStyle = '#d94a3d'
  ctx.beginPath()
  ctx.arc(size - r, size - r, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${Math.round(r * 1.3)}px -apple-system, "Segoe UI", Roboto, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 9 ? '9+' : String(count), size - r, size - r + 2)
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    link.dataset.vlBadge = '1'
    document.head.appendChild(link)
  }
  const url = c.toDataURL('image/png')
  // Браузер берёт последнюю объявленную иконку — наша идёт после исходных
  link.href = url
  return url
}

// ---- Звуки (синтез WebAudio — отдельные файлы не нужны) ----
let audioCtx = null
export function getAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    return audioCtx
  } catch { return null }
}
// Браузер разрешает звук только после действия пользователя — «прогреваем» при первом клике
document.addEventListener('pointerdown', () => getAudioCtx(), { once: true, capture: true })

function tone(ctx, freq, start, dur, gain = 0.06) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

let lastPing = 0
export function playPing() {
  if (store.myStatus === 'dnd') return
  const now = Date.now()
  if (now - lastPing < 1200) return
  lastPing = now
  const ctx = getAudioCtx()
  if (!ctx || ctx.state !== 'running') return
  const t = ctx.currentTime
  tone(ctx, 880, t, 0.16)
  tone(ctx, 1320, t + 0.09, 0.22)
}

// Мелодия входящего звонка: повторяющийся двухтональный сигнал, пока не остановят
export function startRingtone() {
  const ctx = getAudioCtx()
  if (!ctx) return () => {}
  let stopped = false
  const ring = () => {
    if (stopped) return
    const t = ctx.currentTime
    for (let i = 0; i < 2; i++) {
      tone(ctx, 660, t + i * 0.42, 0.34, 0.09)
      tone(ctx, 990, t + i * 0.42 + 0.02, 0.32, 0.05)
    }
  }
  ring()
  const timer = setInterval(ring, 2600)
  const vibrate = () => { try { navigator.vibrate && navigator.vibrate([400, 200, 400]) } catch {} }
  vibrate()
  const vib = setInterval(vibrate, 2600)
  return () => { stopped = true; clearInterval(timer); clearInterval(vib); try { navigator.vibrate && navigator.vibrate(0) } catch {} }
}
