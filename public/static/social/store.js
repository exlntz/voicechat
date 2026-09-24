// ===================== Состояние клиента: друзья, чаты, сообщения, присутствие =====================
// Один источник правды для всех экранов. Экраны подписываются на темы (on('friends', fn)) и
// перерисовывают только своё. Сюда же приходят события из SSE (applyEvent) и результаты
// «мгновенной» отправки сообщений.
import { api } from './api.js'
import * as cache from './cache.js'
import { uid } from './ui.js'

const MAX_IN_MEMORY = 400 // сообщений на чат, пока пользователь внизу ленты

export const store = {
  me: null,
  friends: new Map(), // userId -> {user, status: friend|incoming|outgoing|blocked, since, presence}
  users: new Map(), // userId -> {id, username, displayName}
  presence: new Map(), // userId -> {status, inCall}
  conversations: new Map(), // id -> summary
  conversationsLoaded: false,
  friendsLoaded: false,
  chats: new Map(), // convId -> {list, hasMore, state: 'empty'|'cache'|'ready', loadingOlder}
  typing: new Map(), // convId -> Map(userId -> expiresAt)
  calls: new Map(), // callId -> входящий звонок
  myStatus: 'online',
  connected: false,
  activeConvId: null, // открытый сейчас чат (для непрочитанных и уведомлений)
  atBottom: true // пользователь внизу ленты открытого чата
}

// ---------- Подписки ----------
const listeners = new Map()
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set())
  listeners.get(topic).add(fn)
  return () => listeners.get(topic).delete(fn)
}
export function emit(topic, payload) {
  const set = listeners.get(topic)
  if (set) for (const fn of [...set]) { try { fn(payload) } catch (e) { console.error(e) } }
}

// ---------- Пользователи и присутствие ----------
export function rememberUser(user) {
  if (user && user.id) store.users.set(Number(user.id), user)
}
export function userById(id) {
  return store.users.get(Number(id)) || null
}
export function presenceOf(id) {
  return store.presence.get(Number(id)) || { status: 'offline', inCall: false }
}

// ---------- Друзья ----------
export async function loadFriends() {
  const data = await api.friends()
  store.friends.clear()
  for (const f of data.friends) setFriend(f, false)
  store.friendsLoaded = true
  emit('friends')
  cache.setKV('friends', data.friends)
}
export function setFriend(entry, notify = true) {
  rememberUser(entry.user)
  store.friends.set(Number(entry.user.id), entry)
  if (entry.status === 'friend' && entry.presence) store.presence.set(Number(entry.user.id), entry.presence)
  if (notify) { emit('friends'); emit('presence', Number(entry.user.id)) }
}
export function friendsBy(status) {
  return [...store.friends.values()].filter((f) => f.status === status)
}
export function incomingCount() {
  return friendsBy('incoming').length
}

// ---------- Чаты ----------
export async function loadConversations() {
  const data = await api.conversations()
  store.conversations.clear()
  for (const c of data.conversations) setConversation(c, false)
  store.conversationsLoaded = true
  emit('conversations')
  emit('unread')
  persistConversations()
}
export function setConversation(conv, notify = true) {
  if (!conv) return
  for (const u of conv.members || []) rememberUser(u)
  if (conv.hidden) store.conversations.delete(conv.id)
  else store.conversations.set(conv.id, conv)
  if (notify) { emit('conversations'); emit('unread'); emit('conversation:' + conv.id, conv); persistConversations() }
}
export function sortedConversations() {
  return [...store.conversations.values()].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
}
export function dmWith(userId) {
  for (const c of store.conversations.values()) if (c.peer && c.peer.id === Number(userId)) return c
  return null
}
export async function ensureConversation(id) {
  id = Number(id)
  if (store.conversations.has(id)) return store.conversations.get(id)
  const data = await api.conversation(id)
  // Скрытую (закрытую) личку при прямом переходе по ссылке всё равно открываем
  if (data.conversation.hidden) {
    const res = await api.updateConversation(id, { hidden: false })
    setConversation(res.conversation)
    return res.conversation
  }
  setConversation(data.conversation)
  return data.conversation
}
export function totalUnread() {
  let n = 0
  for (const c of store.conversations.values()) if (!c.muted) n += c.unread || 0
  return n
}
let persistTimer = 0
function persistConversations() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => cache.setKV('conversations', [...store.conversations.values()]), 400)
}

// ---------- Сообщения ----------
function chatOf(convId) {
  convId = Number(convId)
  let chat = store.chats.get(convId)
  if (!chat) { chat = { list: [], hasMore: true, state: 'empty', loadingOlder: false }; store.chats.set(convId, chat) }
  return chat
}
export function getChat(convId) { return chatOf(convId) }

function sortList(list) {
  // Подтверждённые — по id, черновики (id=null) — в конце, в порядке создания
  list.sort((a, b) => {
    if (a.id && b.id) return a.id - b.id
    if (a.id) return -1
    if (b.id) return 1
    return a.createdAt - b.createdAt
  })
}

const persistTimers = new Map()
function persistChat(convId) {
  clearTimeout(persistTimers.get(convId))
  persistTimers.set(convId, setTimeout(() => {
    persistTimers.delete(convId)
    const chat = store.chats.get(convId)
    if (chat && chat.state === 'ready') cache.putMessages(convId, chat.list)
  }, 500))
}

function changed(convId, detail) {
  emit('messages:' + convId, detail)
  persistChat(convId)
}

// Первая загрузка чата: мгновенно из кэша, затем свежая страница с сервера
export async function openChat(convId) {
  convId = Number(convId)
  const chat = chatOf(convId)
  if (chat.state === 'empty') {
    const cached = await cache.getMessages(convId)
    if (cached && cached.length && chat.state === 'empty') {
      chat.list = cached
      chat.state = 'cache'
      emit('messages:' + convId, { type: 'reset' })
    }
  }
  if (chat.state !== 'ready') await refreshChat(convId)
  return chat
}

// Свежая последняя страница. Всё, что лежало в памяти в её диапазоне id, заменяется ответом
// сервера — так пропадают сообщения, удалённые, пока нас не было, и подтягиваются правки.
export async function refreshChat(convId) {
  convId = Number(convId)
  const chat = chatOf(convId)
  const data = await api.messages(convId)
  const fresh = data.messages
  const pending = chat.list.filter((m) => !m.id)
  let older = []
  if (fresh.length && data.hasMore) {
    // Старые (выше страницы) сохраняем, только если страница сомкнулась с ними
    const minId = fresh[0].id
    if (chat.list.some((m) => m.id === minId)) older = chat.list.filter((m) => m.id && m.id < minId)
  }
  const pendingIds = new Set(fresh.map((m) => m.clientId).filter(Boolean))
  chat.list = [...older, ...fresh, ...pending.filter((m) => !pendingIds.has(m.clientId))]
  chat.hasMore = older.length ? chat.hasMore : data.hasMore
  chat.state = 'ready'
  changed(convId, { type: 'reset' })
  return chat
}

export async function loadOlder(convId) {
  convId = Number(convId)
  const chat = chatOf(convId)
  if (chat.loadingOlder || !chat.hasMore || chat.state !== 'ready') return false
  const first = chat.list.find((m) => m.id)
  if (!first) return false
  chat.loadingOlder = true
  try {
    const data = await api.messages(convId, { before: first.id })
    const known = new Set(chat.list.map((m) => m.id))
    chat.list = [...data.messages.filter((m) => !known.has(m.id)), ...chat.list]
    chat.hasMore = data.hasMore
    emit('messages:' + convId, { type: 'prepend', count: data.messages.length })
    return true
  } finally {
    chat.loadingOlder = false
  }
}

// Когда пользователь снова внизу — сбрасываем раздувшуюся историю, чтобы DOM оставался лёгким
export function trimChat(convId) {
  const chat = store.chats.get(Number(convId))
  if (!chat || chat.list.length <= MAX_IN_MEMORY) return false
  chat.list = chat.list.slice(-Math.floor(MAX_IN_MEMORY / 2))
  chat.hasMore = true
  emit('messages:' + convId, { type: 'reset', keepScroll: true })
  return true
}

// Вставить/обновить сообщение от сервера (ответ POST или событие SSE)
export function upsertMessage(message) {
  const convId = Number(message.conversationId)
  const chat = store.chats.get(convId)
  if (!chat || chat.state === 'empty') return false
  let idx = chat.list.findIndex((m) => m.id === message.id)
  if (idx < 0 && message.clientId) idx = chat.list.findIndex((m) => !m.id && m.clientId === message.clientId)
  const isNew = idx < 0
  if (isNew) {
    // Если чат показывает не самый хвост (кэш без стыка) — новое всё равно добавляем в конец
    chat.list.push(message)
  } else {
    chat.list[idx] = message
  }
  sortList(chat.list)
  changed(convId, { type: isNew ? 'append' : 'update', message })
  return isNew
}

export function removeMessage(convId, id) {
  convId = Number(convId)
  const chat = store.chats.get(convId)
  if (!chat) return
  const before = chat.list.length
  chat.list = chat.list.filter((m) => m.id !== id)
  if (chat.list.length !== before) changed(convId, { type: 'remove', id })
}

// ---------- Отправка «мгновенно» ----------
export async function sendMessage(convId, body, replyTo = null) {
  convId = Number(convId)
  const chat = chatOf(convId)
  const replySource = replyTo ? chat.list.find((m) => m.id === replyTo) : null
  const draft = {
    id: null,
    clientId: uid(),
    conversationId: convId,
    authorId: store.me.id,
    kind: 'text',
    body,
    meta: null,
    replyTo,
    reply: replySource ? { id: replySource.id, authorId: replySource.authorId, kind: replySource.kind, body: String(replySource.body).slice(0, 200), deleted: false } : null,
    createdAt: Date.now(),
    editedAt: null,
    pending: true
  }
  chat.list.push(draft)
  sortList(chat.list)
  emit('messages:' + convId, { type: 'append', message: draft, own: true })
  bumpConversation(convId, draft)
  return deliver(convId, draft)
}

async function deliver(convId, draft) {
  try {
    const { message } = await api.sendMessage(convId, { body: draft.body, replyTo: draft.replyTo, clientId: draft.clientId })
    upsertMessage(message)
    bumpConversation(convId, message)
    return message
  } catch (e) {
    const chat = chatOf(convId)
    const m = chat.list.find((x) => x.clientId === draft.clientId && !x.id)
    if (m) {
      m.pending = false
      m.failed = e.message || 'Не отправлено'
      emit('messages:' + convId, { type: 'update', message: m })
    }
    throw e
  }
}

export function retryMessage(convId, clientId) {
  const chat = chatOf(convId)
  const m = chat.list.find((x) => x.clientId === clientId && !x.id)
  if (!m) return
  m.failed = null
  m.pending = true
  emit('messages:' + convId, { type: 'update', message: m })
  deliver(Number(convId), m).catch(() => {})
}

export function discardDraft(convId, clientId) {
  const chat = chatOf(convId)
  chat.list = chat.list.filter((x) => !(x.clientId === clientId && !x.id))
  emit('messages:' + convId, { type: 'reset', keepScroll: true })
}

function bumpConversation(convId, message) {
  const conv = store.conversations.get(Number(convId))
  if (!conv) return
  conv.lastMessage = message
  conv.lastMessageAt = message.createdAt
  if (message.id && message.authorId === store.me.id) conv.lastReadId = Math.max(conv.lastReadId || 0, message.id)
  emit('conversations')
  emit('conversation:' + convId, conv)
  persistConversations()
}

// ---------- Прочитано ----------
let readTimers = new Map()
export function markRead(convId) {
  convId = Number(convId)
  const conv = store.conversations.get(convId)
  if (!conv) return
  const lastId = conv.lastMessage && conv.lastMessage.id
  if (!conv.unread && (!lastId || (conv.lastReadId || 0) >= lastId)) return
  conv.unread = 0
  if (lastId) conv.lastReadId = Math.max(conv.lastReadId || 0, lastId)
  emit('unread')
  emit('conversations')
  // Сеть — не чаще раза в 600 мс на чат
  clearTimeout(readTimers.get(convId))
  readTimers.set(convId, setTimeout(() => {
    readTimers.delete(convId)
    api.markRead(convId).catch(() => {})
  }, 600))
}

// ---------- События SSE ----------
// Возвращает true, если событие обработано; уведомления/звонки обрабатывают свои модули
// через emit('event:<тип>').
export function applyEvent(type, data) {
  switch (type) {
    case 'hello': {
      store.connected = true
      for (const [id, p] of Object.entries(data.presence || {})) store.presence.set(Number(id), p)
      emit('presence')
      emit('connection', true)
      break
    }
    case 'presence': {
      store.presence.set(Number(data.userId), { status: data.status, inCall: data.inCall })
      const f = store.friends.get(Number(data.userId))
      if (f) f.presence = { status: data.status, inCall: data.inCall }
      emit('presence', Number(data.userId))
      break
    }
    case 'friend.update': {
      const prev = store.friends.get(Number(data.user.id))
      setFriend(data)
      if (data.status === 'incoming' && (!prev || prev.status !== 'incoming')) emit('friend-request', data)
      if (data.status === 'friend' && prev && prev.status === 'outgoing') emit('friend-accepted', data)
      emit('unread')
      break
    }
    case 'friend.remove': {
      store.friends.delete(Number(data.userId))
      emit('friends')
      emit('unread')
      break
    }
    case 'conversation.update': {
      setConversation(data)
      break
    }
    case 'message.new': {
      const m = data.message
      const convId = Number(m.conversationId)
      const mine = m.authorId === store.me.id
      upsertMessage(m)
      // Пишущий только что отправил сообщение — «печатает…» больше не актуально
      const t = store.typing.get(convId)
      if (t && t.delete(m.authorId)) emit('typing:' + convId)
      const conv = store.conversations.get(convId)
      if (!conv) {
        // Новая личка (собеседник написал впервые) — подтянуть её карточку
        ensureConversation(convId).then(() => emit('message-notify', m)).catch(() => {})
        break
      }
      const isNewer = !conv.lastMessage || !conv.lastMessage.id || m.id >= conv.lastMessage.id
      if (isNewer) { conv.lastMessage = m; conv.lastMessageAt = m.createdAt }
      if (mine) {
        conv.lastReadId = Math.max(conv.lastReadId || 0, m.id)
      } else if (m.id > (conv.lastReadId || 0)) {
        const viewing = store.activeConvId === convId && document.visibilityState === 'visible' && store.atBottom && document.hasFocus()
        if (viewing) markRead(convId)
        else conv.unread = (conv.unread || 0) + 1
        emit('message-notify', m)
      }
      emit('conversations')
      emit('conversation:' + convId, conv)
      emit('unread')
      persistConversations()
      break
    }
    case 'message.updated': {
      const m = data.message
      upsertMessage(m)
      const conv = store.conversations.get(Number(m.conversationId))
      if (conv && conv.lastMessage && conv.lastMessage.id === m.id) { conv.lastMessage = m; emit('conversations') }
      emit('call-message', m)
      break
    }
    case 'message.deleted': {
      removeMessage(data.conversationId, data.id)
      const conv = store.conversations.get(Number(data.conversationId))
      // Удалили последнее или непрочитанное — пересчёт на сервере надёжнее
      if (conv) api.conversation(conv.id).then((r) => setConversation(r.conversation)).catch(() => {})
      break
    }
    case 'read': {
      const conv = store.conversations.get(Number(data.conversationId))
      if (!conv) break
      if (Number(data.userId) === store.me.id) {
        conv.lastReadId = Math.max(conv.lastReadId || 0, data.lastReadId)
        if (conv.lastMessage && conv.lastReadId >= conv.lastMessage.id) conv.unread = 0
        else api.conversation(conv.id).then((r) => setConversation(r.conversation)).catch(() => {})
        emit('unread')
        emit('conversations')
      } else {
        conv.peerLastReadId = Math.max(conv.peerLastReadId || 0, data.lastReadId)
        emit('conversation:' + conv.id, conv)
      }
      break
    }
    case 'typing': {
      const convId = Number(data.conversationId)
      if (!store.typing.has(convId)) store.typing.set(convId, new Map())
      store.typing.get(convId).set(Number(data.userId), Date.now() + 6000)
      emit('typing:' + convId)
      emit('typing-any')
      break
    }
    default:
      break
  }
  emit('event:' + type, data)
}

export function typingUsers(convId) {
  const map = store.typing.get(Number(convId))
  if (!map) return []
  const now = Date.now()
  const ids = []
  for (const [id, until] of map) { if (until > now) ids.push(id); else map.delete(id) }
  return ids
}
// Раз в секунду гасим устаревшие «печатает…»
setInterval(() => {
  const now = Date.now()
  for (const [convId, map] of store.typing) {
    let dirty = false
    for (const [id, until] of map) if (until <= now) { map.delete(id); dirty = true }
    if (dirty) { emit('typing:' + convId); emit('typing-any') }
  }
}, 1000)

// ---------- Мгновенный старт: списки из кэша до ответа сервера ----------
export async function hydrateFromCache() {
  const [convs, friends] = await Promise.all([cache.getKV('conversations'), cache.getKV('friends')])
  if (Array.isArray(friends) && !store.friendsLoaded) {
    for (const f of friends) setFriend({ ...f, presence: { status: 'offline', inCall: false } }, false)
    emit('friends')
  }
  if (Array.isArray(convs) && !store.conversationsLoaded) {
    for (const c of convs) setConversation(c, false)
    emit('conversations')
    emit('unread')
  }
}

export function resetStore() {
  store.me = null
  store.friends.clear()
  store.users.clear()
  store.presence.clear()
  store.conversations.clear()
  store.chats.clear()
  store.typing.clear()
  store.calls.clear()
  store.conversationsLoaded = false
  store.friendsLoaded = false
  store.activeConvId = null
  store.connected = false
}
