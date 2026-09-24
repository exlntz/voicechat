// ===================== Личка: лента сообщений и поле ввода =====================
// Скорость:
//  · сообщение появляется сразу, до ответа сервера (store.sendMessage рисует черновик);
//  · история берётся из IndexedDB, поэтому чат открывается мгновенно, а сеть лишь сверяет её;
//  · ленту не перерисовываем целиком: узлы сообщений переиспользуются по ключу, меняются только
//    изменившиеся; браузер не считает раскладку сообщений вне экрана (content-visibility в CSS);
//  · старые сообщения подгружаются при прокрутке вверх, а когда вы снова внизу — лишнее
//    выгружается из памяти (store.trimChat), чтобы длинная переписка не тормозила.
import {
  store, on, getChat, openChat, loadOlder, trimChat, sendMessage, retryMessage, discardDraft,
  markRead, userById, presenceOf, typingUsers
} from './store.js'
import { api } from './api.js'
import {
  h, icon, avatar, setPresenceDot, displayName, presenceText, richText, timeHM, dayLabel,
  dayKey, confirmDialog, showMenu, toast
} from './ui.js'
import { startCall, joinCallFromMessage, callState, inCall } from './call-invite.js'

const MAX_LEN = 4000
const GROUP_MS = 7 * 60 * 1000
const TYPING_EVERY_MS = 3000

export function createChatView({ convId, navigate, menuButton }) {
  convId = Number(convId)
  const conv0 = store.conversations.get(convId)
  const peer = (conv0 && conv0.peer) || { id: 0, username: '', displayName: 'Собеседник' }
  const me = store.me
  const unsub = []

  // Разделитель «Новые сообщения»: всё после последнего прочитанного на момент открытия
  const unreadAfter = conv0 && conv0.unread ? conv0.lastReadId || 0 : null
  let unreadMarkerId = null
  let replyTo = null // {id, authorId, body}
  let editingKey = null
  let positioned = false // первичная прокрутка (к непрочитанным или вниз) уже сделана
  let atBottom = true
  let destroyed = false
  const animateKeys = new Set()

  // ---------- Шапка ----------
  const headAvatar = avatar(peer, { size: 44, presence: presenceOf(peer.id) })
  const headName = h('span', { class: 'vl-chat__head-name' })
  const headSub = h('span', { class: 'vl-chat__head-sub' })
  const callBtn = h('button', { type: 'button', class: 'vl-round is-lg', title: 'Позвонить', 'aria-label': 'Позвонить' }, [icon('phone')])
  const muteBtn = h('button', { type: 'button', class: 'vl-round is-lg' })
  callBtn.addEventListener('click', () => {
    if (inCall() && callState.conversationId === convId) { navigate('/room/' + window.VL.state.roomCode); return }
    startCall(convId)
  })
  muteBtn.addEventListener('click', async () => {
    const conv = store.conversations.get(convId)
    if (!conv) return
    try {
      await api.updateConversation(convId, { muted: !conv.muted })
      toast(conv.muted ? 'Уведомления включены' : 'Чат без звука', 'info')
    } catch (e) { toast(e.message, 'error') }
  })
  const header = h('header', { class: 'vl-view__head vl-chat__head' }, [
    menuButton(),
    headAvatar,
    h('div', { class: 'vl-chat__head-text' }, [headName, headSub]),
    h('div', { class: 'vl-chat__head-actions' }, [callBtn, muteBtn])
  ])
  function renderHeader() {
    const conv = store.conversations.get(convId)
    // Собеседник мог сменить юзернейм, пока чат открыт, — берём свежие данные
    const cur = userById(peer.id) || peer
    const p = presenceOf(peer.id)
    setPresenceDot(headAvatar, p)
    headName.textContent = displayName(cur)
    headSub.textContent = `@${cur.username} · ${presenceText(p)}`
    input.placeholder = `Написать @${cur.username || 'собеседнику'}`
    const muted = !!(conv && conv.muted)
    muteBtn.replaceChildren(icon(muted ? 'bell-slash' : 'bell'))
    muteBtn.title = muted ? 'Включить уведомления' : 'Без звука'
    muteBtn.setAttribute('aria-label', muteBtn.title)
    muteBtn.classList.toggle('is-on', muted)
    const here = inCall() && callState.conversationId === convId
    callBtn.classList.toggle('is-live', here)
    callBtn.title = here ? 'Открыть звонок' : 'Позвонить'
  }

  // ---------- Лента ----------
  const list = h('div', { class: 'vl-chat__list', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' })
  const scroller = h('div', { class: 'vl-chat__scroll' }, [list])
  const jumpBtn = h('button', { type: 'button', class: 'vl-jump', hidden: true }, [h('span', {}, 'Новые сообщения'), icon('arrow-down')])
  jumpBtn.addEventListener('click', () => scrollToBottom(true))

  // ---------- Поле ввода ----------
  const replyBar = h('div', { class: 'vl-reply-bar', hidden: true })
  const input = h('textarea', { class: 'vl-composer__input', rows: '1', maxlength: String(MAX_LEN + 500), placeholder: `Написать @${peer.username || 'собеседнику'}`, 'aria-label': 'Сообщение' })
  const sendBtn = h('button', { type: 'button', class: 'vl-composer__send', title: 'Отправить', 'aria-label': 'Отправить', disabled: true }, [icon('paper-plane')])
  const counter = h('span', { class: 'vl-composer__counter', hidden: true })
  // Поле — «таблетка», кнопка отправки — отдельный круг справа
  const composerBox = h('div', { class: 'vl-composer__box' }, [h('div', { class: 'vl-composer__field' }, [input, counter]), sendBtn])
  const blockedNote = h('div', { class: 'vl-composer__blocked', hidden: true })
  // Для экранного диктора: «печатает…» теперь пузырь в ленте, а текст — здесь
  const typingLine = h('div', { class: 'vl-sr-only', 'aria-live': 'polite' })
  const composer = h('div', { class: 'vl-composer' }, [replyBar, composerBox, blockedNote, typingLine])

  const node = h('section', { class: 'vl-view vl-view--chat' }, [header, h('div', { class: 'vl-chat__main' }, [scroller, jumpBtn]), composer])

  // Черновик переживает переход между чатами и перезагрузку вкладки
  const draftKey = `vl:draft:${convId}`
  try { input.value = sessionStorage.getItem(draftKey) || '' } catch {}

  function autosize() {
    // Пока поле не на странице, его высота 0 — если запомнить её, подсказка обрезается
    if (!input.isConnected) return
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px'
  }
  function updateComposer() {
    const len = input.value.length
    const over = len > MAX_LEN
    counter.hidden = len < MAX_LEN - 500
    counter.textContent = `${len}/${MAX_LEN}`
    counter.classList.toggle('is-over', over)
    sendBtn.disabled = !input.value.trim() || over
    autosize()
  }

  let lastTypingSent = 0
  input.addEventListener('input', () => {
    updateComposer()
    try { input.value ? sessionStorage.setItem(draftKey, input.value) : sessionStorage.removeItem(draftKey) } catch {}
    const now = Date.now()
    if (input.value.trim() && now - lastTypingSent > TYPING_EVERY_MS) {
      lastTypingSent = now
      api.typing(convId).catch(() => {})
    }
  })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    else if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReply(null) }
    else if (e.key === 'ArrowUp' && !input.value) {
      const mine = [...getChat(convId).list].reverse().find((m) => m.id && m.authorId === me.id && m.kind === 'text')
      if (mine) { e.preventDefault(); startEdit(mine) }
    }
  })
  sendBtn.addEventListener('click', submit)

  function submit() {
    const text = input.value.replace(/\s+$/, '')
    if (!text.trim() || text.length > MAX_LEN) return
    const reply = replyTo ? replyTo.id : null
    input.value = ''
    try { sessionStorage.removeItem(draftKey) } catch {}
    setReply(null)
    updateComposer()
    lastTypingSent = 0
    sendMessage(convId, text, reply).catch(() => {})
    input.focus()
  }

  function setReply(m) {
    replyTo = m ? { id: m.id, authorId: m.authorId, body: m.body } : null
    if (!replyTo) { replyBar.hidden = true; replyBar.replaceChildren(); return }
    const who = replyTo.authorId === me.id ? 'себе' : displayName(userById(replyTo.authorId))
    const close = h('button', { type: 'button', class: 'vl-round is-sm is-ghost', 'aria-label': 'Отменить ответ' }, [icon('xmark')])
    close.addEventListener('click', () => setReply(null))
    replyBar.replaceChildren(icon('reply'), h('span', { class: 'vl-reply-bar__body' }, [h('b', {}, replyTo.authorId === me.id ? 'Ответ себе' : `Ответ ${who}`), h('span', { class: 'vl-reply-bar__text' }, String(replyTo.body).replace(/\s+/g, ' ').slice(0, 120))]), close)
    replyBar.hidden = false
    input.focus()
  }

  function renderBlocked() {
    const f = store.friends.get(peer.id)
    const blocked = !!(f && f.status === 'blocked')
    composerBox.hidden = blocked
    blockedNote.hidden = !blocked
    if (blocked) {
      const unblock = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost vl-btn--sm' }, 'Разблокировать')
      unblock.addEventListener('click', () => api.unblockUser(peer.id).catch((e) => toast(e.message, 'error')))
      blockedNote.replaceChildren(h('span', {}, 'Вы заблокировали этого пользователя.'), unblock)
    }
  }

  // «Печатает…» — пузырь с точками в конце ленты (см. renderList)
  function typingNames() {
    return typingUsers(convId).filter((id) => id !== me.id).map((id) => displayName(userById(id)))
  }
  function renderTyping() {
    const names = typingNames()
    typingLine.textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'печатают' : 'печатает'}` : ''
    const stick = atBottom
    renderList()
    if (stick && positioned) scrollToBottom()
  }

  // ---------- Сообщения ----------
  function authorOf(m) {
    return m.authorId === me.id ? me : (userById(m.authorId) || { id: m.authorId, username: '', displayName: 'Пользователь' })
  }

  function scrollToMessage(id) {
    const entry = nodes.get('m' + id)
    if (!entry) { toast('Сообщение выше в истории', 'info'); return }
    entry.node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    entry.node.classList.remove('is-flash')
    void entry.node.offsetWidth
    entry.node.classList.add('is-flash')
  }

  function toolButton(iconName, title, onClick, danger = false) {
    const b = h('button', { type: 'button', class: `vl-round is-xs is-dark${danger ? ' is-danger-hover' : ''}`, title, 'aria-label': title }, [icon(iconName)])
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
    return b
  }

  async function askDelete(m, skipConfirm) {
    const ok = skipConfirm || await confirmDialog({ title: 'Удалить сообщение', text: 'Сообщение пропадёт у обоих. Подсказка: с зажатым Shift удаление без вопроса.', confirmLabel: 'Удалить', danger: true })
    if (!ok) return
    try { await api.deleteMessage(convId, m.id) } catch (e) { toast(e.message, 'error'); return }
    // SSE уберёт сообщение и у нас; делаем это сразу, не дожидаясь
    const chat = getChat(convId)
    chat.list = chat.list.filter((x) => x.id !== m.id)
    renderList()
  }

  function startEdit(m) {
    editingKey = 'm' + m.id
    renderList()
    const entry = nodes.get(editingKey)
    const ta = entry && entry.node.querySelector('textarea')
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }
  }

  function buildEditor(m) {
    const ta = h('textarea', { class: 'vl-msg__edit', rows: '1', maxlength: String(MAX_LEN) })
    ta.value = m.body
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px' }
    requestAnimationFrame(fit)
    const cancel = () => { editingKey = null; renderList(); input.focus() }
    const save = async () => {
      const body = ta.value.replace(/\s+$/, '')
      if (!body.trim()) { editingKey = null; askDelete(m); return }
      editingKey = null
      if (body === m.body) { renderList(); return }
      // Мгновенно показываем новый текст, сервер подтвердит
      const local = getChat(convId).list.find((x) => x.id === m.id)
      if (local) { local.body = body; local.editedAt = Date.now() }
      renderList()
      try { await api.editMessage(convId, m.id, body) } catch (e) { toast(e.message, 'error'); if (local) { local.body = m.body; local.editedAt = m.editedAt; renderList() } }
    }
    ta.addEventListener('input', fit)
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
    })
    return h('div', { class: 'vl-msg__editor' }, [
      ta,
      h('div', { class: 'vl-msg__edit-hint' }, ['Esc — ', h('button', { type: 'button', class: 'vl-linkbtn', onclick: cancel }, 'отмена'), ' · Enter — ', h('button', { type: 'button', class: 'vl-linkbtn', onclick: save }, 'сохранить')])
    ])
  }

  // Цитата ответа — внутри пузыря, над текстом
  function buildQuote(m) {
    const r = m.reply
    const who = r ? authorOf(r) : null
    const quote = h('button', { type: 'button', class: 'vl-quote' }, r && !r.deleted
      ? [h('b', {}, r.authorId === me.id ? 'Вы' : displayName(who)), h('span', {}, r.kind === 'call' ? 'Звонок' : String(r.body).replace(/\s+/g, ' ').slice(0, 140))]
      : [h('span', { class: 'is-muted' }, 'Исходное сообщение удалено')])
    if (r && !r.deleted) quote.addEventListener('click', () => scrollToMessage(r.id))
    return quote
  }

  // pos: single | first | middle | last — место в серии подряд идущих сообщений одного автора
  function buildMessage(m, pos, readMark) {
    const mine = m.authorId === me.id
    const key = m.id ? 'm' + m.id : 'c' + m.clientId
    const editing = editingKey === key
    const cls = ['vl-msg', mine ? 'is-mine' : 'is-theirs', 'pos-' + pos]
    if (m.pending) cls.push('is-pending')
    if (m.failed) cls.push('is-failed')
    if (editing) cls.push('is-editing')
    if (animateKeys.has(key)) { cls.push('is-new'); animateKeys.delete(key) }

    let bubble
    if (editing) {
      bubble = buildEditor(m)
    } else {
      const meta = h('span', { class: 'vl-bubble__meta' }, [
        m.editedAt ? h('span', { title: 'Изменено ' + new Date(m.editedAt).toLocaleString('ru-RU') }, 'изм. ') : null,
        h('time', { datetime: new Date(m.createdAt).toISOString() }, timeHM(m.createdAt)),
        m.pending ? icon('clock') : null
      ])
      const text = h('div', { class: 'vl-bubble__text is-selectable' }, [richText(m.body), meta])
      bubble = h('div', { class: 'vl-bubble', title: new Date(m.createdAt).toLocaleString('ru-RU') }, [m.reply ? buildQuote(m) : null, text])
    }

    const tools = []
    if (m.id && !editing) {
      tools.push(toolButton('reply', 'Ответить', () => setReply(m)))
      if (mine) tools.push(toolButton('pen', 'Изменить', () => startEdit(m)))
      tools.push(toolButton('copy', 'Копировать текст', () => window.VL.copyToClipboard(m.body).then((ok) => toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error'))))
      if (mine) tools.push(toolButton('trash', 'Удалить', (e) => askDelete(m, e.shiftKey), true))
    }
    const children = [h('div', { class: 'vl-msg__wrap' }, [bubble, tools.length ? h('div', { class: 'vl-msg__tools' }, tools) : null])]
    if (m.failed) {
      const retry = h('button', { type: 'button', class: 'vl-linkbtn' }, 'Повторить')
      const drop = h('button', { type: 'button', class: 'vl-linkbtn' }, 'Удалить')
      retry.addEventListener('click', () => retryMessage(convId, m.clientId))
      drop.addEventListener('click', () => discardDraft(convId, m.clientId))
      children.push(h('div', { class: 'vl-msg__failed' }, [icon('circle-exclamation'), h('span', {}, `${m.failed}.`), retry, drop]))
    }
    if (readMark) children.push(h('div', { class: 'vl-msg__read' }, [icon('check-double'), 'Прочитано']))

    const msg = h('div', { class: cls.join(' '), 'data-key': key }, children)
    if (m.id) {
      msg.addEventListener('contextmenu', (e) => {
        if (e.target.closest('a, textarea')) return
        e.preventDefault()
        showMenu([
          { label: 'Ответить', icon: 'reply', onClick: () => setReply(m) },
          mine && m.kind === 'text' ? { label: 'Изменить', icon: 'pen', onClick: () => startEdit(m) } : null,
          { label: 'Копировать текст', icon: 'copy', onClick: () => window.VL.copyToClipboard(m.body) },
          mine ? 'sep' : null,
          mine ? { label: 'Удалить', icon: 'trash', danger: true, onClick: () => askDelete(m, false) } : null
        ], e)
      })
      msg.addEventListener('dblclick', (e) => { if (mine && m.kind === 'text' && !e.target.closest('a, textarea')) startEdit(m) })
    }
    return msg
  }

  // Звонок в ленте — пилюля по центру: зелёная, пока звонок жив, красноватая — пропущенный/отклонён
  function buildCallMessage(m) {
    const author = authorOf(m)
    const mine = m.authorId === me.id
    const status = (m.meta && m.meta.status) || 'ringing'
    let text
    if (status === 'missed') text = mine ? `${displayName(peer)} не ответил(а)` : `Пропущенный звонок от ${displayName(author)}`
    else if (status === 'declined') text = mine ? `${displayName(peer)} отклонил(а) звонок` : 'Вы отклонили звонок'
    else if (status === 'ringing') text = mine ? 'Вы звоните…' : `${displayName(author)} звонит вам…`
    else text = mine ? 'Вы начали звонок' : `${displayName(author)} начал(а) звонок`
    const bad = status === 'missed' || status === 'declined'
    const pill = h('div', { class: `vl-callpill${bad ? ' is-bad' : ''}` }, [
      icon(bad ? 'phone-slash' : 'phone'),
      h('span', { class: 'vl-callpill__text' }, text),
      h('time', { class: 'vl-callpill__time' }, timeHM(m.createdAt))
    ])
    const here = inCall() && m.meta && window.VL.state.roomCode === m.meta.roomCode
    if (canJoin(m) && !here) {
      const join = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--sm vl-btn--pill' }, 'Присоединиться')
      join.addEventListener('click', () => joinCallFromMessage(m))
      pill.appendChild(join)
    }
    return h('div', { class: `vl-msg vl-msg--call${animateKeys.delete('m' + m.id) ? ' is-new' : ''}`, 'data-key': 'm' + m.id }, [pill])
  }

  function buildTyping(names) {
    return h('div', { class: 'vl-msg is-theirs pos-single is-typing-row', 'aria-hidden': 'true' }, [
      h('div', { class: 'vl-msg__wrap' }, [h('div', { class: 'vl-bubble is-typing', title: `${names.join(', ')} печатает` }, [h('i'), h('i'), h('i')])])
    ])
  }

  // «Присоединиться» — только пока звонок звонит или в его комнате кто-то есть
  const roomLive = new Map() // roomCode -> {count, at}
  function canJoin(m) {
    const code = m.meta && m.meta.roomCode
    const status = m.meta && m.meta.status
    if (!code || Date.now() - m.createdAt > 12 * 3600 * 1000) return false
    if (status === 'ringing') return true
    if (status !== 'accepted') return false
    const known = roomLive.get(code)
    if (!known || Date.now() - known.at > 20000) checkRoom(code)
    return !!(known && known.count > 0)
  }
  function checkRoom(code) {
    const known = roomLive.get(code)
    if (known && known.pending) return
    roomLive.set(code, { count: known ? known.count : 0, at: Date.now(), pending: true })
    api.get('/api/rooms/' + encodeURIComponent(code)).then((r) => {
      const count = r && r.exists ? r.participantCount : 0
      const changed = !known || known.count !== count
      roomLive.set(code, { count, at: Date.now() })
      if (changed && !destroyed) renderList()
    }).catch(() => roomLive.set(code, { count: 0, at: Date.now() }))
  }

  function buildIntro() {
    return h('div', { class: 'vl-chat__intro' }, [
      avatar(peer, { size: 88 }),
      h('h2', {}, displayName(peer)),
      h('div', { class: 'vl-chat__intro-user' }, '@' + peer.username),
      h('p', {}, ['Это начало вашей личной переписки с ', h('b', {}, displayName(peer)), '.'])
    ])
  }

  function buildSkeleton() {
    const rows = []
    // Неподвижные бледные пузыри той же формы, что и настоящие, — без мерцания
    for (let i = 0; i < 8; i++) {
      const mine = i % 3 === 1
      rows.push(h('div', { class: `vl-msg ${mine ? 'is-mine' : 'is-theirs'} pos-single is-skeleton` }, [
        h('div', { class: 'vl-msg__wrap' }, [h('span', { class: 'vl-skel vl-skel--bubble', style: { width: `${120 + ((i * 67) % 220)}px` } })])
      ]))
    }
    return h('div', { class: 'vl-chat__skeleton' }, rows)
  }

  // ---------- Сборка ленты с переиспользованием узлов ----------
  const nodes = new Map() // key -> {node, sig}
  function renderList() {
    if (destroyed) return
    const chat = getChat(convId)
    const conv = store.conversations.get(convId)
    const items = []
    if (chat.state === 'empty') {
      items.push({ key: 'skeleton', sig: '1', build: buildSkeleton })
    } else if (chat.hasMore) {
      items.push({ key: 'loader', sig: chat.loadingOlder ? '1' : '0', build: () => h('div', { class: 'vl-chat__loader' }, [h('span', { class: 'vl-spinner' }), 'Загружаем историю…']) })
    } else {
      items.push({ key: 'intro', sig: '1', build: buildIntro })
    }
    // Последнее своё сообщение, которое собеседник уже прочитал
    const peerRead = (conv && conv.peerLastReadId) || 0
    let lastMine = null
    for (const m of chat.list) if (m.id && m.authorId === me.id && m.kind === 'text') lastMine = m
    const readMarkId = lastMine && lastMine.id <= peerRead && lastMine === chat.list[chat.list.length - 1] ? lastMine.id : null

    if (unreadAfter != null && unreadMarkerId == null) {
      const first = chat.list.find((m) => m.id && m.id > unreadAfter && m.authorId !== me.id)
      if (first) unreadMarkerId = first.id
    }

    // Серии: сообщение «прилипает» к предыдущему, если тот же автор, тот же день, меньше 7 минут
    // и между ними нет разделителя «Новые». От этого зависят скругления пузырей.
    const msgs = chat.list
    const joins = msgs.map((m, i) => {
      const p = msgs[i - 1]
      return !!p && m.kind === 'text' && p.kind === 'text' && p.authorId === m.authorId &&
        dayKey(p.createdAt) === dayKey(m.createdAt) && m.createdAt - p.createdAt < GROUP_MS &&
        !p.failed && !(m.id && m.id === unreadMarkerId)
    })

    let prev = null
    msgs.forEach((m, i) => {
      const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)
      if (newDay) {
        const k = 'day-' + dayKey(m.createdAt)
        items.push({ key: k, sig: '1', build: () => h('div', { class: 'vl-day', role: 'separator' }, [h('span', {}, dayLabel(m.createdAt))]) })
      }
      const divider = m.id && m.id === unreadMarkerId
      if (divider) items.push({ key: 'unread', sig: '1', build: () => h('div', { class: 'vl-unread-divider', role: 'separator' }, [h('span', {}, 'Новые сообщения')]) })
      const key = m.id ? 'm' + m.id : 'c' + m.clientId
      if (m.kind === 'call') {
        const here = inCall() && m.meta && window.VL.state.roomCode === m.meta.roomCode
        const live = m.meta && roomLive.get(m.meta.roomCode)
        items.push({ key, sig: `call|${m.meta && m.meta.status}|${here}|${live ? live.count : '?'}`, build: () => buildCallMessage(m) })
      } else {
        const jp = joins[i]
        const jn = !!joins[i + 1]
        const pos = jp ? (jn ? 'middle' : 'last') : (jn ? 'first' : 'single')
        const read = m.id && m.id === readMarkId
        const sig = [m.id, m.body, m.editedAt, m.pending ? 1 : 0, m.failed || '', pos, read ? 1 : 0, editingKey === key ? 1 : 0, m.reply ? m.reply.id : ''].join('|')
        items.push({ key, sig, build: () => buildMessage(m, pos, read) })
      }
      prev = m
    })
    const typers = chat.state === 'empty' ? [] : typingNames()
    if (typers.length) items.push({ key: 'typing', sig: typers.join(','), build: () => buildTyping(typers) })

    let cursor = list.firstChild
    const seen = new Set()
    for (const it of items) {
      seen.add(it.key)
      let entry = nodes.get(it.key)
      if (entry && entry.sig !== it.sig) {
        if (entry.node === cursor) cursor = cursor.nextSibling
        entry.node.remove()
        entry = null
      }
      if (!entry) {
        entry = { node: it.build(), sig: it.sig }
        nodes.set(it.key, entry)
      }
      if (entry.node === cursor) cursor = cursor.nextSibling
      else list.insertBefore(entry.node, cursor)
    }
    for (const [k, e] of nodes) if (!seen.has(k)) { e.node.remove(); nodes.delete(k) }
  }

  // ---------- Прокрутка ----------
  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  }
  function scrollToBottom(smooth = false) {
    const go = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    go()
    // Сообщения вне экрана имеют примерную высоту (content-visibility) — добиваем после раскладки
    if (!smooth) requestAnimationFrame(go)
    jumpBtn.hidden = true
  }
  function positionInitially() {
    if (positioned) return
    const chat = getChat(convId)
    if (chat.state === 'empty') return
    positioned = true
    const divider = nodes.get('unread')
    if (divider) {
      scroller.scrollTop = Math.max(0, divider.node.offsetTop - scroller.clientHeight * 0.3)
      requestAnimationFrame(() => { scroller.scrollTop = Math.max(0, divider.node.offsetTop - scroller.clientHeight * 0.3); onScroll() })
    } else {
      scrollToBottom()
    }
  }

  function canMarkRead() {
    return !destroyed && store.activeConvId === convId && document.visibilityState === 'visible' && document.hasFocus()
  }

  let olderLoading = false
  async function maybeLoadOlder() {
    const chat = getChat(convId)
    if (olderLoading || !chat.hasMore || chat.state !== 'ready' || scroller.scrollTop > 600) return
    olderLoading = true
    try { await loadOlder(convId) } catch {} finally { olderLoading = false }
    // Экран всё ещё у самого верха (короткая страница) — грузим дальше
    if (!destroyed && scroller.scrollTop < 200) setTimeout(maybeLoadOlder, 50)
  }

  function onScroll() {
    atBottom = nearBottom()
    store.atBottom = atBottom
    if (atBottom) {
      jumpBtn.hidden = true
      if (canMarkRead()) markRead(convId)
      if (trimChat(convId)) scrollToBottom()
    }
    maybeLoadOlder()
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })

  unsub.push(on('messages:' + convId, (detail) => {
    detail = detail || {}
    const stick = atBottom || detail.own
    if (detail.type === 'append' && detail.message) {
      animateKeys.add(detail.message.id ? 'm' + detail.message.id : 'c' + detail.message.clientId)
    }
    if (detail.type === 'prepend') {
      const prevHeight = scroller.scrollHeight
      const prevTop = scroller.scrollTop
      renderList()
      scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight)
      return
    }
    renderList()
    if (!positioned) { positionInitially(); return }
    if (stick && !detail.keepScroll) scrollToBottom(detail.type === 'append')
    else if (detail.type === 'append' && detail.message && detail.message.authorId !== me.id) jumpBtn.hidden = false
  }))
  unsub.push(on('conversation:' + convId, () => { renderHeader(); renderList() }))
  unsub.push(on('presence', (id) => { if (id == null || id === peer.id) renderHeader() }))
  unsub.push(on('friends', renderBlocked))
  unsub.push(on('me', renderList))
  // «был(а) в сети N мин. назад» в шапке стареет — обновляем раз в минуту
  const headerTimer = setInterval(renderHeader, 60000)
  unsub.push(() => clearInterval(headerTimer))
  unsub.push(on('typing:' + convId, renderTyping))
  const onCallChange = () => { renderHeader(); renderList() }
  window.addEventListener('vl-call-state', onCallChange)
  unsub.push(() => window.removeEventListener('vl-call-state', onCallChange))
  unsub.push(on('call-changed', onCallChange))
  const onFocus = () => { if (atBottom && canMarkRead()) markRead(convId) }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  unsub.push(() => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) })
  // Размер ленты меняется (панель звонка сверху, клавиатура телефона) — держим низ, если были внизу
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (atBottom) scroller.scrollTop = scroller.scrollHeight }) : null
  if (ro) ro.observe(scroller)

  renderHeader()
  renderBlocked()
  renderTyping()
  updateComposer()
  renderList()

  // Данные: кэш -> сервер
  store.activeConvId = convId
  openChat(convId).then(() => {
    if (destroyed) return
    positionInitially()
    if (atBottom && canMarkRead()) markRead(convId)
    maybeLoadOlder()
  }).catch((e) => { if (!destroyed) toast(e.message || 'Не удалось загрузить сообщения', 'error') })

  return {
    node,
    convId,
    focus() { if (!('ontouchstart' in window)) input.focus({ preventScroll: true }) },
    onShown() { autosize(); positionInitially(); if (atBottom) scrollToBottom() },
    destroy() {
      destroyed = true
      if (store.activeConvId === convId) store.activeConvId = null
      store.atBottom = true
      unsub.forEach((u) => u())
      if (ro) ro.disconnect()
    }
  }
}
