// ===================== Личка: лента сообщений и поле ввода =====================
// Скорость:
//  · сообщение появляется сразу, до ответа сервера (store.sendMessage рисует черновик);
//    с файлами — тоже: черновик с превью и полоской загрузки, отправка — когда файлы на сервере;
//  · история берётся из IndexedDB, поэтому чат открывается мгновенно, а сеть лишь сверяет её;
//  · ленту не перерисовываем целиком: узлы сообщений переиспользуются по ключу, меняются только
//    изменившиеся; браузер не считает раскладку сообщений вне экрана (content-visibility в CSS);
//  · старые сообщения подгружаются при прокрутке вверх, а когда вы снова внизу — лишнее
//    выгружается из памяти (store.trimChat), чтобы длинная переписка не тормозила.
// Ответить: двойной клик (ПК) или смахнуть сообщение влево (телефон). ПКМ — меню: ответить,
// изменить, копировать, закрепить, переслать, удалить (у себя или у обоих).
import {
  store, on, getChat, openChat, loadOlder, loadNewer, loadAround, refreshChat, trimChat, sendMessage, retryMessage,
  discardDraft, markRead, userById, presenceOf, typingUsers, removeMessage
} from './store.js'
import { api } from './api.js'
import {
  h, icon, avatar, setPresenceDot, displayName, presenceText, richText, timeHM, dayLabel,
  dayKey, showMenu, toast, isSavedConv, attachmentLabel, fmtClock, msgStatus, ticks, setTicks, onLongPress, homePath, contactName
} from './ui.js'
import { startCall, joinCallFromMessage, callState, inCall } from './call-invite.js'
import { renderAttachments, openLightbox } from './media-ui.js'
import { prepareAttachment, uploadFile, waveformOf } from './upload.js'
import { openForwardPicker } from './forward.js'
import { openUserCard } from './user-card.js'
import { wallpaperCss, openWallpaperPicker, preloadWallpaper } from './wallpapers.js'
import { openContactDialog } from './contact-dialog.js'

const MAX_LEN = 4000
const MAX_FILES = 10
const GROUP_MS = 7 * 60 * 1000
const TYPING_EVERY_MS = 3000
const VOICE_MAX_MS = 10 * 60 * 1000
const SWIPE_REPLY_PX = 56

export function createChatView({ convId, navigate, menuButton }) {
  convId = Number(convId)
  const conv0 = store.conversations.get(convId)
  const saved = isSavedConv(conv0)
  const peer = (conv0 && conv0.peer) || { id: 0, username: '', displayName: 'Собеседник' }
  const me = store.me
  const unsub = []

  // Разделитель «Новые сообщения»: всё после последнего прочитанного на момент открытия
  const unreadAfter = conv0 && conv0.unread ? conv0.lastReadId || 0 : null
  let unreadMarkerId = null
  let replyTo = null // {id, authorId, body, attachments}
  let editingKey = null
  let positioned = false // первичная прокрутка (к непрочитанным или вниз) уже сделана
  let atBottom = true
  let destroyed = false
  const animateKeys = new Set()
  const conv = () => store.conversations.get(convId)

  // ---------- Шапка ----------
  const headAvatar = avatar(saved ? me : peer, { size: 44, presence: saved ? null : presenceOf(peer.id), saved })
  const headName = h('span', { class: 'vl-chat__head-name' })
  const headSub = h('span', { class: 'vl-chat__head-sub' })
  const headWho = h('button', { type: 'button', class: 'vl-chat__head-who', title: 'Профиль, медиа и файлы' }, [headAvatar, h('span', { class: 'vl-chat__head-text' }, [headName, headSub])])
  headWho.addEventListener('click', () => openCard())
  const searchBtn = h('button', { type: 'button', class: 'vl-round is-lg', title: 'Поиск по чату', 'aria-label': 'Поиск по чату' }, [icon('magnifying-glass')])
  // «Позвонить» — синяя таблетка с подписью (на телефоне остаётся только значок)
  const callLabel = h('span', { class: 'vl-chat__call-label' }, 'Позвонить')
  const callBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--pill vl-chat__call', title: 'Позвонить', 'aria-label': 'Позвонить', hidden: saved }, [icon('phone'), callLabel])
  const moreBtn = h('button', { type: 'button', class: 'vl-round is-lg', title: 'Ещё', 'aria-label': 'Ещё' }, [icon('ellipsis-vertical')])
  searchBtn.addEventListener('click', () => openSearch())
  callBtn.addEventListener('click', () => {
    if (inCall() && callState.conversationId === convId) { navigate('/room/' + window.VL.state.roomCode); return }
    startCall(convId)
  })
  moreBtn.addEventListener('click', () => {
    const c = conv()
    if (!c) return
    showMenu([
      { label: saved ? 'Медиа и файлы' : 'Профиль', icon: saved ? 'image' : 'user', onClick: () => openCard() },
      saved ? null : { label: contactName(peer.id) ? 'Изменить контакт' : 'Добавить в контакты', icon: contactName(peer.id) ? 'pen' : 'user-plus', onClick: () => openContactDialog(userById(peer.id) || peer) },
      { label: 'Обои', icon: 'palette', onClick: () => openWallpaperPicker(c) },
      saved ? null : { label: c.muted ? 'Включить уведомления' : 'Выключить уведомления', icon: c.muted ? 'bell' : 'bell-slash', onClick: () => toggleMute() },
      { label: c.pinned ? 'Открепить чат' : 'Закрепить чат', icon: c.pinned ? 'thumbtack-slash' : 'thumbtack', onClick: () => api.updateConversation(convId, { pinned: !c.pinned }).catch((e) => toast(e.message, 'error')) },
      'sep',
      { label: 'Удалить чат', icon: 'trash', danger: true, onClick: () => askDeleteChat(c, { navigate }) }
    ], moreBtn)
  })
  async function toggleMute() {
    const c = conv()
    if (!c) return
    try {
      await api.updateConversation(convId, { muted: !c.muted })
      toast(c.muted ? 'Уведомления включены' : 'Уведомления выключены', 'info')
    } catch (e) { toast(e.message, 'error') }
  }
  function openCard() {
    openUserCard({
      userId: saved ? 0 : peer.id,
      convId,
      saved,
      onMessage: () => {},
      onCall: () => startCall(convId),
      onJump: (_, id) => jumpTo(id)
    })
  }
  const header = h('header', { class: 'vl-view__head vl-chat__head' }, [
    menuButton(),
    headWho,
    h('div', { class: 'vl-chat__head-actions' }, [searchBtn, callBtn, moreBtn])
  ])
  function renderHeader() {
    const c = conv()
    if (saved) {
      headName.textContent = 'Избранное'
      headSub.textContent = 'Только для вас'
      input.placeholder = 'Заметка для себя'
    } else {
      // Собеседник мог сменить юзернейм или аватарку, пока чат открыт, — берём свежие данные
      const cur = userById(peer.id) || peer
      const p = presenceOf(peer.id)
      const img = headAvatar.querySelector('.vl-avatar__img')
      // Аватарка или имя (инициалы) поменялись — пересобрать кружок
      if ((img ? img.getAttribute('src') : null) !== (cur.avatarUrl || null) || headAvatar.dataset.name !== displayName(cur)) {
        headAvatar.dataset.name = displayName(cur)
        const fresh = avatar(cur, { size: 44, presence: p })
        headAvatar.replaceChildren(...fresh.childNodes)
        headAvatar.className = fresh.className
      }
      setPresenceDot(headAvatar, p)
      headName.textContent = displayName(cur)
      headSub.textContent = presenceText(p)
      headSub.classList.toggle('is-online', !!p && p.status !== 'offline' && (p.status === 'online' || !!p.inCall))
      headWho.title = `@${cur.username} — профиль, медиа и файлы`
      input.placeholder = `Написать @${cur.username || 'собеседнику'}`
    }
    moreBtn.classList.toggle('is-on', !!(c && c.muted))
    const here = inCall() && callState.conversationId === convId
    callBtn.classList.toggle('is-live', here)
    callBtn.title = here ? 'Открыть звонок' : 'Позвонить'
    callLabel.textContent = here ? 'В звонок' : 'Позвонить'
    applyWallpaper()
  }

  // ---------- Закреплённые сообщения: полоска под шапкой ----------
  const pinBar = h('div', { class: 'vl-pinbar', hidden: true })
  let pinIndex = 0
  function renderPins() {
    const pins = (conv() && conv().pins) || []
    pinBar.hidden = !pins.length
    if (!pins.length) { pinBar.replaceChildren(); return }
    if (pinIndex >= pins.length) pinIndex = 0
    const m = pins[pinIndex]
    const unpin = h('button', { type: 'button', class: 'vl-round is-xs is-ghost', title: 'Открепить', 'aria-label': 'Открепить' }, [icon('xmark')])
    unpin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(m, false) })
    const marks = h('span', { class: 'vl-pinbar__marks', 'aria-hidden': 'true' }, pins.slice(0, 6).map((_, i) => h('i', { class: i === Math.min(pinIndex, 5) ? 'is-on' : '' })))
    const body = h('button', { type: 'button', class: 'vl-pinbar__body' }, [
      marks,
      h('span', { class: 'vl-pinbar__text' }, [
        h('b', {}, pins.length > 1 ? `Закреплённое ${pinIndex + 1} из ${pins.length}` : 'Закреплённое сообщение'),
        h('span', {}, previewText(m))
      ])
    ])
    // Как в Телеграме: клик — к сообщению, следующий клик — к предыдущему закреплённому
    body.addEventListener('click', () => { jumpTo(m.id); pinIndex = (pinIndex + 1) % pins.length; renderPins() })
    pinBar.replaceChildren(icon('thumbtack'), body, unpin)
  }
  async function togglePin(m, pin) {
    try {
      if (pin) await api.post(`/api/conversations/${convId}/pins`, { messageId: m.id })
      else await api.del(`/api/conversations/${convId}/pins/${m.id}`)
      toast(pin ? 'Сообщение закреплено' : 'Сообщение откреплено', 'success')
    } catch (e) { toast(e.message, 'error') }
  }
  const isPinned = (id) => ((conv() && conv().pins) || []).some((p) => p.id === id)
  function previewText(m) {
    const first = m.attachments && m.attachments[0]
    const text = String(m.body || '').replace(/\s+/g, ' ').slice(0, 140)
    if (!first) return text || 'Сообщение'
    return (first.kind === 'file' ? first.name : attachmentLabel(first.kind)) + (text ? ' · ' + text : '')
  }

  // ---------- Поиск по чату ----------
  const searchInput = h('input', { type: 'search', class: 'vl-search__input', placeholder: 'Поиск по сообщениям', 'aria-label': 'Поиск по сообщениям', autocomplete: 'off', spellcheck: 'false' })
  const searchCount = h('span', { class: 'vl-search__count' })
  const searchUp = h('button', { type: 'button', class: 'vl-round is-sm is-ghost', title: 'Раньше', 'aria-label': 'Предыдущее совпадение' }, [icon('chevron-up')])
  const searchDown = h('button', { type: 'button', class: 'vl-round is-sm is-ghost', title: 'Позже', 'aria-label': 'Следующее совпадение' }, [icon('chevron-down')])
  const searchClose = h('button', { type: 'button', class: 'vl-round is-sm is-ghost', title: 'Закрыть поиск', 'aria-label': 'Закрыть поиск' }, [icon('xmark')])
  const searchResults = h('div', { class: 'vl-search__results', role: 'listbox', hidden: true })
  const searchBar = h('div', { class: 'vl-search', hidden: true }, [
    h('div', { class: 'vl-search__field' }, [icon('magnifying-glass'), searchInput, searchCount, searchUp, searchDown, searchClose]),
    searchResults
  ])
  const search = { hits: [], index: -1, timer: 0, q: '' }
  function openSearch() {
    searchBar.hidden = false
    searchBtn.classList.add('is-on')
    searchInput.focus()
    searchInput.select()
  }
  function closeSearch() {
    searchBar.hidden = true
    searchBtn.classList.remove('is-on')
    searchInput.value = ''
    search.hits = []
    search.index = -1
    search.q = ''
    searchResults.hidden = true
    searchCount.textContent = ''
    highlight = ''
    renderList()
  }
  let highlight = ''
  async function runSearch() {
    const q = searchInput.value.trim()
    search.q = q
    if (!q) { search.hits = []; search.index = -1; searchResults.hidden = true; searchCount.textContent = ''; highlight = ''; renderList(); return }
    try {
      const r = await api.get(`/api/conversations/${convId}/search?q=${encodeURIComponent(q)}`)
      if (search.q !== q || destroyed) return
      search.hits = r.messages
      search.index = -1
      highlight = q
      searchCount.textContent = r.messages.length ? `${r.messages.length}${r.messages.length >= 100 ? '+' : ''}` : 'нет'
      renderResults()
      renderList()
    } catch (e) { searchCount.textContent = ''; toast(e.message, 'error') }
  }
  function renderResults() {
    searchResults.hidden = !search.hits.length
    searchResults.replaceChildren(...search.hits.map((m, i) => {
      const who = m.authorId === me.id ? 'Вы' : displayName(authorOf(m))
      const row = h('button', { type: 'button', class: `vl-search__row${i === search.index ? ' is-active' : ''}`, role: 'option' }, [
        avatar(authorOf(m), { size: 32 }),
        h('span', { class: 'vl-search__text' }, [h('span', { class: 'vl-search__top' }, [h('b', {}, who), h('time', {}, `${dayLabel(m.createdAt).replace(/ \d{4} г\.$/, '')}, ${timeHM(m.createdAt)}`)]), h('span', { class: 'vl-search__snip' }, markMatch(m.body, search.q))])
      ])
      row.addEventListener('click', () => goHit(i))
      return row
    }))
  }
  function goHit(i) {
    if (!search.hits.length) return
    search.index = Math.max(0, Math.min(i, search.hits.length - 1))
    searchCount.textContent = `${search.index + 1} из ${search.hits.length}`
    searchResults.hidden = true
    jumpTo(search.hits[search.index].id)
  }
  searchInput.addEventListener('input', () => { clearTimeout(search.timer); search.timer = setTimeout(runSearch, 300) })
  searchInput.addEventListener('focus', () => { if (search.hits.length) { searchResults.hidden = false; renderResults() } })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); input.focus() }
    if (e.key === 'Enter') { e.preventDefault(); goHit(search.index + 1) }
  })
  // Совпадения идут от новых к старым: «вверх» — раньше (дальше по списку)
  searchUp.addEventListener('click', () => goHit(search.index + 1))
  searchDown.addEventListener('click', () => goHit(search.index - 1))
  searchClose.addEventListener('click', closeSearch)
  function markMatch(text, q) {
    const str = String(text || '').replace(/\s+/g, ' ')
    const i = str.toLocaleLowerCase('ru').indexOf(q.toLocaleLowerCase('ru'))
    if (i < 0 || !q) return str.slice(0, 120)
    const from = Math.max(0, i - 40)
    return [from ? '…' : '', str.slice(from, i), h('mark', {}, str.slice(i, i + q.length)), str.slice(i + q.length, i + q.length + 80)]
  }

  // ---------- Лента ----------
  const list = h('div', { class: 'vl-chat__list', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' })
  const scroller = h('div', { class: 'vl-chat__scroll' }, [list])
  const jumpBtn = h('button', { type: 'button', class: 'vl-jump', hidden: true }, [h('span', {}, 'Новые сообщения'), icon('arrow-down')])
  jumpBtn.addEventListener('click', async () => {
    if (getChat(convId).hasNewer) { await refreshChat(convId).catch(() => {}) }
    scrollToBottom(true)
  })
  const dropZone = h('div', { class: 'vl-dropzone', hidden: true }, [h('div', { class: 'vl-dropzone__card' }, [icon('paperclip'), h('b', {}, 'Отпустите, чтобы прикрепить'), h('span', {}, 'Фото, видео и файлы до 64 МБ')])])
  const chatMain = h('div', { class: 'vl-chat__main' }, [scroller, jumpBtn, dropZone])
  // Обои — под всем чатом (лента и поле ввода), показываются целиком и сразу (плавным появлением), когда картинка уже загружена
  let wallToken = 0
  function applyWallpaper() {
    const c = conv()
    const id = (c && c.wallpaper) || ''
    if (node.dataset.wall === id) return
    node.dataset.wall = id
    const token = ++wallToken
    const show = () => {
      if (token !== wallToken || destroyed) return
      const css = wallpaperCss(id) // после загрузки — картинка уже из памяти
      node.style.setProperty('--vl-wall', css || 'none')
      node.classList.toggle('has-wall', !!css)
      node.classList.remove('wall-in')
      if (css) { void node.offsetWidth; node.classList.add('wall-in') }
    }
    preloadWallpaper(id).then(show, show)
  }

  // ---------- Поле ввода ----------
  const replyBar = h('div', { class: 'vl-reply-bar', hidden: true })
  const tray = h('div', { class: 'vl-tray', hidden: true })
  const input = h('textarea', { class: 'vl-composer__input', rows: '1', maxlength: String(MAX_LEN + 500), placeholder: `Написать @${peer.username || 'собеседнику'}`, 'aria-label': 'Сообщение' })
  const sendBtn = h('button', { type: 'button', class: 'vl-composer__send', title: 'Отправить', 'aria-label': 'Отправить' }, [icon('paper-plane')])
  const counter = h('span', { class: 'vl-composer__counter', hidden: true })
  const attachBtn = h('button', { type: 'button', class: 'vl-composer__attach', title: 'Прикрепить файл', 'aria-label': 'Прикрепить файл' }, [icon('paperclip')])
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true })
  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = '' })
  const field = h('div', { class: 'vl-composer__field' }, [attachBtn, input, counter, fileInput])
  // Запись голосового: вместо поля — таймер и «отмена»
  const recDot = h('span', { class: 'vl-rec__dot' })
  const recTime = h('span', { class: 'vl-rec__time' }, '0:00')
  const recCancel = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost-text vl-btn--sm' }, 'Отмена')
  const recBar = h('div', { class: 'vl-composer__field vl-rec', hidden: true }, [recDot, recTime, h('span', { class: 'vl-rec__hint' }, 'Идёт запись'), recCancel])
  // Поле — «таблетка», кнопка отправки — отдельный круг справа
  const composerBox = h('div', { class: 'vl-composer__box' }, [field, recBar, sendBtn])
  const blockedNote = h('div', { class: 'vl-composer__blocked', hidden: true })
  // Для экранного диктора: «печатает…» теперь пузырь в ленте, а текст — здесь
  const typingLine = h('div', { class: 'vl-sr-only', 'aria-live': 'polite' })
  const composer = h('div', { class: 'vl-composer' }, [replyBar, tray, composerBox, blockedNote, typingLine])

  const node = h('section', { class: `vl-view vl-view--chat${saved ? ' is-saved' : ''}` }, [header, pinBar, searchBar, chatMain, composer])

  // Черновик переживает переход между чатами и перезагрузку вкладки
  const draftKey = `vl:draft:${convId}`
  try { input.value = sessionStorage.getItem(draftKey) || '' } catch {}

  function autosize() {
    // Пока поле не на странице, его высота 0 — если запомнить её, подсказка обрезается
    if (!input.isConnected) return
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px'
  }
  const canRecord = typeof window.MediaRecorder === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  let sendMode = 'send' // send | mic
  function updateComposer() {
    const len = input.value.length
    const over = len > MAX_LEN
    counter.hidden = len < MAX_LEN - 500
    counter.textContent = `${len}/${MAX_LEN}`
    counter.classList.toggle('is-over', over)
    const hasContent = !!input.value.trim() || pending.length > 0
    // Пусто — вместо «отправить» микрофон (голосовое), как в мессенджерах
    const mode = recorder ? 'stop' : (!hasContent && canRecord ? 'mic' : 'send')
    if (mode !== sendMode) {
      sendMode = mode
      sendBtn.replaceChildren(icon(mode === 'mic' ? 'microphone' : 'paper-plane'))
      sendBtn.title = mode === 'mic' ? 'Записать голосовое' : 'Отправить'
      sendBtn.setAttribute('aria-label', sendBtn.title)
      sendBtn.classList.toggle('is-mic', mode === 'mic')
      sendBtn.classList.remove('is-swap')
      void sendBtn.offsetWidth
      sendBtn.classList.add('is-swap')
    }
    sendBtn.disabled = mode === 'send' && (!hasContent || over)
    autosize()
  }

  let lastTypingSent = 0
  input.addEventListener('input', () => {
    updateComposer()
    try { input.value ? sessionStorage.setItem(draftKey, input.value) : sessionStorage.removeItem(draftKey) } catch {}
    const now = Date.now()
    if (!saved && input.value.trim() && now - lastTypingSent > TYPING_EVERY_MS) {
      lastTypingSent = now
      api.typing(convId).catch(() => {})
    }
  })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    else if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReply(null) }
    else if (e.key === 'ArrowUp' && !input.value) {
      const mine = [...getChat(convId).list].reverse().find((m) => m.id && m.authorId === me.id && m.kind === 'text' && !m.forward)
      if (mine) { e.preventDefault(); startEdit(mine) }
    }
  })
  // Вставка картинки из буфера (скриншот) — сразу во вложения
  input.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])]
    if (files.length) { e.preventDefault(); addFiles(files) }
  })
  sendBtn.addEventListener('click', () => {
    if (sendMode === 'mic') startRecording()
    else if (sendMode === 'stop') stopRecording(true)
    else submit()
  })

  // ---------- Вложения: лоток над полем ----------
  let pending = [] // [{file, kind, meta, previewUrl, name, size}]
  async function addFiles(files) {
    if (!files.length) return
    const room = MAX_FILES - pending.length
    if (files.length > room) toast(`Не больше ${MAX_FILES} файлов в сообщении`, 'warning')
    for (const f of files.slice(0, Math.max(0, room))) {
      if (f.size > 64 * 1024 * 1024) { toast(`«${f.name}» больше 64 МБ`, 'error'); continue }
      const prepared = await prepareAttachment(f)
      pending.push({ ...prepared, name: prepared.file.name || f.name, size: prepared.file.size })
      renderTray()
      updateComposer()
    }
    input.focus()
  }
  function renderTray() {
    tray.hidden = !pending.length
    tray.replaceChildren(...pending.map((p, i) => {
      const remove = h('button', { type: 'button', class: 'vl-tray__x', 'aria-label': 'Убрать' }, [icon('xmark')])
      remove.addEventListener('click', () => {
        const [gone] = pending.splice(i, 1)
        if (gone && gone.previewUrl) URL.revokeObjectURL(gone.previewUrl)
        renderTray()
        updateComposer()
      })
      const thumb = p.kind === 'image'
        ? h('img', { src: p.previewUrl, alt: '' })
        : p.kind === 'video' ? h('video', { src: p.previewUrl, muted: true, playsinline: true, preload: 'metadata' }) : h('span', { class: 'vl-tray__ico' }, [icon(p.kind === 'audio' ? 'waveform' : 'file')])
      return h('div', { class: `vl-tray__item is-${p.kind}`, title: p.name }, [thumb, p.kind === 'file' || p.kind === 'audio' ? h('span', { class: 'vl-tray__name' }, p.name) : null, remove])
    }))
  }

  // Загрузить файлы черновика по очереди; прогресс — общий по байтам
  function uploadAll(items, sink) {
    const total = items.reduce((s, p) => s + p.size, 0) || 1
    let done = 0
    return (async () => {
      const out = []
      for (const p of items) {
        const f = await uploadFile(p.file, {
          name: p.name,
          voice: p.kind === 'voice',
          meta: p.meta,
          onProgress: (frac) => setProgress(sink, (done + frac * p.size) / total)
        })
        done += p.size
        out.push(f)
      }
      return out
    })()
  }
  let progressTimer = 0
  function setProgress(sink, value) {
    if (sink.draft) sink.draft.progress = value
    // Не чаще раза в 150 мс — перерисовка пузыря
    if (progressTimer) return
    progressTimer = setTimeout(() => { progressTimer = 0; if (!destroyed) renderList() }, 150)
  }

  function submit() {
    const text = input.value.replace(/\s+$/, '')
    if ((!text.trim() && !pending.length) || text.length > MAX_LEN) return
    const reply = replyTo ? replyTo.id : null
    const items = pending
    pending = []
    renderTray()
    input.value = ''
    try { sessionStorage.removeItem(draftKey) } catch {}
    setReply(null)
    updateComposer()
    lastTypingSent = 0
    sendWithFiles(text.trim() ? text : '', reply, items)
    input.focus()
  }
  function sendWithFiles(text, reply, items) {
    if (!items.length) { sendMessage(convId, text, reply).catch(() => {}); return }
    const sink = { draft: null } // черновик в ленте, куда писать прогресс загрузки
    const attachments = items.map((p) => ({ kind: p.kind, name: p.name, size: p.size, meta: p.meta, previewUrl: p.previewUrl, url: p.kind === 'voice' ? p.previewUrl : null }))
    const start = () => { if (sink.draft) sink.draft.progress = 0; return uploadAll(items, sink) }
    sendMessage(convId, text, reply, { attachments, upload: start() }).catch(() => {})
    // Черновик уже в ленте: дать ему прогресс и «загрузить заново» для кнопки «Повторить»
    const draft = getChat(convId).list.find((m) => !m.id && m.attachments === attachments)
    if (draft) { draft.retry = start; sink.draft = draft }
  }
  function draftProgress(m) { return typeof m.progress === 'number' ? m.progress : 0 }

  // ---------- Голосовые ----------
  let recorder = null // {rec, stream, chunks, startedAt, timer, cancelled}
  async function startRecording() {
    if (recorder) return
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      toast('Нет доступа к микрофону', 'error')
      return
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t)) || ''
    const rec = new window.MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined)
    const r = { rec, stream, chunks: [], startedAt: Date.now(), timer: 0, send: false }
    recorder = r
    rec.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) r.chunks.push(e.data) })
    rec.addEventListener('stop', () => finishRecording(r))
    rec.start(250)
    field.hidden = true
    recBar.hidden = false
    composerBox.classList.add('is-recording')
    r.timer = setInterval(() => {
      const ms = Date.now() - r.startedAt
      recTime.textContent = fmtClock(ms / 1000)
      if (ms >= VOICE_MAX_MS) stopRecording(true)
    }, 250)
    updateComposer()
  }
  function stopRecording(send) {
    if (!recorder) return
    recorder.send = !!send
    clearInterval(recorder.timer)
    try { recorder.rec.stop() } catch { finishRecording(recorder) }
  }
  recCancel.addEventListener('click', () => stopRecording(false))
  async function finishRecording(r) {
    if (r.finished) return
    r.finished = true
    r.stream.getTracks().forEach((t) => t.stop())
    if (recorder === r) recorder = null
    field.hidden = false
    recBar.hidden = true
    composerBox.classList.remove('is-recording')
    recTime.textContent = '0:00'
    updateComposer()
    const elapsed = Date.now() - r.startedAt
    if (!r.send || !r.chunks.length) return
    if (elapsed < 700) { toast('Слишком короткое голосовое', 'info'); return }
    const mime = (r.rec.mimeType || 'audio/webm').split(';')[0]
    const blob = new Blob(r.chunks, { type: mime })
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
    const { waveform, duration } = await waveformOf(blob)
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mime })
    const meta = { duration: duration || elapsed / 1000, waveform }
    const reply = replyTo ? replyTo.id : null
    setReply(null)
    sendWithFiles('', reply, [{ file, kind: 'voice', meta, previewUrl: URL.createObjectURL(blob), name: file.name, size: file.size }])
  }

  // ---------- Перетаскивание файлов ----------
  let dragDepth = 0
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')
  node.addEventListener('dragenter', (e) => { if (!hasFiles(e) || composerBox.hidden) return; e.preventDefault(); dragDepth++; dropZone.hidden = false })
  node.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
  node.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.hidden = true })
  node.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    dropZone.hidden = true
    if (!composerBox.hidden) addFiles([...e.dataTransfer.files])
  })

  function setReply(m) {
    replyTo = m ? { id: m.id, authorId: m.authorId, body: m.body, attachments: m.attachments } : null
    if (!replyTo) { replyBar.hidden = true; replyBar.replaceChildren(); return }
    const who = replyTo.authorId === me.id ? 'себе' : displayName(userById(replyTo.authorId))
    const close = h('button', { type: 'button', class: 'vl-round is-sm is-ghost', 'aria-label': 'Отменить ответ' }, [icon('xmark')])
    close.addEventListener('click', () => setReply(null))
    replyBar.replaceChildren(icon('reply'), h('span', { class: 'vl-reply-bar__body' }, [h('b', {}, replyTo.authorId === me.id ? (saved ? 'Ответ' : 'Ответ себе') : `Ответ ${who}`), h('span', { class: 'vl-reply-bar__text' }, previewText(replyTo))]), close)
    replyBar.hidden = false
    input.focus()
  }

  function renderBlocked() {
    const f = store.friends.get(peer.id)
    const blocked = !saved && !!(f && f.status === 'blocked')
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

  function flash(entry) {
    entry.node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    entry.node.classList.remove('is-flash')
    void entry.node.offsetWidth
    entry.node.classList.add('is-flash')
  }
  // Перейти к сообщению: если его нет в памяти — загрузить страницу вокруг него
  async function jumpTo(id) {
    const entry = nodes.get('m' + id)
    if (entry) { flash(entry); return }
    try {
      const found = await loadAround(convId, id)
      if (destroyed) return
      if (!found) { toast('Сообщение удалено', 'info'); return }
      renderList()
      requestAnimationFrame(() => { const e2 = nodes.get('m' + id); if (e2) flash(e2) })
      jumpBtn.hidden = false
    } catch (e) { toast(e.message, 'error') }
  }

  function toolButton(iconName, title, onClick, danger = false) {
    const b = h('button', { type: 'button', class: `vl-round is-xs is-dark${danger ? ' is-danger-hover' : ''}`, title, 'aria-label': title }, [icon(iconName)])
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
    return b
  }

  // Удалить: своё — «у меня» или «у всех» (галочка), чужое — только у себя
  async function askDelete(m, quick = false) {
    const mine = m.authorId === me.id
    let forAll = mine && !saved
    if (!quick) {
      const res = await deleteDialog({
        title: 'Удалить сообщение?',
        text: saved ? 'Сообщение пропадёт из «Избранного».' : mine ? 'Можно удалить только у себя или сразу у обоих.' : 'Сообщение пропадёт только у вас — у собеседника останется.',
        checkLabel: mine && !saved ? `Удалить и у ${displayName(userById(peer.id) || peer)}` : null
      })
      if (!res) return
      forAll = res.checked
    }
    try { await api.del(`/api/conversations/${convId}/messages/${m.id}?for=${forAll || saved ? 'all' : 'me'}`) } catch (e) { toast(e.message, 'error'); return }
    // SSE уберёт сообщение и у нас; делаем это сразу, не дожидаясь
    removeMessage(convId, m.id)
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
      const hasFiles = m.attachments && m.attachments.length
      if (!body.trim() && !hasFiles) { editingKey = null; renderList(); askDelete(m); return }
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
    const text = r && (r.kind === 'call' ? 'Звонок' : previewText({ body: r.body, attachments: r.attachment ? [r.attachment] : [] }))
    const quote = h('button', { type: 'button', class: 'vl-quote' }, r && !r.deleted
      ? [h('b', {}, r.authorId === me.id ? 'Вы' : displayName(who)), h('span', {}, text)]
      : [h('span', { class: 'is-muted' }, 'Исходное сообщение удалено')])
    if (r && !r.deleted) quote.addEventListener('click', (e) => { e.stopPropagation(); jumpTo(r.id) })
    return quote
  }

  // Текст с подсветкой найденного
  function textWithHighlight(body) {
    if (!highlight) return richText(body)
    const frag = document.createDocumentFragment()
    const str = String(body || '')
    const low = str.toLocaleLowerCase('ru')
    const q = highlight.toLocaleLowerCase('ru')
    let pos = 0
    let i
    while (q && (i = low.indexOf(q, pos)) >= 0) {
      if (i > pos) frag.appendChild(richText(str.slice(pos, i)))
      frag.appendChild(h('mark', { class: 'vl-hit' }, str.slice(i, i + q.length)))
      pos = i + q.length
    }
    if (pos < str.length) frag.appendChild(richText(str.slice(pos)))
    return frag
  }

  function messageMenu(m, e) {
    const mine = m.authorId === me.id
    const pinned = isPinned(m.id)
    showMenu([
      { label: 'Ответить', icon: 'reply', onClick: () => setReply(m) },
      mine && m.kind === 'text' && !m.forward ? { label: 'Изменить', icon: 'pen', onClick: () => startEdit(m) } : null,
      m.body ? { label: 'Копировать текст', icon: 'copy', onClick: () => window.VL.copyToClipboard(m.body).then((ok) => toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error')) } : null,
      { label: pinned ? 'Открепить' : 'Закрепить', icon: pinned ? 'thumbtack-slash' : 'thumbtack', onClick: () => togglePin(m, !pinned) },
      m.kind === 'text' ? { label: 'Переслать', icon: 'share', onClick: () => openForwardPicker(m) } : null,
      'sep',
      { label: 'Удалить', icon: 'trash', danger: true, onClick: () => askDelete(m, false) }
    ], e)
  }

  // Смахнуть влево на телефоне — ответить (как в Телеграме)
  function attachSwipe(msg, m) {
    let sx = 0, sy = 0, dx = 0, active = false, decided = false
    msg.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; active = true; decided = false
    }, { passive: true })
    msg.addEventListener('touchmove', (e) => {
      if (!active) return
      const x = e.touches[0].clientX - sx
      const y = e.touches[0].clientY - sy
      if (!decided) {
        if (Math.abs(x) < 8 && Math.abs(y) < 8) return
        decided = true
        if (Math.abs(y) > Math.abs(x) || x > 0) { active = false; return } // вертикальная прокрутка или вправо
      }
      dx = Math.max(-90, Math.min(0, x))
      msg.style.setProperty('--swipe', dx + 'px')
      msg.classList.add('is-swiping')
      msg.classList.toggle('is-swipe-ready', dx <= -SWIPE_REPLY_PX)
    }, { passive: true })
    const end = () => {
      if (!active) return
      active = false
      msg.classList.remove('is-swiping', 'is-swipe-ready')
      msg.style.removeProperty('--swipe')
      if (dx <= -SWIPE_REPLY_PX) {
        if (navigator.vibrate) try { navigator.vibrate(10) } catch {}
        setReply(m)
      }
    }
    msg.addEventListener('touchend', end, { passive: true })
    msg.addEventListener('touchcancel', end, { passive: true })
  }

  // pos: single | first | middle | last — место в серии подряд идущих сообщений одного автора
  function buildMessage(m, pos) {
    const mine = m.authorId === me.id
    const key = m.id ? 'm' + m.id : 'c' + m.clientId
    const editing = editingKey === key
    const files = m.attachments || []
    const visual = files.filter((f) => f.kind === 'image' || f.kind === 'video')
    const mediaOnly = visual.length > 0 && visual.length === files.length && !m.body && !m.reply && !m.forward
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
        m.id && isPinned(m.id) ? icon('thumbtack') : null,
        m.editedAt ? h('span', { title: 'Изменено ' + new Date(m.editedAt).toLocaleString('ru-RU') }, 'изм. ') : null,
        h('time', { datetime: new Date(m.createdAt).toISOString() }, timeHM(m.createdAt)),
        statusMark(m)
      ])
      const parts = []
      if (m.forward) {
        const fwd = h('button', { type: 'button', class: 'vl-fwd' }, [icon('share'), h('span', {}, ['Переслано от ', h('b', {}, m.forward.userId === me.id ? 'вас' : (displayName(userById(m.forward.userId)) || m.forward.name))])])
        fwd.addEventListener('click', (e) => { e.stopPropagation(); if (m.forward.userId !== me.id) openUserCard({ userId: m.forward.userId, onMessage: () => {}, onCall: () => {} }) })
        parts.push(fwd)
      }
      if (m.reply) parts.push(buildQuote(m))
      if (files.length) {
        const uploading = m.pending && m.upload ? { progress: draftProgress(m) } : null
        parts.push(...renderAttachments(files, {
          mine,
          uploading,
          onOpen: (i) => openLightbox(visual, i, { caption: m.body })
        }))
      }
      if (m.body || !mediaOnly) parts.push(h('div', { class: 'vl-bubble__text is-selectable' }, [m.body ? textWithHighlight(m.body) : null, meta]))
      else parts.push(h('span', { class: 'vl-bubble__meta is-over-media' }, [...meta.childNodes]))
      bubble = h('div', { class: `vl-bubble${files.length ? ' has-files' : ''}${mediaOnly ? ' is-media-only' : ''}${visual.length && !mediaOnly ? ' has-media' : ''}`, title: new Date(m.createdAt).toLocaleString('ru-RU') }, parts)
    }

    const tools = []
    if (m.id && !editing) {
      tools.push(toolButton('reply', 'Ответить', () => setReply(m)))
      if (m.kind === 'text') tools.push(toolButton('share', 'Переслать', () => openForwardPicker(m)))
      tools.push(toolButton('ellipsis', 'Ещё', (e) => messageMenu(m, e)))
    }
    const children = [h('div', { class: 'vl-msg__wrap' }, [h('span', { class: 'vl-msg__swipe', 'aria-hidden': 'true' }, [icon('reply')]), bubble, tools.length ? h('div', { class: 'vl-msg__tools' }, tools) : null])]
    if (m.failed) {
      const retry = h('button', { type: 'button', class: 'vl-linkbtn' }, 'Повторить')
      const drop = h('button', { type: 'button', class: 'vl-linkbtn' }, 'Удалить')
      retry.addEventListener('click', () => retryMessage(convId, m.clientId))
      drop.addEventListener('click', () => discardDraft(convId, m.clientId))
      children.push(h('div', { class: 'vl-msg__failed' }, [icon('circle-exclamation'), h('span', {}, `${m.failed}.`), retry, drop]))
    }

    const msg = h('div', { class: cls.join(' '), 'data-key': key }, children)
    if (m.id) {
      msg.addEventListener('contextmenu', (e) => {
        if (e.target.closest('a, textarea, input')) return
        e.preventDefault()
        messageMenu(m, e)
      })
      // Двойной клик — ответить (выделение текста двойным кликом не мешает: снимаем его)
      msg.addEventListener('dblclick', (e) => {
        if (editing || e.target.closest('a, textarea, button, .vl-voice')) return
        try { window.getSelection().removeAllRanges() } catch {}
        setReply(m)
      })
      attachSwipe(msg, m)
      // Телефон: долгое нажатие — меню сообщения
      onLongPress(msg, (e) => { if (!editingKey && !e.target.closest('a, textarea, button, .vl-voice')) messageMenu(m, e) })
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
    const node = h('div', { class: `vl-msg vl-msg--call${animateKeys.delete('m' + m.id) ? ' is-new' : ''}`, 'data-key': 'm' + m.id }, [pill])
    const callMenu = (e) => {
      e.preventDefault()
      showMenu([{ label: 'Удалить у меня', icon: 'trash', danger: true, onClick: () => api.del(`/api/conversations/${convId}/messages/${m.id}?for=me`).then(() => removeMessage(convId, m.id)).catch((er) => toast(er.message, 'error')) }], e)
    }
    node.addEventListener('contextmenu', callMenu)
    onLongPress(node, callMenu)
    return node
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
    if (saved) {
      return h('div', { class: 'vl-chat__intro' }, [
        avatar(me, { size: 88, saved: true }),
        h('h2', {}, 'Избранное'),
        h('p', {}, 'Пересылайте сюда сообщения, сохраняйте заметки, файлы и ссылки — их видите только вы.')
      ])
    }
    return h('div', { class: 'vl-chat__intro' }, [
      avatar(userById(peer.id) || peer, { size: 88 }),
      h('h2', {}, displayName(peer)),
      h('div', { class: 'vl-chat__intro-user' }, '@' + peer.username),
      h('p', {}, ['Это начало вашей личной переписки с ', h('b', {}, displayName(peer)), '.'])
    ])
  }

  function buildHistoryLoader() {
    const rows = [150, 230, 110].map((w, i) => h('div', { class: `vl-msg ${i === 1 ? 'is-mine' : 'is-theirs'} pos-single is-skeleton` }, [
      h('div', { class: 'vl-msg__wrap' }, [h('span', { class: 'vl-skel vl-skel--bubble', style: { width: w + 'px' } })])
    ]))
    return h('div', { class: 'vl-chat__history', 'aria-label': 'Загружаем историю' }, rows)
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
    const c = conv()
    const items = []
    if (chat.state === 'empty') {
      items.push({ key: 'skeleton', sig: '1', build: buildSkeleton })
    } else if (chat.hasMore) {
      // Над лентой — бледные пузыри-заглушки: пока грузится история, они мягко «дышат»,
      // а новые сообщения потом проявляются на их месте (без спиннера и прыжков)
      items.push({ key: 'loader', sig: '1', build: buildHistoryLoader })
    } else {
      items.push({ key: 'intro', sig: String((userById(peer.id) || peer).avatarUrl || '') + '|' + displayName(userById(peer.id) || peer), build: buildIntro })
    }
    if (unreadAfter != null && unreadMarkerId == null) {
      const first = chat.list.find((m) => m.id && m.id > unreadAfter && m.authorId !== me.id)
      if (first) unreadMarkerId = first.id
    }
    const pinSig = ((c && c.pins) || []).map((p) => p.id).join(',')

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
        const files = (m.attachments || []).map((f) => f.id || f.name).join(',')
        const prog = m.pending && m.upload ? Math.round(draftProgress(m) * 50) : ''
        const pinned = m.id && pinSig && isPinned(m.id) ? 1 : 0
        const hl = highlight && m.body && m.body.toLocaleLowerCase('ru').includes(highlight.toLocaleLowerCase('ru')) ? highlight : ''
        const sig = [m.id, m.body, m.editedAt, m.pending ? 1 : 0, m.failed || '', pos, editingKey === key ? 1 : 0, m.reply ? m.reply.id : '', files, prog, pinned, hl, m.forward ? m.forward.userId : ''].join('|')
        items.push({ key, sig, build: () => buildMessage(m, pos) })
      }
      prev = m
    })
    if (chat.hasNewer) items.push({ key: 'newer', sig: '1', build: () => h('div', { class: 'vl-chat__loader' }, [h('span', { class: 'vl-spinner' }), 'Загружаем новые…']) })
    const typers = chat.state === 'empty' || chat.hasNewer ? [] : typingNames()
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
    updateTicks(c, msgs)
  }

  // Галочки меняются на месте (узел сообщения не пересоздаётся) — так видна анимация
  // «дорисовалась вторая» и «посинели»
  function statusMark(m) {
    const st = msgStatus(conv(), m, me.id)
    if (!st) return null
    return st === 'pending' ? icon('clock') : ticks(st)
  }
  function updateTicks(c, msgs) {
    if (saved || !c) return
    for (const m of msgs) {
      if (!m.id || m.authorId !== me.id) continue
      const entry = nodes.get('m' + m.id)
      if (!entry) continue
      if (entry.ticks === undefined) entry.ticks = entry.node.querySelector('.vl-ticks')
      if (entry.ticks) setTicks(entry.ticks, msgStatus(c, m, me.id))
    }
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
    if (pendingJump) { const id = pendingJump; pendingJump = 0; jumpTo(id); return }
    const divider = nodes.get('unread')
    if (divider) {
      scroller.scrollTop = Math.max(0, divider.node.offsetTop - scroller.clientHeight * 0.3)
      requestAnimationFrame(() => { scroller.scrollTop = Math.max(0, divider.node.offsetTop - scroller.clientHeight * 0.3); onScroll() })
    } else {
      scrollToBottom()
    }
  }

  function canMarkRead() {
    return !destroyed && store.activeConvId === convId && document.visibilityState === 'visible' && document.hasFocus() && !getChat(convId).hasNewer
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
  let newerLoading = false
  async function maybeLoadNewer() {
    const chat = getChat(convId)
    if (newerLoading || !chat.hasNewer || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 600) return
    newerLoading = true
    try { await loadNewer(convId) } catch {} finally { newerLoading = false }
  }

  function onScroll() {
    atBottom = nearBottom() && !getChat(convId).hasNewer
    store.atBottom = atBottom
    if (atBottom) {
      jumpBtn.hidden = true
      if (canMarkRead()) markRead(convId)
      if (trimChat(convId)) scrollToBottom()
    }
    maybeLoadOlder()
    maybeLoadNewer()
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })

  unsub.push(on('messages:' + convId, (detail) => {
    detail = detail || {}
    const stick = atBottom || detail.own
    if (detail.type === 'append' && detail.message) {
      animateKeys.add(detail.message.id ? 'm' + detail.message.id : 'c' + detail.message.clientId)
    }
    if (detail.type === 'prepend') {
      // Подгрузка истории сверху: новые узлы сразу раскладываются по-настоящему (иначе
      // content-visibility даёт им примерную высоту и лента прыгает при прокрутке),
      // позиция экрана сохраняется, а сами сообщения плавно проявляются
      const before = new Set(nodes.keys())
      const prevHeight = scroller.scrollHeight
      const prevTop = scroller.scrollTop
      renderList()
      const fresh = []
      for (const [k, e] of nodes) if (!before.has(k) && k[0] === 'm') { e.node.classList.add('is-history-in'); fresh.push(e.node) }
      scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight)
      setTimeout(() => fresh.forEach((n) => n.classList.remove('is-history-in')), 700)
      return
    }
    // Своё сообщение, пока лента показывает старый кусок, — вернуться к концу переписки
    if (detail.own && getChat(convId).hasNewer) { refreshChat(convId).then(() => scrollToBottom()).catch(() => {}); return }
    renderList()
    if (!positioned) { positionInitially(); return }
    if (stick && !detail.keepScroll) scrollToBottom(detail.type === 'append')
    else if (detail.type === 'append' && detail.message && detail.message.authorId !== me.id) jumpBtn.hidden = false
  }))
  unsub.push(on('conversation:' + convId, () => { renderHeader(); renderPins(); renderList() }))
  unsub.push(on('presence', (id) => { if (id == null || id === peer.id) renderHeader() }))
  unsub.push(on('friends', () => { renderBlocked(); renderHeader() }))
  unsub.push(on('me', () => { renderHeader(); renderList() }))
  unsub.push(on('contacts', () => { renderHeader(); renderList() }))
  // «был(а) в сети N мин. назад» в шапке стареет — обновляем раз в минуту
  const headerTimer = setInterval(renderHeader, 60000)
  unsub.push(() => clearInterval(headerTimer))
  unsub.push(on('typing:' + convId, renderTyping))
  // Нажали на найденное сообщение в поиске слева, а этот чат уже открыт
  const onJumpReq = (e) => { if (e.detail && e.detail.convId === convId) jumpTo(e.detail.id) }
  window.addEventListener('vl-jump', onJumpReq)
  unsub.push(() => window.removeEventListener('vl-jump', onJumpReq))
  const onCallChange = () => { renderHeader(); renderList() }
  window.addEventListener('vl-call-state', onCallChange)
  unsub.push(() => window.removeEventListener('vl-call-state', onCallChange))
  unsub.push(on('call-changed', onCallChange))
  const onFocus = () => { if (atBottom && canMarkRead()) markRead(convId) }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  unsub.push(() => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) })
  // Ctrl+F — поиск по чату, а не по странице
  const onFind = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'а') && !document.querySelector('.vl-modal-overlay, .settings-overlay')) { e.preventDefault(); openSearch() }
  }
  document.addEventListener('keydown', onFind)
  unsub.push(() => document.removeEventListener('keydown', onFind))
  // Размер ленты меняется (панель звонка сверху, клавиатура телефона) — держим низ, если были внизу
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (atBottom) scroller.scrollTop = scroller.scrollHeight }) : null
  // Лента тоже меняет высоту (сообщения вне экрана сначала с примерной высотой, картинки догружаются)
  if (ro) { ro.observe(scroller); ro.observe(list) }

  // Переход «показать в чате» из профиля/поиска до открытия чата
  let pendingJump = Number(store.pendingJump && store.pendingJump.convId === convId ? store.pendingJump.id : 0)
  store.pendingJump = null

  renderHeader()
  renderPins()
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
    jumpTo,
    focus() { if (!('ontouchstart' in window)) input.focus({ preventScroll: true }) },
    onShown() { autosize(); positionInitially(); if (atBottom) scrollToBottom() },
    destroy() {
      destroyed = true
      if (recorder) stopRecording(false)
      for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      if (store.activeConvId === convId) store.activeConvId = null
      store.atBottom = true
      unsub.forEach((u) => u())
      if (ro) ro.disconnect()
    }
  }
}

// ---------- Окно удаления с галочкой «и у собеседника» ----------
export function deleteDialog({ title, text, checkLabel = null, checked = true, confirmLabel = 'Удалить' }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement
    const box = checkLabel ? h('input', { type: 'checkbox' }) : null
    if (box) box.checked = checked
    const cancel = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost' }, 'Отмена')
    const ok = h('button', { type: 'button', class: 'vl-btn vl-btn--danger' }, confirmLabel)
    const card = h('div', { class: 'vl-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('h3', { class: 'vl-modal__title' }, title),
      text ? h('p', { class: 'vl-modal__text' }, text) : null,
      box ? h('label', { class: 'vl-check' }, [box, h('span', { class: 'vl-check__box', 'aria-hidden': 'true' }, [icon('check')]), h('span', {}, checkLabel)]) : null,
      h('div', { class: 'vl-modal__actions' }, [cancel, ok])
    ])
    const overlay = h('div', { class: 'vl-modal-overlay' }, [card])
    function close(result) {
      document.removeEventListener('keydown', onKey, true)
      overlay.classList.add('is-leaving')
      setTimeout(() => overlay.remove(), 160)
      try { prevFocus && prevFocus.focus() } catch {}
      resolve(result)
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null) }
      if (e.key === 'Enter') { e.preventDefault(); close({ checked: box ? box.checked : false }) }
    }
    cancel.addEventListener('click', () => close(null))
    ok.addEventListener('click', () => close({ checked: box ? box.checked : false }))
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null) })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    ok.focus()
  })
}

// Удалить чат: у себя (очистить историю) или у обоих. Для «Избранного» — просто очистить.
export async function askDeleteChat(conv, { navigate } = {}) {
  const saved = isSavedConv(conv)
  const name = saved ? 'Избранное' : displayName(conv.peer)
  const res = await deleteDialog({
    title: saved ? 'Очистить «Избранное»?' : `Удалить чат с ${name}?`,
    text: saved ? 'Все сохранённые сообщения будут удалены.' : 'История пропадёт из вашего списка. Если собеседник напишет снова, чат появится с новыми сообщениями.',
    checkLabel: saved ? null : `Удалить и у ${name}`,
    checked: false,
    confirmLabel: saved ? 'Очистить' : 'Удалить'
  })
  if (!res) return
  try {
    await api.del(`/api/conversations/${conv.id}?for=${res.checked || saved ? 'all' : 'me'}`)
    if (navigate && store.activeConvId === conv.id) navigate(homePath())
  } catch (e) { toast(e.message, 'error') }
}
