// ===================== Реалтайм на клиенте: EventSource к /api/events =====================
// EventSource сам переподключается после обрыва и шлёт Last-Event-ID — сервер доигрывает
// пропущенное. Если соединение закрыто окончательно (например, сервер ответил ошибкой), пробуем
// заново с нарастающей паузой и передаём последнюю позицию в ?lastEventId=.
import { applyEvent, emit, store } from './store.js'

const EVENT_TYPES = [
  'hello', 'resync', 'presence', 'friend.update', 'friend.remove', 'conversation.update', 'conversation.remove', 'pins.update', 'user.update',
  'message.new', 'message.updated', 'message.deleted', 'read', 'delivered', 'typing',
  'call.incoming', 'call.cancel', 'call.accepted', 'call.declined', 'call.timeout'
]

let source = null
let lastEventId = ''
let retryTimer = 0
let retryDelay = 1000
let stopped = true
let everConnected = false

function handle(type, ev) {
  if (ev.lastEventId) lastEventId = ev.lastEventId
  let data = {}
  try { data = ev.data ? JSON.parse(ev.data) : {} } catch { return }
  if (type === 'hello') {
    retryDelay = 1000
    const reconnect = everConnected
    everConnected = true
    applyEvent('hello', data)
    // После переподключения присутствие друзей пришло заново, а списки могли устареть,
    // если сервер не смог доиграть события — тогда он пришлёт отдельный resync
    if (reconnect) emit('reconnected', data)
    return
  }
  if (type === 'resync') { emit('resync'); return }
  applyEvent(type, data)
}

function connect() {
  if (stopped) return
  clearTimeout(retryTimer)
  const url = '/api/events' + (lastEventId ? '?lastEventId=' + encodeURIComponent(lastEventId) : '')
  try { source = new EventSource(url, { withCredentials: true }) } catch { scheduleRetry(); return }
  for (const t of EVENT_TYPES) source.addEventListener(t, (ev) => handle(t, ev))
  source.onerror = () => {
    if (store.connected) { store.connected = false; emit('connection', false) }
    // CONNECTING — браузер переподключится сам; CLOSED — наша очередь
    if (source && source.readyState === EventSource.CLOSED) {
      source.close()
      source = null
      scheduleRetry()
    }
  }
}

function scheduleRetry() {
  if (stopped) return
  clearTimeout(retryTimer)
  retryTimer = setTimeout(connect, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 30000)
}

export function startEvents() {
  if (!stopped) return
  stopped = false
  everConnected = false
  lastEventId = ''
  retryDelay = 1000
  connect()
}

export function stopEvents() {
  stopped = true
  clearTimeout(retryTimer)
  if (source) { source.close(); source = null }
  store.connected = false
}

// Сеть вернулась — не ждём таймер
window.addEventListener('online', () => {
  if (!stopped && !source) { retryDelay = 1000; connect() }
})
