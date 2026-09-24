// ===================== Preload: мост между веб-страницей и Electron =====================
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // Открывает нативное окно выбора экрана/окна для демонстрации, возвращает sourceId или null
  chooseScreenSource: () => ipcRenderer.invoke('choose-screen-source'),
  // Вкл/выкл режима рисования поверх любых программ.
  // Нужно для видимой кнопки в интерфейсе: полагаться только на горячую клавишу нельзя -
  // если комбинация занята другой программой, функция выглядит как отсутствующая.
  toggleDrawing: () => ipcRenderer.send('toggle-drawing'),
  // Какие горячие клавиши реально удалось зарегистрировать в этой системе
  getDrawingShortcuts: () => ipcRenderer.invoke('get-drawing-shortcuts'),
  // Копирование в системный буфер обмена через главный процесс.
  // В .exe navigator.clipboard.writeText() отклонялся, и код комнаты не копировался -
  // app.js сначала пробует этот мост и только потом стандартный Clipboard API.
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write', String(text == null ? '' : text)),
  // «Звонок в отдельном окне»: окно приложения ужимается в угол экрана и встаёт поверх
  // остальных программ (true) или возвращается к прежнему размеру и положению (false)
  setMiniMode: (on) => ipcRenderer.invoke('set-mini-mode', !!on),

  // ---- Друзья и чаты: интеграция с Windows ----
  // Всё ниже сайт проверяет перед вызовом: .exe старых версий этих функций не знает.
  // Уведомление Windows; по клику окно открывается на route (например, /dm/12)
  notify: (data) => ipcRenderer.send('social-notify', {
    title: String((data && data.title) || ''),
    body: String((data && data.body) || ''),
    route: String((data && data.route) || '')
  }),
  // Счётчик непрочитанных: значок на панели задач (overlay) и иконка в трее
  setBadge: (count, overlayDataUrl, trayDataUrl) => ipcRenderer.send('social-badge', {
    count: Number(count) || 0,
    overlay: typeof overlayDataUrl === 'string' ? overlayDataUrl : null,
    tray: typeof trayDataUrl === 'string' ? trayDataUrl : null
  }),
  onNavigate: (cb) => ipcRenderer.on('social-navigate', (_e, route) => cb(String(route || ''))),
  onDeepLink: (cb) => ipcRenderer.on('social-deep-link', (_e, url) => cb(String(url || ''))),
  // Входящий звонок — отдельное маленькое окно поверх всех окон
  showIncomingCall: (data) => ipcRenderer.send('incoming-call-show', data),
  hideIncomingCall: (callId) => ipcRenderer.send('incoming-call-hide', String(callId || '')),
  onIncomingCallAction: (cb) => ipcRenderer.on('incoming-call-action', (_e, data) => cb(data)),
  // Идёт ли звонок: пока идёт, работает глобальная клавиша микрофона
  setCallState: (active) => ipcRenderer.send('social-call-state', !!active),
  onToggleMute: (cb) => ipcRenderer.on('toggle-mute', () => cb()),
  // «Отошёл»: главный процесс следит за простоем всей системы
  onIdleChange: (cb) => ipcRenderer.on('idle-change', (_e, idle) => cb(!!idle))
})
