// ===================== Экран «Друзья» =====================
// Сверху — «Сейчас в сети»: плитки друзей онлайн (в звонке — первыми, с зелёным кольцом).
// Ниже — список: вкладки-«чипы» Все / Заявки / Заблокированные и поле «добавить по юзернейму».
import { store, on, friendsBy, presenceOf, setFriend, loadFriends } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, presenceText, showMenu, confirmDialog, toast } from './ui.js'
import { startCall } from './call-invite.js'

const TABS = [
  { id: 'all', label: 'Все' },
  { id: 'pending', label: 'Заявки' },
  { id: 'blocked', label: 'Заблокированные' }
]
// Старые адреса (/friends?tab=online, ?tab=add) ведут в ближайшую вкладку
const TAB_ALIASES = { online: 'all', add: 'all' }
const MAX_TILES = 6

export function createFriendsView({ openDmWith, menuButton, initialTab }) {
  let tab = normalizeTab(initialTab)

  function normalizeTab(id) {
    const t = TAB_ALIASES[id] || id
    return TABS.some((x) => x.id === t) ? t : 'all'
  }

  // ---------- Верх: «Сейчас в сети» ----------
  const onlineCount = h('span', { class: 'vl-friends__count' })
  const tiles = h('div', { class: 'vl-tiles' })
  const top = h('section', { class: 'vl-panel vl-friends__top', 'aria-label': 'Сейчас в сети' }, [
    h('div', { class: 'vl-friends__head' }, [menuButton(), h('h1', { class: 'vl-friends__title' }, 'Сейчас в сети'), onlineCount]),
    tiles
  ])

  // ---------- Низ: список, вкладки, добавить ----------
  const chips = TABS.map((t) => {
    const count = h('span', { class: 'vl-chip__count' })
    const b = h('button', { type: 'button', role: 'tab', class: 'vl-chip', 'data-tab': t.id }, [h('span', {}, t.label), count])
    b._count = count
    b.addEventListener('click', () => setTab(t.id))
    return b
  })
  const addInput = h('input', { type: 'text', class: 'vl-field', placeholder: 'Добавить по @юзернейму', maxlength: '25', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Юзернейм друга' })
  const addBtn = h('button', { type: 'button', class: 'vl-round is-accent', title: 'Отправить заявку', 'aria-label': 'Отправить заявку', disabled: true }, [icon('user-plus')])
  const addStatus = h('div', { class: 'vl-add__status', role: 'status' })
  const list = h('div', { class: 'vl-friend-list', role: 'list' })
  const bottom = h('section', { class: 'vl-panel vl-friends__bottom' }, [
    h('div', { class: 'vl-friends__bar' }, [
      h('div', { class: 'vl-chips', role: 'tablist', 'aria-label': 'Список друзей' }, chips),
      h('div', { class: 'vl-add' }, [addInput, addBtn])
    ]),
    addStatus,
    list
  ])

  const node = h('section', { class: 'vl-view vl-view--friends' }, [h('div', { class: 'vl-friends' }, [top, bottom])])

  // ---------- Добавить в друзья ----------
  addInput.addEventListener('input', () => {
    addBtn.disabled = !addInput.value.trim()
    addStatus.textContent = ''
    addStatus.className = 'vl-add__status'
  })
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !addBtn.disabled) addBtn.click() })
  addBtn.addEventListener('click', async () => {
    const username = addInput.value.trim()
    addBtn.disabled = true
    try {
      const res = await api.requestFriend(username)
      setFriend(res.friend)
      addStatus.className = 'vl-add__status is-success'
      addStatus.textContent = res.friend.status === 'friend'
        ? `Готово, теперь вы друзья: ${displayName(res.friend.user)}.`
        : `Заявка отправлена: ${displayName(res.friend.user)}.`
      addInput.value = ''
      if (res.friend.status !== 'friend') setTab('pending')
    } catch (e) {
      addStatus.className = 'vl-add__status is-error'
      addStatus.textContent = e.message
      addBtn.disabled = false
    }
  })

  function setTab(id) {
    tab = normalizeTab(id)
    const url = tab === 'all' ? '/friends' : `/friends?tab=${tab}`
    if (location.pathname + location.search !== url) history.replaceState({}, '', url)
    render()
  }

  // После действия сверяем список с сервером: SSE тоже пришлёт изменения, но если соединение
  // сейчас рвётся, кнопка не должна выглядеть «не сработавшей»
  async function run(fn, okText) {
    try { await fn(); if (okText) toast(okText, 'success') } catch (e) { toast(e.message, 'error') }
    loadFriends().catch(() => {})
  }

  async function callFriend(userId) {
    const conv = await openDmWith(userId)
    if (conv) startCall(conv.id)
  }

  function roundBtn(iconName, title, onClick, extra = '') {
    const b = h('button', { type: 'button', class: `vl-round ${extra}`, title, 'aria-label': title }, [icon(iconName)])
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b) })
    return b
  }
  function pillBtn(label, onClick, extra = '') {
    const b = h('button', { type: 'button', class: `vl-btn vl-btn--pill ${extra}` }, label)
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b) })
    return b
  }

  // ---------- Плитки «Сейчас в сети» ----------
  function renderTiles() {
    const online = friendsBy('friend')
      .filter((f) => presenceOf(f.user.id).status !== 'offline')
      .sort((a, b) => Number(presenceOf(b.user.id).inCall) - Number(presenceOf(a.user.id).inCall) || displayName(a.user).localeCompare(displayName(b.user), 'ru'))
    onlineCount.textContent = online.length ? String(online.length) : ''
    if (!store.friendsLoaded && !online.length) {
      tiles.replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'vl-tile is-skeleton' }, [h('span', { class: 'vl-skel vl-skel--circle vl-skel--lg' }), h('span', { class: 'vl-skel vl-skel--line' })])))
      return
    }
    if (!online.length) {
      const add = h('button', { type: 'button', class: 'vl-linkbtn' }, 'Добавить друга')
      add.addEventListener('click', () => addInput.focus())
      tiles.replaceChildren(h('p', { class: 'vl-tiles__empty' }, ['Сейчас никого нет в сети. ', add]))
      return
    }
    const shown = online.slice(0, MAX_TILES)
    const nodes = shown.map((f, i) => {
      const u = f.user
      const p = presenceOf(u.id)
      const featured = i === 0 && p.inCall
      const ava = avatar(u, { size: featured ? 64 : 52, presence: featured ? null : p })
      if (featured) ava.classList.add('is-ringed')
      const tile = h('div', { class: `vl-tile${featured ? ' is-featured' : ''}`, role: 'listitem', tabindex: '0' }, [
        ava,
        h('span', { class: 'vl-tile__text' }, [
          h('span', { class: 'vl-tile__name' }, displayName(u)),
          h('span', { class: `vl-tile__sub${p.inCall ? ' is-call' : ''}` }, presenceText(p))
        ]),
        h('span', { class: 'vl-tile__acts' }, [
          roundBtn('message', `Написать: ${displayName(u)}`, () => openDmWith(u.id), 'is-sm'),
          roundBtn('phone', `Позвонить: ${displayName(u)}`, () => callFriend(u.id), 'is-sm is-accent')
        ])
      ])
      tile.addEventListener('click', () => openDmWith(u.id))
      tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tile) openDmWith(u.id) })
      return tile
    })
    if (online.length > shown.length) {
      const more = h('button', { type: 'button', class: 'vl-tile vl-tile--more' }, `Ещё ${online.length - shown.length}`)
      more.addEventListener('click', () => setTab('all'))
      nodes.push(more)
    }
    tiles.setAttribute('role', 'list')
    tiles.replaceChildren(...nodes)
  }

  // ---------- Список ----------
  function entriesForTab() {
    const all = [...store.friends.values()]
    let items
    if (tab === 'pending') items = all.filter((f) => f.status === 'incoming' || f.status === 'outgoing')
    else if (tab === 'blocked') items = all.filter((f) => f.status === 'blocked')
    else items = all.filter((f) => f.status === 'friend')
    const rank = (f) => (f.status === 'incoming' ? 0 : f.status === 'outgoing' ? 1 : presenceOf(f.user.id).status === 'offline' ? 3 : 2)
    return items.sort((a, b) => rank(a) - rank(b) || displayName(a.user).localeCompare(displayName(b.user), 'ru'))
  }

  function row(f) {
    const u = f.user
    const p = presenceOf(u.id)
    let sub
    let actions
    let extra = ''
    if (f.status === 'incoming') {
      extra = ' is-incoming'
      sub = 'Хочет добавить вас в друзья'
      actions = [
        pillBtn('Отклонить', () => run(() => api.declineFriend(u.id)), 'vl-btn--soft'),
        pillBtn('Принять', () => run(() => api.acceptFriend(u.id)), 'vl-btn--primary')
      ]
    } else if (f.status === 'outgoing') {
      sub = 'Ждёт ответа на вашу заявку'
      actions = [pillBtn('Отменить', () => run(() => api.declineFriend(u.id)), 'vl-btn--soft')]
    } else if (f.status === 'blocked') {
      sub = 'Заблокирован'
      actions = [pillBtn('Разблокировать', () => run(() => api.unblockUser(u.id), 'Пользователь разблокирован'), 'vl-btn--soft')]
    } else {
      sub = presenceText(p)
      actions = [
        roundBtn('message', 'Написать', () => openDmWith(u.id)),
        roundBtn('phone', 'Позвонить', () => callFriend(u.id)),
        roundBtn('ellipsis-vertical', 'Ещё', (b) => moreMenu(f, b))
      ]
    }
    const item = h('div', { class: `vl-friend${extra}`, role: 'listitem', tabindex: f.status === 'friend' ? '0' : null }, [
      avatar(u, { size: 44, presence: f.status === 'friend' ? p : null }),
      h('div', { class: 'vl-friend__text' }, [
        h('div', { class: 'vl-friend__name' }, [h('span', {}, displayName(u)), h('span', { class: 'vl-friend__user' }, '@' + u.username)]),
        h('div', { class: `vl-friend__sub${p.inCall && f.status === 'friend' ? ' is-call' : ''}` }, sub)
      ]),
      h('div', { class: 'vl-friend__actions' }, actions)
    ])
    if (f.status === 'friend') {
      item.addEventListener('click', () => openDmWith(u.id))
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === item) openDmWith(u.id) })
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); moreMenu(f, e) })
    }
    return item
  }

  function moreMenu(f, anchor) {
    const u = f.user
    showMenu([
      { label: 'Написать', icon: 'message', onClick: () => openDmWith(u.id) },
      { label: 'Позвонить', icon: 'phone', onClick: () => callFriend(u.id) },
      { label: 'Скопировать юзернейм', icon: 'at', onClick: () => window.VL.copyToClipboard(u.username).then((ok) => toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error')) },
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

  const EMPTY = {
    all: 'Друзей пока нет. Добавьте кого-нибудь по юзернейму.',
    pending: 'Заявок нет.',
    blocked: 'Вы никого не блокировали.'
  }

  function renderList() {
    const items = entriesForTab()
    if (!store.friendsLoaded && !items.length) {
      list.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'vl-friend is-skeleton' }, [h('span', { class: 'vl-skel vl-skel--circle' }), h('span', { class: 'vl-skel vl-skel--line' })])))
      return
    }
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'vl-empty' }, [
        h('div', { class: 'vl-empty__icon' }, [icon(tab === 'blocked' ? 'ban' : tab === 'pending' ? 'hourglass-half' : 'user-group')]),
        h('p', {}, EMPTY[tab])
      ]))
      return
    }
    list.replaceChildren(...items.map(row))
  }

  function render() {
    const counts = {
      all: friendsBy('friend').length,
      pending: friendsBy('incoming').length + friendsBy('outgoing').length,
      blocked: friendsBy('blocked').length
    }
    const incoming = friendsBy('incoming').length
    for (const c of chips) {
      const active = c.dataset.tab === tab
      c.classList.toggle('is-active', active)
      c.setAttribute('aria-selected', active ? 'true' : 'false')
      c._count.textContent = counts[c.dataset.tab] ? String(counts[c.dataset.tab]) : ''
      c.classList.toggle('has-new', c.dataset.tab === 'pending' && incoming > 0)
    }
    renderTiles()
    renderList()
  }

  const unsub = [on('friends', render), on('presence', () => { renderTiles(); renderList() }), on('connection', render)]
  render()
  if (initialTab === 'add') setTimeout(() => addInput.focus(), 30)

  return {
    node,
    setTab(id) { if (id === 'add') { addInput.focus(); return } if (normalizeTab(id) !== tab) setTab(id) },
    destroy() { unsub.forEach((u) => u()) }
  }
}
