// ===================== Электрон: главный процесс =====================
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Menu, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')

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

// ---- Флаги ради стабильных 60 FPS демонстрации ----
// По умолчанию Chromium ограничивает частоту кадров захвата и рендера вертикальной синхронизацией
// и внутренним лимитом - именно поэтому на сайте потолок получается около 40-50 кадров.
// В своём .exe эти ограничения можно снять - браузер такого не позволяет.
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
      // Разрешаем доступ к getUserMedia/getDisplayMedia без системного диалога Chromium -
      // диалог мы рисуем сами через chooseScreenSource()
      sandbox: false,
      // Без этого Chromium режет частоту кадров и таймеры, когда окно свёрнуто или перекрыто
      // другим приложением - а при демонстрации экрана окно почти всегда перекрыто.
      backgroundThrottling: false
    }
  })

  Menu.setApplicationMenu(null)

  // Автоматически разрешаем доступ к камере/микрофону (нужно самому пользователю для звонка).
  // 'fullscreen' обязательно должен быть в списке - это отдельное разрешение Chromium для Fullscreen
  // API (document.requestFullscreen()). Без него Electron тихо отклоняет ЛЮБОЙ запрос на полноэкранный
  // режим (кнопка/дабл-клик на тайле демонстрации или камеры) - баг "не открывается на фулл" в .exe.
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen']
    callback(allowed.includes(permission))
  })
  // permissionCheckHandler дополняет permissionRequestHandler - некоторые проверки (в т.ч. fullscreen)
  // идут именно через check, а не request, и без этого обработчика Electron может отказать по умолчанию.
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen']
    return allowed.includes(permission)
  })

  mainWindow.loadURL(SERVER_URL)

  // ---- Донастройка сайта под десктоп ----
  // Флаги Chromium выше снимают лимит рендера, но этого НЕ достаточно для 60 FPS в стриме:
  // потолок также задают constraints захвата и параметры публикации LiveKit (пресеты 15/30 FPS).
  // Их можно переопределить только внутри страницы - для этого впрыскиваем site-boost.js.
  // Скрипт лежит отдельным файлом, а не строкой в коде, чтобы его можно было нормально править.
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
// Главная идея: это отдельное прозрачное окно без рамки размером во весь монитор, которое
// висит поверх всех окон ОС. Поскольку оно физически нарисовано на экране, захват экрана
// забирает его вместе с картинкой - собеседники видят рисунок как часть видео, без отдельного
// сетевого протокола и без задержки синхронизации.
//
// Три режима:
//  - скрыт/пассивный: рисунок виден, но клики проходят насквозь;
//  - рисование: окно ловит мышь, видна панель инструментов, рисуем;
//  - режим мыши (управляется из overlay.html): рисунок и панель остаются, но клики уходят
//    в программы под оверлеем везде, кроме самой панели (см. 'overlay-set-ignore-mouse').
// Переключение - кнопкой в интерфейсе или глобальной горячей клавишей из любого приложения.

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
// Горячая клавиша может быть занята другой программой, поэтому нужен явный видимый способ включения.
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

// ---- Обработчик системного выбора 