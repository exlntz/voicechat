// ===================== Профиль (как в канвасе «Голос») =====================
// Окно 1000×680: слева — вы и разделы (Профиль, Оформление, Конфиденциальность, Аккаунт),
// справа — содержимое раздела. Открывается кнопкой-аватаркой в левом верхнем углу.
import { api } from './api.js'
import { store, updateUser } from './store.js'
import { h, icon, avatar, displayName, toast, bannerMedia, bannerKey, getThemeChoice, setThemeChoice, getPref, setPref, showMenu } from './ui.js'
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
  setTimeout(drop, 450)
}

const NAV = [
  { id: 'profile', title: 'Профиль', icon: 'user' },
  { id: 'look', title: 'Оформление', icon: 'sun' },
  { id: 'privacy', title: 'Конфиденциальность', icon: 'eye' },
  { id: 'account', title: 'Аккаунт', icon: 'right-from-bracket' }
]

export function openProfile({ logout }) {
  if (current) { closeProfile(); return }
  let settings = { showLastSeen: true }
  let tab = 'profile'

  const meAva = h('span', { class: 'g-pf__me-ava' })
  const meName = h('span', { class: 'g-pf__me-name' })
  const meUser = h('span', { class: 'g-pf__me-user' })
  const navBtns = new Map()
  const nav = h('div', { class: 'g-pf__side' }, [
    h('div', { class: 'g-pf__me' }, [meAva, h('span', { class: 'g-pf__me-text' }, [meName, meUser])]),
    ...NAV.map((n) => {
      const b = h('button', { type: 'button', class: 'g-pf__nav' }, [icon(n.icon), n.title])
      b.addEventListener('click', () => show(n.id))
      navBtns.set(n.id, b)
      return b
    })
  ])
  const title = h('span', { class: 'g-pf__title' })
  const closeBtn = h('button', { type: 'button', class: 'g-close', 'aria-label': 'Закрыть профиль' }, [icon('xmark')])
  closeBtn.addEventListener('click', closeProfile)
  const pane = h('div', { class: 'g-pf__pane' })
  const main = h('div', { class: 'g-pf__main' }, [h('div', { class: 'g-pf__head' }, [title, closeBtn]), pane])
  const card = h('div', { class: 'g-pf', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Профиль' }, [nav, main])
  const overlay = h('div', { class: 'g-pf-overlay' }, [card])
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeProfile() })
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.vl-lightbox, .vl-crop-overlay, .vl-menu')) { e.preventDefault(); closeProfile() } }
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  current = { overlay, onKey }

  function paintMe() {
    const u = store.me
    meAva.replaceChildren(avatar(u, { size: 48 }))
    meName.textContent = displayName(u)
    meUser.textContent = '@' + u.username
  }
  function show(id) {
    tab = NAV.some((n) => n.id === id) ? id : 'profile'
    for (const [k, b] of navBtns) b.classList.toggle('is-on', k === tab)
    title.textContent = NAV.find((n) => n.id === tab).title
    const build = { profile: buildProfile, look: buildLook, privacy: buildPrivacy, account: buildAccount }[tab]
    pane.replaceChildren(h('div', { class: 'g-pf__sec' }, build()))
  }
  paintMe()
  show('profile')

  api.get('/api/profile').then((p) => {
    if (!p) return
    settings = p.settings
    if (p.user) updateUser(p.user)
    if (current && current.overlay === overlay) { paintMe(); show(tab) }
  }).catch(() => {})

  // ---------- Профиль: обложка, аватар, имя, юзернейм ----------
  function buildProfile() {
    const cover = h('div', { class: 'g-pf__cover' })
    const coverActs = h('div', { class: 'g-pf__cover-act' })
    const ava = h('div', { class: 'g-pf__ava', title: 'Сменить аватарку' })
    const nameBig = h('span', { class: 'g-pf__name' })
    const userLine = h('span', { class: 'g-pf__user' })
    const avaInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true })
    const bannerInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime', hidden: true })
    const status = h('div', { class: 'g-hint g-pf__status', role: 'status' })
    const setStatus = (text, kind = '') => { status.textContent = text; status.dataset.k = kind }

    function paint() {
      const u = store.me
      if (u.bannerUrl) {
        if (cover.dataset.src !== bannerKey(u)) { cover.dataset.src = bannerKey(u); cover.replaceChildren(bannerMedia(u), coverActs) }
      } else { delete cover.dataset.src; cover.replaceChildren(coverActs) }
      cover.dataset.bg = u.bannerUrl ? '1' : '0'
      const swap = h('button', { type: 'button', class: 'g-chip' }, [icon('image'), u.bannerUrl ? 'Сменить фон' : 'Добавить фон'])
      swap.addEventListener('click', (e) => { e.stopPropagation(); bannerInput.click() })
      const acts = [swap]
      if (u.bannerUrl) {
        const rm = h('button', { type: 'button', class: 'g-chip' }, [icon('xmark'), 'Убрать'])
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeMedia('banner') })
        acts.push(rm)
      }
      coverActs.replaceChildren(...acts)
      ava.replaceChildren(avatar(u, { size: 104 }), h('span', { class: 'g-pf__ava-h' }, [icon('image')]))
      nameBig.textContent = displayName(u)
      userLine.textContent = '@' + u.username + ' · в сети'
      paintMe()
    }
    cover.addEventListener('click', () => { const u = store.me; if (u.bannerUrl) openLightbox([{ kind: u.bannerKind === 'video' ? 'video' : 'image', url: u.bannerUrl, name: 'banner' }]) })
    ava.addEventListener('click', (e) => {
      const u = store.me
      if (!u.avatarUrl) { avaInput.click(); return }
      showMenu([
        { label: 'Сменить аватарку', icon: 'image', onClick: () => avaInput.click() },
        { label: 'Открыть', icon: 'eye', onClick: () => openLightbox([{ kind: 'image', url: u.avatarUrl, name: 'avatar' }]) },
        'sep',
        { label: 'Убрать аватарку', icon: 'trash', danger: true, onClick: () => removeMedia('avatar') }
      ], e)
    })

    async function upload(purpose, raw) {
      if (purpose === 'avatar' && raw.type !== 'image/gif') {
        if (raw.size > 20 * 1024 * 1024) { setStatus('Картинка больше 20 МБ', 'bad'); return }
        try { raw = await cropAvatar(raw) } catch (e) { setStatus(e.message, 'bad'); return }
        if (!raw) return
      }
      let picked = null
      if (purpose === 'banner') {
        if (raw.size > 30 * 1024 * 1024) { setStatus('Файл для фона — до 30 МБ', 'bad'); return }
        try { picked = await cropBanner(raw) } catch (e) { setStatus(e.message, 'bad'); return }
        if (!picked) return
      }
      setStatus('Загружаем…')
      try {
        let file = raw
        let meta = {}
        if (purpose === 'avatar') {
          if (file.size > 5 * 1024 * 1024) throw new Error('GIF-аватарка больше 5 МБ')
        } else {
          file = picked.file
          meta = { ...picked.meta }
          if (picked.crop) meta.crop = picked.crop
        }
        await uploadFile(file, { purpose, meta, onProgress: (p) => setStatus(`Загружаем… ${Math.round(p * 100)}%`) })
        const r = await api.get('/api/profile')
        if (r && r.user) updateUser(r.user)
        setStatus(purpose === 'avatar' ? 'Аватарка обновлена' : 'Фон обновлён', 'ok')
        paint()
      } catch (e) { setStatus(e.message, 'bad') }
    }
    avaInput.addEventListener('change', () => { const f = avaInput.files[0]; avaInput.value = ''; if (f) upload('avatar', f) })
    bannerInput.addEventListener('change', () => { const f = bannerInput.files[0]; bannerInput.value = ''; if (f) upload('banner', f) })
    async function removeMedia(what) {
      try {
        const r = await api.del('/api/profile/' + what)
        if (r && r.user) updateUser(r.user)
        paint()
      } catch (e) { toast(e.message, 'error') }
    }

    // Отображаемое имя
    const nameInput = h('input', { type: 'text', class: 'g-inp', placeholder: 'Имя', maxlength: '40', autocomplete: 'off', spellcheck: 'false' })
    nameInput.value = store.me.displayName || store.me.username
    const nameSave = h('button', { type: 'button', class: 'g-ubtn', 'data-dis': '1' }, 'Сохранить')
    const nameHint = h('span', { class: 'g-hint' }, 'Так вас видят в чатах и звонках')
    const NAME_RE = /^[\p{L}\p{N}_\- ]{1,40}$/u
    const wantedName = () => nameInput.value.replace(/\s+/g, ' ').trim()
    function refreshName() {
      const v = wantedName()
      const same = v === (store.me.displayName || store.me.username)
      const valid = NAME_RE.test(v)
      nameSave.dataset.dis = same || !valid ? '1' : '0'
      nameHint.dataset.k = !v || same || valid ? '' : 'bad'
      nameHint.textContent = !v || same || valid ? 'Так вас видят в чатах и звонках' : 'Только буквы, цифры, пробел, _ и -'
    }
    nameInput.addEventListener('input', refreshName)
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameSave.click() })
    nameSave.addEventListener('click', async () => {
      if (nameSave.dataset.dis === '1') return
      nameSave.dataset.dis = '1'
      try {
        const p = await api.patch('/api/profile', { displayName: wantedName() })
        updateUser(p.user)
        nameInput.value = p.user.displayName
        nameHint.dataset.k = 'ok'
        nameHint.textContent = 'Имя сохранено'
        paint()
      } catch (e) {
        nameHint.dataset.k = 'bad'
        nameHint.textContent = e.message
        nameSave.dataset.dis = '0'
      }
    })

    // Юзернейм (без «@» в поле)
    const userInput = h('input', { type: 'text', class: 'g-inp', placeholder: 'username', maxlength: '25', autocomplete: 'off', spellcheck: 'false' })
    userInput.value = store.me.username
    const userSave = h('button', { type: 'button', class: 'g-ubtn', 'data-dis': '1' }, 'Сохранить')
    const userHint = h('span', { class: 'g-hint' }, 'Это ваш юзернейм')
    let timer = 0
    let okToSave = false
    const wanted = () => userInput.value.replace(/^@+/, '').trim()
    const setUserHint = (text, k = '') => { userHint.textContent = text; userHint.dataset.k = k }
    userInput.addEventListener('input', () => {
      const name = wanted()
      okToSave = false
      userSave.dataset.dis = '1'
      clearTimeout(timer)
      if (!name || name === store.me.username) { setUserHint('Это ваш юзернейм'); return }
      setUserHint('Проверяем…')
      timer = setTimeout(async () => {
        const checked = name
        try {
          const r = await api.get('/api/users/check?username=' + encodeURIComponent(name))
          if (wanted() !== checked) return
          if (!r.valid || !r.available) setUserHint(r.message, 'bad')
          else { setUserHint('Свободен', 'ok'); okToSave = true; userSave.dataset.dis = '0' }
        } catch (e) { setUserHint(e.message, 'bad') }
      }, 350)
    })
    userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') userSave.click() })
    userSave.addEventListener('click', async () => {
      if (!okToSave) return
      userSave.dataset.dis = '1'
      try {
        const p = await api.patch('/api/profile', { username: wanted() })
        updateUser(p.user)
        setUserHint('Юзернейм изменён', 'ok')
        okToSave = false
        paint()
      } catch (e) { setUserHint(e.message, 'bad'); userSave.dataset.dis = '0' }
    })

    paint()
    return [
      h('div', { class: 'g-pf__top' }, [
        cover,
        h('div', { class: 'g-pf__id' }, [ava, h('div', { class: 'g-pf__id-text' }, [nameBig, userLine])])
      ]),
      status,
      h('div', { class: 'g-pf__grid' }, [
        h('div', { class: 'g-pf__col' }, [h('span', { class: 'g-label2' }, 'Отображаемое имя'), h('div', { class: 'g-pf__row' }, [nameInput, nameSave]), nameHint]),
        h('div', { class: 'g-pf__col' }, [h('span', { class: 'g-label2' }, 'Юзернейм'), h('div', { class: 'g-pf__row' }, [userInput, userSave]), userHint])
      ]),
      avaInput, bannerInput
    ]
  }

  // ---------- Оформление: тема и размер текста (на этом устройстве) ----------
  function seg(options, value, onPick) {
    const knob = h('span', { class: 'g-seg__k' })
    const box = h('div', { class: 'g-seg', role: 'radiogroup' }, [knob])
    const btns = options.map(([id, label], i) => {
      const b = h('button', { type: 'button', role: 'radio' }, label)
      b.addEventListener('click', () => { set(i); onPick(id) })
      box.appendChild(b)
      return b
    })
    function set(i) {
      knob.style.setProperty('--i', String(i))
      btns.forEach((b, j) => { b.dataset.on = j === i ? '1' : '0'; b.setAttribute('aria-checked', j === i ? 'true' : 'false') })
    }
    set(Math.max(0, options.findIndex(([id]) => id === value)))
    return box
  }
  function buildLook() {
    const FS = { s: 13, m: 15, l: 17 }
    const sample = h('span', { class: 'g-pf__sample' }, 'Привет! Созвон в девять в силе?')
    const paintSample = () => { sample.style.fontSize = (FS[getPref('chatFont', 'm')] || 15) + 'px' }
    paintSample()
    return [
      h('div', { class: 'g-pf__col' }, [
        h('span', { class: 'g-label2' }, 'Тема'),
        seg([['light', 'Светлая'], ['dark', 'Тёмная'], ['system', 'Как в системе']], getThemeChoice(), (id) => setThemeChoice(id)),
        h('span', { class: 'g-hint' }, 'Только на этом устройстве.')
      ]),
      h('div', { class: 'g-pf__col' }, [
        h('span', { class: 'g-label2' }, 'Размер текста в чатах'),
        seg([['s', 'Мелкий'], ['m', 'Средний'], ['l', 'Крупный']], getPref('chatFont', 'm'), (id) => { setPref('chatFont', id); paintSample() })
      ]),
      h('div', { class: 'g-pf__preview' }, [h('span', { class: 'g-pf__preview-t' }, 'Так будут выглядеть сообщения'), sample])
    ]
  }

  // ---------- Конфиденциальность: строки-переключатели ----------
  function toggleRow(label, on, onChange) {
    const tgl = h('span', { class: 'g-tgl', 'data-on': on ? '1' : '0' })
    const row = h('button', { type: 'button', class: 'g-urow', role: 'switch', 'aria-checked': on ? 'true' : 'false' }, [h('span', { class: 'g-urow__t' }, [h('b', {}, label)]), tgl])
    const set = (v) => { tgl.dataset.on = v ? '1' : '0'; row.setAttribute('aria-checked', v ? 'true' : 'false') }
    row.addEventListener('click', async () => {
      const next = tgl.dataset.on !== '1'
      set(next)
      try { const res = await onChange(next); if (res === false) set(!next) } catch (e) { set(!next); toast(e.message || 'Не получилось', 'error') }
    })
    return { row, set }
  }
  function buildPrivacy() {
    const rows = []
    rows.push(toggleRow('Показывать, когда я был(а) в сети', settings.showLastSeen !== false, async (v) => {
      const p = await api.patch('/api/profile', { showLastSeen: v })
      settings = p.settings
    }).row)
    // Уведомления: push на сайте (в .exe — свои системные уведомления, строки нет)
    if (!window.electronAPI) {
      if (needsHomeScreen() || !pushSupported()) {
        rows.push(h('div', { class: 'g-urow' }, [h('span', { class: 'g-urow__t' }, [h('b', {}, 'Уведомления на этом устройстве'), h('span', {}, needsHomeScreen() ? 'На iPhone — только у сайта на экране «Домой»' : 'Браузер не поддерживает уведомления')])]))
      } else {
        const r = toggleRow('Уведомления на этом устройстве', false, async (v) => {
          if (!v) { await disablePush(); return true }
          if (Notification.permission === 'denied') { toast('Уведомления запрещены в настройках браузера', 'error'); return false }
          const res = await requestNotificationPermission()
          if (res !== 'granted') return false
          await enablePush()
          return true
        })
        pushEnabled().then((on) => r.set(on)).catch(() => {})
        rows.push(r.row)
      }
    }
    rows.push(toggleRow('Звук входящего звонка', getPref('ringSound', '1') !== '0', (v) => setPref('ringSound', v ? '1' : '0')).row)
    return rows
  }

  // ---------- Аккаунт: дата создания и выход ----------
  function buildAccount() {
    const created = settings.createdAt ? new Date(settings.createdAt) : null
    const createdText = created && !isNaN(created) ? created.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/ г\.$/, '') : '—'
    const out = h('button', { type: 'button', class: 'g-ubtn2 g-ubad' }, [icon('right-from-bracket'), 'Выйти из аккаунта'])
    const box = h('div', {}, [out])
    out.addEventListener('click', () => {
      const cancel = h('button', { type: 'button', class: 'g-ubtn2 is-panel' }, 'Отмена')
      const yes = h('button', { type: 'button', class: 'g-ubtn2 is-red' }, 'Выйти')
      cancel.addEventListener('click', () => box.replaceChildren(out))
      yes.addEventListener('click', () => { closeProfile(); logout() })
      box.replaceChildren(h('div', { class: 'g-urow g-pf__ask' }, [h('span', { class: 'g-urow__t' }, [h('b', {}, 'Точно выйти?'), h('span', {}, 'На этом устройстве придётся войти заново')]), cancel, yes]))
    })
    return [
      h('div', { class: 'g-urow' }, [h('span', { class: 'g-urow__t' }, [h('b', {}, 'Аккаунт создан'), h('span', {}, createdText)])]),
      box
    ]
  }
}
