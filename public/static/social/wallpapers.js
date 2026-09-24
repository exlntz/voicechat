// ===================== Обои чата =====================
// Готовые — градиенты в тон тёмной теме (id «p:<имя>»), свои — загруженная картинка («file:<id>»).
// Обои личные: собеседник их не видит.
import { api } from './api.js'
import { h, icon, toast } from './ui.js'
import { uploadFile, prepareImage } from './upload.js'

export const PRESETS = [
  { id: 'p:aurora', name: 'Сияние', css: 'radial-gradient(120% 80% at 10% 0%, rgba(4, 88, 207, 0.45), transparent 60%), radial-gradient(90% 70% at 100% 100%, rgba(122, 64, 214, 0.38), transparent 60%), #0d1016' },
  { id: 'p:dusk', name: 'Закат', css: 'radial-gradient(110% 80% at 0% 100%, rgba(230, 110, 70, 0.35), transparent 60%), radial-gradient(90% 70% at 100% 0%, rgba(200, 60, 120, 0.3), transparent 60%), #120e12' },
  { id: 'p:ocean', name: 'Океан', css: 'radial-gradient(120% 90% at 100% 0%, rgba(30, 160, 170, 0.35), transparent 60%), radial-gradient(90% 80% at 0% 100%, rgba(20, 90, 160, 0.4), transparent 60%), #0b1115' },
  { id: 'p:forest', name: 'Лес', css: 'radial-gradient(120% 90% at 0% 0%, rgba(58, 168, 110, 0.3), transparent 60%), radial-gradient(90% 70% at 100% 100%, rgba(30, 110, 80, 0.35), transparent 60%), #0c120f' },
  { id: 'p:dots', name: 'Точки', css: 'radial-gradient(rgba(242, 245, 249, 0.07) 1px, transparent 1.4px) 0 0 / 18px 18px, linear-gradient(180deg, #11151b, #0c0f13)' },
  { id: 'p:grid', name: 'Сетка', css: 'linear-gradient(rgba(242, 245, 249, 0.035) 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, rgba(242, 245, 249, 0.035) 1px, transparent 1px) 0 0 / 28px 28px, #0f1217' }
]

// CSS-фон по id обоев (null — без обоев)
export function wallpaperCss(id) {
  if (!id) return ''
  if (id.startsWith('file:')) return `url("/api/files/${id.slice(5)}") center / cover no-repeat, #0d1016`
  const p = PRESETS.find((x) => x.id === id)
  return p ? p.css : ''
}

export function openWallpaperPicker(conv) {
  const current = conv.wallpaper || null
  const close = h('button', { type: 'button', class: 'vl-round is-ghost', 'aria-label': 'Закрыть' }, [icon('xmark')])
  const grid = h('div', { class: 'vl-wall-grid' })
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true })
  const status = h('div', { class: 'vl-fld-status' })
  const card = h('div', { class: 'vl-modal vl-wall', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Обои чата' }, [
    h('div', { class: 'vl-picker__head' }, [h('h3', { class: 'vl-modal__title' }, 'Обои чата'), close]),
    h('p', { class: 'vl-modal__text' }, 'Обои видите только вы.'),
    grid, status, fileInput
  ])
  const overlay = h('div', { class: 'vl-modal-overlay' }, [card])

  async function apply(id) {
    try {
      await api.updateConversation(conv.id, { wallpaper: id })
      done()
    } catch (e) { toast(e.message, 'error') }
  }
  function tile(id, label, css, extra) {
    const b = h('button', { type: 'button', class: `vl-wall-tile${current === id ? ' is-active' : ''}`, 'aria-label': label, title: label }, [
      h('span', { class: 'vl-wall-tile__bg', style: css ? { background: css } : {} }, extra || []),
      h('span', { class: 'vl-wall-tile__name' }, label)
    ])
    b.addEventListener('click', () => apply(id))
    return b
  }
  grid.appendChild(tile(null, 'Без обоев', 'var(--vl-panel)', [icon('ban')]))
  for (const p of PRESETS) grid.appendChild(tile(p.id, p.name, p.css))
  if (current && current.startsWith('file:')) grid.appendChild(tile(current, 'Своя', wallpaperCss(current)))
  const own = h('button', { type: 'button', class: 'vl-wall-tile is-upload', 'aria-label': 'Загрузить картинку' }, [
    h('span', { class: 'vl-wall-tile__bg' }, [icon('image')]), h('span', { class: 'vl-wall-tile__name' }, 'Своя картинка')
  ])
  own.addEventListener('click', () => fileInput.click())
  grid.appendChild(own)
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0]
    fileInput.value = ''
    if (!f) return
    status.className = 'vl-fld-status'
    status.textContent = 'Загружаем…'
    try {
      const { file, meta } = await prepareImage(f, { maxSide: 2400 })
      const saved = await uploadFile(file, { purpose: 'wallpaper', meta, onProgress: (p) => { status.textContent = `Загружаем… ${Math.round(p * 100)}%` } })
      await apply('file:' + saved.id)
    } catch (e) {
      status.className = 'vl-fld-status is-err'
      status.textContent = e.message
    }
  })
  function done() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done() } }
  close.addEventListener('click', done)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done() })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  close.focus()
}
