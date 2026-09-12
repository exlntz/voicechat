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
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write', String(text == null ? '' : text))
})
