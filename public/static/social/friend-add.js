// ===================== «Добавить друга»: окно (ПК) / шторка снизу (телефон) =====================
// Вводят юзернейм — сервер ищет человека по точному совпадению (/api/users/lookup) и показывает
// карточку с кнопкой по отношению к нему: добавить, принять встречную заявку, написать другу.
import { store, setFriend, loadFriends } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, toast } from './ui.js'

let current = null

export function openFriendAdd({ openDmWith } = {}) {
  if (current) return
  const input = h('input', { type: 'text', class: 'g-field__input', placeholder: 'username', maxlength: '32', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Юзернейм друга' })
  const close = h('button', { type: 'button', class: 'g-close', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const result = h('div', { class: 'g-fadd__res', 'aria-live': 'polite' })
  const me = store.me ? store.me.username : ''
  const copyBtn = h('button', { type: 'button', class: 'g-fadd__copy' }, 'Скопировать')
  const card = h('div', { class: 'g-modal g-fadd', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Добавить друга' }, [
    h('span', { class: 'g-fadd__grab', 'aria-hidden': 'true' }),
    h('div', { class: 'g-modal__head' }, [h('span', { class: 'g-modal__title' }, 'Добавить друга'), close]),
    h('p', { class: 'g-fadd__text' }, 'Юзернейм есть в профиле друга после @'),
    h('label', { class: 'g-field g-fadd__field' }, [h('span', { class: 'g-fadd__at' }, '@'), input]),
    result,
    h('div', { class: 'g-fadd__foot' }, [h('span', {}, ['Ваш юзернейм ', h('b', {}, '@' + me)]), copyBtn])
  ])
  const overlay = h('div', { class: 'g-overlay g-fadd-ov' }, [card])
  current = overlay

  let seq = 0
  let timer = 0
  let found = null // { user, status }
  let busy = false

  function hint(text, ico = 'magnifying-glass') {
    found = null
    result.replaceChildren(h('div', { class: 'g-fadd__hint' }, [icon(ico), text]))
  }
  function actionFor(f) {
    const s = f.status
    if (s === 'none') return { label: 'Добавить', cls: 'g-btn--acc', run: add }
    if (s === 'incoming') return { label: 'Принять', cls: 'g-btn--acc', run: accept }
    if (s === 'friend') return { label: 'Написать', cls: 'g-btn--acc', run: () => { done(); if (openDmWith) openDmWith(f.user.id) } }
    if (s === 'outgoing') return { label: 'Отправлено', cls: 'is-soft', done: true }
    if (s === 'self') return { label: 'Это вы', cls: 'is-soft', done: true }
    return { label: 'Заблокирован', cls: 'is-soft', done: true }
  }
  function renderFound() {
    const f = found
    const a = actionFor(f)
    const btn = h('button', { type: 'button', class: `g-btn g-btn--sm g-fadd__act ${a.cls}`, disabled: !!a.done }, [a.done && f.status === 'outgoing' ? icon('check') : null, a.label])
    if (a.run) btn.addEventListener('click', () => a.run(btn))
    result.replaceChildren(h('div', { class: 'g-fadd__card' }, [
      avatar(f.user, { size: 46 }),
      h('span', { class: 'g-fadd__who' }, [h('b', {}, displayName(f.user)), h('span', {}, '@' + f.user.username)]),
      btn
    ]))
  }
  async function lookup(name) {
    const my = ++seq
    try {
      const r = await api.get('/api/users/lookup?username=' + encodeURIComponent(name))
      if (my !== seq) return
      found = { user: r.user, status: r.status }
      renderFound()
    } catch (e) {
      if (my !== seq) return
      if (e.status === 404 || /не найден/i.test(e.message || '')) hint(`Никого с юзернеймом @${name}`, 'circle-xmark')
      else hint(e.message || 'Не получилось проверить', 'circle-xmark')
    }
  }
  function onInput() {
    const name = input.value.replace(/^@+/, '').trim()
    clearTimeout(timer)
    seq++
    if (name.length < 2) { hint('Юзернейм друга — например, anya'); return }
    result.replaceChildren(h('div', { class: 'g-fadd__hint is-wait' }, [h('span', { class: 'g-skel g-skel--ava is-sm' }), h('span', { class: 'g-skel g-skel--line' })]))
    timer = setTimeout(() => lookup(name), 280)
  }
  async function add(btn) {
    if (busy || !found) return
    busy = true
    if (btn) btn.disabled = true
    try {
      const res = await api.requestFriend(found.user.username)
      setFriend(res.friend)
      found = { user: found.user, status: res.friend.status === 'friend' ? 'friend' : 'outgoing' }
      renderFound()
      toast(found.status === 'friend' ? `Теперь вы друзья: ${displayName(found.user)}` : 'Заявка отправлена', 'success')
    } catch (e) {
      toast(e.message, 'error')
      if (btn) btn.disabled = false
    }
    busy = false
  }
  async function accept(btn) {
    if (busy || !found) return
    busy = true
    if (btn) btn.disabled = true
    try {
      await api.acceptFriend(found.user.id)
      found = { user: found.user, status: 'friend' }
      renderFound()
      toast(`Теперь вы друзья: ${displayName(found.user)}`, 'success')
      loadFriends().catch(() => {})
    } catch (e) {
      toast(e.message, 'error')
      if (btn) btn.disabled = false
    }
    busy = false
  }

  function done() {
    if (overlay.classList.contains('is-out')) return
    overlay.classList.add('is-out')
    clearTimeout(timer)
    seq++
    document.removeEventListener('keydown', onKey, true)
    setTimeout(() => { overlay.remove(); if (current === overlay) current = null }, 320)
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done() }
    if (e.key === 'Enter' && e.target === input && found) {
      e.preventDefault()
      const a = actionFor(found)
      if (a.run) a.run(result.querySelector('.g-fadd__act'))
    }
  }
  input.addEventListener('input', onInput)
  close.addEventListener('click', done)
  copyBtn.addEventListener('click', () => {
    const copy = window.VL && window.VL.copyToClipboard ? window.VL.copyToClipboard('@' + me) : Promise.resolve(false)
    copy.then((ok) => toast(ok ? 'Юзернейм скопирован' : 'Не удалось скопировать', ok ? 'success' : 'error'))
  })
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  hint('Юзернейм друга — например, anya')
  // На телефоне клавиатура выезжает вместе со шторкой — фокус после начала анимации
  setTimeout(() => input.focus(), 60)
}
