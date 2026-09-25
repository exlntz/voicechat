// ===================== «Добавить в контакты»: своё имя для человека =====================
import { saveContact } from './store.js'
import { h, icon, avatar, contactName, profileName, toast } from './ui.js'

export function openContactDialog(user) {
  const current = contactName(user.id)
  const input = h('input', { type: 'text', placeholder: 'Как записать', maxlength: '64', autocomplete: 'off', spellcheck: 'false' })
  input.value = current || profileName(user)
  const close = h('button', { type: 'button', class: 'vl-round is-ghost', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const remove = current ? h('button', { type: 'button', class: 'vl-btn vl-btn--ghost-text vl-contact__remove' }, 'Удалить из контактов') : null
  const cancel = h('button', { type: 'button', class: 'vl-btn vl-btn--ghost' }, 'Отмена')
  const save = h('button', { type: 'button', class: 'vl-btn vl-btn--primary' }, 'Сохранить')
  const card = h('div', { class: 'vl-modal vl-contact', role: 'dialog', 'aria-modal': 'true', 'aria-label': current ? 'Изменить контакт' : 'Добавить в контакты' }, [
    h('div', { class: 'vl-picker__head' }, [h('h3', { class: 'vl-modal__title' }, current ? 'Изменить контакт' : 'Добавить в контакты'), close]),
    h('div', { class: 'vl-contact__who' }, [
      avatar(user, { size: 44 }),
      h('div', { class: 'vl-contact__text' }, [h('b', {}, profileName(user)), h('span', {}, '@' + user.username)])
    ]),
    h('div', { class: 'vl-fld-host' }, [input]),
    h('p', { class: 'vl-modal__text vl-contact__note' }, 'Это имя видите только вы — в чатах, списке друзей и уведомлениях.'),
    h('div', { class: 'vl-modal__actions' }, [remove, h('span', { class: 'vl-contact__spacer' }), cancel, save])
  ])
  const overlay = h('div', { class: 'vl-modal-overlay' }, [card])
  let busy = false
  async function submit(name) {
    if (busy) return
    busy = true
    try {
      // То же, что имя в профиле, — это не контакт, а просто имя: не храним
      const clean = String(name || '').trim()
      await saveContact(user.id, clean && clean !== profileName(user) ? clean : '')
      done()
      toast(clean && clean !== profileName(user) ? 'Контакт сохранён' : 'Удалено из контактов', 'success')
    } catch (e) {
      busy = false
      toast(e.message, 'error')
    }
  }
  function done() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done() }
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(input.value) }
  }
  save.addEventListener('click', () => submit(input.value))
  if (remove) remove.addEventListener('click', () => submit(''))
  cancel.addEventListener('click', done)
  close.addEventListener('click', done)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  input.focus()
  input.select()
}
