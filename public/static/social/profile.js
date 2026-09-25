// ===================== Профиль: оформление и конфиденциальность =====================
// Открывается по нажатию на своё имя внизу слева. Устроено как «Настройки» в звонке:
// слева разделы, справа карточки (те же классы settings-*, одно оформление на весь сайт).
import { api } from './api.js'
import { store, updateUser } from './store.js'
import { h, icon, avatar, displayName, toast, bannerMedia, bannerKey, getThemeChoice, setThemeChoice } from './ui.js'
import { uploadFile } from './upload.js'
import { openLightbox } from './media-ui.js'
import { cropAvatar, cropBanner } from './crop.js'
import { pushSupported, needsHomeScreen, pushEnabled, enablePush, disablePush } from './push.js'
import { requestNotificationPermission } from './notify.js'

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
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.vl-lightbox, .vl-crop-overlay')) { e.preventDefault(); closeProfile() } }
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
      avaBox.classList.toggle('is-openable', !!u.avatarUrl)
      if (u.bannerUrl) {
        if (bannerBox.dataset.src !== bannerKey(u)) {
          bannerBox.dataset.src = bannerKey(u)
          bannerBox.replaceChildren(bannerMedia(u))
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
    avaBox.addEventListener('click', () => { const u = store.me; if (u.avatarUrl) openLightbox([{ kind: 'image', url: u.avatarUrl, name: 'avatar' }]) })
    bannerBox.addEventListener('click', () => { const u = store.me; if (u.bannerUrl) openLightbox([{ kind: u.bannerKind === 'video' ? 'video' : 'image', url: u.bannerUrl, name: 'banner' }]) })
    pickBanner.addEventListener('click', () => bannerInput.click())
    const setMediaStatus = (text, kind) => { mediaStatus.textContent = text; mediaStatus.className = 'vl-fld-status' + (kind ? ' is-' + kind : '') }
    async function upload(purpose, raw) {
      // Аватарка: сначала выбрать область под кружком (GIF остаётся живым, без обрезки)
      if (purpose === 'avatar' && raw.type !== 'image/gif') {
        if (raw.size > 20 * 1024 * 1024) { setMediaStatus('Картинка больше 20 МБ', 'err'); return }
        try {
          raw = await cropAvatar(raw)
        } catch (e) { setMediaStatus(e.message, 'err'); return }
        if (!raw) return // «Отмена»
      }
      // Фон: выбрать полосу 3:1 — картинка вырезается, у видео и GIF запоминается рамка
      let bannerPicked = null
      if (purpose === 'banner') {
        if (raw.size > 30 * 1024 * 1024) { setMediaStatus('Файл для фона — до 30 МБ', 'err'); return }
        try {
          bannerPicked = await cropBanner(raw)
        } catch (e) { setMediaStatus(e.message, 'err'); return }
        if (!bannerPicked) return // «Отмена»
      }
      pickAva.disabled = pickBanner.disabled = true
      setMediaStatus('Загружаем…', '')
      try {
        let file = raw
        let meta = {}
        if (purpose === 'avatar') {
          // Уже вырезана в cropAvatar (квадрат до 1024 px); GIF — как есть
          if (file.size > 5 * 1024 * 1024) throw new Error('GIF-аватарка больше 5 МБ')
        } else {
          file = bannerPicked.file
          meta = { ...bannerPicked.meta }
          if (bannerPicked.crop) meta.crop = bannerPicked.crop
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
    // Тема: светлая, тёмная или как в системе — хранится на этом устройстве
    const themeRow = h('div', { class: 'vl-theme-pick', role: 'radiogroup', 'aria-label': 'Тема' })
    const THEMES = [['light', 'sun', 'Светлая'], ['dark', 'moon', 'Тёмная'], ['system', 'desktop', 'Как в системе']]
    function paintTheme() {
      const cur = getThemeChoice()
      themeRow.replaceChildren(...THEMES.map(([id, ico, label]) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': cur === id ? 'true' : 'false', class: `vl-chip${cur === id ? ' is-active' : ''}` }, [icon(ico), label])
        b.addEventListener('click', () => { setThemeChoice(id); paintTheme() })
        return b
      }))
    }
    paintTheme()
    const themeCard = h('div', { class: 'settings-card' }, [
      h('div', { class: 'settings-card-head' }, [h('span', { class: 'settings-card-title' }, [icon('palette'), 'Тема'])]),
      h('p', { class: 'settings-card-note' }, 'Только на этом устройстве.'),
      themeRow
    ])
    return [preview, themeCard, mediaCard, card]
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
    const lastSeenCard = h('div', { class: 'settings-card' }, [
      h('div', { class: 'settings-card-head' }, [h('span', { class: 'settings-card-title' }, [icon('clock'), 'Время в сети'])]),
      row,
      note
    ])
    return window.electronAPI ? [lastSeenCard] : [lastSeenCard, buildPushCard()]
  }

  // ---------- Уведомления на этом устройстве (push: приходят и при закрытом сайте) ----------
  function buildPushCard() {
    const note = h('p', { class: 'settings-card-note' })
    const btn = h('button', { type: 'button', class: 'vl-btn vl-btn--primary vl-btn--pill vl-btn--sm' })
    const actions = h('div', { class: 'settings-card-actions' }, [btn])
    const card = h('div', { class: 'settings-card' }, [
      h('div', { class: 'settings-card-head' }, [h('span', { class: 'settings-card-title' }, [icon('bell'), 'Уведомления на этом устройстве'])]),
      note, actions
    ])
    async function refresh() {
      btn.disabled = false
      if (needsHomeScreen()) {
        note.textContent = 'На iPhone уведомления приходят только у сайта на экране «Домой»: в Safari нажмите «Поделиться» → «На экран „Домой“» и откройте Voice Lobby с иконки.'
        actions.hidden = true
        return
      }
      if (!pushSupported()) { note.textContent = 'Этот браузер не поддерживает уведомления при закрытом сайте.'; actions.hidden = true; return }
      if (Notification.permission === 'denied') {
        note.textContent = 'Уведомления запрещены в настройках браузера (или телефона) для этого сайта — разрешите их там.'
        actions.hidden = true
        return
      }
      const on = await pushEnabled()
      note.textContent = on
        ? 'Включены: сообщения, звонки и заявки в друзья приходят, даже когда сайт закрыт.'
        : 'Включите, чтобы получать сообщения и звонки, даже когда сайт закрыт.'
      btn.textContent = on ? 'Выключить' : 'Включить'
      btn.className = `vl-btn ${on ? 'vl-btn--soft' : 'vl-btn--primary'} vl-btn--pill vl-btn--sm`
      btn.onclick = async () => {
        btn.disabled = true
        try {
          if (on) await disablePush()
          else {
            const res = await requestNotificationPermission()
            if (res === 'granted') await enablePush()
          }
        } catch (e) { toast(e.message || 'Не получилось', 'error') }
        refresh()
      }
    }
    refresh()
    return card
  }
}
