// ===================== Электрон: главный процесс =====================
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Menu, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')

// URL веб-приложения (Cloudflare Pages control-plane + фронтенд).
// Меняется на реальный адрес после деплоя backend'а.
const SERVER_URL = process.env.ZVONKI_SERVER_URL || 'https://app.185.199.199.114.nip.io'

// ---- GPU / аппаратное ускорение кодирования видео (для плавной демонстрации экрана, как в Discord) ----
app.commandLine.appendSwitch('enable-accelerated-video-encode')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
// Явно включаем WebRTC H264 hardware encoding через Chromium feature flags
app.commandLine.appendSwitch('enable-features', 'WebRtcH264WithOpenH264FFmpeg,VaapiVideoEncoder,VaapiVideoDecoder')

// ---- Флаги ради стабильных 60 FPS демонстрации ----
app.commandLine.appendSwitch('disable-frame-rate-limit')
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('force_high_performance_gpu')
// Без этих двух Chromium усыпляет таймеры и рендерер, когда окно перекрыто другой
// программой - а во время урока оно перекрыто практически всегда.
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

let mainWindow = null
let pickerWindow = null

// ---- Состояние оверлея для рисования поверх любых приложений ----
let overlayWindow = null
let overlayActive = false      // true = окно ловит мышь и можно рисовать
let overlayDisplayId = null    // на каком мониторе рисуем (тот, который демонстрируем)
let activeShortcuts = []       // горячие клавиши, которые реально удалось забрать у системы

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
      sandbox: false,
      // Без этого Chromium режет частоту кадров и таймеры, когда окно свёрнуто или перекрыто.
      backgroundThrottling: false
    }
  })

  Menu.setApplicationMenu(null)

  // Автоматически разрешаем доступ к камере/микрофону и fullscreen.
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen']
    callback(allowed.includes(permission))
  })
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen']
    return allowed.includes(permission)
  })

  mainWindow.loadURL(SERVER_URL)

  // ---- Донастройка сайта под десктоп ----
  // Флаги Chromium выше снимают лимит рендера, но этого НЕ достаточно для 60 FPS в стриме:
  // потолок также задают constraints захвата и параметры публикации LiveKit (пресеты 15/30 FPS).
  mainWindow.webContents.on('did-finish-load', () => {
    let boost = ''
    try {
      boost = fs.readFileSync(path.join(__dirname, 'site-boost.js'), 'utf8')
    } catch (e) {
      boost = ''
    }
    if (boost) {
      mainWindow.webContents.executeJavaScript(boost).catch(() => {})
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ===================== Оверлей для рисования поверх экрана =====================
// Отдельное прозрачное окно без рамки размером во весь монитор, которое висит поверх всех
// окон ОС. Поскольку оно физически нарисовано на экране, захват экрана забирает его вместе
// с картинкой - собеседники видят рисунок как часть видео, без сетевой синхронизации.
//
// Три режима:
//  - пассивный: рисунок виден, клики проходят насквозь;
//  - рисование: окно ловит мышь, видна панель инструментов;
//  - режим мыши (управляется из overlay.html): рисунок и панель остаются на экране, но клики
//    уходят в программы под оверлеем везде, кроме самой панели (см. 'overlay-set-ignore-mouse').

function getTargetDisplay() {
  const displays = screen.getAllDisplays()
  if (overlayDisplayId !== null && overlayDisplayId !== undefined) {
    const found = displays.find((d) => String(d.id) === String(overlayDisplayId))
    if (found) return found
  }
  // Если не знаем, какой экран демонстрируется - берём тот, где сейчас курсор.
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  } catch (e) {
    return screen.getPrimaryDisplay()
  }
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  const bounds = getTargetDisplay().bounds

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // Без backgroundColor с нулевой альфой Windows может залить окно чёрным.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  // 'screen-saver' - самый высокий уровень: оверлей остаётся поверх даже полноэкранных приложений.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Стартуем в пассивном режиме: клики проходят насквозь в обычные программы.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))

  overlayWindow.on('closed', () => {
    overlayWindow = null
    overlayActive = false
  })

  return overlayWindow
}

function showOverlayPassive() {
  const win = createOverlayWindow()
  if (!win.isVisible()) win.showInactive()
  sendOverlayState()
}

function sendOverlayState() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-state', { active: overlayActive })
  }
}

function setOverlayActive(active) {
  const win = createOverlayWindow()
  overlayActive = !!active

  if (overlayActive) {
    // Окно могло остаться на старом мониторе или пережить смену разрешения - выравниваем по экрану.
    const bounds = getTargetDisplay().bounds
    win.setBounds(bounds)
    win.setIgnoreMouseEvents(false)
    win.show()
    win.focus()
  } else {
    win.setIgnoreMouseEvents(true, { forward: true })
    if (!win.isVisible()) win.showInactive()
    // Возвращаем фокус тому, с чем работал пользователь, чтобы оверлей не перехватывал клавиатуру.
    if (win.blur) win.blur()
  }

  sendOverlayState()
}

function toggleOverlayDrawing() {
  setOverlayActive(!overlayActive)
}

function sendOverlayCommand(command) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-command', command)
  }
}

function hideOverlay() {
  overlayActive = false
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-command', 'clear')
    overlayWindow.hide()
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  }
}

ipcMain.on('overlay-exit', () => setOverlayActive(false))
ipcMain.on('overlay-hide', () => hideOverlay())
// Кнопка "Рисовать" из интерфейса сайта (site-boost.js -> preload -> сюда).
ipcMain.on('toggle-drawing', () => toggleOverlayDrawing())
ipcMain.handle('get-drawing-shortcuts', () => activeShortcuts)

// ---- Режим мыши внутри активного рисования ----
// Оверлей сам решает, когда ему нужна мышь: в режиме мыши клики должны уходить в другие
// программы, но когда курсор наведён на панель инструментов - окно снова должно ловить клики,
// иначе кнопки были бы мертвыми. forward: true обязателен - без него окно перестало бы
// получать mousemove и не узнало бы, что курсор вернулся на панель.
ipcMain.on('overlay-set-ignore-mouse', (_e, ignore) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (ignore) overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  else overlayWindow.setIgnoreMouseEvents(false)
})
ipcMain.on('overlay-focus', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.focus()
})

// ---- Обработчик системного выбора источника экрана/окна ----
// Electron сам не показывает системный диалог выбора экрана как в браузере - рисуем свой,
// и отдаём выбранный источник через setDisplayMediaRequestHandler.
// Возвращает { source, shareAudio } (или null при отмене).
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

// Оставляем IPC-метод для обратной совместимости - возвращает только id источника.
ipcMain.handle('choose-screen-source', async () => {
  const picked = await openPickerWindow()
  return picked ? picked.source.id : null
})

// ---- Регистрация горячих клавиш с запасными вариантами ----
// globalShortcut.register возвращает false, если комбинация уже занята другой программой
// (например, Ctrl+Shift+D любят занимать браузеры и панели GPU) - и раньше это проходило
// тихо, из-за чего рисование выглядело полностью отсутствующим.
function registerShortcut(candidates, handler, label) {
  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, handler)) {
        activeShortcuts.push({ action: label, accelerator: accel })
        return accel
      }
    } catch (e) { /* пробуем следующий вариант */ }
  }
  return null
}

app.whenReady().then(() => {
  createMainWindow()

  // ---- Глобальные горячие клавиши рисования ----
  // Работают из любого приложения, даже когда наше окно свёрнуто.
  // F7-F10 идут запасными: одиночные функциональные клавиши редко заняты в системе.
  registerShortcut(['Control+Shift+D', 'Alt+D', 'F8'], toggleOverlayDrawing, 'вкл/выкл рисования')
  // Переключение между карандашом и обычной мышкой без выхода из режима рисования:
  // рисунок и панель остаются на экране, но можно листать и двигать окна.
  registerShortcut(['Control+Shift+M', 'Alt+M', 'F7'], () => sendOverlayCommand('cursor'), 'мышь/рисование')
  registerShortcut(['Control+Shift+Z', 'Alt+Z', 'F9'], () => sendOverlayCommand('undo'), 'отмена')
  registerShortcut(['Control+Shift+X', 'Alt+X', 'F10'], () => sendOverlayCommand('clear'), 'стереть всё')

  // ---- Захват экрана + системного звука для getDisplayMedia() из рендерера ----
  // 'loopback' поддерживается на Windows (наша целевая платформа).
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const picked = await openPickerWindow()
      if (!picked) {
        // Пользователь отменил выбор - отдаём пустой результат
        callback({})
        return
      }

      // Если демонстрируется целый экран - сразу готовим оверлей на этом же мониторе,
      // чтобы рисунок гарантированно попадал в захват. Для захвата отдельного окна это
      // не работает принципиально: ОС отдаёт содержимое ровно одного окна.
      if (picked.source.id.startsWith('screen')) {
        overlayDisplayId = picked.source.display_id || null
        showOverlayPassive()
      }

      // ВАЖНО: Electron требует, чтобы ключ audio либо был валидной строкой
      // ('loopback'/'loopbackWithMute'), либо ПОЛНОСТЬЮ ОТСУТСТВОВАЛ в объекте - передача
      // audio: undefined кидает TypeError внутри Electron и демонстрация не стартует вообще.
      const result = { video: picked.source }
      if (picked.shareAudio) result.audio = 'loopback'
      callback(result)
    } catch (e) {
      callback({})
    }
  }, { useSystemPicker: false })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
