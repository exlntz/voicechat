// ===================== Электрон: главный процесс =====================
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Menu } = require('electron')
const path = require('path')

// URL веб-приложения (Cloudflare Pages control-plane + фронтенд).
// Меняется на реальный адрес после деплоя backend'а.
const SERVER_URL = process.env.ZVONKI_SERVER_URL || 'https://app.185.199.199.114.nip.io'

// ---- GPU / аппаратное ускорение кодирования видео (для плавной демонстрации экрана, как в Discord) ----
// Discord добивается плавности 60 FPS в первую очередь за счёт GPU-энкодера (NVENC/QuickSync/AMF),
// а не софтверного JS/CPU-кодирования. Chromium (на котором построен Electron) умеет использовать
// аппаратный видео-энкодер для WebRTC (H264), но по умолчанию иногда отключает его на некоторых GPU
// из-за блок-листа совместимости. Эти флаги нужно выставить ДО app.whenReady().
app.commandLine.appendSwitch('enable-accelerated-video-encode')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
// Явно включаем WebRTC H264 hardware encoding через Chromium feature flags
app.commandLine.appendSwitch('enable-features', 'WebRtcH264WithOpenH264FFmpeg,VaapiVideoEncoder,VaapiVideoDecoder')

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
// Возвращает { source, shareAudio } (или null при отмене) - shareAudio - состояние чекбокса
// "Поделиться звуком стрима" из picker.html, по умолчанию true.
function openPickerWindow() {
  return new Promise((resolve) => {
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 200 } })
      .then((sources) => {
        pickerWindow = new BrowserWindow({
          width: 760,
          height: 620,
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
            // s.id обычно вида "screen:0:0" или "window:1234:0" - используем это как надёжный
            // признак типа источника, т.к. поле s.display_id не всегда присутствует
            type: s.id.startsWith('screen') ? 'screen' : 'window',
            thumbnail: s.thumbnail.toDataURL()
          })))
        }

        pickerWindow.webContents.once('did-finish-load', sendSources)

        const onChosen = (_e, sourceId, shareAudio) => {
          cleanup()
          const source = sources.find((s) => s.id === sourceId) || null
          resolve(source ? { source, shareAudio: shareAudio !== false } : null)
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
  const picked = await openPickerWindow()
  return picked ? picked.source.id : null
})

app.whenReady().then(() => {
  createMainWindow()

  // ---- Захват экрана + системного звука для getDisplayMedia() из рендерера ----
  // Рендерер (app.js) вызывает navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }) -
  // Electron не показывает системный пикер (на Windows/Linux), поэтому мы сами открываем
  // свой pickerWindow, а затем отдаём выбранный источник + 'loopback' для звука всего компьютера.
  // 'loopback' поддерживается на Windows (наша целевая платформа) - официально из документации Electron.
  //
  // ВАЖНО про звук ("баг: при демке не слышно звука, нет тумблера"): раньше здесь звук включался
  // ТОЛЬКО если request.audioRequested было true, и никакого UI для управления этим не было -
  // пользователь не понимал, почему звука нет. Теперь:
  //  1. Наш пикер (picker.html) ВСЕГДА показывает чекбокс "Поделиться звуком стрима" (по умолчанию
  //     включён) - явный и понятный контроль, а не скрытая логика.
  //  2. Аудио-трек запрашивается через 'loopback' ровно тогда, когда пользователь оставил чекбокс
  //     включённым (shareAudio), независимо от того, что именно передал рендерер в audioRequested -
  //     так гарантируется, что звук демонстрации будет слышен, если пользователь сам не отключил его.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const picked = await openPickerWindow()
      if (!picked) {
        // Пользователь отменил выбор - отдаём пустой результат, getDisplayMedia отклонится с NotAllowedError
        callback({})
        return
      }
      callback({
        video: picked.source,
        audio: picked.shareAudio ? 'loopback' : undefined
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
