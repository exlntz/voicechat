// ===================== Оболочка «как в Дискорде»: слева лички и друзья, справа чат или звонок =====================
// Адреса: /friends — друзья, /dm/:id — личка, /lobby — звонок по коду, /room/:code — звонок.
// Лобби и сам звонок по-прежнему рисует app.js в #app-root; оболочка решает, что видно:
//   · /lobby и /room/:code — #app-root на всю правую часть;
//   · друзья/личка во время звонка — звонок встаёт панелью над чатом (#app-root сверху,
//     под ним #vl-view), звонок не прерывается и видео не пересоздаётся;
//   · друзья/личка без звонка — #app-root пуст и скрыт.
import { api, setUnauthorizedHandler } from './api.js'
import * as cache from './cache.js'
import {
  store, on, emit, loadFriends, loadConversations, hydrateFromCache, ensureConversation, dmWith,
  setConversation, refreshChat, resetStore
} from './store.js'
import { startEvents, stopEvents } from './events.js'
import { createSidebar } from './sidebar.js'
import { createFriendsView } from './friends.js'
import { createChatView } from './chat.js'
import { initNotifications, setBaseTitle } from './notify.js'
import { initCalls, onCallEnded, isSwitching, inCall } from './call-invite.js'
import { h, icon, toast, displayName } from './ui.js'

const VL = window.VL
const E = () => window.electronAPI || {}
const body = document.body
const sidebarRoot = document.getElementById('vl-sidebar')
const viewRoot = document.getElementById('vl-view')
const appRoot = document.getElementById('app-root')
const mainRoot = document.getElementById('vl-main')

let route = { name: 'friends' }
let sidebar = null
let view = null // {node, destroy, ...}
let viewKey = ''
let sessionActive = false

// ---------- Маршруты ----------
export function parseRoute(path = location.pathname, search = location.search) {
  let m
  if ((m = path.match(/^\/dm\/(\d+)\/?$/))) return { name: 'dm', id: Number(m[1]) }
  if ((m = path.match(/^\/room\/([a-z0-9]+)\/?$/i))) return { name: 'room', code: m[1].toLowerCase() }
  if (/^\/lobby\/?$/.test(path)) return { name: 'lobby' }
  const tab = new URLSearchParams(search).get('tab') || ''
  return { name: 'friends', tab }
}

export function navigate(path, { replace = false } = {}) {
  const url = new URL(path, location.origin)
  if (url.pathname + url.search !== location.pathname + location.search) {
    history[replace ? 'replaceState' : 'pushState']({}, '', url.pathname + url.search)
  }
  applyRoute(parseRoute(url.pathname, url.search))
}

const isAppRoute = (r) => r.name === 'lobby' || r.name === 'room'
function hasCallUi() {
  return inCall() || !!appRoot.querySelector('.room-screen, .pip-placeholder')
}

function applyRoute(next, { fromApp = false } = {}) {
  if (!sessionActive) return
  // Во время звонка /lobby и чужой /room/<код> показывают текущий звонок: лобби на его месте
  // уничтожило бы звонок
  if (!fromApp && isAppRoute(next) && inCall()) {
    const code = VL.state.roomCode
    if (next.name === 'lobby' || next.code !== code) {
      next = { name: 'room', code }
      history.replaceState({}, '', '/room/' + code)
    }
  }
  route = next
  body.classList.remove('vl-drawer-open')

  if (!fromApp) {
    if (isAppRoute(next)) {
      if (!hasCallUi()) {
        const lobby = appRoot.querySelector('.lobby-screen')
        // Лобби уже на экране (например, повторный клик) — не пересоздаём камеру превью
        if (!lobby || next.name === 'room') VL.renderLobby(next.code || '')
      }
    } else if (!hasCallUi()) {
      // Уходим из лобби в чат — выключить камеру превью и индикатор микрофона
      if (VL.teardownLobby) VL.teardownLobby()
      appRoot.replaceChildren()
    }
  }

  // Правая часть: друзья или личка
  if (isAppRoute(next)) {
    unmountView()
  } else {
    const key = next.name === 'dm' ? 'dm:' + next.id : 'friends'
    if (key !== viewKey) mountView(next, key)
    else if (next.name === 'friends' && view && view.setTab) view.setTab(next.tab || 'online')
  }
  if (sidebar) sidebar.setRoute(next)
  updateLayout()
  updateTitle()
}

function menuButton() {
  const b = h('button', { type: 'button', class: 'vl-icon-btn vl-menu-btn', 'aria-label': 'Открыть список чатов' }, [icon('bars')])
  b.addEventListener('click', () => body.classList.toggle('vl-drawer-open'))
  return b
}

async function mountView(r, key) {
  unmountView()
  viewKey = key
  if (r.name === 'friends') {
    view = createFriendsView({ navigate, openDmWith, menuButton, initialTab: r.tab || 'online' })
  } else {
    // Карточка лички нужна до отрисовки (собеседник в шапке); из кэша/списка — мгновенно
    let conv = store.conversations.get(r.id)
    if (!conv) {
      const placeholder = h('section', { class: 'vl-view vl-view--loading' }, [h('header', { class: 'vl-view__head' }, [menuButton()]), h('div', { class: 'vl-view__center' }, [h('span', { class: 'vl-spinner' })])])
      viewRoot.replaceChildren(placeholder)
      try { conv = await ensureConversation(r.id) } catch (e) {
        if (viewKey !== key) return
        toast(e.message || 'Чат не найден', 'error')
        navigate('/friends', { replace: true })
        return
      }
      if (viewKey !== key) return
    }
    view = createChatView({ convId: r.id, navigate, menuButton })
  }
  view.node.classList.add('vl-view-enter')
  viewRoot.replaceChildren(view.node)
  view.node.addEventListener('animationend', () => view && view.node.classList.remove('vl-view-enter'), { once: true })
  if (view.onShown) requestAnimationFrame(() => view && view.onShown && view.onShown())
  if (view.focus) view.focus()
  updateTitle()
}

function unmountView() {
  if (view) { try { view.destroy() } catch (e) { console.error(e) } }
  view = null
  viewKey = ''
  viewRoot.replaceChildren()
}

function updateTitle() {
  if (route.name === 'dm') {
    const conv = store.conversations.get(route.id)
    setBaseTitle(conv && conv.peer ? `@${displayName(conv.peer)} — Voice Lobby` : 'Voice Lobby')
  } else if (route.name === 'friends') setBaseTitle('Друзья — Voice Lobby')
  else setBaseTitle('Voice Lobby')
}

// ---------- Раскладка ----------
function updateLayout() {
  const showApp = isAppRoute(route)
  const docked = !showApp && hasCallUi()
  body.classList.toggle('vl-show-app', showApp)
  body.classList.toggle('vl-call-docked', docked)
  const screen = appRoot.querySelector('.room-screen')
  if (screen) screen.classList.toggle('is-docked', docked)
  renderDockTools(docked)
  if (sidebar) sidebar.refreshCall()
}

let dockTools = null
function renderDockTools(show) {
  if (!show) { if (dockTools) { dockTools.remove(); dockTools = null } return }
  if (dockTools) return
  const expand = h('button', { type: 'button', class: 'vl-dock__btn', title: 'Развернуть звонок', 'aria-label': 'Развернуть звонок' }, [icon('up-right-and-down-left-from-center')])
  expand.addEventListener('click', () => { if (VL.state.roomCode) navigate('/room/' + VL.state.roomCode) })
  dockTools = h('div', { class: 'vl-dock__tools' }, [expand])
  mainRoot.appendChild(dockTools)
}

// app.js перерисовывает #app-root сам (лобби -> звонок, звонок -> лобби) — держим раскладку в курсе
new MutationObserver(() => { if (sessionActive) updateLayout() }).observe(appRoot, { childList: true })
window.addEventListener('vl-call-state', () => { if (sessionActive) updateLayout() })

// ---------- Действия ----------
export async function openDmWith(userId) {
  const existing = dmWith(userId)
  if (existing) { navigate('/dm/' + existing.id); return existing }
  try {
    const { conversation } = await api.openDm(userId)
    setConversation(conversation)
    navigate('/dm/' + conversation.id)
    return conversation
  } catch (e) {
    toast(e.message, 'error')
    return null
  }
}

// ---------- Статус: ручной + автоматический «Отошёл» ----------
let manualStatus = 'online'
let autoIdle = false
try { manualStatus = localStorage.getItem('vl:status') || 'online' } catch {}
if (!['online', 'idle', 'dnd'].includes(manualStatus)) manualStatus = 'online'

function effectiveStatus() {
  if (manualStatus !== 'online') return manualStatus
  return autoIdle ? 'idle' : 'online'
}
function pushStatus() {
  const status = effectiveStatus()
  store.myStatus = status
  emit('status')
  if (store.connected) api.setPresence({ status }).catch(() => {})
}
function setStatus(status) {
  manualStatus = status
  try { localStorage.setItem('vl:status', status) } catch {}
  pushStatus()
}

// «Отошёл»: в .exe — по простою всей системы (главный процесс), на сайте — по простою страницы
const IDLE_MS = 10 * 60 * 1000
let lastActivity = Date.now()
function setAutoIdle(idle) {
  if (autoIdle === idle) return
  autoIdle = idle
  pushStatus()
}
if (typeof E().onIdleChange === 'function') {
  E().onIdleChange((idle) => setAutoIdle(!!idle))
} else {
  const bump = () => { lastActivity = Date.now(); if (autoIdle) setAutoIdle(false) }
  for (const ev of ['pointerdown', 'keydown', 'pointermove', 'wheel', 'touchstart']) window.addEventListener(ev, bump, { passive: true, capture: true })
  setInterval(() => { if (!autoIdle && Date.now() - lastActivity > IDLE_MS && !inCall()) setAutoIdle(true) }, 30000)
}

// ---------- Сессия ----------
async function startSession(me, prefillRoom = '') {
  if (sessionActive) return
  sessionActive = true
  store.me = { ...me, id: Number(me.id) }
  VL.state.currentUser = me
  body.classList.remove('vl-auth')
  body.classList.add('vl-ready')

  cache.openCache(store.me.id)
  sidebar = createSidebar({ root: sidebarRoot, navigate, openDmWith, setStatus, logout })
  hydrateFromCache().catch(() => {})
  store.myStatus = effectiveStatus()
  startEvents()
  Promise.all([loadFriends(), loadConversations()]).catch((e) => toast(e.message || 'Не удалось загрузить списки', 'error'))

  if (prefillRoom) history.replaceState({}, '', '/room/' + prefillRoom)
  else if (location.pathname === '/' || location.pathname === '') history.replaceState({}, '', '/friends' + location.search)
  applyRoute(parseRoute())
  if (pendingLink) { const link = pendingLink; pendingLink = null; navigate(link) }
}

async function endSession({ callServer = false } = {}) {
  if (!sessionActive) return
  if (inCall() && VL.leaveCall) VL.leaveCall()
  sessionActive = false
  if (callServer) { try { await api.logout() } catch {} }
  stopEvents()
  unmountView()
  if (sidebar) { sidebar.destroy(); sidebar = null }
  await cache.dropCache()
  resetStore()
  try { E().setBadge && E().setBadge(0, null) } catch {}
  body.classList.remove('vl-ready', 'vl-show-app', 'vl-call-docked', 'vl-drawer-open')
  body.classList.add('vl-auth')
  history.replaceState({}, '', '/')
  VL.state.currentUser = null
  VL.renderAuthScreen()
}

function logout() { endSession({ callServer: true }) }

// ---------- Хуки для app.js ----------
VL.onLogin = (user, prefillRoom) => startSession(user, prefillRoom)
VL.onLogout = () => endSession()
VL.onCallEnded = () => {
  const ctx = onCallEnded()
  // app.js сообщает vl-call-state ещё до того, как обнулит state.room, — повторяем, когда
  // звонка точно нет, чтобы шапка чата и панель слева перестали показывать «в звонке»
  const announce = () => { try { window.dispatchEvent(new CustomEvent('vl-call-state', { detail: { active: false } })) } catch {} }
  if (isSwitching()) return
  appRoot.replaceChildren()
  if (isAppRoute(route)) {
    // Выход из развёрнутого звонка: в личку, из которой звонили, иначе — в лобби
    if (ctx.conversationId) navigate('/dm/' + ctx.conversationId, { replace: true })
    else { history.replaceState({}, '', '/lobby'); route = { name: 'lobby' }; VL.renderLobby(); updateLayout() }
  } else {
    updateLayout()
  }
  announce()
}
// Навигация, которую сделал сам app.js (вход в комнату из лобби)
window.addEventListener('vl:navigate', (e) => {
  if (!sessionActive) return
  applyRoute(parseRoute(e.detail.path, ''), { fromApp: true })
})
window.addEventListener('popstate', () => applyRoute(parseRoute()))

// Ссылки внутри приложения (например, из уведомлений .exe: voicelobby://dm/12). Пришла до
// входа в аккаунт — откроем сразу после входа.
let pendingLink = null
function openDeepLink(link) {
  const path = String(link || '').replace(/^voicelobby:\/\//i, '/').replace(/^\/+/, '/')
  if (!/^\/(dm\/\d+|room\/[a-z0-9]+|friends|lobby)/i.test(path)) return
  if (!sessionActive) { pendingLink = path; return }
  navigate(path)
}

// ---------- События ----------
on('resync', async () => {
  // Сервер не смог доиграть пропущенное (перезапуск, долгий обрыв) — перечитываем всё
  try {
    await Promise.all([loadFriends(), loadConversations()])
    for (const [id, chat] of store.chats) {
      if (id === store.activeConvId) refreshChat(id).catch(() => {})
      else if (chat.state === 'ready') chat.state = 'cache'
    }
  } catch {}
})
on('connection', (up) => {
  body.classList.toggle('vl-offline', !up)
  if (up && manualStatus !== 'online' || up && autoIdle) pushStatus()
})
on('conversations', () => { if (route.name === 'dm') updateTitle() })

setUnauthorizedHandler(() => { if (sessionActive) { toast('Сессия истекла — войдите снова', 'warning'); endSession() } })

// ---------- Запуск ----------
async function boot() {
  VL.shellReady = true
  body.classList.add('vl-shell')
  initNotifications({ navigate: openDeepLink })
  initCalls({ navigate, onCallStart: () => updateLayout() })
  if (typeof E().onDeepLink === 'function') E().onDeepLink(openDeepLink)
  // Телефон: кнопка списка чатов поверх лобби/звонка и закрытие панели тапом мимо неё
  const fab = h('button', { type: 'button', class: 'vl-fab-menu', 'aria-label': 'Открыть список чатов' }, [icon('bars')])
  fab.addEventListener('click', () => body.classList.add('vl-drawer-open'))
  body.appendChild(fab)
  mainRoot.addEventListener('click', (e) => { if (e.target === mainRoot && body.classList.contains('vl-drawer-open')) body.classList.remove('vl-drawer-open') })
  const me = await VL.fetchMe()
  if (!me) {
    body.classList.add('vl-auth')
    const r = parseRoute()
    VL.renderAuthScreen(r.name === 'room' ? r.code : '')
    return
  }
  VL.state.currentUser = me
  await startSession(me)
}

boot()
