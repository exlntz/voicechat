const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pickerAPI', {
  onSources: (cb) => ipcRenderer.on('sources-list', (_e, list) => cb(list)),
  // shareAudio: состояние чекбокса "Поделиться звуком стрима" из picker.html (по умолчанию true)
  choose: (id, shareAudio) => ipcRenderer.send('picker-choose', id, shareAudio !== false),
  cancel: () => ipcRenderer.send('picker-cancel')
})
