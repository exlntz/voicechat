// ===================== Сервис-воркер Voice Lobby: push-уведомления =====================
// Сервер шлёт push, когда человека нет на сайте. Здесь уведомление показывается (iPhone требует
// показывать его на каждый push), а нажатие открывает нужный чат: в уже открытом окне сайта,
// если оно есть, иначе — в новом. Страницы и файлы воркер не кэширует.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: 'Voice Lobby', body: event.data ? event.data.text() : '' } }
  const title = data.title || 'Voice Lobby'
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag, // новое сообщение в том же чате — снова со звуком, но одной карточкой
    icon: '/static/icon-192.png',
    badge: '/static/badge-96.png',
    data: { url: data.url || '/' },
    requireInteraction: !!data.call
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
    if (win) {
      // Окно сайта уже открыто — переключаемся в нём, без перезагрузки
      win.postMessage({ type: 'vl-open', url })
      return win.focus()
    }
    return self.clients.openWindow(url)
  })())
})
