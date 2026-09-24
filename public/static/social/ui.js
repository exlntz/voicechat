// ===================== Общие UI-хелперы оболочки «друзья и чаты» =====================

export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'style' && typeof v === 'object') {
      // CSS-переменные (--size) через Object.assign не ставятся — только setProperty
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, val)
        else node.style[prop] = val
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (v === true) node.setAttribute(k, '')
    else node.setAttribute(k, v)
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
  return node
}

export function icon(name, extra = '') {
  return h('i', { class: `fas fa-${name}${extra ? ' ' + extra : ''}`, 'aria-hidden': 'true' })
}

export function displayName(user) {
  return (user && (user.displayName || user.username)) || 'Пользователь'
}

// Инициалы и цвет аватара — постоянные для пользователя (цвет от id)
export function avatarColor(id) {
  const hue = (Number(id) * 47) % 360
  return `hsl(${hue} 42% 40%)`
}

export function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return String(name || '?').trim().slice(0, 2).toUpperCase()
}

// presence: {status: online|idle|dnd|offline, inCall}
export function avatar(user, { size = 32, presence = null } = {}) {
  const node = h('span', { class: 'vl-avatar', style: { '--size': size + 'px', background: avatarColor(user && user.id) }, 'aria-hidden': 'true' }, [
    h('span', { class: 'vl-avatar__txt' }, initialsOf(displayName(user)))
  ])
  if (presence) node.appendChild(h('span', { class: 'vl-presence', dataset: { status: presence.status || 'offline', call: presence.inCall ? '1' : '' } }))
  return node
}

export function setPresenceDot(avatarNode, presence) {
  const dot = avatarNode && avatarNode.querySelector('.vl-presence')
  if (!dot) return
  dot.dataset.status = (presence && presence.status) || 'offline'
  dot.dataset.call = presence && presence.inCall ? '1' : ''
}

export function presenceText(p) {
  if (!p || p.status === 'offline') return 'Не в сети'
  if (p.inCall) return 'В звонке'
  if (p.status === 'idle') return 'Отошёл'
  if (p.status === 'dnd') return 'Не беспокоить'
  return 'В сети'
}

// ---- Время ----
const pad = (n) => String(n).padStart(2, '0')
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
export function timeHM(ts) {
  const d = new Date(ts)
  return `${d.getHours()}:${pad(d.getMinutes())}`
}
export function timeLong(ts) {
  const d = new Date(ts)
  const now = new Date()
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return `Сегодня в ${timeHM(ts)}`
  if (sameDay(d, y)) return `Вчера в ${timeHM(ts)}`
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${timeHM(ts)}`
}
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
export function dayLabel(ts) {
  const d = new Date(ts)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`
}
export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
// Короткое время для списка слева: 14:05 / вчера / 12.09
export function timeShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return timeHM(ts)
  if (sameDay(d, y)) return 'вчера'
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
}

// ---- Текст сообщения: ссылки кликабельны, остальное — только текстовые узлы (никакого innerHTML) ----
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}»]/gi
export function richText(text) {
  const frag = document.createDocumentFragment()
  const str = String(text || '')
  let last = 0
  str.replace(URL_RE, (url, index) => {
    if (index > last) frag.appendChild(document.createTextNode(str.slice(last, index)))
    frag.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'vl-link' }, url))
    last = index + url.length
    return url
  })
  if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)))
  return frag
}

export function messagePreview(m) {
  if (!m) return ''
  if (m.kind === 'call') {
    const st = m.meta && m.meta.status
    if (st === 'missed') return 'Пропущенный звонок'
    if (st === 'declined') return 'Звонок отклонён'
    return 'Звонок'
  }
  return String(m.body || '').replace(/\s+/g, ' ').slice(0, 120)
}

export function uid() {
  try { if (crypto.randomUUID) return crypto.randomUUID() } catch {}
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

// ---- Модальное подтверждение (удалить сообщение, удалить из друзей) ----
export function confirmDialog({ title, text, confirmLabel = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement
    const cancel = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost' }, 'Отмена')
    const ok = h('button', { type: 'button', class: `vl-btn ${danger ? 'vl-btn--danger' : 'vl-btn--primary'}` }, confirmLabel)
    const card = h('div', { class: 'vl-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('h3', { class: 'vl-modal__title' }, title),
      text ? h('p', { class: 'vl-modal__text' }, text) : null,
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
      if (e.key === 'Escape') { e.preventDefault(); close(false) }
      if (e.key === 'Enter') { e.preventDefault(); close(true) }
    }
    cancel.addEventListener('click', () => close(false))
    ok.addEventListener('click', () => close(true))
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false) })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    ok.focus()
  })
}

// ---- Всплывающее меню (ПКМ по сообщению/другу, «…») ----
let openMenu = null
export function closeMenu() {
  if (!openMenu) return
  const m = openMenu
  openMenu = null
  m.remove()
}
// items: [{label, icon, danger, onClick}] | 'sep'
export function showMenu(items, anchor) {
  closeMenu()
  const menu = h('div', { class: 'vl-menu', role: 'menu' })
  for (const item of items) {
    if (!item) continue
    if (item === 'sep') { menu.appendChild(h('div', { class: 'vl-menu__sep' })); continue }
    const btn = h('button', { type: 'button', role: 'menuitem', class: `vl-menu__item${item.danger ? ' is-danger' : ''}` }, [
      h('span', {}, item.label), item.icon ? icon(item.icon) : null
    ])
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); item.onClick && item.onClick() })
    menu.appendChild(btn)
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  let x, y
  if (anchor && typeof anchor.clientX === 'number') { x = anchor.clientX; y = anchor.clientY } else {
    const r = anchor.getBoundingClientRect()
    x = r.right - rect.width; y = r.bottom + 6
  }
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
  if (y + rect.height > window.innerHeight - 8) y = Math.max(8, y - rect.height - (anchor.clientY != null ? 0 : 40))
  menu.style.left = x + 'px'
  menu.style.top = y + 'px'
  openMenu = menu
  const first = menu.querySelector('button')
  if (first) first.focus({ preventScroll: true })
  return menu
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu() }, true)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })
window.addEventListener('blur', closeMenu)
window.addEventListener('resize', closeMenu)

export function toast(message, type = 'info') {
  if (window.VL && typeof window.VL.showToast === 'function') window.VL.showToast(message, type)
}
