// ===================== Электрон: главный процесс =====================
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Menu } = require('electron')
const path = require('path')

// URL веб-приложения (Cloudflare Pages control-plane + фронтенд).
// Меняется на реальный адрес после деплоя backend'а.
const SERVER_URL = process.env.ZVONKI_SERVER_URL || 'https://app.185.199.199.114.nip.io'

let mainWindow = null
let pickerWindow = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Разрешаем доступ к getUserMedia/getDisplayMedia без системного диалога Chromium —
      // диалог мы рисуем сами через chooseScreenSource()
      sandbox: false
    }
  })

  Menu.setApplicationMenu(null)

  // Автоматически разрешаем доступ к камере/микрофону (нужно самому пользователю для звонка)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture']
    callback(allowed.includes(permission))
  })

  mainWindow.loadURL(SERVER_URL)

  mainWindow.on('closed', () => { mainWindow = null })
}

// ---- Обработчик системного выбора источника экрана/окна ----
// Electron сам не показывает системный диалог выбора экрана как в браузере — рисуем свой,
// и отдаём выбранный источник через setDisplayMediaRequestHandler (см. ниже), благодаря
// чему звук с устройства (системный звук) захватывается автоматически через 'loopback'.
// Возвращает выбранный DesktopCapturerSource целиком (или null при отмене).
function openPickerWindow() {
  return new Promise((resolve) => {
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 200 } })
      .then((sources) => {
        pickerWindow = new BrowserWindow({
          width: 720,
          height: 480,
          resizable: false,
          minimizable: false,
          maximizable: false,
          parent: mainWindow,
          modal: true,
          backgroundColor: '#0f1115',
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, 'picker-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
          }
        })

        pickerWindow.setMenuBarVisibility(false)
        pickerWindow.loadFile(path.join(__dirname, 'picker.html'))

        const sendSources = () => {
          pickerWindow.webContents.send('sources-list', sources.map((s) => ({
            id: s.id,
            name: s.name,
            thumbnail: s.thumbnail.toDataURL()
          })))
        }

        pickerWindow.webContents.once('did-finish-load', sendSources)

        const onChosen = (_e, sourceId) => {
          cleanup()
          const source = sources.find((s) => s.id === sourceId) || null
          resolve(source)
        }
        const onCancel = () => {
          cleanup()
          resolve(null)
        }
        const onClosed = () => {
          cleanup()
          resolve(null)
        }

        function cleanup() {
          ipcMain.removeListener('picker-choose', onChosen)
          ipcMain.removeListener('picker-cancel', onCancel)
          if (pickerWindow) {
            pickerWindow.removeListener('closed', onClosed)
            pickerWindow.close()
            pickerWindow = null
          }
        }

        ipcMain.once('picker-choose', onChosen)
        ipcMain.once('picker-cancel', onCancel)
        pickerWindow.once('closed', onClosed)
      })
      .catch(() => resolve(null))
  })
}

// Оставляем IPC-метод для обратной совместимости (не используется в новом flow,
// но пусть будет, если где-то ещё вызывается) - возвращает только id источника.
ipcMain.handle('choose-screen-source', async () => {
  const source = await openPickerWindow()
  return source ? source.id : null
})

app.whenReady().then(() => {
  createMainWindow()

  // ---- Захват экрана + системного звука для getDisplayMedia() из рендерера ----
  // Рендерер вызывает navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }) -
  // Electron не показывает системный пикер (на Windows/Linux), поэтому мы сами открываем
  // свой pickerWindow, а затем отдаём выбранный источник + 'loopback' для звука всего компьютера.
  // 'loopback' поддерживается на Windows (наша целевая платформа) - официально из документации Electron.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const source = await openPickerWindow()
      if (!source) {
        // Пользователь отменил выбор - отдаём пустой результат, getDisplayMedia отклонится с NotAllowedError
        callback({})
        return
      }
      callback({
        video: source,
        audio: request.audioRequested ? 'loopback' : undefined
      })
    } catch (e) {
      callback({})
    }
  }, { useSystemPicker: false })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
