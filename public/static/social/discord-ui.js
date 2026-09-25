// Presentation adapter: the original session, routing and call shell stays in shell.js.
import { store, on, sortedConversations } from './store.js'
import { h, icon, avatar, displayName, isMobile } from './ui.js'
import { filterDestinations, moveSelection } from './quick-switcher.js'

let initialized = false
export function initDiscordUI({ navigate, openDmWith }) {
  if (initialized) return
  initialized = true
  if (!document.querySelector('link[href="/static/discord.css"]')) {
    document.head.appendChild(h('link', { rel: 'stylesheet', href: '/static/discord.css' }))
  }
  const body = document.body
  const shell = document.getElementById('vl-shell')
  const sidebar = document.getElementById('vl-sidebar')
  const viewRoot = document.getElementById('vl-view')
  if (!shell || !sidebar || !viewRoot) return
  const ready = () => body.classList.contains('vl-ready') && !!store.me
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
  let rail = null
  let titlebar = null
  let railList = null
  let routeLabel = null
  let railSignature = ''
  let frame = 0
  let dialog = null
  let refreshDialog = null
  let accountId = null
  let messageSubscription = null
  let subscribedConversation = null

  function routeLink(path, label, glyph, className = '') {
    const link = h('a', { href: path, class: className, 'aria-label': label, 'data-dc-tooltip': label }, [icon(glyph)])
    link.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate(path)
      schedule()
    })
    return link
  }

  function buildChrome() {
    rail = h('nav', { class: 'dc-rail', 'aria-label': 'Основная навигация' })
    const home = routeLink('/friends', 'Друзья', 'comment-dots', 'dc-rail__item dc-rail__home')
    const chats = h('button', { type: 'button', class: 'dc-rail__item', 'aria-label': 'Найти чат', 'data-dc-tooltip': 'Найти чат (' + shortcut + ')' }, [icon('magnifying-glass')])
    chats.addEventListener('click', openSwitcher)
    const call = routeLink('/lobby', 'Звонок по коду', 'phone', 'dc-rail__item dc-rail__call')
    railList = h('div', { class: 'dc-rail__dms', 'aria-label': 'Недавние переписки' })
    const profile = h('button', { type: 'button', class: 'dc-rail__item dc-rail__profile', 'aria-label': 'Настройки профиля', 'data-dc-tooltip': 'Настройки профиля' }, [icon('gear')])
    profile.addEventListener('click', () => sidebar.querySelector('.vl-me__btn')?.click())
    rail.append(home, h('div', { class: 'dc-rail__separator', 'aria-hidden': 'true' }), chats, call, railList, profile)
    shell.insertBefore(rail, sidebar)
    routeLabel = h('span', { class: 'dc-titlebar__route' })
    titlebar = h('header', { class: 'dc-titlebar' }, [
      h('span', { class: 'dc-titlebar__brand' }, [icon('headphones'), ' Voice Lobby']),
      routeLabel,
      h('span', { class: 'dc-titlebar__hint', 'aria-hidden': 'true' }, shortcut)
    ])
    body.appendChild(titlebar)
  }

  function destinations() {
    const result = [
      { id: 'friends', title: 'Друзья', subtitle: 'Список друзей и заявки', keywords: 'friends online', path: '/friends', glyph: 'user-group' },
      { id: 'lobby', title: 'Звонок по коду', subtitle: 'Создать комнату или присоединиться', keywords: 'call room voice', path: '/lobby', glyph: 'phone' }
    ]
    const knownPeers = new Set()
    for (const conv of sortedConversations()) {
      const saved = conv.type === 'saved'
      if (conv.peer) knownPeers.add(Number(conv.peer.id))
      result.push({ id: 'dm-' + conv.id, title: saved ? 'Избранное' : displayName(conv.peer),
        subtitle: saved ? 'Личные заметки и сохранённые сообщения' : conv.peer?.username ? '@' + conv.peer.username : 'Личные сообщения',
        keywords: saved ? 'saved bookmarks' : '', path: '/dm/' + conv.id, peer: conv.peer, saved,
        unread: Number(conv.unread) || 0, glyph: saved ? 'bookmark' : 'message' })
    }
    for (const friend of store.friends.values()) {
      if (friend.status !== 'friend' || !friend.user || knownPeers.has(Number(friend.user.id))) continue
      result.push({ id: 'user-' + friend.user.id, title: displayName(friend.user),
        subtitle: '@' + friend.user.username, peer: friend.user, userId: friend.user.id, glyph: 'user' })
    }
    return result
  }

  function closeSwitcher() { if (dialog?.open) dialog.close() }
  function openSwitcher() {
    if (!ready()) return
    if (dialog?.open) { closeSwitcher(); return }
    // Do not steal focus from profile/settings, incoming-call dialogs, or another modal.
    if (document.querySelector('dialog[open], .settings-overlay, .vl-modal-overlay')) return
    const previousFocus = document.activeElement
    const input = h('input', { type: 'search', class: 'dc-switcher__input', placeholder: 'Куда отправимся?',
      autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-label': 'Найти чат или друга',
      'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'dc-switcher-results', 'aria-describedby': 'dc-switcher-help' })
    const list = h('div', { id: 'dc-switcher-results', class: 'dc-switcher__results', role: 'listbox', 'aria-label': 'Результаты поиска' })
    const status = h('span', { class: 'dc-sr-only', role: 'status', 'aria-live': 'polite' })
    const close = h('button', { type: 'button', class: 'dc-switcher__close', 'aria-label': 'Закрыть поиск' }, [icon('xmark')])
    const currentDialog = h('dialog', { class: 'dc-switcher', 'aria-labelledby': 'dc-switcher-title' }, [
      h('div', { class: 'dc-switcher__head' }, [h('h2', { id: 'dc-switcher-title' }, 'Быстрый переход'), close]),
      h('div', { class: 'dc-switcher__field' }, [icon('magnifying-glass'), input]), list, status,
      h('p', { class: 'dc-switcher__help', id: 'dc-switcher-help' }, '↑ ↓ выбрать · Enter открыть · Esc закрыть')
    ])
    dialog = currentDialog
    let results = []
    let selected = -1
    let activating = false
    let navigated = false
    function updateSelection(scroll = false) {
      const options = list.querySelectorAll('[role="option"]')
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === selected)))
      if (selected >= 0 && options[selected]) {
        input.setAttribute('aria-activedescendant', options[selected].id)
        if (scroll) options[selected].scrollIntoView({ block: 'nearest' })
      } else input.removeAttribute('aria-activedescendant')
    }
    async function activate(index) {
      const item = results[index]
      if (!item || activating || !ready()) return
      activating = true
      navigated = true
      currentDialog.close()
      if (item.path) navigate(item.path)
      else await openDmWith(item.userId)
      schedule()
    }
    function render(reset = false) {
      const oldId = results[selected]?.id
      results = filterDestinations(destinations(), input.value)
      selected = reset ? 0 : Math.max(0, results.findIndex(item => item.id === oldId))
      if (!results.length) selected = -1
      const nodes = results.map((item, index) => {
        const node = h('div', { class: 'dc-switcher__option', role: 'option', id: 'dc-option-' + index, 'aria-selected': 'false' }, [
          item.peer || item.saved ? avatar(item.peer, { size: 32, saved: item.saved }) : h('span', { class: 'dc-switcher__icon' }, [icon(item.glyph)]),
          h('span', { class: 'dc-switcher__text' }, [h('span', { class: 'dc-switcher__name' }, item.title), h('span', { class: 'dc-switcher__sub' }, item.subtitle)]),
          item.unread ? h('span', { class: 'vl-badge', 'aria-label': 'Непрочитанных: ' + item.unread }, String(item.unread)) : null
        ])
        node.addEventListener('pointermove', () => { selected = index; updateSelection() })
        node.addEventListener('click', () => { void activate(index) })
        return node
      })
      list.replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'dc-switcher__empty' }, [icon('magnifying-glass'), h('strong', {}, 'Ничего не найдено'), h('span', {}, 'Попробуй другое имя или название чата.')])]))
      status.textContent = 'Найдено: ' + results.length
      updateSelection()
    }
    input.addEventListener('input', () => render(true))
    close.addEventListener('click', closeSwitcher)
    currentDialog.addEventListener('click', event => {
      if (event.target !== currentDialog) return
      const rect = currentDialog.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSwitcher()
    })
    currentDialog.addEventListener('keydown', event => {
      if (event.isComposing) return
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target === input) {
        event.preventDefault(); selected = moveSelection(selected, event.key === 'ArrowDown' ? 1 : -1, results.length); updateSelection(true)
      } else if (event.key === 'Enter' && event.target === input) {
        event.preventDefault(); void activate(selected)
      }
      // Prevent underlying chat/call shortcuts from seeing dialog keystrokes.
      event.stopPropagation()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); closeSwitcher() }
    })
    currentDialog.addEventListener('close', () => {
      currentDialog.remove()
      if (dialog === currentDialog) { dialog = null; refreshDialog = null }
      if (!navigated && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }, { once: true })
    body.appendChild(currentDialog)
    refreshDialog = () => render()
    render(true)
    currentDialog.showModal()
    input.focus()
  }

  function renderRail() {
    const conversations = sortedConversations().slice(0, 8)
    const signature = JSON.stringify(conversations.map(conv => [conv.id, conv.type, conv.unread, displayName(conv.peer), conv.peer?.avatarUrl]))
    if (signature !== railSignature) {
      const focusedPath = railList.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null
      railSignature = signature
      railList.replaceChildren(...conversations.map(conv => {
        const saved = conv.type === 'saved'
        const name = saved ? 'Избранное' : displayName(conv.peer)
        const link = routeLink('/dm/' + conv.id, name, 'message', 'dc-rail__item dc-rail__dm')
        link.replaceChildren(avatar(conv.peer, { size: 40, saved }))
        if (conv.unread) link.appendChild(h('span', { class: 'dc-rail__badge', 'aria-label': 'Непрочитанных: ' + conv.unread }, String(Math.min(99, conv.unread))))
        return link
      }))
      if (focusedPath) [...railList.querySelectorAll('a')].find(link => link.getAttribute('href') === focusedPath)?.focus({ preventScroll: true })
    }
    for (const link of rail.querySelectorAll('a')) {
      const active = link.getAttribute('href') === location.pathname || (link.getAttribute('href') === '/lobby' && location.pathname.startsWith('/room/'))
      link.classList.toggle('is-active', active)
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current')
    }
    const conv = store.conversations.get(Number(location.pathname.match(/^\/dm\/(\d+)/)?.[1]))
    const label = conv ? conv.type === 'saved' ? 'Избранное' : displayName(conv.peer)
      : location.pathname.startsWith('/room/') ? 'Голосовой звонок' : location.pathname === '/lobby' ? 'Звонок по коду' : 'Друзья'
    if (routeLabel.textContent !== label) routeLabel.textContent = label
  }

  function enhanceMessages() {
    const id = store.activeConvId
    if (subscribedConversation !== id) {
      messageSubscription?.()
      subscribedConversation = id
      messageSubscription = id ? on('messages:' + id, schedule) : null
    }
    const chat = store.chats.get(id)
    if (!chat || !store.me) return
    const messages = new Map(chat.list.map(message => [message.id ? 'm' + message.id : 'c' + message.clientId, message]))
    for (const row of viewRoot.querySelectorAll('.vl-msg[data-key]')) {
      const message = messages.get(row.dataset.key)
      if (!message) continue
      const conv = store.conversations.get(id)
      const user = Number(message.authorId) === Number(store.me.id) ? store.me : store.users.get(Number(message.authorId)) || conv?.peer
      const name = displayName(user)
      const stamp = new Date(message.createdAt)
      const signature = JSON.stringify([id, name, user?.avatarUrl, message.createdAt])
      if (row.dataset.dcAuthor === signature) continue
      row.dataset.dcAuthor = signature
      row.classList.add('dc-message')
      row.querySelector(':scope > .dc-message__avatar')?.remove()
      row.querySelector(':scope > .dc-message__header')?.remove()
      const avatarNode = h('span', { class: 'dc-message__avatar' }, [avatar(user, { size: 40 })])
      const heading = h('div', { class: 'dc-message__header' }, [h('span', { class: 'dc-message__name' }, name),
        h('time', { datetime: stamp.toISOString(), title: stamp.toLocaleString('ru-RU'), class: 'dc-message__time' }, stamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))])
      row.prepend(avatarNode, heading)
    }
  }

  function sync() {
    frame = 0
    if (!ready()) {
      closeSwitcher()
      rail?.remove(); titlebar?.remove()
      rail = titlebar = railList = routeLabel = null
      railSignature = ''
      sidebar.querySelector('.dc-sidebar-tools')?.remove()
      messageSubscription?.(); messageSubscription = null; subscribedConversation = null; accountId = null
      return
    }
    if (accountId !== store.me.id) { closeSwitcher(); railSignature = ''; accountId = store.me.id }
    if (!rail) buildChrome()
    if (!sidebar.querySelector('.dc-sidebar-tools')) {
      const button = h('button', { type: 'button', class: 'dc-sidebar-search', 'aria-label': 'Быстрый переход к чату', 'aria-keyshortcuts': 'Control+k Meta+k' }, [
        h('span', {}, 'Найти или начать беседу'), h('kbd', {}, shortcut)
      ])
      button.addEventListener('click', openSwitcher)
      sidebar.prepend(h('div', { class: 'dc-sidebar-tools' }, [button]))
    }
    renderRail()
    enhanceMessages()
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync) }
  new MutationObserver(schedule).observe(body, { attributes: true, attributeFilter: ['class'] })
  new MutationObserver(schedule).observe(sidebar, { childList: true, subtree: true })
  // Ignore adapter-owned nodes so decorating a message never creates an observer loop.
  new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 &&
      (node.matches('.vl-msg, .vl-view') || node.querySelector('.vl-msg'))))) schedule()
  }).observe(viewRoot, { childList: true, subtree: true })
  for (const topic of ['me', 'friends', 'contacts', 'conversations', 'unread']) on(topic, () => { schedule(); refreshDialog?.() })
  window.addEventListener('popstate', schedule)
  window.addEventListener('vl:navigate', schedule)
  window.addEventListener('keydown', event => {
    if (!event.isComposing && !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && ready()) {
      event.preventDefault(); openSwitcher()
    }
  })
  // Ctrl+K remains available on mobile keyboards; mobile navigation keeps its existing routes.
  void isMobile
  schedule()
}
