// ===================== Переслать сообщение: выбор чата («Избранное» — первым) =====================
import { sortedConversations, friendsBy, dmWith, ensureSaved, forwardMessage, setConversation, presenceOf } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, presenceText, toast } from './ui.js'

export function openForwardPicker(message) {
  // Вид — как у окна «Новый звонок»: заголовок и крестик, поле поиска, «Избранное» отдельной
  // строкой сверху (как «Комната по коду»), ниже — чаты и друзья
  const input = h('input', { type: 'text', class: 'g-field__input', placeholder: 'Кому переслать', autocomplete: 'off', spellcheck: 'false' })
  const savedRow = h('button', { type: 'button', class: 'g-frow' }, [
    h('span', { class: 'g-ava g-ava--ico' }, [icon('bookmark')]),
    h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, 'Избранное'), h('span', { class: 'g-frow__sub' }, 'сохранить себе')])
  ])
  savedRow.addEventListener('click', () => pick({ key: 'saved', saved: true, name: 'Избранное' }))
  const list = h('div', { class: 'g-picker__list' })
  const close = h('button', { type: 'button', class: 'g-close', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const card = h('div', { class: 'g-modal g-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Переслать' }, [
    h('div', { class: 'g-modal__head' }, [h('span', { class: 'g-modal__title' }, 'Переслать'), close]),
    h('label', { class: 'g-field' }, [input]),
    savedRow,
    list
  ])
  const overlay = h('div', { class: 'g-overlay' }, [card])
  let targets = []
  let busy = false

  // Кандидаты: лички по свежести, затем друзья, с которыми ещё нет лички
  function candidates() {
    const out = []
    const seen = new Set()
    for (const c of sortedConversations()) {
      if (c.type === 'saved' || !c.peer) continue
      seen.add(c.peer.id)
      out.push({ key: 'c' + c.id, convId: c.id, user: c.peer, name: displayName(c.peer) })
    }
    for (const f of friendsBy('friend')) {
      if (seen.has(f.user.id)) continue
      out.push({ key: 'u' + f.user.id, userId: f.user.id, user: f.user, name: displayName(f.user) })
    }
    return out
  }
  function render() {
    const q = input.value.trim().toLowerCase().replace(/^@/, '')
    savedRow.hidden = !!q && !'избранное'.includes(q)
    targets = candidates().filter((t) => !q || t.name.toLowerCase().includes(q) || (t.user.username || '').toLowerCase().includes(q))
    list.replaceChildren(...(targets.length ? targets.map((t) => {
      const p = presenceOf(t.user.id)
      const ava = avatar(t.user, { size: 40 })
      ava.classList.add('g-ava')
      if (p && p.status !== 'offline') ava.appendChild(h('span', { class: 'g-dot' }))
      const row = h('button', { type: 'button', class: 'g-frow' }, [
        ava,
        h('span', { class: 'g-frow__text' }, [h('span', { class: 'g-frow__name' }, t.name), h('span', { class: 'g-frow__sub' }, presenceText(p))])
      ])
      row.addEventListener('click', () => pick(t))
      return row
    }) : [h('div', { class: 'g-empty' }, 'Никого не нашлось')]))
  }
  async function pick(t) {
    if (busy) return
    busy = true
    try {
      let convId = t.convId
      if (t.saved) convId = (await ensureSaved()).id
      else if (t.userId) {
        const existing = dmWith(t.userId)
        if (existing) convId = existing.id
        else { const { conversation } = await api.openDm(t.userId); setConversation(conversation); convId = conversation.id }
      }
      await forwardMessage(convId, message.id)
      done()
      toast(t.saved ? 'Сохранено в «Избранное»' : `Переслано: ${t.name}`, 'success')
    } catch (e) {
      busy = false
      toast(e.message, 'error')
    }
  }
  function done() { overlay.classList.add('is-out'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey, true) }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); done() }
    if (e.key === 'Enter') { e.preventDefault(); if (!savedRow.hidden && !input.value.trim()) pick({ key: 'saved', saved: true, name: 'Избранное' }); else if (targets[0]) pick(targets[0]) }
  }
  input.addEventListener('input', render)
  close.addEventListener('click', done)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  render()
  input.focus()
}
