// ===================== Левая колонка: друзья, лички, панель звонка, профиль =====================
import { store, on, sortedConversations, presenceOf, incomingCount, friendsBy } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, presenceText, messagePreview, timeShort, showMenu, toast, waveBars, isSavedConv, msgStatus, ticks, onLongPress, contactName } from './ui.js'
import { askDeleteChat } from './chat.js'
import { openContactDialog } from './contact-dialog.js'
import { notificationsNeedPermission, requestNotificationPermission } from './notify.js'
import { needsHomeScreen } from './push.js'
import { callState, inCall, startCall } from './call-invite.js'

export function createSidebar({ root, navigate, openDmWith, openProfile }) {
  let route = { name: 'friends' }
  const unsub = []

  // ---- Шапка: «Чаты» и «+ Звонок» (позвонить другу), под ними — поле поиска ----
  const newCallBtn = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--pill vl-side__new-call', title: 'Позвонить другу' }, [icon('plus'), 'Звонок'])
  newCallBtn.addEventListener('click', () => openPicker('call'))

  // Поиск: друзья и чаты — сразу по мере ввода, сообщения во всех чатах — с сервера
  const searchInput = h('input', { type: 'search', class: 'vl-side__search-input', placeholder: 'Найти друга или сообщение', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Найти друга или сообщение' })
  const searchClear = h('button', { type: 'button', class: 'vl-side__search-x', 'aria-label': 'Очистить поиск', hidden: true }, [icon('xmark')])
  const searchBox = h('label', { class: 'vl-side__search' }, [icon('magnifying-glass'), searchInput, searchClear])
  let searchQ = ''
  let msgHits = { q: '', items: [], loading: false }
  let searchTimer = 0
  function setSearch(v) {
    searchQ = v.trim()
    searchClear.hidden = !v
    clearTimeout(searchTimer)
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
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; setSearch('') }
    if (e.key === 'Enter') { const first = dmList.querySelector('a, button'); if (first) { e.preventDefault(); first.click() } }
  })
  searchClear.addEventListener('click', (e) => { e.preventDefault(); searchInput.value = ''; setSearch(''); searchInput.focus() })
  const norm = (t) => String(t || '').toLocaleLowerCase('ru')

  // ---- «Друзья» — круглая кнопка в шапке, с числом заявок; «По коду» живёт в меню «Звонок» ----
  const friendsBadge = h('span', { class: 'vl-side__friends-badge', hidden: true })
  const navFriends = h('a', { href: '/friends', class: 'vl-round vl-side__friends', title: 'Друзья', 'aria-label': 'Друзья' }, [icon('user-group'), friendsBadge])
  navFriends.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate('/friends')
  })

  const dmList = h('div', { class: 'vl-dm-list', role: 'list', 'aria-label': 'Личные сообщения' })
  const scroller = h('div', { class: 'vl-side__scroll' }, [dmList])

  // ---- Баннер «включите уведомления» (сайт; разрешение просим только по клику) ----
  const notifBanner = h('div', { class: 'vl-notif-banner', hidden: true }, [
    icon('bell'),
    h('span', {}, 'Включите уведомления о сообщениях и звонках'),
    h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--sm' }, 'Включить'),
    h('button', { type: 'button', class: 'vl-round is-ghost is-sm', 'aria-label': 'Скрыть' }, [icon('xmark')])
  ])
  const [, bannerText, enableBtn, hideBtn] = notifBanner.children
  enableBtn.addEventListener('click', async () => {
    const res = await requestNotificationPermission()
    if (res === 'granted') toast('Уведомления включены', 'success')
    renderNotifBanner()
  })
  // iPhone в обычной вкладке Safari: уведомлений там не бывает — подсказываем про экран «Домой»
  const iosHint = needsHomeScreen()
  const hideKey = iosHint ? 'vl:iosHomeHintHidden' : 'vl:notifBannerHidden'
  hideBtn.addEventListener('click', () => { try { localStorage.setItem(hideKey, '1') } catch {} renderNotifBanner() })
  function renderNotifBanner() {
    let hidden = false
    try { hidden = localStorage.getItem(hideKey) === '1' } catch {}
    if (iosHint) {
      bannerText.textContent = 'Уведомления на iPhone: «Поделиться» → «На экран „Домой“», затем откройте сайт с иконки'
      enableBtn.hidden = true
      notifBanner.classList.add('is-hint')
      notifBanner.hidden = hidden
      return
    }
    notifBanner.hidden = hidden || !notificationsNeedPermission()
  }

  // ---- Профиль внизу ----
  const meAvatarSlot = h('span', { class: 'vl-me__ava' })
  const meName = h('div', { class: 'vl-me__name' })
  const meSub = h('div', { class: 'vl-me__sub' })
  // Нажатие на своё имя открывает профиль (оформление, конфиденциальность, выход)
  const meBtn = h('button', { type: 'button', class: 'vl-me__btn', title: 'Профиль' }, [meAvatarSlot, h('div', { class: 'vl-me__text' }, [meName, meSub])])
  const mePanel = h('div', { class: 'vl-me' }, [meBtn])
  meBtn.addEventListener('click', () => openProfile())

  function renderMe() {
    if (!store.me) return
    const p = { status: store.connected ? store.myStatus : 'offline', inCall: false }
    meAvatarSlot.replaceChildren(avatar(store.me, { size: 36, presence: p }))
    meName.textContent = displayName(store.me)
    meSub.textContent = store.connected ? '@' + store.me.username : 'Подключение…'
  }

  // ---- Список личек ----
  function renderDms() {
    const convs = sortedConversations()
    const activeId = route.name === 'dm' ? route.id : route.name === 'room' ? callState.conversationId : null
    const nodes = []
    const needle = norm(searchQ)
    const inChats = new Set()
    for (const conv of convs) {
      const peer = conv.peer || (conv.members || []).find((u) => u.id !== store.me.id) || { id: 0, username: '?' }
      if (needle) {
        const names = isSavedConv(conv) ? 'избранное' : `${norm(displayName(peer))} ${norm(peer.displayName)} ${norm(peer.username)}`
        if (!names.includes(needle.replace(/^@/, ''))) continue
        inChats.add(Number(peer.id))
      }
      const p = presenceOf(peer.id)
      const typing = store.typing.get(conv.id)
      const isTyping = typing && [...typing.values()].some((t) => t > Date.now())
      // В звонке именно с этим человеком — живые зелёные полоски вместо последнего сообщения
      const callHere = inCall() && callState.conversationId === conv.id
      const subText = isTyping ? 'печатает…' : callHere ? 'в звонке с вами' : conv.lastMessage ? (conv.lastMessage.authorId === store.me.id && conv.type !== 'saved' ? 'Вы: ' : '') + messagePreview(conv.lastMessage) : presenceText(p)
      const sub = callHere && !isTyping ? [waveBars(4), subText] : subText
      const saved = isSavedConv(conv)
      const item = h('a', {
        href: '/dm/' + conv.id,
        role: 'listitem',
        class: `vl-dm${conv.id === activeId ? ' is-active' : ''}${conv.unread ? ' is-unread' : ''}${conv.muted ? ' is-muted' : ''}${conv.pinned ? ' is-pinned' : ''}`
      }, [
        avatar(peer, { size: 44, presence: saved ? null : p, saved }),
        h('div', { class: 'vl-dm__text' }, [
          h('div', { class: 'vl-dm__row' }, [
            h('span', { class: 'vl-dm__name' }, saved ? 'Избранное' : displayName(peer)),
            conv.muted ? h('span', { class: 'vl-dm__flag', title: 'Уведомления выключены' }, [icon('bell-slash')]) : null,
            lastTicks(conv),
            h('span', { class: 'vl-dm__time' }, timeShort(conv.lastMessageAt))
          ]),
          h('div', { class: `vl-dm__sub${isTyping ? ' is-typing' : ''}${callHere ? ' is-call' : ''}` }, saved && !conv.lastMessage ? 'Сохранённые сообщения' : sub)
        ]),
        conv.unread ? h('span', { class: 'vl-badge' }, conv.unread > 99 ? '99+' : String(conv.unread)) : conv.pinned ? h('span', { class: 'vl-dm__pin', title: 'Закреплён' }, [icon('thumbtack')]) : null
      ])
      item.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate('/dm/' + conv.id)
      })
      // ПКМ по чату: закрепить, уведомления, удалить (у себя или у обоих)
      const chatMenu = (e) => {
        e.preventDefault()
        const patch = (body) => api.updateConversation(conv.id, body).catch((er) => toast(er.message, 'error'))
        showMenu([
          { label: conv.pinned ? 'Открепить' : 'Закрепить', icon: conv.pinned ? 'thumbtack-slash' : 'thumbtack', onClick: () => patch({ pinned: !conv.pinned }) },
          saved || !conv.peer ? null : { label: contactName(conv.peer.id) ? 'Изменить контакт' : 'Добавить в контакты', icon: contactName(conv.peer.id) ? 'pen' : 'user-plus', onClick: () => openContactDialog(conv.peer) },
          saved ? null : { label: conv.muted ? 'Включить уведомления' : 'Выключить уведомления', icon: conv.muted ? 'bell' : 'bell-slash', onClick: () => patch({ muted: !conv.muted }) },
          saved ? null : { label: 'Позвонить', icon: 'phone', onClick: () => import('./call-invite.js').then((m) => { navigate('/dm/' + conv.id); m.startCall(conv.id) }) },
          'sep',
          { label: saved ? 'Очистить' : 'Удалить чат', icon: 'trash', danger: true, onClick: () => askDeleteChat(conv, { navigate }) }
        ], e)
      }
      item.addEventListener('contextmenu', chatMenu)
      onLongPress(item, chatMenu) // телефон: долгое нажатие
      nodes.push(item)
    }
    if (needle) {
      // Друзья, с которыми ещё нет переписки
      const q = needle.replace(/^@/, '')
      const friends = friendsBy('friend').map((f) => f.user).filter((u) => !inChats.has(Number(u.id)) && `${norm(displayName(u))} ${norm(u.username)}`.includes(q))
      if (friends.length) nodes.push(h('div', { class: 'vl-side__label' }, 'Друзья'))
      for (const u of friends) {
        const row = h('button', { type: 'button', class: 'vl-dm' }, [
          avatar(u, { size: 44, presence: presenceOf(u.id) }),
          h('div', { class: 'vl-dm__text' }, [h('div', { class: 'vl-dm__row' }, [h('span', { class: 'vl-dm__name' }, displayName(u))]), h('div', { class: 'vl-dm__sub' }, '@' + u.username)])
        ])
        row.addEventListener('click', () => { clearSearch(); openDmWith(u.id) })
        nodes.push(row)
      }
      // Сообщения во всех чатах
      const hits = msgHits.q === searchQ ? msgHits.items : []
      if (hits.length) nodes.push(h('div', { class: 'vl-side__label' }, 'Сообщения'))
      for (const m of hits) {
        const conv = store.conversations.get(m.conversationId)
        if (!conv) continue
        const saved = isSavedConv(conv)
        const peer = conv.peer || { id: 0, username: '?' }
        const row = h('a', { href: '/dm/' + conv.id, class: 'vl-dm vl-dm--hit' }, [
          avatar(saved ? store.me : peer, { size: 44, saved }),
          h('div', { class: 'vl-dm__text' }, [
            h('div', { class: 'vl-dm__row' }, [h('span', { class: 'vl-dm__name' }, saved ? 'Избранное' : displayName(peer)), h('span', { class: 'vl-dm__time' }, timeShort(m.createdAt))]),
            h('div', { class: 'vl-dm__sub' }, (m.authorId === store.me.id && !saved ? 'Вы: ' : '') + m.body)
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
      if (!nodes.length) nodes.push(h('div', { class: 'vl-side__empty' }, msgHits.loading ? 'Ищем…' : 'Ничего не нашлось'))
    }
    if (!nodes.length) {
      if (!store.conversationsLoaded) {
        for (let i = 0; i < 5; i++) nodes.push(h('div', { class: 'vl-dm is-skeleton' }, [h('span', { class: 'vl-skel vl-skel--circle' }), h('span', { class: 'vl-skel vl-skel--line' })]))
      } else {
        nodes.push(h('div', { class: 'vl-side__empty' }, 'Здесь появятся ваши переписки'))
      }
    }
    dmList.replaceChildren(...nodes)
  }

  // Галочки у последнего своего сообщения — без анимации (список перерисовывается целиком)
  function lastTicks(conv) {
    const st = msgStatus(conv, conv.lastMessage, store.me.id)
    return st && st !== 'pending' ? ticks(st, { still: true }) : null
  }

  function renderNav() {
    const n = incomingCount()
    friendsBadge.hidden = !n
    friendsBadge.textContent = n > 99 ? '99+' : String(n)
    navFriends.setAttribute('aria-label', n ? `Друзья, заявок: ${n}` : 'Друзья')
    navFriends.classList.toggle('is-active', route.name === 'friends')
  }

  function clearSearch() { if (searchInput.value) { searchInput.value = ''; setSearch('') } }

  // ---- Выбор друга: новая личка или звонок ----
  function openPicker(mode = 'message') {
    const forCall = mode === 'call'
    const input = h('input', { type: 'text', placeholder: 'Имя или юзернейм друга', autocomplete: 'off', spellcheck: 'false' })
    // Звонок без друга: комната по коду (как «По коду» в меню)
    const codeLink = h('button', { type: 'button', class: 'vl-picker__row vl-picker__code' }, [
      h('span', { class: 'vl-picker__code-ico' }, [icon('hashtag')]),
      h('span', { class: 'vl-picker__name' }, 'Комната по коду'),
      h('span', { class: 'vl-picker__user' }, 'создать или войти')
    ])
    // Отдельный экран входа в звонок, без чатов (как по ссылке на звонок)
    codeLink.addEventListener('click', () => { done(); location.assign('/call') })
    const pick = (u) => { done(); if (forCall) callFriend(u.id); else openDmWith(u.id) }
    const list = h('div', { class: 'vl-picker__list' })
    const close = h('button', { type: 'button', class: 'vl-round is-ghost', 'aria-label': 'Закрыть' }, [icon('xmark')])
    const card = h('div', { class: 'vl-modal vl-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Новое сообщение' }, [
      h('div', { class: 'vl-picker__head' }, [h('h3', { class: 'vl-modal__title' }, forCall ? 'Звонок' : 'Написать другу'), close]),
      forCall ? codeLink : null,
      h('div', { class: 'vl-fld-host' }, [input]), list
    ])
    const overlay = h('div', { class: 'vl-modal-overlay' }, [card])
    let results = []
    function render() {
      const q = input.value.trim().toLowerCase()
      results = friendsBy('friend').map((f) => f.user)
        .filter((u) => !q || displayName(u).toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
        .sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'))
      list.replaceChildren(...(results.length ? results.map((u, i) => {
        const row = h('button', { type: 'button', class: `vl-picker__row${i === 0 ? ' is-first' : ''}` }, [
          avatar(u, { size: 40, presence: presenceOf(u.id) }),
          h('span', { class: 'vl-picker__name' }, displayName(u)),
          h('span', { class: 'vl-picker__user' }, '@' + u.username)
        ])
        row.addEventListener('click', () => pick(u))
        return row
      }) : [h('div', { class: 'vl-side__empty' }, friendsBy('friend').length ? 'Никого не нашлось' : 'Пока нет друзей. Добавьте кого-нибудь в разделе «Друзья»')]))
    }
    function done() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
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
    const conv = await openDmWith(userId)
    if (conv) startCall(conv.id)
  }

  // Телефон, экран «Чаты» во время звонка: полоска «Вернуться в звонок» (звонок идёт за списком)
  const callBar = h('button', { type: 'button', class: 'vl-side__call', hidden: true }, [waveBars(4), h('span', {}, 'Идёт звонок'), h('b', {}, 'Вернуться')])
  callBar.addEventListener('click', () => {
    if (callState.conversationId) navigate('/dm/' + callState.conversationId)
    else if (window.VL.state.roomCode) navigate('/room/' + window.VL.state.roomCode)
  })
  function renderCallBar() { callBar.hidden = !inCall() }

  root.replaceChildren(
    h('div', { class: 'vl-side__head' }, [h('h2', { class: 'vl-side__title' }, 'Чаты'), navFriends, newCallBtn]),
    searchBox,
    callBar,
    scroller,
    notifBanner,
    mePanel
  )

  unsub.push(on('conversations', renderDms), on('presence', () => { renderDms(); renderMe() }), on('typing-any', renderDms))
  unsub.push(on('friends', renderNav), on('unread', renderNav), on('connection', renderMe), on('status', renderMe), on('me', renderMe))
  unsub.push(on('call-changed', () => { renderNav(); renderDms(); renderCallBar() }))
  const onCallUi = () => { renderDms(); renderCallBar() }
  window.addEventListener('vl-call-state', onCallUi)

  renderDms(); renderNav(); renderMe(); renderNotifBanner()

  return {
    setRoute(r) { route = r; renderDms(); renderNav() },
    refreshCall: renderDms,
    destroy() {
      unsub.forEach((u) => u())
      window.removeEventListener('vl-call-state', onCallUi)
      root.replaceChildren()
    }
  }
}
