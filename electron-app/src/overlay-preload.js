// ===================== Preload окна-оверлея =====================
// Мост между изолированным окном рисования и главным процессом.
// contextIsolation включён, поэтому наружу отдаём только явный минимум.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  // Главный процесс сообщает, включён ли режим рисования (мышь ловится окном)
  // или оверлей в режиме "смотрю, но не мешаю" (клики проходят насквозь).
  onState: (cb) => ipcRenderer.on('overlay-state', (_e, state) => cb(state)),
  // Команды по глобальным горячим клавишам: 'undo' | 'clear' | 'cursor'.
  onCommand: (cb) => ipcRenderer.on('overlay-command', (_e, command) => cb(command)),
  // Выйти из режима рисования (Esc или кнопка на панели).
  exit: () => ipcRenderer.send('overlay-exit'),
  // Полностью убрать оверлей с экрана.
  hide: () => ipcRenderer.send('overlay-hide'),
  // Режим мыши: пропускать ли клики насквозь в программы под оверлеем.
  // Нужно, чтобы рисунок и панель оставались на экране, но можно было работать мышкой
  // в любом приложении: оверлей сам включает захват мыши только когда курсор над панелью.
  setMouseIgnore: (ignore) => ipcRenderer.send('overlay-set-ignore-mouse', !!ignore),
  // Вернуть фокус оверлею, чтобы снова работали локальные клавиши инструментов.
  focusOverlay: () => ipcRenderer.send('overlay-focus')
})
