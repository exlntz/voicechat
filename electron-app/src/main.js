// ===================== Электрон: главный процесс =====================
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Menu, globalShortcut, clipboard } = require('electron')
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
