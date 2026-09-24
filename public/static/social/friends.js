// ===================== Экран «Друзья»: в сети / все / ожидание / заблокированные / добавить =====================
import { store, on, friendsBy, presenceOf, setFriend, loadFriends } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, presenceText, showMenu, confirmDialog, toast } from './ui.js'
import { startCall } from './call-invite.js'

const TABS = [
  { id: 'online', label: 'В сети' },
  { id: 'all', label: 'Все' },
  { id: 'pending', label: 'Ожидание' },
  { id: 'blocked', label: 'Заблокированные' }
]

export function createFriendsView({ navigate, openDmWith, menuButton, initialTab }) {
  let tab = TABS.some((t) => t.id === initialTab) || initialTab === 'add' ? initialTab : 'online'
  let query = ''

  const tabButtons = TABS.map((t) => {
    const b = h('button', { type: 'button', class: 'vl-tab', 'data-tab': t.id }, [h('span', {}, t.label)])
    b.addEventListener('click', () => setTab(t.id))
    return b
  })
  const pendingBadge = h('span', { class: 'vl-badge', hidden: true })
  tabButtons[2].appendChild(pendingBadge)
  const addTab = h('button', { type: 'button', class: 'vl-tab vl-tab--add', 'data-tab': 'add' }, 'Добавить в друзья')
  addTab.addEventListener('click', () => setTab('add'))

  const header = h('header', { class: 'vl-view__head' }, [
    menuButton(),
    h('div', { class: 'vl-view__title' }, [icon('user-group'), h('span', {}, 'Друзья')]),
    h('span', { class: 'vl-view__divider', 'aria-hidden': 'true' }),
    h('div', { class: 'vl-tabs', role: 'tablist' }, [...tabButtons, addTab])
  ])

  const search = h('input', { type: 'search', class: 'vl-input vl-search', placeholder: 'Поиск', autocomplete: 'off' })
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderList() })
  const countLabel = h('div', { class: 'vl-list-title' })
  const list = h('div', { class: 'vl-friend-list', role: 'list' })
  const listPane = h('div', { class: 'vl-friends__pane' }, [search, countLabel, list])

  // ---- Добавить в друзья ----
  const addInput = h('input', { type: 'text', class: 'vl-input', placeholder: 'Введите юзернейм', maxlength: '24', autocomplete: 'off', spellcheck: 'false' })
  const addSubmit = h('button', { type: 'button', class: 'vl-btn vl-btn--primary', disabled: true }, 'Отправить запрос')
  const addStatus = h('div', { class: 'vl-add__status', role: 'status' })
  const addForm = h('div', { class: 'vl-add__form' }, [addInput, addSubmit])
  const addPane = h('div', { class: 'vl-friends__pane vl-add' }, [
    h('h2', { class: 'vl-add__title' }, 'Добавить в друзья'),
    h('p', { class: 'vl-add__hint' }, ['Отправьте заявку по юзернейму. Свой юзернейм можно скопировать, нажав на профиль внизу слева — вы ', h('b', {}, '@' + (store.me ? store.me.username : '')), '.']),
    addForm,
    addStatus
  ])
  addInput.addEventListener('input', () => {
    addSubmit.disabled = !addInput.value.trim()
    addForm.classList.remove('is-error', 'is-success')
    addStatus.textContent = ''
  })
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !addSubmit.disabled) addSubmit.click() })
  addSubmit.addEventListener('click', async () => {
    const username = addInput.value.trim()
    addSubmit.disabled = true
    try {
      const res = await api.requestFriend(username)
      setFriend(res.friend)
      addForm.classList.add('is-success')
      addStatus.className = 'vl-add__status is-success'
      addStatus.textContent = res.friend.status === 'friend'
        ? `Готово! Вы с ${displayName(res.friend.user)} теперь друзья.`
        : `Заявка для ${displayName(res.friend.user)} отправлена.`
      addInput.value = ''
    } catch (e) {
      addForm.classList.add('is-error')
      addStatus.className = 'vl-add__status is-error'
      addStatus.textContent = e.message
      addSubmit.disabled = false
    }
  })

  const body = h('div', { class: 'vl-view__body vl-friends' }, [listPane, addPane])
  const node = h('section', { class: 'vl-view vl-view--friends' }, [header, body])

  function setTab(id) {
    tab = id
    const url = id === 'online' ? '/friends' : `/friends?tab=${id}`
    if (location.pathname + location.search !== url) history.replaceState({}, '', url)
    render()
    if (id === 'add') setTimeout(() => addInput.focus(), 30)
  }

  function entriesForTab() {
    const all = [...store.friends.values()]
    let items
    if (tab === 'online') items = all.filter((f) => f.status === 'friend' && presenceOf(f.user.id).status !== 'offline')
    else if (tab === 'all') items = all.filter((f) => f.status === 'friend')
    else if (tab === 'pending') items = all.filter((f) => f.status === 'incoming' || f.status === 'outgoing')
    else items = all.filter((f) => f.status === 'blocked')
    if (query) items = items.filter((f) => displayName(f.user).toLowerCase().includes(query) || f.user.username.toLowerCase().includes(query))
    const rank = (f) => (f.status === 'incoming' ? 0 : f.status === 'outgoing' ? 1 : presenceOf(f.user.id).status === 'offline' ? 3 : 2)
    return items.sort((a, b) => rank(a) - rank(b) || displayName(a.user).localeCompare(displayName(b.user), 'ru'))
  }

  function actionBtn(iconName, title, onClick, cls = '') {
    const b = h('button', { type: 'button', class: `vl-round-btn ${cls}`, title, 'aria-label': title }, [icon(iconName)])
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b) })
    return b
  }

  // После действия сверяем список с сервером: SSE тоже пришлёт изменения, но если соединение
  // сейчас рвётся, кнопка не должна выглядеть «не сработавшей»
  async function run(fn, okText) {
    try { await fn(); if (okText) toast(okText, 'success') } catch (e) { toast(e.message, 'error') }
    loadFriends().catch(() => {})
  }

  function row(f) {
    const u = f.user
    const p = presenceOf(u.id)
    let sub, actions
    if (f.status === 'incoming') {
      sub = 'Входящая заявка в друзья'
      actions = [
        actionBtn('check', 'Принять', () => run(() => api.acceptFriend(u.id)), 'is-accept'),
        actionBtn('xmark', 'Отклонить', () => run(() => api.declineFriend(u.id)), 'is-decline')
      ]
    } else if (f.status === 'outgoing') {
      sub = 'Исходящая заявка в друзья'
      actions = [actionBtn('xmark', 'Отменить заявку', () => run(() => api.declineFriend(u.id)), 'is-decline')]
    } else if (f.status === 'blocked') {
      sub = 'Заблокирован'
      actions = [actionBtn('user-check', 'Разблокировать', () => run(() => api.unblockUser(u.id), 'Пользователь разблокирован'))]
    } else {
      sub = presenceText(p)
      actions = [
        actionBtn('message', 'Написать', () => openDmWith(u.id)),
        actionBtn('phone', 'Позвонить', async () => { const conv = await openDmWith(u.id); if (conv) startCall(conv.id) }),
        actionBtn('ellipsis-vertical', 'Ещё', (b) => moreMenu(f, b))
      ]
    }
    const item = h('div', { class: 'vl-friend', role: 'listitem', tabindex: '0' }, [
      avatar(u, { size: 36, presence: f.status === 'friend' ? p : null }),
      h('div', { class: 'vl-friend__text' }, [
        h('div', { class: 'vl-friend__name' }, [h('span', {}, displayName(u)), h('span', { class: 'vl-friend__user' }, '@' + u.username)]),
        h('div', { class: 'vl-friend__sub' }, sub)
      ]),
      h('div', { class: 'vl-friend__actions' }, actions)
    ])
    if (f.status === 'friend') {
      item.addEventListener('click', () => openDmWith(u.id))
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDmWith(u.id) })
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); moreMenu(f, e) })
    }
    return item
  }

  function moreMenu(f, anchor) {
    const u = f.user
    showMenu([
      { label: 'Написать', icon: 'message', onClick: () => openDmWith(u.id) },
      { label: 'Скопировать юзернейм', icon: 'at', onClick: () => window.VL.copyToClipboard(u.username).then((ok) => toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error')) },
      'sep',
      {
        label: 'Удалить из друзей', icon: 'user-minus', danger: true,
        onClick: async () => {
          const ok = await confirmDialog({ title: `Удалить ${displayName(u)}?`, text: 'Переписка сохранится, но новую личку можно будет начать только после повторной заявки.', confirmLabel: 'Удалить из друзей', danger: true })
          if (ok) run(() => api.removeFriend(u.id))
        }
      },
      {
        label: 'Заблокировать', icon: 'ban', danger: true,
        onClick: async () => {
          const ok = await confirmDialog({ title: `Заблокировать ${displayName(u)}?`, text: 'Пользователь не сможет писать и звонить вам, а дружба будет удалена.', confirmLabel: 'Заблокировать', danger: true })
          if (ok) run(() => api.blockUser(u.id), 'Пользователь заблокирован')
        }
      }
    ], anchor)
  }

  const EMPTY = {
    online: 'Сейчас никого из друзей нет в сети.',
    all: 'Друзей пока нет. Добавьте кого-нибудь по юзернейму.',
    pending: 'Заявок в друзья нет.',
    blocked: 'Вы никого не блокировали.'
  }
  const TITLES = { online: 'В сети', all: 'Все друзья', pending: 'Ожидание', blocked: 'Заблокированные' }

  function renderList() {
    if (tab === 'add') return
    const items = entriesForTab()
    countLabel.textContent = `${TITLES[tab]} — ${items.length}`
    if (!store.friendsLoaded && !items.length) {
      list.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'vl-friend is-skeleton' }, [h('span', { class: 'vl-skel vl-skel--circle' }), h('span', { class: 'vl-skel vl-skel--line' })])))
      return
    }
    if (!items.length) {
      const empty = h('div', { class: 'vl-empty' }, [
        h('div', { class: 'vl-empty__icon' }, [icon(tab === 'blocked' ? 'ban' : tab === 'pending' ? 'hourglass-half' : 'user-group')]),
        h('p', {}, query ? 'Никого не нашлось.' : EMPTY[tab])
      ])
      if (!query && (tab === 'all' || tab === 'online')) {
        const b = h('button', { type: 'button', class: 'vl-btn vl-btn--primary' }, 'Добавить в друзья')
        b.addEventListener('click', () => setTab('add'))
        empty.appendChild(b)
      }
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(...items.map(row))
  }

  function render() {
    for (const b of [...tabButtons, addTab]) b.classList.toggle('is-active', b.dataset.tab === tab)
    const n = friendsBy('incoming').length
    pendingBadge.hidden = !n
    pendingBadge.textContent = String(n)
    listPane.hidden = tab === 'add'
    addPane.hidden = tab !== 'add'
    renderList()
  }

  const unsub = [on('friends', render), on('presence', renderList), on('connection', renderList)]
  render()

  return {
    node,
    setTab(id) { if (id && id !== tab) setTab(id) },
    destroy() { unsub.forEach((u) => u()) }
  }
}
