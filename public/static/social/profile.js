// ===================== Профиль: оформление и конфиденциальность =====================
// Открывается по нажатию на своё имя внизу слева. Устроено как «Настройки» в звонке:
// слева разделы, справа карточки (те же классы settings-*, одно оформление на весь сайт).
import { api } from './api.js'
import { store, updateUser } from './store.js'
import { h, icon, avatar, displayName, toast } from './ui.js'
import { uploadFile, squareAvatar, prepareImage, probeMedia } from './upload.js'

let current = null // открытое окно

export function closeProfile() {
  if (!current) return
  const { overlay, onKey } = current
  current = null
  document.removeEventListener('keydown', onKey, true)
  overlay.classList.add('is-closing')
  const drop = () => overlay.remove()
  overlay.addEventListener('animationend', drop, { once: true })
  setTimeout(drop, 400)
}

export function openProfile({ logout }) {
  if (current) { closeProfile(); return }
  let settings = { showLastSeen: true }

  const closeBtn = h('button', { type: 'button', class: 'vl-round is-ghost', 'aria-label': 'Закрыть профиль' }, [icon('xmark')])
  closeBtn.addEventListener('click', closeProfile)
  const body = h('div', { class: 'settings-body' })
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Разделы профиля' })

  const SECTIONS = [
    { id: 'look', title: 'Оформление', icon: 'pen', build: buildLook },
    { id: 'privacy', title: 'Конфиденциальность', icon: 'ban', build: buildPrivacy }
  ]
  const navButtons = new Map()
  function show(id) {
    const sec = SECTIONS.find((s) => s.id === id) || SECTIONS[0]
    navButtons.forEach((b, key) => { b.classList.toggle('active', key === sec.id); b.setAttribute('aria-current', key === sec.id ? 'page' : 'false') })
    body.replaceChildren(h('h4', { class: 'settings-section-title' }, sec.title), ...sec.build())
  }
  nav.appendChild(h('div', { class: 'settings-nav__group' }, 'Аккаунт'))
  for (const sec of SECTIONS) {
    const b = h('button', { type: 'button', class: 'settings-nav__item' }, [icon(sec.icon), sec.title])
    b.addEventListener('click', () => show(sec.id))
    navButtons.set(sec.id, b)
    nav.appendChild(b)
  }
  const logoutBtn = h('button', { type: 'button', class: 'settings-nav__item is-danger' }, [icon('right-from-bracket'), 'Выйти из аккаунта'])
  logoutBtn.addEventListener('click', () => { closeProfile(); logout() })
  nav.appendChild(h('div', { class: 'settings-nav__spacer' }))
  nav.appendChild(logoutBtn)

  const sheet = h('div', { class: 'settings-sheet vl-profile', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Профиль' }, [
    h('div', { class: 'settings-head' }, [h('h3', {}, 'Профиль'), closeBtn]),
    h('div', { class: 'settings-layout' }, [nav, body])
  ])
  const overlay = h('div', { class: 'settings-overlay vl-profile-overlay' }, [sheet])
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeProfile() })
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeProfile() } }
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  current = { overlay, onKey }
  show('look')

  api.get('/api/profile').then((p) => {
    if (!p) return
    settings = p.settings
    if (p.user) updateUser(p.user)
    const active = [...navButtons.entries()].find(([, b]) => b.classList.contains('active'))
    if (active && current && current.overlay === overlay) show(active[0])
  }).catch(() => {})

  // ---------- Оформление: аватарка, фон, юзернейм ----------
  function buildLook() {
    const me = store.me
    // Превью — как профиль видят друзья: фон (картинка, GIF или видео) и аватарка на нём
    const bannerBox = h('div', { class: 'vl-pcard__banner' })
    const avaBox = h('div', { class: 'vl-pcard__ava' })
    const preview = h('div', { class: 'settings-card vl-pcard' }, [
      bannerBox,
      h('div', { class: 'vl-pcard__row' }, [
        avaBox,
        h('div', { class: 'vl-profile-card__text' }, [
          h('div', { class: 'vl-profile-card__name' }, displayName(me)),
          h('div', { class: 'vl-profile-card__user' }, '@' + me.username)
        ])
      ])
    ])
    function paintPreview() {
      const u = store.me
      avaBox.replaceChildren(avatar(u, { size: 72 }))
      if (u.bannerUrl) {
        if (bannerBox.dataset.src !== u.bannerUrl) {
          bannerBox.dataset.src = u.bannerUrl
          bannerBox.replaceChildren(u.bannerKind === 'video'
            ? h('video', { src: u.bannerUrl, autoplay: true, muted: true, loop: true, playsinline: true })
            : h('img', { src: u.bannerUrl, alt: '' }))
          const v = bannerBox.querySelector('video')
          if (v) { v.muted = true; v.play().catch(() => {}) }
        }
      } else { bannerBox.replaceChildren(); delete bannerBox.dataset.src }
      bannerBox.classList.toggle('has-media', !!u.bannerUrl)
      removeAva.hidden = !u.avatarUrl
      removeBanner.hidden = !u.bannerUrl
    }

    const mediaStatus = h('div', { class: 'vl-fld-status', role: 'status' })
    const avaInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true })
    const bannerInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime', hidden: true })
    const pickAva = h('button', { type: 'button', class: 'vl-btn vl-btn--soft vl-btn--pill vl-btn--sm' }, [icon('camera'), 'Аватарка'])
    const pickBanner = h('button', { type: 'button', class: 'vl-btn vl-btn--soft vl-btn--pill vl-btn--sm' }, [icon('image'), 'Фон'])
    const removeAva = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost-text vl-btn--sm' }, 'Убрать аватарку')
    const removeBanner = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost-text vl-btn--sm' }, 'Убрать фон')
    pickAva.addEventListener('click', () => avaInput.click())
    pickBanner.addEventListener('click', () => bannerInput.click())
    const setMediaStatus = (text, kind) => { mediaStatus.textContent = text; mediaStatus.className = 'vl-fld-status' + (kind ? ' is-' + kind : '') }
    async function upload(purpose, raw) {
      pickAva.disabled = pickBanner.disabled = true
      setMediaStatus('Загружаем…', '')
      try {
        let file = raw
        let meta = {}
        if (purpose === 'avatar') {
          if (raw.size > 20 * 1024 * 1024) throw new Error('Картинка больше 20 МБ')
          file = await squareAvatar(raw)
          if (file.size > 5 * 1024 * 1024) throw new Error('GIF-аватарка больше 5 МБ')
        } else if (raw.type.startsWith('video/')) {
          if (raw.size > 30 * 1024 * 1024) throw new Error('Видео для фона — до 30 МБ')
          meta = await probeMedia(raw)
        } else {
          const prepared = await prepareImage(raw, { maxSide: 1920 })
          file = prepared.file
          meta = prepared.meta
          if (file.size > 30 * 1024 * 1024) throw new Error('Файл для фона — до 30 МБ')
        }
        await uploadFile(file, { purpose, meta, onProgress: (p) => setMediaStatus(`Загружаем… ${Math.round(p * 100)}%`, '') })
        const r = await api.get('/api/profile')
        if (r && r.user) updateUser(r.user)
        setMediaStatus(purpose === 'avatar' ? 'Аватарка обновлена' : 'Фон обновлён', 'ok')
        paintPreview()
      } catch (e) {
        setMediaStatus(e.message, 'err')
      } finally {
        pickAva.disabled = pickBanner.disabled = false
      }
    }
    avaInput.addEventListener('change', () => { const f = avaInput.files[0]; avaInput.value = ''; if (f) upload('avatar', f) })
    bannerInput.addEventListener('change', () => { const f = bannerInput.files[0]; bannerInput.value = ''; if (f) upload('banner', f) })
    async function removeMedia(what) {
      try {
        const r = await api.del('/api/profile/' + what)
        if (r && r.user) updateUser(r.user)
        paintPreview()
      } catch (e) { toast(e.message, 'error') }
    }
    removeAva.addEventListener('click', () => removeMedia('avatar'))
    removeBanner.addEventListener('click', () => removeMedia('banner'))
    const mediaCard = h('div', { class: 'settings-card' }, [
      h('div', { class: 'settings-card-head' }, [h('span', { class: 'settings-card-title' }, [icon('image'), 'Аватарка и фон'])]),
      h('p', { class: 'settings-card-note' }, 'Фон — картинка, GIF или короткое видео (до 30 МБ): друзья увидят его в вашем профиле. Видео играет без звука по кругу.'),
      h('div', { class: 'vl-pcard__actions' }, [pickAva, pickBanner, removeAva, removeBanner]),
      mediaStatus, avaInput, bannerInput
    ])
    paintPreview()

    const input = h('input', { type: 'text', placeholder: 'Новый юзернейм', maxlength: '25', autocomplete: 'off', spellcheck: 'false' })
    input.value = '@' + me.username
    if (window.VL.atPrefixField) window.VL.atPrefixField(input)
    const status = h('div', { class: 'vl-fld-status', role: 'status' })
    const save = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--pill', disabled: true }, 'Сохранить')
    const card = h('div', { class: 'settings-card' }, [
      h('div', { class: 'settings-card-head' }, [h('span', { class: 'settings-card-title' }, [icon('at'), 'Юзернейм'])]),
      h('p', { class: 'settings-card-note' }, 'По нему вас находят друзья и по нему вы входите в аккаунт.'),
      h('div', { class: 'vl-fld-host' }, [input]),
      status,
      h('div', { class: 'settings-card-actions' }, [save])
    ])

    let timer = 0
    let lastChecked = ''
    let okToSave = false
    const setStatus = (text, kind) => {
      status.textContent = text
      status.className = 'vl-fld-status' + (kind ? ' is-' + kind : '')
    }
    function wanted() { return input.value.replace(/^@+/, '').trim() }
    function refresh() {
      const name = wanted()
      okToSave = false
      save.disabled = true
      clearTimeout(timer)
      if (!name || name === store.me.username) { setStatus('', ''); return }
      setStatus('Проверяем…', '')
      timer = setTimeout(async () => {
        lastChecked = name
        try {
          const r = await api.get('/api/users/check?username=' + encodeURIComponent(name))
          if (wanted() !== lastChecked) return
          if (!r.valid) setStatus(r.message, 'err')
          else if (!r.available) setStatus(r.message, 'err')
          else { setStatus('Свободен', 'ok'); okToSave = true; save.disabled = false }
        } catch (e) { setStatus(e.message, 'err') }
      }, 350)
    }
    input.addEventListener('input', refresh)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && okToSave) save.click() })
    save.addEventListener('click', async () => {
      if (!okToSave) return
      save.disabled = true
      try {
        const p = await api.patch('/api/profile', { username: wanted() })
        updateUser(p.user)
        setStatus('Юзернейм изменён', 'ok')
        toast('Юзернейм изменён', 'success')
        preview.querySelector('.vl-profile-card__user').textContent = '@' + p.user.username
        okToSave = false
      } catch (e) {
        setStatus(e.message, 'err')
        save.disabled = false
      }
    })
    return [preview, mediaCard, card]
  }

  // ---------- Конфиденциальность: «был в сети» ----------
  function buildPrivacy() {
    const toggle = h('input', { type: 'checkbox', role: 'switch' })
    toggle.checked = settings.showLastSeen !== false
    const note = h('p', { class: 'settings-card-note' })
    const setNote = () => {
      note.textContent = toggle.checked
        ? 'Друзья видят, когда вы были в сети: «был(а) в сети сегодня в 14:05».'
        : 'Друзья видят только «был(а) недавно», без точного времени.'
    }
    setNote()
    toggle.addEventListener('change', async () => {
      setNote()
      try {
        const p = await api.patch('/api/profile', { showLastSeen: toggle.checked })
        settings = p.settings
      } catch (e) {
        toggle.checked = !toggle.checked
        setNote()
        toast(e.message, 'error')
      }
    })
    const row = h('label', { class: 'settings-row settings-row--first' }, [
      h('span', { class: 'settings-row__text' }, 'Показывать, когда я был(а) в сети'),
      h('span', { class: 'switch' }, [toggle, h('span', { class: 'switch__track', 'aria-hidden': 'true' })])
    ])
    return [h('div', { class: 'settings-card' }, [
      h('div', { class: 'settings-card-head' }, [h('span', { class: 'settings-card-title' }, [icon('clock'), 'Время в сети'])]),
      row,
      note
    ])]
  }
}
