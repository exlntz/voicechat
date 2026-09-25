// ===================== Профиль собеседника: фон, аватарка, вкладки медиа/файлы/голосовые/ссылки =====================
// Как в Дискорде: сверху фон (картинка, GIF или беззвучное зацикленное видео), на нём аватарка;
// ниже — как в Телеграме: всё, чем вы обменялись в личке, по вкладкам.
import { api } from './api.js'
import { store, userById, presenceOf, dmWith, rememberUser } from './store.js'
import { h, icon, avatar, displayName, presenceText, timeShort, dayLabel, fmtClock, bannerMedia, bannerKey } from './ui.js'
import { voicePlayer, fileCard, openLightbox } from './media-ui.js'

let current = null

export function closeUserCard() {
  if (!current) return
  const { overlay, onKey } = current
  current = null
  document.removeEventListener('keydown', onKey, true)
  overlay.querySelectorAll('video').forEach((v) => v.pause())
  overlay.classList.add('is-leaving')
  setTimeout(() => overlay.remove(), 180)
}

const TABS = [
  { id: 'media', title: 'Медиа', icon: 'image', empty: 'Здесь будут фото и видео из переписки' },
  { id: 'files', title: 'Файлы', icon: 'file', empty: 'Здесь будут файлы из переписки' },
  { id: 'voice', title: 'Голосовые', icon: 'microphone', empty: 'Здесь будут голосовые сообщения' },
  { id: 'links', title: 'Ссылки', icon: 'link', empty: 'Здесь будут ссылки из переписки' }
]

// userId — чей профиль; convId — личка с ним (для вкладок). saved — «Избранное».
export function openUserCard({ userId = 0, convId = 0, saved = false, onMessage, onCall, onJump }) {
  closeUserCard()
  let user = saved ? store.me : (userById(userId) || { id: userId, username: '', displayName: 'Пользователь' })
  if (!convId && !saved && userId) { const c = dmWith(userId); if (c) convId = c.id }

  const banner = h('div', { class: 'vl-ucard__banner' })
  const avaSlot = h('div', { class: 'vl-ucard__ava' })
  const name = h('h2', { class: 'vl-ucard__name' })
  const uname = h('div', { class: 'vl-ucard__user' })
  const status = h('div', { class: 'vl-ucard__status' })
  const since = h('div', { class: 'vl-ucard__since', hidden: true })
  const close = h('button', { type: 'button', class: 'vl-round is-glass is-sm vl-ucard__close', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const actions = h('div', { class: 'vl-ucard__actions' })
  const tabsBar = h('div', { class: 'vl-ucard__tabs', role: 'tablist' })
  const pane = h('div', { class: 'vl-ucard__pane' })
  const card = h('div', { class: `vl-ucard${saved ? ' is-saved' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Профиль' }, [
    banner, close,
    h('div', { class: 'vl-ucard__head' }, [avaSlot, h('div', { class: 'vl-ucard__who' }, [name, uname, status, since]), actions]),
    convId ? tabsBar : null,
    convId ? pane : null
  ])
  const overlay = h('div', { class: 'vl-modal-overlay vl-ucard-overlay' }, [card])

  function renderHead() {
    const hasBanner = !saved && user.bannerUrl
    banner.classList.toggle('has-media', !!hasBanner)
    if (hasBanner) {
      const key = bannerKey(user)
      if (banner.dataset.src !== key) {
        banner.dataset.src = key
        banner.replaceChildren(bannerMedia(user))
      }
    } else { banner.replaceChildren(); delete banner.dataset.src }
    avaSlot.replaceChildren(avatar(user, { size: 96, presence: saved ? null : presenceOf(user.id), saved }))
    avaSlot.classList.toggle('is-openable', !saved && !!user.avatarUrl)
    banner.classList.toggle('is-openable', !!hasBanner)
    name.textContent = saved ? 'Избранное' : displayName(user)
    uname.textContent = saved ? 'Заметки, файлы и пересланное — только для вас' : '@' + user.username
    status.textContent = saved ? '' : presenceText(presenceOf(user.id))
    status.hidden = saved
  }

  if (!saved) {
    const msg = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--pill vl-btn--sm' }, [icon('message'), 'Написать'])
    const call = h('button', { type: 'button', class: 'vl-round is-sm', title: 'Позвонить', 'aria-label': 'Позвонить' }, [icon('phone')])
    msg.addEventListener('click', () => { closeUserCard(); onMessage && onMessage(user.id) })
    call.addEventListener('click', () => { closeUserCard(); onCall && onCall(user.id) })
    actions.append(msg, call)
  }

  // ---------- Вкладки ----------
  const state = { tab: 'media', items: [], next: null, loading: false }
  const tabButtons = new Map()
  for (const t of TABS) {
    const b = h('button', { type: 'button', role: 'tab', class: 'vl-chip' }, [icon(t.icon), t.title])
    b.addEventListener('click', () => setTab(t.id))
    tabButtons.set(t.id, b)
    tabsBar.appendChild(b)
  }
  function setTab(id) {
    state.tab = id
    state.items = []
    state.next = null
    tabButtons.forEach((b, key) => { b.classList.toggle('is-active', key === id); b.setAttribute('aria-selected', key === id ? 'true' : 'false') })
    pane.replaceChildren(h('div', { class: 'vl-ucard__loading' }, [h('span', { class: 'vl-spinner' })]))
    load()
  }
  async function load() {
    if (state.loading) return
    state.loading = true
    const tab = state.tab
    try {
      const qs = new URLSearchParams({ type: tab })
      if (state.next) qs.set('before', state.next)
      const data = await api.get(`/api/conversations/${convId}/media?${qs}`)
      if (tab !== state.tab || !current) return
      state.items.push(...data.items)
      state.next = data.next
      renderPane()
    } catch (e) {
      if (tab === state.tab) pane.replaceChildren(h('div', { class: 'vl-ucard__empty' }, e.message))
    } finally {
      state.loading = false
    }
  }
  function renderPane() {
    const t = TABS.find((x) => x.id === state.tab)
    if (!state.items.length) {
      pane.replaceChildren(h('div', { class: 'vl-ucard__empty' }, [h('span', { class: 'vl-empty__icon' }, [icon(t.icon)]), h('p', {}, t.empty)]))
      return
    }
    let body
    if (state.tab === 'media') {
      const files = state.items.map((it) => it.file)
      body = h('div', { class: 'vl-ucard__grid' }, state.items.map((it, i) => {
        const f = it.file
        const cell = h('button', { type: 'button', class: 'vl-ucard__cell', 'aria-label': f.kind === 'video' ? 'Видео' : 'Фото' }, [
          f.kind === 'video' ? h('video', { src: f.url + '#t=0.1', muted: true, playsinline: true, preload: 'metadata' }) : h('img', { src: f.url, alt: '', loading: 'lazy', decoding: 'async' }),
          f.kind === 'video' ? h('span', { class: 'vl-media-cell__dur' }, [icon('play'), f.meta && f.meta.duration ? fmtClock(f.meta.duration) : '']) : null
        ])
        cell.addEventListener('click', () => openLightbox(files, i))
        return cell
      }))
    } else if (state.tab === 'files') {
      body = h('div', { class: 'vl-ucard__list' }, state.items.map((it) => h('div', { class: 'vl-ucard__row' }, [fileCard(it.file), jumpBtn(it, timeShort(it.createdAt))])))
    } else if (state.tab === 'voice') {
      body = h('div', { class: 'vl-ucard__list' }, state.items.map((it) => h('div', { class: 'vl-ucard__row' }, [
        h('div', { class: 'vl-ucard__voice' }, [h('span', { class: 'vl-ucard__by' }, it.authorId === store.me.id ? 'Вы' : displayName(userById(it.authorId))), voicePlayer(it.file)]),
        jumpBtn(it, timeShort(it.createdAt))
      ])))
    } else {
      body = h('div', { class: 'vl-ucard__list' }, state.items.map((it) => {
        let host = it.url
        try { host = new URL(it.url).hostname.replace(/^www\./, '') } catch {}
        return h('div', { class: 'vl-ucard__row' }, [
          h('a', { class: 'vl-ucard__link', href: it.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, [
            h('span', { class: 'vl-ucard__link-ico' }, host.slice(0, 1).toUpperCase()),
            h('span', { class: 'vl-ucard__link-text' }, [h('b', {}, host), h('span', {}, it.url)])
          ]),
          jumpBtn(it, timeShort(it.createdAt))
        ])
      }))
    }
    const nodes = [body]
    if (state.next) {
      const more = h('button', { type: 'button', class: 'vl-btn vl-btn--soft vl-btn--pill vl-btn--sm vl-ucard__more' }, 'Показать ещё')
      more.addEventListener('click', () => { more.disabled = true; load() })
      nodes.push(more)
    }
    pane.replaceChildren(...nodes)
  }
  // «Показать в чате» — дата-кнопка справа от элемента
  function jumpBtn(it, label) {
    const b = h('button', { type: 'button', class: 'vl-ucard__when', title: 'Показать в чате · ' + dayLabel(it.createdAt) }, label)
    b.addEventListener('click', () => { closeUserCard(); onJump && onJump(convId, it.messageId) })
    return b
  }

  // Нажатие на аватарку или фон — открыть целиком
  avaSlot.addEventListener('click', () => { if (!saved && user.avatarUrl) openLightbox([{ kind: 'image', url: user.avatarUrl, name: 'avatar' }]) })
  banner.addEventListener('click', () => { if (!saved && user.bannerUrl) openLightbox([{ kind: user.bannerKind === 'video' ? 'video' : 'image', url: user.bannerUrl, name: 'banner' }]) })
  // Esc при открытом просмотре закрывает только просмотр
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.vl-lightbox')) { e.preventDefault(); e.stopPropagation(); closeUserCard() } }
  close.addEventListener('click', closeUserCard)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeUserCard() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  current = { overlay, onKey }
  renderHead()
  if (convId) setTab('media')

  // Свежие данные: аватарка/фон могли смениться, «в друзьях с …»
  if (!saved && userId) {
    api.get('/api/users/' + userId).then((r) => {
      if (!current || current.overlay !== overlay) return
      user = r.user
      rememberUser(user)
      if (r.since) { since.hidden = false; since.textContent = 'В друзьях с ' + dayLabel(r.since).replace(/ г\.$/, '') }
      renderHead()
    }).catch(() => {})
  }
  close.focus({ preventScroll: true })
  return { close: closeUserCard }
}
