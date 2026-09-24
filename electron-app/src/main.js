// ===================== Электрон: главный процесс =====================
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Menu, globalShortcut, clipboard, Tray, Notification, nativeImage, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')

// URL веб-приложения (Cloudflare Pages control-plane + фронтенд).
// Меняется на реальный адрес после деплоя backend'а.
const SERVER_URL = process.env.ZVONKI_SERVER_URL || 'https://voicelobby.online'

// Продукт теперь называется Voice Lobby, но папка данных остаётся прежней:
// иначе у всех, кто уже вошёл в приложении, слетела бы сессия и настройки устройств.
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'Звонки'))
} catch (e) {}

// ---- Только одна копия приложения ----
// Второй запуск (ярлык, автозапуск, ссылка voicelobby://) не открывает новое окно, а
// показывает уже работающее и передаёт ему ссылку.
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
}

// Ссылки вида voicelobby://dm/12 или voicelobby://room/abc123
const PROTOCOL = 'voicelobby'
// Путь к самому .exe: у portable-сборки process.execPath указывает на распакованную во временную
// папку копию, настоящий файл — в PORTABLE_EXECUTABLE_FILE
const EXE_PATH = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
const START_HIDDEN = process.argv.includes('--hidden')

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

// Разрешения, которые окно получает без вопросов. clipboard-* нужны, чтобы работало
// копирование кода комнаты/ссылки прямо со страницы (см. setPermission*Handler ниже).
const ALLOWED_PERMISSIONS = [
  'media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen',
  'clipboard-read', 'clipboard-sanitized-write'
]

let mainWindow = null
let pickerWindow = null
let tray = null
let isQuitting = false

// ---- Состояние оверлея для рисования поверх любых приложений ----
let overlayWindow = null
let overlayActive = false      // true = окно ловит мышь и можно рисовать
let overlayDisplayId = null    // на каком мониторе рисуем (тот, который демонстрируем)
let activeShortcuts = []       // горячие клавиши, которые реально удалось забрать у системы

function createMainWindow() {
  mainWindow = new BrowserWindow({
    // При автозапуске с Windows окно не показываем — приложение сидит в трее
    show: !START_HIDDEN,
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    // Иконка окна и панели задач — логотип «Живой голос» (тот же файл, что у .exe: build/icon.ico)
    icon: path.join(__dirname, 'icon.ico'),
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

  // Автоматически разрешаем доступ к камере/микрофону, fullscreen и буферу обмена.
  // ВАЖНО ("баг: в приложении не копируется код комнаты"): без clipboard-sanitized-write
  // navigator.clipboard.writeText() внутри .exe отклонялся молча, и клик по бейджу
  // "Комната: xxx" ничего не делал, хотя на сайте всё работало.
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission))
  })
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED_PERMISSIONS.includes(permission)
  })

  mainWindow.loadURL(SERVER_URL)

  // ---- Донастройка сайта под десктоп ----
  // Флаги Chromium выше снимают лимит рендера, но этого НЕ достаточно для 60 FPS в стриме:
  // потолок также задают constraints захвата и параметры публикации LiveKit (пресеты 15/30 FPS).
  mainWindow.webContents.on('did-finish-load', () => {
    setMiniMode(false)
    let boost = ''
    try {
      boost = fs.readFileSync(path.join(__dirname, 'site-boost.js'), 'utf8')
    } catch (e) {
      boost = ''
    }
    if (boost) {
      mainWindow.webContents.executeJavaScript(boost).catch(() => {})
    }
    // Ссылка, с которой запустили приложение, — после загрузки сайта
    if (pendingDeepLink) {
      mainWindow.webContents.send('social-deep-link', pendingDeepLink)
      pendingDeepLink = null
    }
  })

  // Крестик не закрывает приложение, а прячет его в трей: соединение с сервером продолжает
  // работать, сообщения и звонки приходят. Выход — через меню иконки в трее.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow.hide()
    showTrayHintOnce()
  })
  mainWindow.on('focus', () => { try { mainWindow.flashFrame(false) } catch (err) {} })

  mainWindow.on('closed', () => { mainWindow = null })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ===================== Настройки .exe (автозапуск и т.п.) =====================
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'desktop-settings.json')
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')) } catch (e) { return {} }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  try { fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(next, null, 2)) } catch (e) {}
  return next
}

// ---- Автозапуск с Windows ----
// Включён по умолчанию (как у Дискорда); выключается галочкой в меню трея. В режиме разработки
// (electron .) не трогаем, иначе в автозагрузку попал бы electron.exe.
function applyAutostart(enabled) {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: EXE_PATH, args: ['--hidden'] })
  } catch (e) {}
}
function autostartEnabled() {
  const s = readSettings()
  return s.autostart !== false
}

// ---- Ссылки voicelobby:// ----
let pendingDeepLink = null
function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL, EXE_PATH, [])
    }
  } catch (e) {}
}
function findDeepLink(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(PROTOCOL + '://')) || null
}
function openDeepLink(url) {
  if (!url) return
  showMainWindow()
  if (mainWindow && !mainWindow.webContents.isLoading()) sendToMain('social-deep-link', url)
  else pendingDeepLink = url
}

// ===================== Трей и счётчик непрочитанных =====================
let unreadCount = 0
let callActive = false
const ICON_PATH = path.join(__dirname, 'icon.ico')

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Открыть Voice Lobby', click: showMainWindow },
    { type: 'separator' },
    {
      label: muteAccelerator ? `Микрофон вкл/выкл (${muteAccelerator.replace('Control', 'Ctrl')})` : 'Микрофон вкл/выкл',
      enabled: callActive,
      click: () => sendToMain('toggle-mute')
    },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: autostartEnabled(),
      enabled: app.isPackaged,
      click: (item) => { writeSettings({ autostart: item.checked }); applyAutostart(item.checked) }
    },
    { type: 'separator' },
    { label: 'Выйти', click: () => { isQuitting = true; app.quit() } }
  ])
}

function createTray() {
  if (tray) return
  try {
    tray = new Tray(ICON_PATH)
  } catch (e) {
    tray = null
    return
  }
  tray.setToolTip('Voice Lobby')
  tray.setContextMenu(trayMenu())
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

function refreshTray() {
  if (!tray) return
  tray.setToolTip(unreadCount ? `Voice Lobby — непрочитанных: ${unreadCount}` : 'Voice Lobby')
  tray.setContextMenu(trayMenu())
}

function showTrayHintOnce() {
  const s = readSettings()
  if (s.trayHintShown || !tray) return
  writeSettings({ trayHintShown: true })
  try {
    tray.displayBalloon({
      iconType: 'info',
      title: 'Voice Lobby работает в трее',
      content: 'Сообщения и звонки продолжат приходить. Выйти можно через меню этой иконки.'
    })
  } catch (e) {}
}

ipcMain.on('social-badge', (_e, data) => {
  unreadCount = Math.max(0, Number(data && data.count) || 0)
  try { app.setBadgeCount(unreadCount) } catch (e) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Красный кружок с числом поверх иконки на панели задач (Windows)
    try {
      const img = unreadCount && data.overlay ? nativeImage.createFromDataURL(data.overlay) : null
      mainWindow.setOverlayIcon(img && !img.isEmpty() ? img : null, unreadCount ? `Непрочитанных: ${unreadCount}` : '')
    } catch (e) {}
  }
  if (tray) {
    try {
      const img = unreadCount && data.tray ? nativeImage.createFromDataURL(data.tray) : null
      tray.setImage(img && !img.isEmpty() ? img.resize({ width: 32, height: 32 }) : ICON_PATH)
    } catch (e) {}
  }
  refreshTray()
})

// ===================== Уведомления Windows =====================
// Ссылки на уведомления держим, пока они живы: иначе сборщик мусора забирает объект и клик
// по уведомлению уже никуда не ведёт.
const liveNotifications = new Set()
ipcMain.on('social-notify', (_e, data) => {
  if (!Notification.isSupported()) {
    if (mainWindow && !mainWindow.isFocused()) try { mainWindow.flashFrame(true) } catch (err) {}
    return
  }
  const n = new Notification({
    title: String(data.title || 'Voice Lobby').slice(0, 120),
    body: String(data.body || '').slice(0, 300),
    icon: ICON_PATH,
    silent: true // звук играет сама страница, двойной не нужен
  })
  liveNotifications.add(n)
  const drop = () => liveNotifications.delete(n)
  n.on('click', () => {
    drop()
    showMainWindow()
    if (data.route) sendToMain('social-navigate', data.route)
  })
  n.on('close', drop)
  n.on('failed', drop)
  n.show()
  if (mainWindow && !mainWindow.isFocused()) try { mainWindow.flashFrame(true) } catch (err) {}
})

// ===================== Окно входящего звонка =====================
let callWindow = null
let callWindowCallId = null

function showIncomingCall(data) {
  const callId = String((data && data.callId) || '')
  if (!callId) return
  callWindowCallId = callId
  const payload = {
    callId,
    name: String(data.name || 'Звонок').slice(0, 60),
    initials: String(data.initials || '?').slice(0, 3),
    color: /^hsl\([\d.\s%]+\)$|^#[0-9a-f]{3,8}$/i.test(String(data.color || '')) ? String(data.color) : '#0458cf'
  }
  if (!callWindow || callWindow.isDestroyed()) {
    const { workArea } = screen.getPrimaryDisplay()
    const width = 360
    const height = 96
    callWindow = new BrowserWindow({
      width,
      height,
      x: workArea.x + workArea.width - width - 16,
      y: workArea.y + workArea.height - height - 16,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      show: false,
      backgroundColor: '#15181e',
      title: 'Входящий звонок',
      icon: ICON_PATH,
      webPreferences: {
        preload: path.join(__dirname, 'call-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Мелодия должна играть без клика по окну
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    callWindow.setAlwaysOnTop(true, 'screen-saver')
    callWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    callWindow.loadFile(path.join(__dirname, 'call.html'))
    callWindow.webContents.once('did-finish-load', () => {
      if (!callWindow || callWindow.isDestroyed()) return
      callWindow.webContents.send('call-data', callWindow.__payload)
      callWindow.showInactive()
    })
    callWindow.on('closed', () => { callWindow = null; callWindowCallId = null })
  } else {
    callWindow.webContents.send('call-data', payload)
    callWindow.showInactive()
  }
  callWindow.__payload = payload
  // Мигание на панели задач, пока не ответили
  if (mainWindow && !mainWindow.isDestroyed()) try { mainWindow.flashFrame(true) } catch (e) {}
}

function hideIncomingCall(callId) {
  if (callId && callWindowCallId && callId !== callWindowCallId) return
  if (callWindow && !callWindow.isDestroyed()) callWindow.close()
  callWindow = null
  callWindowCallId = null
  if (mainWindow && !mainWindow.isDestroyed()) try { mainWindow.flashFrame(false) } catch (e) {}
}

ipcMain.on('incoming-call-show', (_e, data) => showIncomingCall(data || {}))
ipcMain.on('incoming-call-hide', (_e, callId) => hideIncomingCall(String(callId || '')))
ipcMain.on('incoming-call-action', (_e, data) => {
  const callId = String((data && data.callId) || '')
  const action = data && data.action === 'accept' ? 'accept' : 'decline'
  hideIncomingCall(callId)
  if (action === 'accept') showMainWindow()
  sendToMain('incoming-call-action', { callId, action })
})

// ===================== Микрофон горячей клавишей (работает при свёрнутом окне) =====================
// Клавиша забирается у системы только на время звонка: вне звонка она не должна мешать другим
// программам.
let muteAccelerator = null
function setCallActive(active) {
  callActive = !!active
  if (callActive && !muteAccelerator) {
    for (const accel of ['Control+Alt+M', 'Alt+Shift+M']) {
      try {
        if (globalShortcut.register(accel, () => sendToMain('toggle-mute'))) { muteAccelerator = accel; break }
      } catch (e) {}
    }
  } else if (!callActive && muteAccelerator) {
    try { globalShortcut.unregister(muteAccelerator) } catch (e) {}
    muteAccelerator = null
  }
  refreshTray()
}
ipcMain.on('social-call-state', (_e, active) => setCallActive(!!active))

// ===================== «Отошёл» по простою системы =====================
const IDLE_SECONDS = 10 * 60
let idleState = false
function setIdle(idle) {
  if (idle === idleState) return
  idleState = idle
  sendToMain('idle-change', idle)
}
function watchIdle() {
  setInterval(() => {
    try { setIdle(powerMonitor.getSystemIdleTime() >= IDLE_SECONDS) } catch (e) {}
  }, 30000)
  try {
    powerMonitor.on('lock-screen', () => setIdle(true))
    powerMonitor.on('unlock-screen', () => setIdle(false))
    powerMonitor.on('resume', () => setIdle(false))
  } catch (e) {}
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

// ---- Свои собственные окна в списке источников не нужны ----
// Оверлей рисования (overlay.html, заголовок "Аннотации") и сам пикер физически существуют
// в системе, поэтому desktopCapturer отдаёт их как обычные окна: в списке появлялись пустые
// чёрные плитки "Аннотации", выбрать которые бессмысленно (оверлей прозрачный, показывать
// в нём нечего). Отсекаем их двумя способами: по нативному хэндлу окна (надёжно) и по
// заголовку наших внутренних страниц (страховка, если формат source.id изменится).
const INTERNAL_WINDOW_TITLES = new Set(['Аннотации', 'Выберите экран или окно'])

// ВАЖНО ("баг: в списке источников пустые плитки about:blank"): служебные окна Chromium/Electron
// (в т.ч. невидимые вспомогательные окна нашего же приложения) попадают в desktopCapturer с
// заголовком about:blank. Показывать их нельзя - это пустые чёрные плитки, которые пользователь
// принимает за сломанные превью. Сравниваем заголовок в нижнем регистре.
// Список намеренно узкий: "untitled"/"blank" бывают настоящими именами документов,
// и отсекать их было бы уже вредно.
const BLANK_WINDOW_TITLES = new Set(['about:blank', 'about:blank#blocked'])

function nativeHandleKeys(win) {
  const keys = []
  try {
    const buf = win.getNativeWindowHandle()
    if (buf && buf.length >= 4) keys.push(String(buf.readUInt32LE(0)))
    if (buf && buf.length >= 8) keys.push(String(buf.readBigUInt64LE(0)))
  } catch (e) { /* платформа без нативного хэндла - остаётся фильтр по заголовку */ }
  return keys
}

// Раньше проверялись только overlayWindow и pickerWindow, поэтому любое другое окно самого
// приложения (главное окно, служебные окна Chromium) оставалось в списке. Берём ВСЕ окна
// процесса - тогда "свои" окна отсекаются независимо от того, кто их создал.
function internalWindowHandles() {
  const handles = new Set()
  let windows = []
  try { windows = BrowserWindow.getAllWindows() } catch (e) { windows = [] }
  for (const win of windows) {
    if (win && !win.isDestroyed()) nativeHandleKeys(win).forEach((k) => handles.add(k))
  }
  return handles
}

// Оставляем в списке только то, что пользователь реально может показать.
function isPickableSource(source, internalHandles) {
  if (!source || !source.id) return false
  if (source.id.startsWith('screen')) return true
  const name = String(source.name || '').trim()
  if (!name) return false // безымянные служебные окна ОС: в списке это чёрная плитка без подписи
  if (BLANK_WINDOW_TITLES.has(name.toLowerCase())) return false
  if (INTERNAL_WINDOW_TITLES.has(name)) return false
  // source.id окна выглядит как "window:<хэндл>:<индекс>"
  const handle = source.id.split(':')[1]
  if (handle && internalHandles.has(handle)) return false
  return true
}

// ---- Обработчик системного выбора источника экрана/окна ----
// Electron сам не показывает системный диалог выбора экрана как в браузере - рисуем свой,
// и отдаём выбранный источник через setDisplayMediaRequestHandler.
// Возвращает { source, shareAudio } (или null при отмене).
function openPickerWindow() {
  return new Promise((resolve) => {
    // 16:9 под рамку плитки в picker.html. Размер снижен с 480x270 до 320x180: плитка в списке
    // занимает ~175 CSS-px, так что 320px хватает даже при масштабе 150%, а вот цена больших
    // превью была высокой - каждое уезжает в рендерер как base64-строка (toDataURL), и на
    // машине с десятком открытых окон это давало многомегабайтный IPC-пакет и заметные
    // подлагивания при скролле списка.
    // fetchWindowIcons даёт иконку приложения - с ней окно опознаётся быстрее, чем по превью.
    desktopCapturer
      .getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true
      })
      .then((allSources) => {
        const internalHandles = internalWindowHandles()
        const sources = allSources.filter((s) => isPickableSource(s, internalHandles))

        // Размер подбираем под рабочую область экрана: на ноутбуках с 768px по высоте
        // фиксированные 620px + рамка + панель задач не влезали, и окно само уезжало в прокрутку.
        const workArea = screen.getPrimaryDisplay().workAreaSize
        const pickerWidth = Math.max(600, Math.min(900, workArea.width - 120))
        const pickerHeight = Math.max(460, Math.min(680, workArea.height - 120))

        pickerWindow = new BrowserWindow({
          width: pickerWidth,
          height: pickerHeight,
          minWidth: 560,
          minHeight: 420,
          resizable: true,
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
            thumbnail: s.thumbnail.toDataURL(),
            // appIcon есть не у всех окон и никогда нет у экранов - передаём null, рендерер его просто пропустит
            icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
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

// ---- Буфер обмена ----
// Самый надёжный путь для .exe: пишем через нативный clipboard главного процесса, минуя
// разрешения и требования к "жесту пользователя" у navigator.clipboard в рендерере.
// На сайте этот мост отсутствует, и app.js сам падает обратно на navigator.clipboard.
// ---- «Звонок в отдельном окне» (мини-режим главного окна) ----
// Окно запоминает прежние размер/положение, ужимается в правый нижний угол текущего монитора
// и встаёт поверх остальных программ. Выход — возврат ровно туда, где было.
let miniState = null
const MINI_SIZE = { width: 440, height: 340 }

function setMiniMode(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (on && !miniState) {
    miniState = {
      bounds: mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    }
    if (miniState.fullscreen) mainWindow.setFullScreen(false)
    if (miniState.maximized) mainWindow.unmaximize()
    const { workArea } = screen.getDisplayMatching(miniState.bounds)
    const margin = 16
    mainWindow.setMinimumSize(320, 240)
    mainWindow.setBounds({
      x: workArea.x + workArea.width - MINI_SIZE.width - margin,
      y: workArea.y + workArea.height - MINI_SIZE.height - margin,
      width: MINI_SIZE.width,
      height: MINI_SIZE.height
    })
    mainWindow.setAlwaysOnTop(true, 'floating')
  } else if (!on && miniState) {
    const prev = miniState
    miniState = null
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setMinimumSize(900, 600)
    mainWindow.setBounds(prev.bounds)
    if (prev.maximized) mainWindow.maximize()
    if (prev.fullscreen) mainWindow.setFullScreen(true)
  }
  return true
}

ipcMain.handle('set-mini-mode', (_e, on) => setMiniMode(!!on))

ipcMain.handle('clipboard-write', (_e, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text))
    return true
  } catch (e) {
    return false
  }
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

// Второй запуск: показать окно и передать ссылку voicelobby://, если она есть
app.on('second-instance', (_e, argv) => {
  const link = findDeepLink(argv)
  if (link) openDeepLink(link)
  else showMainWindow()
})
// macOS присылает ссылки отдельным событием
app.on('open-url', (e, url) => { e.preventDefault(); openDeepLink(url) })
app.on('before-quit', () => { isQuitting = true })

app.whenReady().then(() => {
  if (!gotSingleLock) return
  // Нужен Windows, чтобы уведомления показывались от имени приложения (совпадает с appId сборки)
  try { app.setAppUserModelId('com.zvonki.desktop') } catch (e) {}
  pendingDeepLink = findDeepLink(process.argv)
  registerProtocol()
  const settings = readSettings()
  if (settings.autostart === undefined) writeSettings({ autostart: true })
  applyAutostart(autostartEnabled())
  createMainWindow()
  createTray()
  watchIdle()

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
    if (!mainWindow) createMainWindow()
    else showMainWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Главное окно при закрытии прячется в трей, поэтому сюда попадаем только при настоящем выходе
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isQuitting) app.quit()
})
