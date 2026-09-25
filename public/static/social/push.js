// ===================== Push-уведомления на этом устройстве =====================
// Сервис-воркер /sw.js принимает push от сервера и показывает уведомление, даже когда сайт
// закрыт. На iPhone это работает только у сайта, добавленного на экран «Домой» (iOS 16.4+),
// а разрешение можно спросить только по нажатию кнопки. В .exe свои уведомления Windows — там
// push не нужен.
import { api } from './api.js'

let registration = null
let openFn = () => {}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !window.electronAPI
}
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
export function isStandalone() {
  return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true
}
// iPhone в обычной вкладке Safari: push невозможен, нужно добавить сайт на экран «Домой»
export function needsHomeScreen() {
  return isIOS() && !isStandalone()
}

function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
}

// Зарегистрировать воркер; если уведомления уже разрешены — обновить подписку на сервере
export async function initPush({ open } = {}) {
  if (open) openFn = open
  if (!('serviceWorker' in navigator) || window.electronAPI) return
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch { return }
  // Нажали на уведомление, а сайт уже открыт — воркер просит открыть чат здесь
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'vl-open' && e.data.url) openFn(e.data.url)
  })
  if (pushSupported() && Notification.permission === 'granted') enablePush().catch(() => {})
}

// Подписаться и сообщить серверу (повторный вызов безопасен)
export async function enablePush() {
  if (!pushSupported()) return false
  const reg = registration || await navigator.serviceWorker.ready
  const { publicKey } = await api.get('/api/push/key')
  let sub = await reg.pushManager.getSubscription()
  // Подписка сделана под другой ключ сервера — пересоздать
  if (sub && sub.options && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey)
    const want = keyBytes(publicKey)
    if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await sub.unsubscribe().catch(() => {}); sub = null }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() })
  return true
}

// Выход из аккаунта или «Выключить на этом устройстве»
export async function disablePush() {
  try {
    const reg = registration || (('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistration('/') : null)
    const sub = reg && await reg.pushManager.getSubscription()
    if (!sub) return
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  } catch {}
}

export async function pushEnabled() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return false
    const reg = registration || await navigator.serviceWorker.getRegistration('/')
    return !!(reg && await reg.pushManager.getSubscription())
  } catch { return false }
}

// Уведомление от открытой страницы. На Android new Notification() запрещён — только через воркер.
export async function showLocalNotification(title, options, onClick) {
  try {
    const n = new Notification(title, options)
    n.onclick = () => { try { window.focus() } catch {} onClick && onClick(); n.close() }
    return
  } catch {}
  try {
    const reg = registration || await navigator.serviceWorker.getRegistration('/')
    if (reg) await reg.showNotification(title, { ...options, data: { url: options.data && options.data.url } })
  } catch {}
}
