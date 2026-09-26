// ===================== Левая колонка (как в канвасе «Голос»): лого, поиск, вкладки Чаты/Звонки/Друзья =====================
// ПК: сверху лого и кнопка профиля, поле поиска с ⌘K и вкладки с едущей плашкой; ниже — одна из
// трёх панелей; внизу — тёмная плашка «В звонке», пока идёт звонок.
// Телефон: крупный заголовок раздела, поле поиска и стеклянная панель вкладок внизу экрана.
import { store, on, sortedConversations, presenceOf, incomingCount, friendsBy, setFriend, loadFriends, dmWith } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, presenceText, messagePreview, timeShort, showMenu, toast, isSavedConv, msgStatus, ticks, onLongPress, contactName, confirmDialog } from './ui.js'
import { askDeleteChat } from './chat.js'
import { openContactDialog } from './contact-dialog.js'
import { openUserCard } from './user-card.js'
import { openWallpaperPicker } from './wallpapers.js'
import { notificationsNeedPermission, requestNotificationPermission } from './notify.js'
import { needsHomeScreen } from './push.js'
import { callState, inCall, startCall } from './call-invite.js'

const TABS = [
  { id: 'chats', label: 'Чаты', icon: 'message' },
  { id: 'calls', label: 'Звонки', icon: 'phone' },
  { id: 'friends', label: 'Друзья', icon: 'user-group' }
]

export function createSidebar({ root, navigate, openDmWith, openProfile }) {
  let route = { name: 'friends' }
  let tab = 'chats'
  const unsub = []

  // ---------- Шапка: лого «Голос» и кнопка профиля ----------
  const meBtn = h('button', { type: 'button', class: 'g-meb', title: 'Профиль', 'aria-label': 'Открыть профиль' })
  meBtn.addEventListener('click', () => openProfile())
  // Лого Voice Lobby (облачко с полосками голоса, anker.js), чёрное под новый дизайн
  const logo = window.VLLogo ? window.VLLogo(36) : h('span', { class: 'g-logo' }, [icon('logo')])
  const brand = h('div', { class: 'g-brand' }, [logo, h('span', { class: 'g-brand__name' }, 'Voice Lobby')])
  const mobileTitle = h('span', { class: 'g-side__title' }, 'Чаты')
  const head = h('div', { class: 'g-side__head' }, [brand, mobileTitle, meBtn])

  function renderMe() {
    if (!store.me) return
    meBtn.replaceChildren(avatar(store.me, { size: 38 }))
    meBtn.classList.toggle('is-offline', !store.connected)
    meBtn.title = store.connected ? `${displayName(store.me)} · @${store.me.username}` : 'Подключение…'
  }

  // ---------- Поиск: друзья и чаты — сразу, сообщения во всех чатах — с сервера ----------
  const searchInput = h('input', { type: 'search', class: 'g-search__input', placeholder: 'Поиск', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Поиск' })
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const kbd = h('span', { class: 'g-kbd' }, isMac ? '⌘K' : 'Ctrl K')
  const searchClear = h('button', { type: 'button', class: 'g-search__x', 'aria-label': 'Очистить поиск', hidden: true }, [icon('xmark')])
  const searchBox = h('label', { class: 'g-search' }, [icon('magnifying-glass'), searchInput, kbd, searchClear])
  let searchQ = ''
  let msgHits = { q: '', items: [], loading: false }
  let searchTimer = 0
  function setSearch(v) {
    searchQ = v.trim()
    searchClear.hidden = !v
    kbd.hidden = !!v
    clearTimeout(searchTimer)
    if (searchQ && tab !== 'chats') setTab('chats')
    if (searchQ.length >= 2) {
      msgHits = { q: searchQ, items: msgHits.q === searchQ ? msgHits.items : [], loading: true }
      searchTimer = setTimeout(async () => {
        const q = searchQ
        try {
          const r = await api.get('/api/search?q=' + encodeURIComponent(q))
          if (q === searchQ) msgHits = { q, items: r.messages || [], loading: false }
        } catch { if (q === searchQ) msgHits = { q, items: [], loading: false } }
        if (q === searchQ) renderDms()
      }, 280)
    } else msgHits = { q: '', items: [], loading: false }
    renderDms()
  }
  searchInput.addEventListener('input', () => setSearch(searchInput.value))
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; setSearch(''); searchInput.blur() }
    if (e.key === 'Enter') { const first = dmList.querySelector('a, button'); if (first) { e.preventDefault(); first.click() } }
  })
  searchClear.addEventListener('click', (e) => { e.preventDefault(); searchInput.value = ''; setSearch(''); searchInput.focus() })
  // ⌘K / Ctrl+K — к поиску откуда угодно
  const onHotkey = (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) {
      e.preventDefault()
      searchInput.focus()
      searchInput.select()
    }
  }
  document.addEventListener('keydown', onHotkey)
  const norm = (t) => String(t || '').toLocaleLowerCase('ru')

  // ---------- Вкладки с едущей плашкой ----------
  const tabBtns = new Map()
  const tabBadges = new Map()
  const knob = h('span', { class: 'g-tabs__knob', 'aria-hidden': 'true' })
  const tabsRow = h('div', { class: 'g-tabs', role: 'tablist', 'aria-label': 'Разделы' }, [knob, ...TABS.map((t) => {
    const badge = h('span', { class: 'g-tabs__badge', hidden: true })
    const b = h('button', { type: 'button', role: 'tab', class: 'g-tabs__btn', 'data-tab': t.id }, [h('span', {}, t.label), badge])
    b.addEventListener('click', () => setTab(t.id))
    tabBtns.set(t.id, b)
    tabBadges.set(t.id, badge)
    return b
  })])
  // Телефон: та же тройка — стеклянной панелью внизу
  const barKnob = h('span', { class: 'g-bar__knob', 'aria-hidden': 'true' })
  const barBadges = new Map()
  const barBtns = new Map()
  const bottomBar = h('nav', { class: 'g-bar', 'aria-label': 'Разделы' }, [barKnob, ...TABS.map((t) => {
    const badge = h('span', { class: 'g-bar__badge', hidden: true })
    const b = h('button', { type: 'button', class: 'g-bar__btn', 'data-tab': t.id }, [icon(t.icon), h('span', {}, t.label), badge])
    b.addEventListener('click', () => setTab(t.id))
    barBtns.set(t.id, b)
    barBadges.set(t.id, badge)
    return b
  })])
  let lastTabIdx = 0
  function setTab(id, { silent = false } = {}) {
    if (!TABS.some((t) => t.id === id)) id = 'chats'
    const idx = TABS.findIndex((t) => t.id === id)
    // Плашка тянется в сторону движения: передний край быстрее, задний догоняет
    const dir = idx > lastTabIdx ? 1 : idx < lastTabIdx ? -1 : 0
    lastTabIdx = idx
    for (const el of [knob, barKnob]) {
      el.style.transitionDuration = dir > 0 ? '0.62s, 0.34s' : dir < 0 ? '0.34s, 0.62s' : ''
      el.style.setProperty('--i', String(idx))
    }
    tab = id
    for (const [k, b] of tabBtns) { b.classList.toggle('is-on', k === id); b.setAttribute('aria-selected', k === id ? 'true' : 'false') }
    for (const [k, b] of barBtns) b.classList.toggle('is-on', k === id)
    for (const [k, p] of panes) p.classList.toggle('is-on', k === id)
    mobileTitle.textContent = TABS[idx].label
    root.dataset.tab = id
    if (id === 'calls') loadCalls()
    if (!silent) renderPanes()
  }

  // ---------- Панель «Чаты» ----------
  const dmList = h('div', { class: 'g-list', role: 'list', 'aria-label': 'Чаты' })
  const chatsPane = h('div', { class: 'g-pane g-pane--chats' }, [dmList])

  function rowAvatar(user, { saved = false, presence = null, size = 48 } = {}) {
    const a = avatar(user, { size, saved })
    a.classList.add('g-ava')
    if (presence && presence.status !== 'offline') a.appendChild(h('span', { class: 'g-dot' }))
    return a
  }

  const rowCache = new Map() // convId -> <a class="g-row">
  function renderDms() {
    const convs = sortedConversations()
    const activeId = route.name === 'dm' ? route.id : route.name === 'room' ? callState.conversationId : null
    const nodes = []
    const needle = norm(searchQ)
    const inChats = new Set()
    for (const conv of convs) {
      const peer = conv.peer || (conv.members || []).find((u) => u.id !== store.me.id) || { id: 0, username: '?' }
      const saved = isSavedConv(conv)
      if (needle) {
        const names = saved ? 'избранное' : `${norm(displayName(peer))} ${norm(peer.displayName)} ${norm(peer.username)}`
        if (!names.includes(needle.replace(/^@/, ''))) continue
        inChats.add(Number(peer.id))
      }
      const p = presenceOf(peer.id)
      const typing = store.typing.get(conv.id)
      const isTyping = typing && [...typing.values()].some((t) => t > Date.now())
      const callHere = inCall() && callState.conversationId === conv.id
      const subText = isTyping ? 'печатает…' : callHere ? 'в звонке с вами' : conv.lastMessage ? (conv.lastMessage.authorId === store.me.id && !saved ? 'Вы: ' : '') + messagePreview(conv.lastMessage) : saved ? 'Сохранённые сообщения' : presenceText(p)
      const active = conv.id === activeId
      const cls = `g-row${active ? ' is-on' : ''}${conv.unread ? ' is-unread' : ''}${conv.muted ? ' is-muted' : ''}${saved ? ' is-saved' : ''}`
      const kids = [
        rowAvatar(saved ? store.me : peer, { saved, presence: saved ? null : p }),
        h('span', { class: 'g-row__text' }, [
          h('span', { class: 'g-row__top' }, [
            h('span', { class: 'g-row__name' }, saved ? 'Избранное' : displayName(peer)),
            conv.muted ? h('span', { class: 'g-row__flag', title: 'Уведомления выключены' }, [icon('bell-slash')]) : null,
            lastTicks(conv),
            h('span', { class: 'g-row__time' }, timeShort(conv.lastMessageAt))
          ]),
          h('span', { class: 'g-row__bottom' }, [
            h('span', { class: `g-row__last${isTyping || callHere ? ' is-live' : ''}` }, subText),
            conv.unread ? h('span', { class: 'g-badge' }, conv.unread > 99 ? '99+' : String(conv.unread)) : conv.pinned ? h('span', { class: 'g-row__pin', title: 'Закреплён' }, [icon('thumbtack')]) : null
          ])
        ])
      ]
      // Строка живёт между перерисовками: меняются только класс и содержимое — так выбор чата
      // плавно перетекает (фон, подъём, тень), а не появляется новым узлом
      let item = rowCache.get(conv.id)
      if (item) {
        if (item.className !== cls) item.className = cls
        item.replaceChildren(...kids)
        nodes.push(item)
        continue
      }
      item = h('a', { href: '/dm/' + conv.id, role: 'listitem', class: cls }, kids)
      rowCache.set(conv.id, item)
      const convId = conv.id
      item.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate('/dm/' + conv.id)
      })
      // ПКМ по чату: закрепить, контакт, обои, уведомления, позвонить, удалить
      const chatMenu = (e) => {
        e.preventDefault()
        const conv = store.conversations.get(convId)
        if (!conv) return
        const saved = isSavedConv(conv)
        const patch = (body) => api.updateConversation(conv.id, body).catch((er) => toast(er.message, 'error'))
        showMenu([
          { label: conv.pinned ? 'Открепить' : 'Закрепить', icon: conv.pinned ? 'thumbtack-slash' : 'thumbtack', onClick: () => patch({ pinned: !conv.pinned }) },
          saved || !conv.peer ? null : { label: 'Профиль', icon: 'user', onClick: () => openProfileOf(conv.peer) },
          saved || !conv.peer ? null : { label: contactName(conv.peer.id) ? 'Изменить контакт' : 'Добавить в контакты', icon: contactName(conv.peer.id) ? 'pen' : 'user-plus', onClick: () => openContactDialog(conv.peer) },
          { label: 'Обои', icon: 'palette', onClick: () => openWallpaperPicker(conv) },
          saved ? null : { label: conv.muted ? 'Включить уведомления' : 'Выключить уведомления', icon: conv.muted ? 'bell' : 'bell-slash', onClick: () => patch({ muted: !conv.muted }) },
          saved ? null : { label: 'Позвонить', icon: 'phone', onClick: () => { navigate('/dm/' + conv.id); startCall(conv.id) } },
          'sep',
          { label: saved ? 'Очистить' : 'Удалить чат', icon: 'trash', danger: true, onClick: () => askDeleteChat(conv, { navigate }) }
        ], e)
      }
      item.addEventListener('contextmenu', chatMenu)
      onLongPress(item, chatMenu)
      nodes.push(item)
    }
    if (needle) {
      const q = needle.replace(/^@/, '')
      const friends = friendsBy('friend').map((f) => f.user).filter((u) => !inChats.has(Number(u.id)) && `${norm(displayName(u))} ${norm(u.username)}`.includes(q))
      if (friends.length) nodes.push(h('div', { class: 'g-label' }, 'ДРУЗЬЯ'))
      for (const u of friends) {
        const row = h('button', { type: 'button', class: 'g-row' }, [
          rowAvatar(u, { presence: presenceOf(u.id) }),
          h('span', { class: 'g-row__text' }, [h('span', { class: 'g-row__top' }, [h('span', { class: 'g-row__name' }, displayName(u))]), h('span', { class: 'g-row__bottom' }, [h('span', { class: 'g-row__last' }, '@' + u.username)])])
        ])
        row.addEventListener('click', () => { clearSearch(); openDmWith(u.id) })
        nodes.push(row)
      }
      const hits = msgHits.q === searchQ ? msgHits.items : []
      if (hits.length) nodes.push(h('div', { class: 'g-label' }, 'СООБЩЕНИЯ'))
      for (const m of hits) {
        const conv = store.conversations.get(m.conversationId)
        if (!conv) continue
        const saved = isSavedConv(conv)
        const peer = conv.peer || { id: 0, username: '?' }
        const row = h('a', { href: '/dm/' + conv.id, class: 'g-row' }, [
          rowAvatar(saved ? store.me : peer, { saved }),
          h('span', { class: 'g-row__text' }, [
            h('span', { class: 'g-row__top' }, [h('span', { class: 'g-row__name' }, saved ? 'Избранное' : displayName(peer)), h('span', { class: 'g-row__time' }, timeShort(m.createdAt))]),
            h('span', { class: 'g-row__bottom' }, [h('span', { class: 'g-row__last' }, (m.authorId === store.me.id && !saved ? 'Вы: ' : '') + m.body)])
          ])
        ])
        row.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          if (route.name === 'dm' && route.id === conv.id) window.dispatchEvent(new CustomEvent('vl-jump', { detail: { convId: conv.id, id: m.id } }))
          else { store.pendingJump = { convId: conv.id, id: m.id }; navigate('/dm/' + conv.id) }
        })
        nodes.push(row)
      }
      if (!nodes.length) nodes.push(h('div', { class: 'g-empty' }, msgHits.loading ? 'Ищем…' : 'Ничего не нашлось'))
    }
    if (!nodes.length) {
      if (!store.conversationsLoaded) {
        for (let i = 0; i < 6; i++) nodes.push(h('div', { class: 'g-row is-skeleton' }, [h('span', { class: 'g-skel g-skel--ava' }), h('span', { class: 'g-row__text' }, [h('span', { class: 'g-skel g-skel--line' }), h('span', { class: 'g-skel g-skel--line is-short' })])]))
      } else {
        nodes.push(h('div', { class: 'g-empty' }, 'Здесь появятся ваши переписки'))
      }
    }
    // Без replaceChildren: узлы, которые уже стоят на месте, не вынимаются из документа
    // (иначе их CSS-переходы обрывались бы)
    let at = dmList.firstChild
    for (const n of nodes) {
      if (n === at) { at = at.nextSibling; continue }
      dmList.insertBefore(n, at)
    }
    while (at) { const next = at.nextSibling; at.remove(); at = next }
    if (!needle) for (const id of [...rowCache.keys()]) if (!store.conversations.has(id)) rowCache.delete(id)
  }

  function lastTicks(conv) {
    const st = msgStatus(conv, conv.lastMessage, store.me.id)
    return st && st !== 'pending' ? ticks(st, { still: true }) : null
  }
  function clearSearch() { if (searchInput.value) { searchInput.value = ''; setSearch('') } }

  // ---------- Панель «Звонки» ----------
  const newCallBtn = h('button', { type: 'button', class: 'g-btn g-btn--acc g-btn--wide' }, [icon('phone'), 'Новый звонок'])
  newCallBtn.addEventListener('click', () => openPicker('call'))
  const codeInput = h('input', { type: 'text', class: 'g-field__input', placeholder: 'Код комнаты', maxlength: '32', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Код комнаты' })
  const codeGo = h('button', { type: 'button', class: 'g-field__btn' }, 'Войти')
  const codeField = h('label', { class: 'g-field' }, [codeInput, codeGo])
  function goCode() {
    const code = codeInput.value.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (!code) { codeInput.focus(); return }
    codeInput.value = ''
    navigate('/room/' + code)
  }
  codeGo.addEventListener('click', (e) => { e.preventDefault(); goCode() })
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goCode() } })
  // Телефон: «Позвонить другу» — друзья в сети кружками в ряд
  const callStrip = h('div', { class: 'g-strip' })
  const callsList = h('div', { class: 'g-list g-list--calls' })
  const mobileCode = h('div', { class: 'g-codecard' }, [h('span', { class: 'g-codecard__title' }, 'Комната по коду')])
  const callsPane = h('div', { class: 'g-pane g-pane--calls' }, [
    newCallBtn,
    h('div', { class: 'g-label g-only-phone' }, 'Позвонить другу'),
    callStrip,
    mobileCode,
    codeField,
    h('div', { class: 'g-label' }, 'НЕДАВНИЕ'),
    callsList
  ])
  // Поле кода на телефоне живёт в карточке, на ПК — сразу под кнопкой
  const codeHomeDesktop = () => { if (codeField.parentNode !== callsPane) callsPane.insertBefore(codeField, mobileCode.nextSibling) }
  const phoneMQ = matchMedia('(max-width: 860px)')
  function placeCode() {
    if (phoneMQ.matches) { mobileCode.appendChild(codeField); codeGo.classList.add('g-btn', 'g-btn--acc'); codeGo.classList.remove('g-field__btn') }
    else { codeHomeDesktop(); codeGo.classList.remove('g-btn', 'g-btn--acc'); codeGo.classList.add('g-field__btn') }
  }
  phoneMQ.addEventListener && phoneMQ.addEventListener('change', placeCode)
  placeCode()

  let recentCalls = null
  let callsLoading = false
  async function loadCalls() {
    if (callsLoading) return
    callsLoading = true
    try { recentCalls = (await api.get('/api/calls/recent')).calls || [] } catch { if (!recentCalls) recentCalls = [] }
    callsLoading = false
    renderCalls()
  }
  function callLabel(m) {
    const mine = m.authorId === store.me.id
    const st = (m.meta && m.meta.status) || 'ringing'
    if (st === 'missed') return { text: mine ? 'Без ответа' : 'Пропущенный', bad: !mine }
    if (st === 'declined') return { text: mine ? 'Отклонён' : 'Вы отклонили', bad: false }
    if (st === 'ringing') return { text: mine ? 'Исходящий · вызов…' : 'Входящий · вызов…', bad: false }
    return { text: mine ? 'Исходящий' : 'Входящий', bad: false }
  }
  function renderCalls() {
    const friends = friendsBy('friend').map((f) => f.user)
      .sort((a, b) => Number(presenceOf(b.id).status !== 'offline') - Number(presenceOf(a.id).status !== 'offline') || displayName(a).localeCompare(displayName(b), 'ru'))
      .slice(0, 8)
    callStrip.replaceChildren(...friends.map((u) => {
      const b = h('button', { type: 'button', class: 'g-strip__item' }, [rowAvatar(u, { size: 62, presence: presenceOf(u.id) }), h('span', {}, displayName(u).split(' ')[0])])
      b.addEventListener('click', () => callFriend(u.id))
      return b
    }))
    if (recentCalls == null) {
      callsList.replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'g-crow is-skeleton' }, [h('span', { class: 'g-skel g-skel--ava is-sm' }), h('span', { class: 'g-skel g-skel--line' })])))
      return
    }
    if (!recentCalls.length) { callsList.replaceChildren(h('div', { class: 'g-empty' }, 'Звонков пока не было')); return }
    callsList.replaceChildren(...recentCalls.map((m) => {
      const conv = store.conversations.get(m.conversationId)
      const peer = conv && conv.peer
      const who = peer || { id: 0, username: '?', displayName: 'Звонок' }
      const lab = callLabel(m)
      const row = h('button', { type: 'button', class: 'g-crow' }, [
        rowAvatar(who, { size: 40 }),
        h('span', { class: 'g-crow__text' }, [h('span', { class: 'g-crow__name' }, displayName(who)), h('span', { class: `g-crow__sub${lab.bad ? ' is-bad' : ''}` }, lab.text)]),
        h('span', { class: 'g-crow__when' }, timeShort(m.createdAt))
      ])
      row.addEventListener('click', () => { if (conv) { setTab('chats'); navigate('/dm/' + conv.id) } })
      return row
    }))
  }

  // ---------- Панель «Друзья» ----------
  const addInput = h('input', { type: 'text', class: 'g-field__input', placeholder: 'Юзернейм друга', maxlength: '25', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Юзернейм друга' })
  const addBtn = h('button', { type: 'button', class: 'g-field__add', 'aria-label': 'Добавить', title: 'Отправить заявку' }, [icon('plus')])
  const addField = h('label', { class: 'g-field' }, [addInput, addBtn])
  const friendsList = h('div', { class: 'g-list g-list--friends' })
  const friendsPane = h('div', { class: 'g-pane g-pane--friends' }, [addField, friendsList])
  async function addFriend() {
    const username = addInput.value.replace(/^@+/, '').trim()
    if (!username) { addInput.focus(); return }
    addBtn.disabled = true
    try {
      const res = await api.requestFriend(username)
      setFriend(res.friend)
      addInput.value = ''
      toast(res.friend.status === 'friend' ? `Теперь вы друзья: ${displayName(res.friend.user)}` : `Заявка отправлена: ${displayName(res.friend.user)}`, 'success')
    } catch (e) { toast(e.message, 'error') }
    addBtn.disabled = false
  }
  addBtn.addEventListener('click', (e) => { e.preventDefault(); addFriend() })
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFriend() } })

  async function run(fn, okText) {
    try { await fn(); if (okText) toast(okText, 'success') } catch (e) { toast(e.message, 'error') }
    loadFriends().catch(() => {})
  }
  function roundBtn(name, label, onClick, cls = '') {
    const b = h('button', { type: 'button', class: `g-rbtn ${cls}`, 'aria-label': label, title: label }, [icon(name)])
    b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onClick(b) })
    return b
  }
  function openProfileOf(u) {
    openUserCard({
      userId: u.id,
      onMessage: openDmWith,
      onCall: callFriend,
      onJump: (convId, id) => { store.pendingJump = { convId, id }; navigate('/dm/' + convId) }
    })
  }
  function friendMenu(f, anchor) {
    const u = f.user
    showMenu([
      { label: 'Профиль', icon: 'user', onClick: () => openProfileOf(u) },
      { label: contactName(u.id) ? 'Изменить контакт' : 'Добавить в контакты', icon: contactName(u.id) ? 'pen' : 'user-plus', onClick: () => openContactDialog(u) },
      { label: 'Написать', icon: 'message', onClick: () => openDmWith(u.id) },
      { label: 'Позвонить', icon: 'phone', onClick: () => callFriend(u.id) },
      'sep',
      {
        label: 'Удалить из друзей', icon: 'user-minus', danger: true,
        onClick: async () => {
          const ok = await confirmDialog({ title: `Удалить ${displayName(u)} из друзей?`, text: 'Переписка сохранится. Новую личку можно будет начать только после повторной заявки.', confirmLabel: 'Удалить', danger: true })
          if (ok) run(() => api.removeFriend(u.id))
        }
      },
      {
        label: 'Заблокировать', icon: 'ban', danger: true,
        onClick: async () => {
          const ok = await confirmDialog({ title: `Заблокировать ${displayName(u)}?`, text: 'Пользователь не сможет писать и звонить вам, дружба удалится.', confirmLabel: 'Заблокировать', danger: true })
          if (ok) run(() => api.blockUser(u.id), 'Пользователь заблокирован')
        }
      }
    ], anchor)
  }
  function renderFriends() {
    const nodes = []
    const incoming = friendsBy('incoming')
    const outgoing = friendsBy('outgoing')
    const blocked = friendsBy('blocked')
    const byName = (a, b) => displayName(a.user).localeCompare(displayName(b.user), 'ru')
    if (incoming.length + outgoing.length) {
      nodes.push(h('div', { class: 'g-label' }, `ЗАЯВКИ · ${incoming.length + outgoing.length}`))
      for (const f of [...incoming.sort(byName), ...outgoing.sort(byName)]) {
        const u = f.user
        const inc = f.status === 'incoming'
        nodes.push(h('div', { class: 'g-frow is-req' }, [
          rowAvatar(u, { size: 40 }),
          h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, displayName(u)), h('span', { class: 'g-frow__sub' }, inc ? 'хочет добавить вас' : 'ждёт ответа')]),
          inc ? roundBtn('xmark', 'Отклонить', () => run(() => api.declineFriend(u.id)), 'is-soft') : roundBtn('xmark', 'Отменить заявку', () => run(() => api.declineFriend(u.id)), 'is-soft'),
          inc ? roundBtn('check', 'Принять', () => run(() => api.acceptFriend(u.id)), 'is-acc') : null
        ]))
      }
    }
    const friends = friendsBy('friend').sort((a, b) => Number(presenceOf(b.user.id).status !== 'offline') - Number(presenceOf(a.user.id).status !== 'offline') || byName(a, b))
    nodes.push(h('div', { class: 'g-label' }, 'ДРУЗЬЯ'))
    if (!friends.length) nodes.push(h('div', { class: 'g-empty' }, store.friendsLoaded ? 'Друзей пока нет. Добавьте кого-нибудь по юзернейму.' : 'Загружаем…'))
    for (const f of friends) {
      const u = f.user
      const p = presenceOf(u.id)
      const ava = rowAvatar(u, { size: 40, presence: p })
      ava.addEventListener('click', (e) => { e.stopPropagation(); openProfileOf(u) })
      const row = h('button', { type: 'button', class: 'g-frow' }, [
        ava,
        h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, displayName(u)), h('span', { class: `g-frow__sub${p.inCall ? ' is-live' : ''}` }, presenceText(p))]),
        roundBtn('message', 'Написать', () => openDmWith(u.id), 'g-only-phone'),
        roundBtn('phone', 'Позвонить', () => callFriend(u.id), 'g-only-phone')
      ])
      row.addEventListener('click', () => { setTab('chats'); openDmWith(u.id) })
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); friendMenu(f, e) })
      onLongPress(row, (e) => friendMenu(f, e))
      nodes.push(row)
    }
    if (blocked.length) {
      nodes.push(h('div', { class: 'g-label' }, `ЗАБЛОКИРОВАННЫЕ · ${blocked.length}`))
      for (const f of blocked.sort(byName)) {
        nodes.push(h('div', { class: 'g-frow' }, [
          rowAvatar(f.user, { size: 40 }),
          h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, displayName(f.user)), h('span', { class: 'g-frow__sub' }, 'заблокирован')]),
          roundBtn('ban', 'Разблокировать', () => run(() => api.unblockUser(f.user.id), 'Пользователь разблокирован'), 'is-soft')
        ]))
      }
    }
    friendsList.replaceChildren(...nodes)
  }

  const panes = new Map([['chats', chatsPane], ['calls', callsPane], ['friends', friendsPane]])
  const panesBox = h('div', { class: 'g-panes' }, [...panes.values()])

  function renderBadges() {
    let unread = 0
    for (const c of store.conversations.values()) if (c.unread && !c.muted) unread++
    const counts = { chats: unread, calls: 0, friends: incomingCount() }
    for (const t of TABS) {
      const n = counts[t.id]
      for (const badge of [tabBadges.get(t.id), barBadges.get(t.id)]) {
        badge.hidden = !n
        badge.textContent = n > 99 ? '99+' : String(n)
      }
    }
  }
  function renderPanes() {
    if (tab === 'chats') renderDms()
    else if (tab === 'calls') renderCalls()
    else renderFriends()
  }

  // ---------- Баннер «включите уведомления» ----------
  const notifText = h('span', {}, 'Включите уведомления о сообщениях и звонках')
  const enableBtn = h('button', { type: 'button', class: 'g-btn g-btn--acc g-btn--sm' }, 'Включить')
  const hideBtn = h('button', { type: 'button', class: 'g-rbtn is-soft is-sm', 'aria-label': 'Скрыть' }, [icon('xmark')])
  const notifBanner = h('div', { class: 'g-notif', hidden: true }, [notifText, enableBtn, hideBtn])
  enableBtn.addEventListener('click', async () => {
    const res = await requestNotificationPermission()
    if (res === 'granted') toast('Уведомления включены', 'success')
    renderNotifBanner()
  })
  const iosHint = needsHomeScreen()
  const hideKey = iosHint ? 'vl:iosHomeHintHidden' : 'vl:notifBannerHidden'
  hideBtn.addEventListener('click', () => { try { localStorage.setItem(hideKey, '1') } catch {} renderNotifBanner() })
  function renderNotifBanner() {
    let hidden = false
    try { hidden = localStorage.getItem(hideKey) === '1' } catch {}
    if (iosHint) {
      notifText.textContent = 'Уведомления на iPhone: «Поделиться» → «На экран „Домой“», затем откройте сайт с иконки'
      enableBtn.hidden = true
      notifBanner.hidden = hidden
      return
    }
    notifBanner.hidden = hidden || !notificationsNeedPermission()
  }

  // ---------- Плашка «В звонке» внизу ----------
  const islandAvas = h('span', { class: 'g-island__avas' })
  const islandTitle = h('span', { class: 'g-island__title' }, 'В звонке')
  const islandTime = h('span', { class: 'g-island__time' }, '00:00')
  const islandMic = h('button', { type: 'button', class: 'g-island__btn', 'aria-label': 'Микрофон' }, [icon('microphone')])
  const islandHang = h('button', { type: 'button', class: 'g-island__btn is-hang', 'aria-label': 'Выйти из звонка', title: 'Выйти из звонка' }, [icon('phone-slash')])
  const island = h('div', { class: 'g-island', role: 'button', tabindex: '0', title: 'Открыть звонок', hidden: true }, [islandAvas, h('span', { class: 'g-island__text' }, [islandTitle, islandTime]), islandMic, islandHang])
  const openCall = () => {
    const code = window.VL.state.roomCode
    if (code) navigate('/room/' + code)
    else if (callState.conversationId) navigate('/dm/' + callState.conversationId)
  }
  island.addEventListener('click', (e) => { if (!e.target.closest('.g-island__btn')) openCall() })
  island.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === island) openCall() })
  // stopPropagation: иначе клик доходит до самой плашки и открывает звонок (значок внутри
  // кнопки к этому моменту уже перерисован, и проверка closest() его не находит)
  islandMic.addEventListener('click', (e) => { e.stopPropagation(); if (window.VL.toggleMic) window.VL.toggleMic() })
  islandHang.addEventListener('click', (e) => { e.stopPropagation(); if (window.VL.leaveCall) window.VL.leaveCall() })
  let islandTimer = 0
  let callStartedAt = 0
  function fmt(ms) {
    const t = Math.max(0, Math.floor(ms / 1000))
    const hh = Math.floor(t / 3600)
    const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0')
    const ss = String(t % 60).padStart(2, '0')
    return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
  }
  function islandPeople() {
    const room = window.VL.state.room
    const people = []
    try {
      if (room && room.remoteParticipants) for (const p of room.remoteParticipants.values()) people.push(p.name || p.identity || '?')
    } catch {}
    if (!people.length && callState.conversationId) {
      const conv = store.conversations.get(callState.conversationId)
      if (conv && conv.peer) people.push(displayName(conv.peer))
    }
    return people
  }
  function renderIsland() {
    const show = inCall() && route.name !== 'room'
    island.hidden = !show
    root.classList.toggle('has-island', show)
    if (!show) { clearInterval(islandTimer); islandTimer = 0; return }
    const tick = () => {
      const live = document.body.classList.contains('in-call')
      if (live && !callStartedAt) callStartedAt = Date.now()
      islandTitle.textContent = callState.outgoingCallId ? 'Вызов…' : live ? 'В звонке' : 'Подключение…'
      islandTime.textContent = live && callStartedAt ? fmt(Date.now() - callStartedAt) : '00:00'
      const micOn = !!window.VL.state.micEnabled
      islandMic.classList.toggle('is-off', !micOn)
      if (islandMic.dataset.on !== String(micOn)) { islandMic.dataset.on = String(micOn); islandMic.replaceChildren(icon(micOn ? 'microphone' : 'microphone-slash')) }
      islandMic.title = micOn ? 'Выключить микрофон' : 'Включить микрофон'
      const people = islandPeople().slice(0, 2)
      const sig = people.join('|')
      if (islandAvas.dataset.sig !== sig) {
        islandAvas.dataset.sig = sig
        islandAvas.replaceChildren(...people.map((n, i) => h('span', { class: `g-island__ava is-${i}` }, Array.from(String(n).trim())[0] || '?')))
      }
    }
    tick()
    if (!islandTimer) islandTimer = setInterval(tick, 1000)
  }
  const onCallState = (e) => {
    if (e.detail && e.detail.active) { if (!callStartedAt && document.body.classList.contains('in-call')) callStartedAt = Date.now() } else if (!inCall()) callStartedAt = 0
    renderDms(); renderIsland()
  }
  window.addEventListener('vl-call-state', onCallState)
  const onMic = () => renderIsland()
  window.addEventListener('vl-mic-state', onMic)

  // ---------- Выбор друга: новая личка или звонок ----------
  function openPicker(mode = 'message') {
    const forCall = mode === 'call'
    const input = h('input', { type: 'text', class: 'g-field__input', placeholder: 'Имя или юзернейм друга', autocomplete: 'off', spellcheck: 'false' })
    const codeLink = h('button', { type: 'button', class: 'g-frow' }, [
      h('span', { class: 'g-ava g-ava--ico' }, [icon('hashtag')]),
      h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, 'Комната по коду'), h('span', { class: 'g-frow__sub' }, 'создать или войти')])
    ])
    codeLink.addEventListener('click', () => { done(); navigate('/lobby') })
    const pick = (u) => { done(); if (forCall) callFriend(u.id); else openDmWith(u.id) }
    const list = h('div', { class: 'g-picker__list' })
    const close = h('button', { type: 'button', class: 'g-close', 'aria-label': 'Закрыть' }, [icon('xmark')])
    const card = h('div', { class: 'g-modal g-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': forCall ? 'Новый звонок' : 'Написать другу' }, [
      h('div', { class: 'g-modal__head' }, [h('span', { class: 'g-modal__title' }, forCall ? 'Новый звонок' : 'Написать другу'), close]),
      h('label', { class: 'g-field' }, [input]),
      forCall ? codeLink : null,
      list
    ])
    const overlay = h('div', { class: 'g-overlay' }, [card])
    let results = []
    function render() {
      const q = input.value.trim().toLowerCase()
      results = friendsBy('friend').map((f) => f.user)
        .filter((u) => !q || displayName(u).toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
        .sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'))
      list.replaceChildren(...(results.length ? results.map((u) => {
        const row = h('button', { type: 'button', class: 'g-frow' }, [
          rowAvatar(u, { size: 40, presence: presenceOf(u.id) }),
          h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, displayName(u)), h('span', { class: 'g-frow__sub' }, presenceText(presenceOf(u.id)))])
        ])
        row.addEventListener('click', () => pick(u))
        return row
      }) : [h('div', { class: 'g-empty' }, friendsBy('friend').length ? 'Никого не нашлось' : 'Пока нет друзей. Добавьте кого-нибудь во вкладке «Друзья»')]))
    }
    function done() { overlay.classList.add('is-out'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey, true) }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done() }
      if (e.key === 'Enter' && results[0]) { e.preventDefault(); pick(results[0]) }
    }
    input.addEventListener('input', render)
    close.addEventListener('click', done)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    render()
    input.focus()
  }

  async function callFriend(userId) {
    const existing = dmWith(userId)
    const conv = existing || await openDmWith(userId)
    if (!conv) return
    if (existing) navigate('/dm/' + conv.id)
    startCall(conv.id)
  }

  root.replaceChildren(
    head,
    h('div', { class: 'g-side__tools' }, [searchBox, tabsRow]),
    panesBox,
    notifBanner,
    island,
    bottomBar
  )
  root.classList.add('g-side')

  unsub.push(on('conversations', () => { if (tab === 'chats') renderDms(); renderBadges(); if (tab === 'calls') renderCalls() }))
  unsub.push(on('presence', () => { renderPanes(); renderMe() }), on('typing-any', () => { if (tab === 'chats') renderDms() }))
  unsub.push(on('friends', () => { renderBadges(); if (tab !== 'chats') renderPanes() }), on('unread', renderBadges))
  unsub.push(on('connection', renderMe), on('status', renderMe), on('me', renderMe))
  unsub.push(on('call-changed', () => { renderDms(); renderIsland(); if (tab === 'calls') loadCalls() }))

  setTab('chats', { silent: true })
  renderDms(); renderBadges(); renderMe(); renderNotifBanner()

  return {
    setRoute(r) {
      route = r
      // /friends открывает вкладку «Друзья»
      if (r.name === 'friends' && r.tab === 'friends') setTab('friends')
      renderDms(); renderIsland()
    },
    setTab,
    refreshCall() { renderDms(); renderIsland() },
    destroy() {
      unsub.forEach((u) => u())
      clearInterval(islandTimer)
      document.removeEventListener('keydown', onHotkey)
      window.removeEventListener('vl-call-state', onCallState)
      window.removeEventListener('vl-mic-state', onMic)
      root.classList.remove('g-side', 'has-island')
      root.replaceChildren()
    }
  }
}
