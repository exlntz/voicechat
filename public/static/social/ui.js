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

// ---- Иконки: свои тонкие линии (как микрофон и камера в звонке), имена — как у Font Awesome,
// чтобы вызовы icon('phone') не менять. Неизвестное имя — старый шрифтовой значок.
const PHONE = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z'
// Трубка «положить» — та же, что у кнопки «Выйти» в звонке (Material «call_end»), заливкой
const HANGUP = 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1 0-1.36C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.72c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85a1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z'
const USERS = '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
const ICONS = {
  xmark: '<path d="M18 6 6 18M6 6l12 12"/>',
  phone: `<path d="${PHONE}"/>`,
  'phone-slash': `<path fill="currentColor" stroke="none" d="${HANGUP}"/>`,
  'user-group': USERS + '<path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-plus': USERS + '<path d="M19 8v6M22 11h-6"/>',
  'user-minus': USERS + '<path d="M22 11h-6"/>',
  'user-check': USERS + '<path d="m16 11 2 2 4-4"/>',
  bars: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  'up-right-and-down-left-from-center': '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  'down-left-and-up-right-to-center': '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  'right-from-bracket': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'paper-plane': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  microphone: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  'microphone-slash': '<path d="m2 2 20 20M18.89 13.23A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3"/>',
  video: '<path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  'magnifying-glass': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  hashtag: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  'circle-xmark': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  'circle-exclamation': '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  'check-double': '<path d="M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'bell-slash': '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  circle: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  'circle-minus': '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  pen: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  'ellipsis-vertical': '<path stroke-width="3" d="M12 5h.01M12 12h.01M12 19h.01"/>',
  ellipsis: '<path stroke-width="3" d="M5 12h.01M12 12h.01M19 12h.01"/>',
  'hourglass-half': '<path d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  play: '<path fill="currentColor" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  thumbtack: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  'thumbtack-slash': '<path d="M12 17v5M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12"/>',
  share: '<path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  'circle-info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  waveform: '<path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/>'
}

export function icon(name, extra = '') {
  const body = ICONS[name]
  if (!body) return h('i', { class: `fas fa-${name}${extra ? ' ' + extra : ''}`, 'aria-hidden': 'true' })
  const t = document.createElement('template')
  // Разметка — только из таблицы выше (константы), пользовательский текст сюда не попадает
  t.innerHTML = `<svg class="vl-ico${extra ? ' ' + extra : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  return t.content.firstElementChild
}

// Своё имя для человека («контакт») важнее имени из его профиля — как в Телеграме
const contactNames = new Map() // userId -> имя, которое задал я
export function setContactName(userId, name) {
  if (name) contactNames.set(Number(userId), name)
  else contactNames.delete(Number(userId))
}
export function clearContactNames() { contactNames.clear() }
export function contactName(userId) { return contactNames.get(Number(userId)) || null }
export function displayName(user) {
  if (!user) return 'Пользователь'
  return contactNames.get(Number(user.id)) || user.displayName || user.username || 'Пользователь'
}
// Имя из профиля самого человека (без моего имени-контакта)
export function profileName(user) {
  return (user && (user.displayName || user.username)) || 'Пользователь'
}

// Аватары нейтральные: одна тёмная подложка для всех, синим — только вы (как в звонке, без радуги)
let selfId = 0
export function setSelfId(id) { selfId = Number(id) || 0 }
export function avatarColor(id) {
  return Number(id) && Number(id) === selfId ? '#0458cf' : '#2a303b'
}
// Для страницы — через переменные темы: в тёмной все подложки нейтральные, в светлой —
// мягкие пастельные, у каждого человека своя (по id), синим — только вы
function avatarFill(id) {
  const n = Number(id) || 0
  return n && n === selfId ? 'var(--accent)' : `var(--vl-ava-${n % 6})`
}

// Инициалы — только из букв и цифр, по целым символам (эмодзи «🎸» не разрезать пополам)
export function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).map((w) => Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch))).filter((w) => w.length)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).join('').toUpperCase()
  return Array.from(String(name || '?').trim())[0] || '?'
}

// presence: {status: online|idle|dnd|offline, inCall}
// Аватарка: картинка, если загружена, иначе инициалы. «Избранное» — закладка на синем.
export function avatar(user, { size = 32, presence = null, saved = false } = {}) {
  const url = user && user.avatarUrl
  const node = h('span', { class: `vl-avatar${url ? ' has-img' : ''}${saved ? ' is-saved' : ''}${saved || (user && Number(user.id) === selfId) ? ' is-self' : ''}`, style: { '--size': size + 'px', background: saved ? 'var(--accent)' : avatarFill(user && user.id) }, 'aria-hidden': 'true' }, [
    saved ? icon('bookmark') : h('span', { class: 'vl-avatar__txt' }, initialsOf(displayName(user)))
  ])
  if (url && !saved) {
    const img = h('img', { class: 'vl-avatar__img', src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' })
    img.addEventListener('error', () => { img.remove(); node.classList.remove('has-img') }, { once: true })
    node.appendChild(img)
  }
  if (presence) node.appendChild(h('span', { class: 'vl-presence', dataset: { status: presence.status || 'offline', call: presence.inCall ? '1' : '' } }))
  return node
}

// Фон профиля (картинка, GIF или видео) с выбранной рамкой: медиа растягивается так, чтобы
// рамка {x, y, w, h} (доли 0..1) ровно заняла полосу 3:1. Без рамки — по центру (cover).
export function bannerMedia(user) {
  const el = user.bannerKind === 'video'
    ? h('video', { src: user.bannerUrl, autoplay: true, muted: true, loop: true, playsinline: true, preload: 'auto' })
    : h('img', { src: user.bannerUrl, alt: '', draggable: 'false' })
  const c = user.bannerCrop
  if (c && c.w > 0 && c.h > 0) {
    el.classList.add('is-cropped')
    el.style.width = (100 / c.w) + '%'
    el.style.height = (100 / c.h) + '%'
    el.style.left = (-c.x / c.w * 100) + '%'
    el.style.top = (-c.y / c.h * 100) + '%'
  }
  if (el.tagName === 'VIDEO') { el.muted = true; el.play().catch(() => {}) }
  return el
}
export function bannerKey(user) {
  return user && user.bannerUrl ? user.bannerUrl + JSON.stringify(user.bannerCrop || null) : ''
}

// Имя чата и аватар: для «Избранного» — своё, для лички — собеседник
export function isSavedConv(conv) { return !!conv && conv.type === 'saved' }
export function convTitle(conv, peer) { return isSavedConv(conv) ? 'Избранное' : displayName(peer) }

export function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' Б'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' КБ'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',') + ' МБ'
  return (n / 1024 / 1024 / 1024).toFixed(1).replace('.', ',') + ' ГБ'
}
export function fmtClock(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

// Живые полоски «идёт звонок» (как индикатор в капсуле звонка)
export function waveBars(count = 4) {
  return h('span', { class: 'vl-wave', 'aria-hidden': 'true' }, Array.from({ length: count }, () => h('i')))
}

export function setPresenceDot(avatarNode, presence) {
  const dot = avatarNode && avatarNode.querySelector('.vl-presence')
  if (!dot) return
  dot.dataset.status = (presence && presence.status) || 'offline'
  dot.dataset.call = presence && presence.inCall ? '1' : ''
}

// Не в сети: «был(а) в сети 14:05», а если человек скрыл это в профиле — «был(а) недавно»
export function presenceText(p) {
  if (!p || p.status === 'offline') {
    if (p && p.hidden) return 'Был(а) недавно'
    if (p && p.lastSeen) return 'Был(а) в сети ' + lastSeenWhen(p.lastSeen)
    return 'Не в сети'
  }
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
function lastSeenWhen(ts) {
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return 'только что'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} мин. назад`
  const d = new Date(ts)
  const now = new Date()
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return `сегодня в ${timeHM(ts)}`
  if (sameDay(d, y)) return `вчера в ${timeHM(ts)}`
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
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
  const text = String(m.body || '').replace(/\s+/g, ' ').slice(0, 120)
  const first = m.attachments && m.attachments[0]
  if (!first) return text
  const label = ATTACH_LABEL[first.kind] || 'Файл'
  const what = first.kind === 'file' || first.kind === 'audio' ? first.name : label
  const n = m.attachments.length
  return (n > 1 ? `${label} ×${n}` : what) + (text ? ' · ' + text : '')
}
const ATTACH_LABEL = { image: 'Фото', video: 'Видео', voice: 'Голосовое сообщение', audio: 'Аудио', file: 'Файл' }
export function attachmentLabel(kind) { return ATTACH_LABEL[kind] || 'Файл' }

// ---- Галочки у своих сообщений, как в Телеграме ----
// ✓ — отправлено (на сервере, собеседник ещё не получил), ✓✓ — доставлено, синие ✓✓ — прочитано
export function msgStatus(conv, m, meId) {
  if (!conv || conv.type === 'saved' || !m || m.authorId !== meId || m.kind !== 'text' || m.failed) return null
  if (m.pending || !m.id) return 'pending'
  if (m.id <= (conv.peerLastReadId || 0)) return 'read'
  if (m.id <= (conv.peerLastDeliveredId || 0)) return 'delivered'
  return 'sent'
}
const TICK_TITLES = { sent: 'Отправлено', delivered: 'Доставлено', read: 'Прочитано' }
export function ticks(status, { still = false } = {}) {
  const t = document.createElement('template')
  // Вторая галочка всегда в разметке: при «доставлено» она дорисовывается (stroke-dashoffset)
  t.innerHTML = '<span class="vl-ticks"><svg viewBox="0 0 18 12" aria-hidden="true" focusable="false"><path class="t1" d="M1.4 6.4l3.3 3.3L11 3.2"/><path class="t2" d="M8.2 9l.7.7 6.4-6.5"/></svg></span>'
  const node = t.content.firstElementChild
  setTicks(node, status)
  if (still) node.classList.add('is-still')
  return node
}
export function setTicks(node, status) {
  if (!node || node.dataset.st === status) return false
  const prev = node.dataset.st
  node.dataset.st = status
  node.title = TICK_TITLES[status] || ''
  node.setAttribute('aria-label', node.title)
  // Стало «прочитано» — лёгкий «пульс»
  if (prev && status === 'read') { node.classList.remove('is-bump'); void node.offsetWidth; node.classList.add('is-bump') }
  return true
}

// ---- Заливка от курсора, как у кнопок звонка (anker.js) ----
// При наведении мышью из точки входа вырастает круг цвета наведения (--ank-fill в social.css)
// и заполняет кнопку; при уходе сжимается в точку выхода. Один делегированный обработчик на
// весь документ — не нужно навешивать его на каждую кнопку при каждой перерисовке.
const FILL_SEL = [
  '.vl-round', '.vl-btn', '.vl-pill', '.vl-chip', '.vl-dm:not(.is-skeleton)', '.vl-me__btn', '.vl-composer__send', '.vl-composer__attach',
  '.vl-menu__item', '.vl-picker__row', '.vl-search__row', '.vl-friend:not(.is-skeleton)', '.vl-tile:not(.is-skeleton)', '.settings-nav__item',
  '.vl-call-btn', '.vl-jump', '.vl-solo-chats', '.vl-side__call', '.vl-voice__btn', '.vl-quote', '.vl-filecard', '.vl-ucard__when',
  '.vl-ucard__link', '.vl-pinbar__body', '.vl-fwd', '.vl-tray__x', '.vl-wall-tile__bg', '.vl-side__search-x'
].join(',')
const FILL_MS = 420
export function initHoverFill() {
  if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const state = new WeakMap()
  function ensure(el) {
    let st = state.get(el)
    if (!st) {
      const wrap = document.createElement('span')
      wrap.className = 'ank-fill'
      wrap.setAttribute('aria-hidden', 'true')
      const dot = document.createElement('span')
      dot.className = 'ank-fill__dot'
      wrap.appendChild(dot)
      st = { wrap, dot, t0: 0 }
      state.set(el, st)
    }
    // Узел мог перерисоваться (replaceChildren) — вернуть заливку на место
    if (st.wrap.parentNode !== el) el.insertBefore(st.wrap, el.firstChild)
    // У кнопок с position: absolute/fixed (плавающие) позицию не трогаем
    el.classList.add(getComputedStyle(el).position === 'static' ? 'has-fill' : 'has-fill-keep')
    return st
  }
  function place(el, st, e) {
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const rad = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y)) + 2
    st.dot.style.left = (x - rad).toFixed(1) + 'px'
    st.dot.style.top = (y - rad).toFixed(1) + 'px'
    st.dot.style.width = st.dot.style.height = (rad * 2).toFixed(1) + 'px'
  }
  function jump(st, scale) {
    st.dot.classList.add('is-instant')
    st.dot.style.transform = `scale(${scale})`
    void st.dot.offsetWidth
    st.dot.classList.remove('is-instant')
  }
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return
    const el = e.target.closest && e.target.closest(FILL_SEL)
    if (!el || el.disabled || (e.relatedTarget && el.contains(e.relatedTarget))) return
    const st = ensure(el)
    place(el, st, e)
    jump(st, 0)
    st.dot.style.transform = 'scale(1)'
    st.t0 = performance.now()
  }, { passive: true, capture: true })
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return
    const el = e.target.closest && e.target.closest(FILL_SEL)
    if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return
    const st = state.get(el)
    if (!st) return
    // Круг уже залил кнопку — переносим центр в точку выхода и сжимаем туда
    if (performance.now() - st.t0 >= FILL_MS) { place(el, st, e); jump(st, 1) }
    st.dot.style.transform = 'scale(0)'
  }, { passive: true, capture: true })
}

// ---- Телефон ----
// На узком экране список чатов — отдельный главный экран (/chats), как в Телеграме
const MOBILE_MQ = typeof matchMedia === 'function' ? matchMedia('(max-width: 860px)') : null
export function isMobile() { return !!(MOBILE_MQ && MOBILE_MQ.matches) }
export function onMobileChange(fn) { if (MOBILE_MQ && MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', fn) }
export function homePath() { return isMobile() ? '/chats' : '/friends' }

// Долгое нажатие пальцем — то же, что ПКМ на компьютере (на iPhone события contextmenu нет).
// Срабатывает через 450 мс, если палец не сдвинулся; следующий «клик» после него гасится.
export function onLongPress(el, fn) {
  let timer = 0
  let start = null
  let fired = 0
  const cancel = () => { clearTimeout(timer); timer = 0; start = null }
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { cancel(); return }
    const t = e.touches[0]
    start = { x: t.clientX, y: t.clientY, target: e.target }
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = 0
      if (!start) return
      fired = Date.now()
      try { if (navigator.vibrate) navigator.vibrate(12) } catch {}
      fn({ clientX: start.x, clientY: start.y, target: start.target, preventDefault() {} })
    }, 450)
  }, { passive: true })
  el.addEventListener('touchmove', (e) => {
    if (!start) return
    const t = e.touches[0]
    if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) cancel()
  }, { passive: true })
  el.addEventListener('touchend', (e) => { if (Date.now() - fired < 600) e.preventDefault(); cancel() })
  el.addEventListener('touchcancel', cancel, { passive: true })
  // Android сам шлёт contextmenu после долгого нажатия — второе меню не нужно
  el.addEventListener('contextmenu', (e) => { if (Date.now() - fired < 1000) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
  el.addEventListener('click', (e) => { if (Date.now() - fired < 600) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
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

// ---------- Тема оформления (на этом устройстве) ----------
// 'light' | 'dark' | 'system', по умолчанию тёмная. Атрибут data-theme ставит ещё скрипт в <head> — здесь только смена.
export function getThemeChoice() {
  try { return localStorage.getItem('vl:theme') || 'dark' } catch { return 'dark' }
}
function resolveTheme(choice) {
  if (choice === 'system') return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  return choice === 'light' ? 'light' : 'dark'
}
export function applyTheme(choice = getThemeChoice()) {
  const t = resolveTheme(choice)
  const root = document.documentElement
  root.dataset.theme = t
  root.style.colorScheme = t
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = t === 'light' ? '#eef1f4' : '#0f1115'
  window.dispatchEvent(new CustomEvent('vl-theme', { detail: t }))
}
export function setThemeChoice(choice) {
  try { localStorage.setItem('vl:theme', choice) } catch {}
  applyTheme(choice)
}
// Для app.js (настройки звонка): тот же выбор темы
if (window.VL) Object.assign(window.VL, { getThemeChoice, setThemeChoice })

// ---- Настройки этого устройства (localStorage 'vl:*'): размер текста в чатах, имена на плитках, звук входящего ----
export function getPref(key, def) {
  try { const v = localStorage.getItem('vl:' + key); return v == null ? def : v } catch { return def }
}
export function setPref(key, value) {
  try { localStorage.setItem('vl:' + key, String(value)) } catch {}
  applyPrefs()
}
export const CHAT_FONT_SIZES = { s: 13, m: 15, l: 17 }
export function applyPrefs() {
  const root = document.documentElement
  root.style.setProperty('--vl-msg-size', (CHAT_FONT_SIZES[getPref('chatFont', 'm')] || 15) + 'px')
  root.classList.toggle('vl-hide-tile-names', getPref('tileNames', '1') === '0')
}
applyPrefs()
if (window.VL) Object.assign(window.VL, { getPref, setPref })
// «Как в системе»: переключаемся вместе с системой
if (window.matchMedia) {
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const onSys = () => { if (getThemeChoice() === 'system') applyTheme('system') }
  if (mq.addEventListener) mq.addEventListener('change', onSys)
}

