// ===================== Preload: мост между веб-страницей и Electron =====================
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // Открывает нативное окно выбора экрана/окна для демонстрации, возвращает sourceId или null
  chooseScreenSource: () => ipcRenderer.invoke('choose-screen-source')
})
