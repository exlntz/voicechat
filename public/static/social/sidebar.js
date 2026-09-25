// ===================== Левая колонка: друзья, лички, панель звонка, профиль =====================
import { store, on, sortedConversations, presenceOf, incomingCount, friendsBy } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, presenceText, messagePreview, timeShort, showMenu, toast, waveBars, isSavedConv, msgStatus, ticks, onLongPress, contactName } from './ui.js'
import { askDeleteChat } from './chat.js'
import { openContactDialog } from './contact-dialog.js'
import { notificationsNeedPermission, requestNotificationPermission } from './notify.js'
import { callState, inCall } from './call-invite.js'

export function createSidebar({ root, navigate, openDmWith, openProfile }) {
  let route = { name: 'friends' }
  const unsub = []

  // ---- Шапка: «Чаты», поиск и новая личка — круглые кнопки ----
  const findBtn = h('button', { type: 'button', class: 'vl-round', title: 'Найти беседу', 'aria-label': 'Найти беседу' }, [icon('magnifying-glass')])
  findBtn.addEventListener('click', () => openPicker())
  const addDmBtn = h('button', { type: 'button', class: 'vl-round is-accent', title: 'Новое сообщение', 'aria-label': 'Новое сообщение' }, [icon('plus')])
  addDmBtn.addEventListener('click', () => openPicker())

  // ---- Навигация: две «таблетки» ----
  const friendsBadge = h('span', { class: 'vl-dot-badge', hidden: true, 'aria-label': 'Есть заявки в друзья' })
  const navFriends = h('a', { href: '/friends', class: 'vl-pill', 'data-nav': 'friends' }, [icon('user-group'), h('span', {}, 'Друзья'), friendsBadge])
  const navLobby = h('a', { href: '/lobby', class: 'vl-pill', 'data-nav': 'lobby' }, [icon('hashtag'), h('span', {}, 'По коду')])
  for (const a of [navFriends, navLobby]) {
    a.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      navigate(a.getAttribute('href'))
    })
  }

  const dmList = h('div', { class: 'vl-dm-list', role: 'list', 'aria-label': 'Личные сообщения' })
  const scroller = h('div', { class: 'vl-side__scroll' }, [dmList])

  // ---- Баннер «включите уведомления» (сайт; разрешение просим только по клику) ----
  const notifBanner = h('div', { class: 'vl-notif-banner', hidden: true }, [
    icon('bell'),
    h('span', {}, 'Включите уведомления о сообщениях и звонках'),
    h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--sm' }, 'Включить'),
    h('button', { type: 'button', class: 'vl-round is-ghost is-sm', 'aria-label': 'Скрыть' }, [icon('xmark')])
  ])
  const [, , enableBtn, hideBtn] = notifBanner.children
  enableBtn.addEventListener('click', async () => {
    const res = await requestNotificationPermission()
    if (res === 'granted') toast('Уведомления включены', 'success')
    renderNotifBanner()
  })
  hideBtn.addEventListener('click', () => { try { localStorage.setItem('vl:notifBannerHidden', '1') } catch {} renderNotifBanner() })
  function renderNotifBanner() {
    let hidden = false
    try { hidden = localStorage.getItem('vl:notifBannerHidden') === '1' } catch {}
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
    for (const conv of convs) {
      const peer = conv.peer || (conv.members || []).find((u) => u.id !== store.me.id) || { id: 0, username: '?' }
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
    friendsBadge.textContent = String(n)
    navFriends.classList.toggle('is-active', route.name === 'friends')
    // Звонок из лички подсвечивает личку, а не «Звонок по коду»
    navLobby.classList.toggle('is-active', route.name === 'lobby' || (route.name === 'room' && !callState.conversationId))
  }

  // ---- Выбор друга для новой лички ----
  function openPicker() {
    const input = h('input', { type: 'text', placeholder: 'Имя или юзернейм друга', autocomplete: 'off', spellcheck: 'false' })
    const list = h('div', { class: 'vl-picker__list' })
    const close = h('button', { type: 'button', class: 'vl-round is-ghost', 'aria-label': 'Закрыть' }, [icon('xmark')])
    const card = h('div', { class: 'vl-modal vl-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Новое сообщение' }, [
      h('div', { class: 'vl-picker__head' }, [h('h3', { class: 'vl-modal__title' }, 'Написать другу'), close]),
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
        row.addEventListener('click', () => { done(); openDmWith(u.id) })
        return row
      }) : [h('div', { class: 'vl-side__empty' }, friendsBy('friend').length ? 'Никого не нашлось' : 'Пока нет друзей. Добавьте кого-нибудь в разделе «Друзья»')]))
    }
    function done() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done() }
      if (e.key === 'Enter' && results[0]) { e.preventDefault(); done(); openDmWith(results[0].id) }
    }
    input.addEventListener('input', render)
    close.addEventListener('click', done)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    render()
    input.focus()
  }

  // Телефон, экран «Чаты» во время звонка: полоска «Вернуться в звонок» (звонок идёт за списком)
  const callBar = h('button', { type: 'button', class: 'vl-side__call', hidden: true }, [waveBars(4), h('span', {}, 'Идёт звонок'), h('b', {}, 'Вернуться')])
  callBar.addEventListener('click', () => {
    if (callState.conversationId) navigate('/dm/' + callState.conversationId)
    else if (window.VL.state.roomCode) navigate('/room/' + window.VL.state.roomCode)
  })
  function renderCallBar() { callBar.hidden = !inCall() }

  root.replaceChildren(
    h('div', { class: 'vl-side__head' }, [h('h2', { class: 'vl-side__title' }, 'Чаты'), findBtn, addDmBtn]),
    callBar,
    h('nav', { class: 'vl-side__nav', 'aria-label': 'Разделы' }, [navFriends, navLobby]),
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
