// ===================== Переслать сообщение: выбор чата («Избранное» — первым) =====================
import { sortedConversations, friendsBy, dmWith, ensureSaved, forwardMessage, setConversation } from './store.js'
import { api } from './api.js'
import { h, icon, avatar, displayName, toast } from './ui.js'

export function openForwardPicker(message) {
  const input = h('input', { type: 'text', placeholder: 'Кому переслать', autocomplete: 'off', spellcheck: 'false' })
  const list = h('div', { class: 'vl-picker__list' })
  const close = h('button', { type: 'button', class: 'vl-round is-ghost', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const card = h('div', { class: 'vl-modal vl-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Переслать' }, [
    h('div', { class: 'vl-picker__head' }, [h('h3', { class: 'vl-modal__title' }, 'Переслать'), close]),
    h('div', { class: 'vl-fld-host' }, [input]), list
  ])
  const overlay = h('div', { class: 'vl-modal-overlay' }, [card])
  let targets = []
  let busy = false

  // Кандидаты: «Избранное», лички по свежести, затем друзья, с которыми ещё нет лички
  function candidates() {
    const out = [{ key: 'saved', saved: true, name: 'Избранное', sub: 'Сохранить себе' }]
    const seen = new Set()
    for (const c of sortedConversations()) {
      if (c.type === 'saved' || !c.peer) continue
      seen.add(c.peer.id)
      out.push({ key: 'c' + c.id, convId: c.id, user: c.peer, name: displayName(c.peer), sub: '@' + c.peer.username })
    }
    for (const f of friendsBy('friend')) {
      if (seen.has(f.user.id)) continue
      out.push({ key: 'u' + f.user.id, userId: f.user.id, user: f.user, name: displayName(f.user), sub: '@' + f.user.username })
    }
    return out
  }
  function render() {
    const q = input.value.trim().toLowerCase().replace(/^@/, '')
    targets = candidates().filter((t) => !q || t.name.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q))
    list.replaceChildren(...(targets.length ? targets.map((t, i) => {
      const row = h('button', { type: 'button', class: `vl-picker__row${i === 0 ? ' is-first' : ''}` }, [
        avatar(t.user, { size: 40, saved: !!t.saved }),
        h('span', { class: 'vl-picker__name' }, t.name),
        h('span', { class: 'vl-picker__user' }, t.sub)
      ])
      row.addEventListener('click', () => pick(t))
      return row
    }) : [h('div', { class: 'vl-side__empty' }, 'Никого не нашлось')]))
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
  function done() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); done() }
    if (e.key === 'Enter' && targets[0]) { e.preventDefault(); pick(targets[0]) }
  }
  input.addEventListener('input', render)
  close.addEventListener('click', done)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  render()
  input.focus()
}
