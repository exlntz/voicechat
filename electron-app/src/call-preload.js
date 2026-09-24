// ===================== Preload окна входящего звонка =====================
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('callBridge', {
  // Кто звонит: { callId, name, initials, color }
  onData: (cb) => ipcRenderer.on('call-data', (_e, data) => cb(data)),
  // «Принять» / «Отклонить» — главный процесс передаст это странице сайта
  action: (callId, action) => ipcRenderer.send('incoming-call-action', { callId: String(callId), action: action === 'accept' ? 'accept' : 'decline' })
})
