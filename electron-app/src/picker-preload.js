const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pickerAPI', {
  onSources: (cb) => ipcRenderer.on('sources-list', (_e, list) => cb(list)),
  choose: (id) => ipcRenderer.send('picker-choose', id),
  cancel: () => ipcRenderer.send('picker-cancel')
})
