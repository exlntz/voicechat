// ===================== Звонки из чата: исходящий, входящий, вход в комнату =====================
// Звонок — обычная комната LiveKit. Из лички: сервер создаёт комнату, звонящий сразу в неё
// входит (звонок встаёт панелью над чатом), собеседнику приходит call.incoming.
// Входящий на сайте — карточка поверх страницы с мелодией; в .exe — отдельное маленькое окно
// поверх всех окон (electronAPI.showIncomingCall), страница только передаёт данные.
import { api } from './api.js'
import { store, on, userById, emit } from './store.js'
import { h, icon, avatar, displayName, toast, avatarColor, initialsOf } from './ui.js'
import { startRingtone, notify, getAudioCtx } from './notify.js'

const E = () => window.electronAPI || {}
const VL = () => window.VL || {}

// Контекст текущего звонка, начатого через оболочку
export const callState = {
  roomCode: null,
  conversationId: null, // из какой лички звонок (туда вернёмся после «Выйти»)
  outgoingCallId: null // пока собеседник не ответил
}
let switching = false // кладём трубку, чтобы сразу войти в другой звонок
let hooks = { navigate: () => {}, onCallStart: () => {} }

export function inCall() {
  return !!(VL().state && VL().state.room)
}

export function isSwitching() { return switching }

export function initCalls(h0) {
  hooks = { ...hooks, ...h0 }
  on('event:call.incoming', (call) => showIncoming(call))
  on('event:call.cancel', (d) => {
    const call = store.calls.get(d.callId)
    dismissIncoming(d.callId)
    if (call && (d.reason === 'cancelled' || d.reason === 'timeout')) {
      notify({ title: 'Пропущенный звонок', body: `от ${displayName(call.from)}`, tag: 'call-' + d.callId, route: '/dm/' + call.conversationId })
    }
  })
  on('event:call.accepted', (d) => {
    if (d.callId === callState.outgoingCallId) { callState.outgoingCallId = null; stopRingback() }
  })
  on('event:call.declined', (d) => outgoingEnded(d.callId, 'отклонил(а) звонок'))
  on('event:call.timeout', (d) => outgoingEnded(d.callId, 'не ответил(а)'))
  on('event:hello', (d) => {
    const live = new Set((d.calls || []).map((c) => c.callId))
    for (const id of [...store.calls.keys()]) if (!live.has(id)) dismissIncoming(id)
    for (const c of d.calls || []) if (!store.calls.has(c.callId)) showIncoming(c)
  })
  if (typeof E().onIncomingCallAction === 'function') {
    E().onIncomingCallAction(({ callId, action }) => {
      const call = store.calls.get(callId)
      if (!call) return
      if (action === 'accept') accept(call)
      else decline(call)
    })
  }
  if (typeof E().onToggleMute === 'function') E().onToggleMute(() => { if (VL().toggleMic) VL().toggleMic() })
}

function peerName(convId) {
  const conv = store.conversations.get(Number(convId))
  return conv && conv.peer ? displayName(conv.peer) : 'Собеседник'
}

function outgoingEnded(callId, what) {
  if (callId !== callState.outgoingCallId) return
  const convId = callState.conversationId
  callState.outgoingCallId = null
  stopRingback()
  toast(`${peerName(convId)} ${what}`, 'info')
  // Остались в комнате одни — выходим, как в Дискорде при сброшенном вызове
  const room = VL().state && VL().state.room
  if (room && room.remoteParticipants && room.remoteParticipants.size === 0 && VL().leaveCall) VL().leaveCall()
}

// ---------- Вход в комнату из оболочки ----------
export async function joinRoom({ roomCode, hostSecret = null, conversationId = null, outgoingCallId = null }) {
  const vl = VL()
  if (inCall()) {
    if (vl.state.roomCode === roomCode) return true
    switching = true
    try { vl.leaveCall && vl.leaveCall() } finally { switching = false }
  }
  if (vl.teardownLobby) vl.teardownLobby()
  const secret = hostSecret || safeGet(`hostSecret:${roomCode}`)
  let data
  try {
    data = await api.join(roomCode, secret)
  } catch (e) {
    toast(e.message || 'Не удалось подключиться', 'error')
    if (outgoingCallId) api.cancelCall(outgoingCallId).catch(() => {})
    return false
  }
  if (data.isHost && data.hostSecret) safeSet(`hostSecret:${data.roomCode}`, data.hostSecret)
  callState.roomCode = data.roomCode
  callState.conversationId = conversationId
  callState.outgoingCallId = outgoingCallId
  // Звонок из чата — голосом, камера выключена; микрофон по настройке «входить без звука»
  vl.state.cameraEnabled = false
  vl.state.micEnabled = !(vl.getPref && vl.getPref('joinMicMuted'))
  if (outgoingCallId) startRingback()
  try { E().setCallState && E().setCallState(true) } catch {}
  const pending = vl.enterRoom(data)
  hooks.onCallStart()
  emit('call-changed')
  await pending
  return true
}

// Вызывается из app.js (VL.onCallEnded) после выхода из звонка
export function onCallEnded() {
  stopRingback()
  const ctx = { ...callState }
  if (ctx.outgoingCallId) api.cancelCall(ctx.outgoingCallId).catch(() => {})
  callState.roomCode = null
  callState.conversationId = null
  callState.outgoingCallId = null
  api.setPresence({ inCall: false }).catch(() => {})
  try { E().setCallState && E().setCallState(false) } catch {}
  emit('call-changed')
  return ctx
}

export async function startCall(convId) {
  convId = Number(convId)
  if (inCall() && callState.conversationId === convId) return
  let res
  try {
    res = await api.startCall(convId)
  } catch (e) {
    toast(e.message || 'Не удалось позвонить', 'error')
    return
  }
  // Встречный звонок: собеседник уже звонил нам — сервер засчитал это как «принять»
  if (res.accepted) dismissIncoming(res.callId)
  await joinRoom({ roomCode: res.roomCode, hostSecret: res.hostSecret, conversationId: convId, outgoingCallId: res.accepted ? null : res.callId })
}

// Кнопка «Присоединиться» у карточки звонка в чате
export async function joinCallFromMessage(message) {
  const code = message.meta && message.meta.roomCode
  if (!code) return
  const pendingIncoming = message.meta.callId && store.calls.get(message.meta.callId)
  if (pendingIncoming) { accept(pendingIncoming); return }
  await joinRoom({ roomCode: code, conversationId: message.conversationId })
}

// ---------- Входящий ----------
let current = null // {call, node, stopRing}

function showIncoming(call) {
  if (!call || !call.callId) return
  if (call.from) store.users.set(call.from.id, call.from)
  store.calls.set(call.callId, call)
  emit('calls')
  const e = E()
  if (typeof e.showIncomingCall === 'function') {
    const name = displayName(call.from)
    try {
      e.showIncomingCall({ callId: call.callId, name, username: call.from && call.from.username, color: avatarColor(call.from && call.from.id), initials: initialsOf(name) })
      return
    } catch {}
  }
  notify({ title: displayName(call.from), body: 'Входящий звонок', tag: 'call-' + call.callId, route: '/dm/' + call.conversationId })
  if (!current) renderIncoming(call)
}

function renderIncoming(call) {
  const from = call.from || userById(call.from && call.from.id)
  const acceptBtn = h('button', { type: 'button', class: 'vl-call-btn is-accept', 'aria-label': 'Принять звонок' }, [icon('phone')])
  const declineBtn = h('button', { type: 'button', class: 'vl-call-btn is-decline', 'aria-label': 'Отклонить звонок' }, [icon('phone-slash')])
  const card = h('div', { class: 'vl-incoming', role: 'alertdialog', 'aria-label': `Входящий звонок от ${displayName(from)}` }, [
    h('div', { class: 'vl-incoming__ava' }, [h('span', { class: 'vl-incoming__wave', 'aria-hidden': 'true' }), avatar(from, { size: 88 })]),
    h('div', { class: 'vl-incoming__name' }, displayName(from)),
    h('div', { class: 'vl-incoming__sub' }, 'Звонит вам'),
    h('div', { class: 'vl-incoming__actions' }, [
      h('span', { class: 'vl-incoming__act' }, [declineBtn, h('span', {}, 'Отклонить')]),
      h('span', { class: 'vl-incoming__act' }, [acceptBtn, h('span', {}, 'Принять')])
    ])
  ])
  const overlay = h('div', { class: 'vl-incoming-wrap' }, [card])
  acceptBtn.addEventListener('click', () => accept(call))
  declineBtn.addEventListener('click', () => decline(call))
  document.body.appendChild(overlay)
  const stopRing = store.myStatus === 'dnd' ? () => {} : startRingtone()
  current = { call, node: overlay, stopRing }
  acceptBtn.focus()
}

export function dismissIncoming(callId) {
  store.calls.delete(callId)
  emit('calls')
  try { E().hideIncomingCall && E().hideIncomingCall(callId) } catch {}
  if (current && current.call.callId === callId) {
    current.stopRing()
    const node = current.node
    node.classList.add('is-leaving')
    setTimeout(() => node.remove(), 200)
    current = null
    // Следующий в очереди (два звонка одновременно — редкость, но не теряем)
    const next = [...store.calls.values()][0]
    if (next && typeof E().showIncomingCall !== 'function') renderIncoming(next)
  }
}

async function accept(call) {
  dismissIncoming(call.callId)
  let res
  try {
    res = await api.acceptCall(call.callId)
  } catch (e) {
    toast(e.message || 'Звонок уже завершён', 'warning')
    return
  }
  hooks.navigate('/dm/' + res.conversationId)
  await joinRoom({ roomCode: res.roomCode, conversationId: res.conversationId })
}

function decline(call) {
  dismissIncoming(call.callId)
  api.declineCall(call.callId).catch(() => {})
}

// ---------- Гудки для звонящего ----------
let ringbackTimer = 0
function startRingback() {
  stopRingback()
  const ctx = getAudioCtx()
  if (!ctx) return
  const beep = () => {
    if (ctx.state !== 'running') return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.value = 425
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.035, t + 0.03)
    g.gain.setValueAtTime(0.035, t + 0.95)
    g.gain.linearRampToValueAtTime(0, t + 1)
    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 1.05)
  }
  beep()
  ringbackTimer = setInterval(() => {
    // Собеседник уже в комнате (принял на другом устройстве) — гудки не нужны
    const room = VL().state && VL().state.room
    if (room && room.remoteParticipants && room.remoteParticipants.size > 0) { stopRingback(); return }
    beep()
  }, 4000)
}
function stopRingback() {
  clearInterval(ringbackTimer)
  ringbackTimer = 0
}

function safeGet(k) { try { return localStorage.getItem(k) } catch { return null } }
function safeSet(k, v) { try { localStorage.setItem(k, v) } catch {} }
