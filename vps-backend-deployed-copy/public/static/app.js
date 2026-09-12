// ===================== Voice Lobby: клиентское приложение =====================
// Работает как в браузере, так и внутри Electron (window.electronAPI, если доступен)
const LK = window.LivekitClient
const IS_ELECTRON = !!window.electronAPI

const state = {
  currentUser: null, // { id, username, displayName } - авторизованный пользователь (см. renderAuthScreen/fetchMe)
  room: null,
  roomCode: null,
  displayName: '',
  cameraEnabled: false, // по умолчанию входим в звонок с выключенной камерой
  micEnabled: true,
  screenShares: new Map(), // trackSid -> { participantIdentity, participantName }
  maxScreenShares: 2,
  maxParticipants: 5,
  previewStream: null,
  selectedCamId: null,
  selectedMicId: null,
  selectedSpeakerId: null,
  isHost: false, // является ли текущий пользователь создателем комнаты
  hostSecret: null, // секрет для управления комнатой (выгон участников), известен только создателю
  // "Поделиться звуком стрима" - по умолчанию ВКЛЮЧЕНО (звук демонстрации должен быть слышен всегда,
  // если явно не выключен пользователем через кастомное контекстное меню на тайле демонстрации)
  screenShareAudioShared: localStorage.getItem('screenShareAudioShared') !== '0',
  // Выбранная частота кадров демонстрации экрана (меняется только в меню ПКМ на своём тайле,
  // запоминается между звонками)
  screenShareFps: Number(localStorage.getItem('screenShareFps')) || 60
}

// ---- Демонстрация экрана: параметры передачи ----
// Частота кадров выбирается ТОЛЬКО в контекстном меню своего тайла демонстрации
// (ПКМ -> "Качество передачи" -> 15/30/60 FPS). Отдельного селектора/кнопки рядом с кнопкой
// демонстрации намеренно нет - в панели управления должны оставаться только основные действия.
// Выбор запоминается в localStorage и применяется к уже идущей демонстрации "живьём"
// (applyScreenShareFps), без перезапуска стрима.
const SCREEN_SHARE_FPS_OPTIONS = [15, 30, 60]
// Оптимизация картинки фиксирована: подменю "Движение/чёткость" убрано - в звонке всегда
// нужна плавность (motion), а не резкость статичного текста.
const SCREEN_SHARE_CONTENT_HINT = 'motion'

const root = document.getElementById('app-root')

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (k === 'html') node.innerHTML = v
    else node.setAttribute(k, v)
  }
  for (const child of [].concat(children)) {
    if (child == null) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container')
  if (!container) {
    container = el('div', { class: 'toast-container' })
    document.body.appendChild(container)
  }
  const toast = el('div', { class: `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}` }, message)
  container.appendChild(toast)
  setTimeout(() => toast.remove(), 4500)
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase()
}

// Поле пароля с кнопкой-глазиком, переключающей видимость введённого текста (type: password <-> text).
// Возвращает { wrapper, input } - wrapper вставляется в форму, input используется как обычное поле
// (value, addEventListener и т.д.), логика клика по глазику инкапсулирована здесь.
function makePasswordField(placeholder, maxlength, autocomplete) {
  const input = el('input', { type: 'password', placeholder, maxlength, autocomplete })
  const eyeIcon = el('i', { class: 'fas fa-eye' })
  const toggleBtn = el('button', { type: 'button', class: 'password-toggle-btn', tabindex: '-1', 'aria-label': 'Показать пароль' }, [eyeIcon])
  toggleBtn.addEventListener('click', () => {
    const shown = input.type === 'text'
    input.type = shown ? 'password' : 'text'
    eyeIcon.className = shown ? 'fas fa-eye' : 'fas fa-eye-slash'
    toggleBtn.setAttribute('aria-label', shown ? 'Показать пароль' : 'Скрыть пароль')
  })
  const wrapper = el('div', { class: 'password-field' }, [input, toggleBtn])
  return { wrapper, input }
}

// ===================== АВТОРИЗАЦИЯ (регистрация / вход) =====================
// Требование: пользователь должен быть залогинен, чтобы попасть в приложение (звонок).
// Сессия хранится в httpOnly-cookie (см. server.js) - на фронтенде просто дёргаем /api/auth/me
// при загрузке и, если не авторизован, показываем экран логина/регистрации вместо лобби.

async function fetchMe() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
    if (!res.ok) return null
    const data = await res.json()
    return data.user || null
  } catch {
    return null
  }
}

// Экран входа/регистрации в виде анимированной "раздвижной панели" (форма слева/справа,
// сплошная акцентная панель с призывом к действию сдвигается между ними). На десктопе -
// полноценная анимация сдвига (как в референсном видео, но сплошные цвета без градиентов).
// На узких экранах (телефон) 2-колоночная механика физически не влезает - там просто
// показываем текущую форму + текстовую подсказку-переключатель под ней (без анимации сдвига).
function renderAuthScreen(afterLoginRoomCode = '') {
  root.innerHTML = ''

  let mode = 'login' // 'login' | 'register'

  const screen = el('div', { class: 'auth-screen' })
  const container = el('div', { class: 'auth-container', 'data-mode': 'login' })

  // ---- Форма входа ----
  const loginErrorSlot = el('div', { class: 'auth-error', style: 'display:none' })
  const loginUsername = el('input', { type: 'text', placeholder: 'Юзернейм', maxlength: '24', autocomplete: 'username' })
  const { wrapper: loginPasswordField, input: loginPassword } = makePasswordField('Пароль', '100', 'current-password')
  const loginSubmit = el('button', { type: 'button', class: 'auth-submit-btn' }, 'Войти')

  // Текстовая ссылка-переключатель под формой - видна только на узких экранах (телефон),
  // где двухпанельный слайдер физически не влезает (см. media query в style.css)
  const mobileToRegister = el('button', { type: 'button', class: 'auth-switch-link' }, 'Зарегистрироваться')
  const mobileSwitchToRegister = el('div', { class: 'auth-mobile-switch' }, ['Нет аккаунта? ', mobileToRegister])

  const loginPanel = el('div', { class: 'auth-form-panel auth-signin' }, [
    el('h1', {}, 'Вход'),
    el('div', { class: 'auth-form-hint' }, 'Используйте юзернейм и пароль от аккаунта'),
    loginErrorSlot,
    loginUsername,
    loginPasswordField,
    loginSubmit,
    mobileSwitchToRegister
  ])

  // ---- Форма регистрации ----
  // "Отображаемое имя" (может быть на любом языке, включая кириллицу) - то, что видят другие
  // участники звонка. "Юзернейм" - технический идентификатор для входа в аккаунт (и в будущем -
  // для добавления в друзья), поэтому строго ограничен латиницей/цифрами/_/- .
  const registerErrorSlot = el('div', { class: 'auth-error', style: 'display:none' })
  const registerDisplayName = el('input', { type: 'text', placeholder: 'Отображаемое имя', maxlength: '40', autocomplete: 'name' })
  const registerUsername = el('input', { type: 'text', placeholder: 'Юзернейм (для входа)', maxlength: '24', autocomplete: 'username' })
  const { wrapper: registerPasswordField, input: registerPassword } = makePasswordField('Пароль (мин. 6 символов)', '100', 'new-password')
  const registerSubmit = el('button', { type: 'button', class: 'auth-submit-btn' }, 'Зарегистрироваться')

  const mobileToLogin = el('button', { type: 'button', class: 'auth-switch-link' }, 'Войти')
  const mobileSwitchToLogin = el('div', { class: 'auth-mobile-switch' }, ['Уже есть аккаунт? ', mobileToLogin])

  const registerPanel = el('div', { class: 'auth-form-panel auth-signup' }, [
    el('h1', {}, 'Регистрация'),
    el('div', { class: 'auth-form-hint' }, 'Создайте аккаунт, чтобы заходить в звонки с любого устройства'),
    registerErrorSlot,
    registerDisplayName,
    registerUsername,
    registerPasswordField,
    registerSubmit,
    mobileSwitchToLogin
  ])

  // ---- Акцентная сдвигающаяся панель с призывом к действию (правая CTA = "войти в звонки",
  // левая CTA = "уже есть аккаунт") ----
  const toRegisterBtn = el('button', { type: 'button', class: 'auth-ghost-btn' }, 'Регистрация')
  const overlayRight = el('div', { class: 'auth-overlay-panel auth-overlay-right' }, [
    el('div', { class: 'auth-brand' }, 'Voice Lobby'),
    el('h1', {}, 'Привет!'),
    el('p', {}, 'Введите логин и пароль, чтобы начать пользоваться сервисом'),
    toRegisterBtn
  ])

  const toLoginBtn = el('button', { type: 'button', class: 'auth-ghost-btn' }, 'Войти')
  const overlayLeft = el('div', { class: 'auth-overlay-panel auth-overlay-left' }, [
    el('div', { class: 'auth-brand' }, 'Voice Lobby'),
    el('h1', {}, 'С возвращением!'),
    el('p', {}, 'Чтобы продолжить, войдите с вашим логином и паролем'),
    toLoginBtn
  ])

  const overlay = el('div', { class: 'auth-overlay' }, [overlayLeft, overlayRight])
  const overlayContainer = el('div', { class: 'auth-overlay-container' }, [overlay])

  container.appendChild(loginPanel)
  container.appendChild(registerPanel)
  container.appendChild(overlayContainer)
  // На телефоне акцентная панель с названием скрыта — выводим название отдельной шапкой
  screen.appendChild(el('div', { class: 'auth-brand-mobile' }, 'Voice Lobby'))
  screen.appendChild(container)
  root.appendChild(screen)

  function setMode(next) {
    mode = next
    container.dataset.mode = mode
    container.classList.toggle('right-panel-active', mode === 'register')
    loginErrorSlot.style.display = 'none'
    loginErrorSlot.classList.remove('success')
    registerErrorSlot.style.display = 'none'
    registerErrorSlot.classList.remove('success')
  }

  toRegisterBtn.addEventListener('click', () => setMode('register'))
  toLoginBtn.addEventListener('click', () => setMode('login'))
  mobileToRegister.addEventListener('click', () => setMode('register'))
  mobileToLogin.addEventListener('click', () => setMode('login'))

  // type: 'error' (красный, по умолчанию) | 'success' (зелёный, для сообщения после регистрации)
  function showMessage(slot, message, type = 'error') {
    slot.style.display = 'block'
    slot.textContent = message
    slot.classList.toggle('success', type === 'success')
  }

  async function submit(kind, usernameInput, passwordInput, errorSlot, submitBtn, defaultLabel, loadingLabel, displayNameInput) {
    const username = usernameInput.value.trim()
    const password = passwordInput.value
    const displayName = displayNameInput ? displayNameInput.value.trim() : undefined

    errorSlot.style.display = 'none'
    errorSlot.classList.remove('success')
    submitBtn.disabled = true
    submitBtn.textContent = loadingLabel

    try {
      const endpoint = kind === 'login' ? '/api/auth/login' : '/api/auth/register'
      const payload = { username, password }
      if (displayNameInput) payload.displayName = displayName
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'Ошибка авторизации')

      submitBtn.disabled = false
      submitBtn.textContent = defaultLabel

      if (kind === 'register') {
        // По просьбе пользователя после регистрации не бросаем сразу в звонок - вместо этого
        // красиво (той же анимацией слайдера, что и обычное переключение форм) переводим на
        // форму входа и подставляем туда только что введённые юзернейм/пароль, чтобы пользователю
        // достаточно было просто нажать "Войти". Эндпоинт /api/auth/register сам создаёт сессию
        // (см. server.js) - разлогиниваем, чтобы вход происходил осознанно через форму логина.
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
        registerDisplayName.value = ''
        registerUsername.value = ''
        registerPassword.value = ''
        setMode('login')
        loginUsername.value = username
        loginPassword.value = password
        showMessage(loginErrorSlot, 'Аккаунт создан! Проверьте данные и нажмите «Войти»', 'success')
        showToast('Регистрация завершена', 'success')
        loginSubmit.focus()
        return
      }

      state.currentUser = data.user
      renderLobby(afterLoginRoomCode)
    } catch (e) {
      showMessage(errorSlot, e.message || 'Ошибка авторизации', 'error')
      submitBtn.disabled = false
      submitBtn.textContent = defaultLabel
    }
  }

  loginSubmit.addEventListener('click', () => submit('login', loginUsername, loginPassword, loginErrorSlot, loginSubmit, 'Войти', 'Вход...'))
  registerSubmit.addEventListener('click', () => submit('register', registerUsername, registerPassword, registerErrorSlot, registerSubmit, 'Зарегистрироваться', 'Регистрация...', registerDisplayName))

  loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginSubmit.click() })
  loginUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginSubmit.click() })
  registerPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') registerSubmit.click() })
  registerUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') registerSubmit.click() })
  registerDisplayName.addEventListener('keydown', (e) => { if (e.key === 'Enter') registerSubmit.click() })
}

// ===================== ЛОББИ (экран входа) =====================

async function renderLobby(prefillRoomCode = '') {
  // Требуем авторизацию перед лобби - если нет активной сессии, показываем экран входа/регистрации.
  if (!state.currentUser) {
    state.currentUser = await fetchMe()
  }
  if (!state.currentUser) {
    renderAuthScreen(prefillRoomCode)
    return
  }

  root.innerHTML = ''
  const params = new URLSearchParams(location.search)
  const urlRoom = prefillRoomCode || (location.pathname.startsWith('/room/') ? location.pathname.split('/room/')[1] : '') || params.get('room') || ''

  const screen = el('div', { class: 'lobby-screen' })
  const card = el('div', { class: 'lobby-card' })

  card.appendChild(el('h1', {}, 'Voice Lobby'))

  const userBar = el('div', { class: 'lobby-userbar' })
  userBar.appendChild(el('span', {}, [el('i', { class: 'fas fa-user' }), ` ${state.currentUser.displayName || state.currentUser.username}`]))
  const logoutBtn = el('button', { type: 'button', class: 'lobby-logout-btn' }, 'Выйти')
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    state.currentUser = null
    renderAuthScreen()
  })
  userBar.appendChild(logoutBtn)
  card.appendChild(userBar)

  const errorSlot = el('div', { style: 'display:none' })
  card.appendChild(errorSlot)

  // Device preview
  const preview = el('div', { class: 'device-preview' })
  const previewVideo = el('video', { autoplay: true, muted: true, playsinline: true, 'webkit-playsinline': 'true' })
  const noCam = el('div', { class: 'no-cam' }, 'Камера отключена')
  preview.appendChild(previewVideo)
  preview.appendChild(noCam)
  card.appendChild(preview)

  // ---- Переключатели: с чем входить в звонок (камера/микрофон вкл/выкл) ----
  const joinToggles = el('div', { class: 'join-toggles' })
  function makeJoinToggle(iconOnClass, iconOffClass, labelText, initialOn) {
    const btn = el('button', { type: 'button', class: `join-toggle-btn ${initialOn ? 'on' : 'off'}` }, [
      el('i', { class: initialOn ? iconOnClass : iconOffClass }),
      el('span', {}, labelText)
    ])
    return btn
  }
  const camToggleBtn = makeJoinToggle('fas fa-video', 'fas fa-video-slash', 'Камера', state.cameraEnabled)
  const micToggleBtn = makeJoinToggle('fas fa-microphone', 'fas fa-microphone-slash', 'Микрофон', state.micEnabled)
  joinToggles.appendChild(camToggleBtn)
  joinToggles.appendChild(micToggleBtn)
  card.appendChild(joinToggles)

  function setJoinToggle(btn, on, iconOnClass, iconOffClass) {
    btn.classList.toggle('on', on)
    btn.classList.toggle('off', !on)
    btn.querySelector('i').className = on ? iconOnClass : iconOffClass
  }

  camToggleBtn.addEventListener('click', async () => {
    state.cameraEnabled = !state.cameraEnabled
    setJoinToggle(camToggleBtn, state.cameraEnabled, 'fas fa-video', 'fas fa-video-slash')
    if (state.cameraEnabled) {
      await switchCamera(state.selectedCamId)
    } else {
      if (state.previewStream) {
        state.previewStream.getTracks().forEach((t) => t.stop())
        state.previewStream = null
      }
      previewVideo.srcObject = null
      noCam.style.display = 'flex'
    }
  })

  micToggleBtn.addEventListener('click', async () => {
    state.micEnabled = !state.micEnabled
    setJoinToggle(micToggleBtn, state.micEnabled, 'fas fa-microphone', 'fas fa-microphone-slash')
    if (state.micEnabled) {
      await startMicMonitor(state.selectedMicId)
    } else {
      stopMicMonitor()
    }
  })

  // ---- Выбор устройств ввода/вывода ----
  const deviceSettings = el('div', { class: 'device-settings' })

  const camRow = el('div', { class: 'device-row' })
  camRow.appendChild(el('label', {}, [el('i', { class: 'fas fa-video' }), ' Камера']))
  const camSelect = el('select', {})
  camRow.appendChild(camSelect)
  deviceSettings.appendChild(camRow)

  const micRow = el('div', { class: 'device-row' })
  micRow.appendChild(el('label', {}, [el('i', { class: 'fas fa-microphone' }), ' Микрофон']))
  const micSelect = el('select', {})
  micRow.appendChild(micSelect)
  const micMeter = el('div', { class: 'mic-meter' }, [el('div', { class: 'mic-meter-bar' })])
  micRow.appendChild(micMeter)
  deviceSettings.appendChild(micRow)

  const spkRow = el('div', { class: 'device-row' })
  spkRow.appendChild(el('label', {}, [el('i', { class: 'fas fa-volume-up' }), ' Динамики']))
  const spkSelect = el('select', {})
  spkRow.appendChild(spkSelect)
  const testBtn = el('button', { class: 'btn-secondary test-sound-btn', type: 'button', title: 'Проверить звук' }, 'Тест')
  spkRow.appendChild(testBtn)
  deviceSettings.appendChild(spkRow)

  card.appendChild(deviceSettings)

  const roomInput = el('input', {
    type: 'text',
    placeholder: 'Код комнаты (оставьте пустым — создать новую)',
    value: urlRoom
  })
  card.appendChild(roomInput)

  const joinBtn = el('button', {}, urlRoom ? 'Войти в комнату' : 'Создать / войти')
  card.appendChild(joinBtn)

  const hint = el('div', { class: 'hint-text' }, 'Поделитесь кодом комнаты с теми, кого хотите позвать в звонок.')
  card.appendChild(hint)

  screen.appendChild(card)
  root.appendChild(screen)

  // ---- Управление превью камеры ----
  async function switchCamera(deviceId) {
    if (state.previewStream) {
      state.previewStream.getTracks().forEach((t) => t.stop())
      state.previewStream = null
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false
      })
      state.previewStream = stream
      previewVideo.srcObject = stream
      noCam.style.display = 'none'
    } catch (e) {
      noCam.style.display = 'flex'
    }
  }

  // ---- Индикатор уровня микрофона ----
  let micStream = null
  let audioCtx = null
  let meterRAF = null

  function stopMicMonitor() {
    if (meterRAF) cancelAnimationFrame(meterRAF)
    meterRAF = null
    if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null }
  }

  async function startMicMonitor(deviceId) {
    stopMicMonitor()
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      })
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const source = audioCtx.createMediaStreamSource(micStream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const bar = micMeter.querySelector('.mic-meter-bar')
      const loop = () => {
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        bar.style.width = Math.min(100, (avg / 100) * 100) + '%'
        meterRAF = requestAnimationFrame(loop)
      }
      loop()
    } catch (e) {
      // нет доступа к микрофону - индикатор просто не покажется
    }
  }

  // ---- Тест динамиков ----
  async function playTestSound(deviceId) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator()
      osc.frequency.value = 880
      const gain = ctx.createGain()
      gain.gain.value = 0.18
      const dest = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dest)
      const audioEl = document.createElement('audio')
      audioEl.srcObject = dest.stream
      audioEl.autoplay = true
      if (deviceId && typeof audioEl.setSinkId === 'function') {
        await audioEl.setSinkId(deviceId).catch(() => {})
      }
      document.body.appendChild(audioEl)
      osc.start()
      setTimeout(() => {
        try { osc.stop() } catch {}
        try { ctx.close() } catch {}
        audioEl.remove()
      }, 600)
    } catch (e) {
      showToast('Не удалось воспроизвести тестовый звук', 'error')
    }
  }

  // ---- Заполнение списков устройств ----
  const speakerSupported = typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function'
  if (!speakerSupported) spkRow.style.display = 'none'

  async function populateDeviceLists() {
    let devices = []
    try {
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch (e) {
      return
    }
    const cams = devices.filter((d) => d.kind === 'videoinput')
    const mics = devices.filter((d) => d.kind === 'audioinput')
    const speakers = devices.filter((d) => d.kind === 'audiooutput')

    const savedCam = localStorage.getItem('camDeviceId')
    const savedMic = localStorage.getItem('micDeviceId')
    const savedSpk = localStorage.getItem('speakerDeviceId')

    camSelect.innerHTML = ''
    if (cams.length === 0) {
      camSelect.appendChild(el('option', { value: '' }, 'Камеры не найдены'))
    } else {
      cams.forEach((d, i) => camSelect.appendChild(el('option', { value: d.deviceId }, d.label || `Камера ${i + 1}`)))
      if (savedCam && cams.some((d) => d.deviceId === savedCam)) camSelect.value = savedCam
    }

    micSelect.innerHTML = ''
    if (mics.length === 0) {
      micSelect.appendChild(el('option', { value: '' }, 'Микрофоны не найдены'))
    } else {
      mics.forEach((d, i) => micSelect.appendChild(el('option', { value: d.deviceId }, d.label || `Микрофон ${i + 1}`)))
      if (savedMic && mics.some((d) => d.deviceId === savedMic)) micSelect.value = savedMic
    }

    if (speakerSupported) {
      spkSelect.innerHTML = ''
      if (speakers.length === 0) {
        spkSelect.appendChild(el('option', { value: '' }, 'Не найдено'))
      } else {
        speakers.forEach((d, i) => spkSelect.appendChild(el('option', { value: d.deviceId }, d.label || `Динамики ${i + 1}`)))
        if (savedSpk && speakers.some((d) => d.deviceId === savedSpk)) spkSelect.value = savedSpk
      }
    }

    state.selectedCamId = camSelect.value || null
    state.selectedMicId = micSelect.value || null
    state.selectedSpeakerId = speakerSupported ? (spkSelect.value || null) : null
  }

  camSelect.addEventListener('change', async () => {
    state.selectedCamId = camSelect.value || null
    if (state.selectedCamId) localStorage.setItem('camDeviceId', state.selectedCamId)
    if (state.cameraEnabled) await switchCamera(state.selectedCamId)
  })

  micSelect.addEventListener('change', async () => {
    state.selectedMicId = micSelect.value || null
    if (state.selectedMicId) localStorage.setItem('micDeviceId', state.selectedMicId)
    if (state.micEnabled) await startMicMonitor(state.selectedMicId)
  })

  spkSelect.addEventListener('change', () => {
    state.selectedSpeakerId = spkSelect.value || null
    if (state.selectedSpeakerId) localStorage.setItem('speakerDeviceId', state.selectedSpeakerId)
  })

  testBtn.addEventListener('click', () => playTestSound(state.selectedSpeakerId))

  const onDeviceChange = () => populateDeviceLists()
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)

  // start local camera preview (best effort), затем получить лейблы устройств и запустить индикатор микрофона
  // (только если соответствующее устройство включено переключателем "с чем входить")
  if (state.cameraEnabled) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      state.previewStream = stream
      previewVideo.srcObject = stream
      noCam.style.display = 'none'
    } catch (e) {
      noCam.style.display = 'flex'
    }
  } else {
    noCam.style.display = 'flex'
  }

  await populateDeviceLists()
  if (state.micEnabled) {
    await startMicMonitor(state.selectedMicId)
    await populateDeviceLists() // обновить лейблы аудиоустройств после получения разрешения на микрофон
  }

  function stopPreview() {
    if (state.previewStream) {
      state.previewStream.getTracks().forEach((t) => t.stop())
      state.previewStream = null
    }
    stopMicMonitor()
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
  }

  async function doJoin() {
    const roomCode = roomInput.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    // Если ранее этот же браузер создал комнату с таким кодом - подтягиваем сохранённый секрет создателя,
    // чтобы при повторном входе (например, обновление страницы) права хоста восстановились
    const savedHostSecret = roomCode ? localStorage.getItem(`hostSecret:${roomCode}`) : null

    joinBtn.disabled = true
    joinBtn.textContent = 'Подключение...'
    errorSlot.style.display = 'none'

    try {
      // displayName больше не передаётся - сервер берёт имя из авторизованной сессии (куки-cookie)
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ roomCode, hostSecret: savedHostSecret })
      })
      const data = await res.json()

      if (res.status === 401) {
        state.currentUser = null
        renderAuthScreen(roomCode)
        return
      }

      if (!res.ok) {
        throw new Error(data.message || 'Не удалось подключиться')
      }

      if (data.isHost && data.hostSecret) {
        localStorage.setItem(`hostSecret:${data.roomCode}`, data.hostSecret)
      }

      stopPreview()
      history.pushState({}, '', `/room/${data.roomCode}`)
      await enterRoom(data)
    } catch (e) {
      errorSlot.style.display = 'block'
      errorSlot.className = 'error-box'
      errorSlot.textContent = e.message || 'Ошибка подключения. Проверьте интернет-соединение.'
      joinBtn.disabled = false
      joinBtn.textContent = urlRoom ? 'Войти в комнату' : 'Создать / войти'
    }
  }

  joinBtn.addEventListener('click', doJoin)
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin() })
}

// ===================== КОМНАТА (звонок) =====================

async function enterRoom(joinData) {
  const { token, url, roomCode, displayName, maxParticipants, maxScreenShares, isHost, hostSecret } = joinData
  state.roomCode = roomCode
  state.displayName = displayName
  state.maxParticipants = maxParticipants || 5
  state.maxScreenShares = maxScreenShares || 2
  state.isHost = !!isHost
  state.hostSecret = hostSecret || null

  root.innerHTML = ''

  const screen = el('div', { class: 'room-screen' })

  // ---- Верхняя панель ----
  const topbar = el('div', { class: 'room-topbar' })
  const roomInfo = el('div', { class: 'room-info' })
  const statusDot = el('span', { class: 'status-dot connecting' })
  roomInfo.appendChild(statusDot)
  roomInfo.appendChild(el('span', {}, 'Подключение...'))
  const codeBadge = el('span', { class: 'room-code-badge', title: 'Нажмите, чтобы скопировать код' }, `Комната: ${roomCode}`)
  codeBadge.addEventListener('click', () => {
    navigator.clipboard.writeText(roomCode).then(() => showToast('Код комнаты скопирован'))
  })
  roomInfo.appendChild(codeBadge)
  if (state.isHost) {
    roomInfo.appendChild(el('span', { class: 'host-indicator', title: 'Вы создатель этой комнаты - можете выгонять участников' }, [
      el('i', { class: 'fas fa-crown' }), ' Вы создатель'
    ]))
  }
  topbar.appendChild(roomInfo)

  const topRight = el('div', {})
  const participantsBtn = el('button', {
    class: 'ctrl-btn',
    // 40px, а не 36px - минимальный рекомендуемый размер тач-таргета на телефоне
    style: 'width:40px;height:40px;font-size:14px',
    title: 'Участники'
  }, [el('i', { class: 'fas fa-users' })])
  topRight.appendChild(participantsBtn)
  topbar.appendChild(topRight)

  screen.appendChild(topbar)

  // ---- Основная область (сцена + сайдбар для демок) ----
  const roomMain = el('div', { class: 'room-main' })
  const stage = el('div', { class: 'stage' })
  const sidebar = el('div', { class: 'sidebar-participants' })
  roomMain.appendChild(stage)
  roomMain.appendChild(sidebar)
  screen.appendChild(roomMain)

  // ---- Панель управления ----
  const controls = el('div', { class: 'controls-bar' })

  const micBtn = el('button', { class: 'ctrl-btn active', title: 'Микрофон' }, [el('i', { class: 'fas fa-microphone' })])
  const camBtn = el('button', { class: 'ctrl-btn active', title: 'Камера' }, [el('i', { class: 'fas fa-video' })])
  const screenBtn = el('button', { class: 'ctrl-btn', title: 'Демонстрация экрана' }, [el('i', { class: 'fas fa-desktop' })])
  const screenCountBadge = el('span', { class: 'badge-count', style: 'display:none' }, '0')
  screenBtn.appendChild(screenCountBadge)

  // Демонстрация экрана через getDisplayMedia() не поддерживается в большинстве мобильных
  // браузеров (iOS Safari/Chrome, Android Chrome вне десктоп-режима) - без проверки пользователь
  // на телефоне видел бы активную кнопку, а по нажатию получал бы непонятную ошибку/тишину.
  // Скрываем кнопку целиком, если API физически отсутствует.
  const canScreenShare = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')

  const divider1 = el('div', { class: 'ctrl-divider' })
  const leaveBtn = el('button', { class: 'leave-btn' }, [el('i', { class: 'fas fa-phone-slash' }), ' Выйти'])

  controls.appendChild(micBtn)
  controls.appendChild(camBtn)
  if (canScreenShare) controls.appendChild(screenBtn)
  controls.appendChild(divider1)
  controls.appendChild(leaveBtn)
  screen.appendChild(controls)

  root.appendChild(screen)

  // ---- LiveKit Room ----
  const room = new LK.Room({
    adaptiveStream: true,
    dynacast: true,
    // Маршрутизация удалённого аудио через Web Audio API (GainNode), а не напрямую через
    // HTMLMediaElement.volume. Это нужно для корректной работы регулятора громкости >100%:
    // родная громкость <audio>/<video> ограничена диапазоном [0,1] и браузер бросает исключение
    // при попытке выставить больше 1 - из-за этого слайдер "залипал"/не реагировал на верхних значениях.
    // GainNode такого ограничения не имеет и позволяет усиливать сигнал выше 100% без ошибок.
    webAudioMix: true,
    videoCaptureDefaults: {
      resolution: LK.VideoPresets.h720.resolution,
      ...(state.selectedCamId ? { deviceId: state.selectedCamId } : {})
    },
    audioCaptureDefaults: {
      ...(state.selectedMicId ? { deviceId: state.selectedMicId } : {})
    },
    ...(state.selectedSpeakerId ? { audioOutput: { deviceId: state.selectedSpeakerId } } : {}),
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [LK.VideoPresets.h180, LK.VideoPresets.h360]
    }
  })
  state.room = room

  function setStatus(text, cls) {
    statusDot.className = `status-dot ${cls}`
    roomInfo.querySelector('span:nth-child(2)').textContent = text
  }

  // ---- Приглашение, когда в звонке пока только ты ----
  // Отдельная раскладка "пустой комнаты": слева большая карточка себя (камера или аккуратные
  // инициалы), справа - призыв позвать других и крупная кнопка "Скопировать ссылку".
  // Как только подключается второй участник, карточка убирается и сетка становится обычной.
  let soloInviteCard = null
  let soloCopyTimer = null

  function copyTextFallback(text) {
    // Clipboard API недоступен (нет https/разрешения) - копируем через скрытое textarea.
    // Выделение текста в интерфейсе отключено через CSS, но у input/textarea оно
    // сохранено (user-select: text), поэтому execCommand('copy') здесь работает.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }

  function getSoloInviteCard() {
    if (soloInviteCard) return soloInviteCard

    const btnIcon = el('i', { class: 'fas fa-link' })
    const btnLabel = el('span', {}, 'Скопировать ссылку')
    const copyBtn = el('button', { type: 'button', class: 'solo-copy-btn' }, [btnIcon, btnLabel])

    copyBtn.addEventListener('click', async () => {
      // Реальный адрес комнаты - ровно то, что открыто в адресной строке
      const link = location.href
      let ok = false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(link)
          ok = true
        }
      } catch {
        ok = false
      }
      if (!ok) ok = copyTextFallback(link)

      if (!ok) {
        showToast('Не удалось скопировать ссылку', 'error')
        return
      }
      // Короткое подтверждение прямо на кнопке + тост
      copyBtn.classList.add('is-copied')
      btnIcon.className = 'fas fa-check'
      btnLabel.textContent = 'Ссылка скопирована'
      showToast('Ссылка на звонок скопирована', 'success')
      clearTimeout(soloCopyTimer)
      soloCopyTimer = setTimeout(() => {
        copyBtn.classList.remove('is-copied')
        btnIcon.className = 'fas fa-link'
        btnLabel.textContent = 'Скопировать ссылку'
      }, 2200)
    })

    soloInviteCard = el('div', { class: 'solo-invite' }, [
      el('h2', { class: 'solo-invite__title' }, 'Чтобы пригласить других участников, отправьте им ссылку на звонок'),
      copyBtn,
      el('div', { class: 'solo-invite__code' }, ['Код комнаты: ', el('b', {}, state.roomCode || '')]),
      el('p', { class: 'solo-invite__hint' }, 'Как только кто-то подключится, он появится рядом с вами.')
    ])
    return soloInviteCard
  }

  // ---- Инкрементальная расстановка узлов в контейнере ----
  // Переставляет только то, что реально изменилось: узлы, которых быть не должно, убираются,
  // остальные двигаются в нужный порядок. Если изменений нет - DOM не трогается вообще.
  function placeTiles(container, nodes) {
    for (const child of Array.from(container.children)) {
      if (!nodes.includes(child)) child.remove()
    }
    nodes.forEach((node, i) => {
      const current = container.children[i]
      if (current !== node) container.insertBefore(node, current || null)
    })
  }

  function relayout() {
    // ВАЖНО ("баг: при уменьшении окна Chrome демонстрация исчезает и остаётся пустое место"):
    // раньше эта функция брала тайлы из document.querySelectorAll('.camera-tile'/'.screen-tile')
    // и начинала с stage.innerHTML = '' / sidebar.innerHTML = ''. Источником правды был DOM, а не
    // screenTilesMap/cameraTilesMap - поэтому любой тайл, который на момент вызова оказался вне
    // документа (его только что вынули из контейнера, видео ушло в PiP-окно, пришла гонка событий
    // LiveKit), в выборку не попадал, а затем терялся вместе с очищенным контейнером: демонстрация
    // продолжала идти (счётчик на кнопке показывал 1), но на сцене оставалась пустая область. Чаще
    // всего relayout() вызывает именно resize окна - отсюда "исчезает при уменьшении окна Chrome".
    // Плюс innerHTML='' физически вынимал <video> из документа и ставил его на паузу ("чёрный
    // экран" после выхода из fullscreen). Теперь источник правды - Map'ы тайлов, а DOM приводится
    // к нужному виду инкрементально (placeTiles): при обычном ресайзе узлы не переставляются
    // вовсе, трек не переподключается, демонстрация не мигает и не может пропасть.
    const screenTiles = Array.from(screenTilesMap.values(), (t) => t.tile)
    const cameraTiles = Array.from(cameraTilesMap.values(), (t) => t.tile)
    const hasScreenShares = screenTiles.length > 0
    // "Я один в комнате" - особая раскладка с приглашением (см. getSoloInviteCard)
    const isSolo = !hasScreenShares && cameraTiles.length === 1
    // Две демонстрации рядом имеют смысл только на очень широкой сцене: паре кадров 16:9
    // нужна пропорция около 32:9, иначе друг под другом они получаются заметно крупнее
    // (на телефоне и в узком окне — тем более). Считаем по фактической сцене, а не по ширине окна.
    const stageH = stage.clientHeight
    const stageRatio = stageH > 0 ? stage.clientWidth / stageH : 1.6
    const sideBySideScreens = screenTiles.length > 1 && stageRatio >= 3.1

    stage.classList.toggle('stage-solo', isSolo)
    stage.classList.toggle('stage-centered', !isSolo)
    stage.classList.toggle('screen-count-2', hasScreenShares && sideBySideScreens)

    // Сколько камер на сцене - от этого зависит размер плиток (CSS: .cam-count-N).
    // Без этого плитки всегда были одной ширины и на большом экране вдвоем выглядели потерянно.
    const camCount = hasScreenShares ? 0 : Math.min(cameraTiles.length, 5)
    for (let n = 1; n <= 5; n++) stage.classList.toggle(`cam-count-${n}`, camCount === n)

    if (hasScreenShares) {
      placeTiles(stage, screenTiles)
      placeTiles(sidebar, cameraTiles)
      sidebar.style.display = cameraTiles.length ? 'flex' : 'none'
    } else {
      placeTiles(stage, isSolo ? cameraTiles.concat([getSoloInviteCard()]) : cameraTiles)
      placeTiles(sidebar, [])
      sidebar.style.display = 'none'
    }
    stage.style.gridTemplateColumns = ''

    screenCountBadge.style.display = state.screenShares.size > 0 ? 'block' : 'none'
    screenCountBadge.textContent = String(state.screenShares.size)

    // Защитная сетка: если <video> всё же оказался на паузе (браузер ставит видео на паузу, когда
    // узел вынимали из документа - например, при первом монтировании тайла), продолжаем
    // воспроизведение. Если видео и так играет, ничего не делаем.
    stage.querySelectorAll('video').forEach((v) => { if ((v.srcObject || v.src) && v.paused) v.play().catch(() => {}) })
    sidebar.querySelectorAll('video').forEach((v) => { if ((v.srcObject || v.src) && v.paused) v.play().catch(() => {}) })
  }

  // Пересчёт раскладки собран в одну rAF-очередь: поворот телефона, ресайз окна Electron и
  // изменение размеров самого контейнера сводятся к одному вызову за кадр.
  let relayoutRAF = null
  function scheduleRelayout() {
    if (relayoutRAF) return
    relayoutRAF = requestAnimationFrame(() => {
      relayoutRAF = null
      // ВАЖНО ("баг: полный экран открывается на 1мс и закрывается"): по спецификации Fullscreen
      // API перемещение элемента в DOM принудительно завершает fullscreen, а requestFullscreen()
      // сам вызывает resize. relayout() теперь идемпотентен и при простом ресайзе DOM не трогает,
      // но если раскладка реально меняется, узлы переставятся - поэтому, пока тайл в нативном
      // fullscreen, откладываем пересчёт до его закрытия (см. fullscreenchange ниже).
      if (document.fullscreenElement) return
      relayout()
    })
  }
  window.addEventListener('resize', scheduleRelayout)
  window.addEventListener('orientationchange', scheduleRelayout)
  // Контейнер сцены может менять размер и без window resize (окно Electron, появление сайдбара,
  // виртуальная клавиатура). ResizeObserver ловит это напрямую; relayout() идемпотентен, поэтому
  // обратной связи "ресайз -> ресайз" не возникает.
  let stageResizeObserver = null
  if (typeof ResizeObserver === 'function') {
    stageResizeObserver = new ResizeObserver(() => scheduleRelayout())
    stageResizeObserver.observe(roomMain)
  }
  // Как только fullscreen закрывается (штатно или из-за гонки выше) - пересчитываем раскладку
  // разово, чтобы вернуть тайл на его место в сетке.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) scheduleRelayout()
  })

  // ---- Высота вьюпорта на мобильных ----
  // На iOS Safari адресная строка и панель жестов меняют высоту видимой области без window
  // resize, а 100vh считается по "большому" вьюпорту - интерфейс уезжает под панели. CSS уже
  // использует 100svh/100dvh, а --app-vh даёт точное значение для внутреннего полного экрана.
  let viewportRAF = null
  function syncViewportHeight() {
    if (viewportRAF) return
    viewportRAF = requestAnimationFrame(() => {
      viewportRAF = null
      const vv = window.visualViewport
      const h = Math.round(vv ? vv.height : window.innerHeight)
      if (h > 0) document.documentElement.style.setProperty('--app-vh', h + 'px')
    })
  }
  syncViewportHeight()
  window.addEventListener('resize', syncViewportHeight)
  window.addEventListener('orientationchange', syncViewportHeight)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight)
    window.visualViewport.addEventListener('scroll', syncViewportHeight)
  }

  // ---- Регулятор громкости (слайдер + иконка), общий для камеры и демонстрации ----
  function makeVolumeControl(onChange, initial = 1) {
    const wrap = el('div', { class: 'volume-control' })
    const icon = el('i', { class: 'fas fa-volume-up' })
    const slider = el('input', { type: 'range', min: '0', max: '150', value: String(Math.round(initial * 100)) })
    wrap.appendChild(icon)
    wrap.appendChild(slider)
    slider.addEventListener('input', (e) => {
      e.stopPropagation()
      const v = Number(slider.value) / 100
      icon.className = v === 0 ? 'fas fa-volume-mute' : v < 0.5 ? 'fas fa-volume-down' : 'fas fa-volume-up'
      onChange(v)
    })
    wrap.addEventListener('click', (e) => e.stopPropagation())
    wrap.addEventListener('dblclick', (e) => e.stopPropagation())
    return wrap
  }

  // Обновить визуальное состояние (значение слайдера + иконка) уже существующего .volume-control
  // на тайле (камера/демонстрация) - используется, чтобы слайдер в контекстном меню и штатный
  // регулятор громкости на самом тайле оставались синхронизированы между собой.
  function syncVolumeControlUI(wrap, v) {
    if (!wrap) return
    const slider = wrap.querySelector('input[type="range"]')
    const icon = wrap.querySelector('i')
    if (slider) slider.value = String(Math.round(v * 100))
    if (icon) icon.className = v === 0 ? 'fas fa-volume-mute' : v < 0.5 ? 'fas fa-volume-down' : 'fas fa-volume-up'
  }

  function makeCameraTile(identity, name, isLocal, hostBadge) {
    const tile = el('div', { class: 'tile camera-tile', id: `tile-cam-${identity}` })
    const video = el('video', { autoplay: true, playsinline: true, 'webkit-playsinline': 'true', ...(isLocal ? { muted: true } : {}) })
    if (isLocal) video.style.transform = 'scaleX(-1)'
    const placeholder = el('div', { class: 'no-video-placeholder' }, [el('div', { class: 'avatar-circle' }, initials(name))])
    const micIcon = el('i', { class: 'fas fa-microphone-slash', style: 'display:none' })
    // По умолчанию считаем камеру выключенной (большинство участников входят с выключенной камерой),
    // индикатор скрывается явно как только подтверждается активная камера-трек
    const camIcon = el('i', { class: 'fas fa-video-slash', style: isLocal ? 'display:none' : 'display:inline' })
    const labelChildren = [camIcon, micIcon, el('span', {}, name + (isLocal ? ' (Вы)' : ''))]
    if (hostBadge) labelChildren.push(el('i', { class: 'fas fa-crown host-crown', title: 'Создатель комнаты' }))
    const label = el('div', { class: 'tile-label' }, labelChildren)
    tile.appendChild(video)
    tile.appendChild(placeholder)
    tile.appendChild(label)

    // Полноэкранный режим для тайла камеры (выбрать конкретного участника "на весь экран")
    const fsBtn = el('button', { class: 'tile-fullscreen-btn', title: 'На весь экран' }, [el('i', { class: 'fas fa-expand' })])
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleTileFullscreen(tile)
    })
    tile.appendChild(fsBtn)
    tile.addEventListener('dblclick', () => toggleTileFullscreen(tile))

    let volumeCtl = null
    let kickBtn = null
    if (!isLocal) {
      // Громкость голоса конкретного собеседника (не влияет на других)
      volumeCtl = makeVolumeControl((v) => {
        const p = room.getParticipantByIdentity(identity)
        if (p) p.setVolume(v, LK.Track.Source.Microphone)
      })
      tile.appendChild(volumeCtl)
      // Кнопка "выгнать участника" - видна только создателю комнаты (слева, чтобы не конфликтовать с fullscreen справа)
      if (state.isHost) {
        kickBtn = el('button', { class: 'tile-kick-btn', title: 'Выгнать из звонка' }, [el('i', { class: 'fas fa-user-slash' })])
        kickBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          kickParticipant(identity, name)
        })
        tile.appendChild(kickBtn)
      }
    }
    return { tile, video, placeholder, label, micIcon, camIcon, volumeCtl, kickBtn, fsBtn }
  }

  // Обновить видимость иконки "микрофон выключен" на тайле участника по его identity
  function updateMicIndicator(identity, muted) {
    const t = cameraTilesMap.get(identity)
    if (t && t.micIcon) t.micIcon.style.display = muted ? 'inline' : 'none'
  }

  // Обновить видимость иконки "камера выключена" на тайле участника по его identity
  function updateCamIndicator(identity, off) {
    const t = cameraTilesMap.get(identity)
    if (t && t.camIcon) t.camIcon.style.display = off ? 'inline' : 'none'
  }

  // ---- Выгнать участника из комнаты (доступно только создателю) ----
  async function kickParticipant(identity, name) {
    if (!state.isHost || !state.hostSecret) return
    if (!confirm(`Выгнать «${name}» из звонка?`)) return
    try {
      const res = await fetch(`/api/rooms/${state.roomCode}/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetIdentity: identity, hostSecret: state.hostSecret })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'Не удалось удалить участника')
      showToast(`${name} выгнан из звонка`)
    } catch (e) {
      showToast(e.message || 'Не удалось выгнать участника', 'error')
    }
  }

  // ---- Полноэкранный режим тайла: нативный + фолбэк для iPhone ----
  // На iOS Safari Fullscreen API у обычных элементов отсутствует (document.fullscreenEnabled
  // false, Element.requestFullscreen нет вовсе) - раньше кнопка "на весь экран" там просто
  // показывала ошибку. Теперь порядок такой:
  //   1) нативный requestFullscreen (десктоп, Android, Electron);
  //   2) webkitEnterFullscreen у самого <video> (системный плеер iPhone, если трек уже играет);
  //   3) "внутренний" полный экран - тайл раскрывается на весь вьюпорт через CSS
  //      (position: fixed + высота 100dvh/--app-vh + safe-area), без Fullscreen API.
  // Во всех трёх случаях повторное нажатие/Escape возвращает обычную раскладку.
  const NATIVE_FS_SUPPORTED = !!(
    typeof document !== 'undefined' &&
    document.fullscreenEnabled &&
    typeof Element !== 'undefined' &&
    typeof Element.prototype.requestFullscreen === 'function'
  )

  function syncFullscreenButtons() {
    document.querySelectorAll('.screen-tile, .camera-tile').forEach((t) => {
      const on = document.fullscreenElement === t || t.classList.contains('in-app-fullscreen')
      t.classList.toggle('is-fullscreen', on)
      const icon = t.querySelector('.tile-fullscreen-btn i')
      if (icon) icon.className = on ? 'fas fa-compress' : 'fas fa-expand'
    })
  }

  function exitInAppFullscreen() {
    const tile = document.querySelector('.tile.in-app-fullscreen')
    if (!tile) return false
    tile.classList.remove('in-app-fullscreen')
    document.body.classList.remove('inapp-fullscreen')
    syncFullscreenButtons()
    // Тайл остаётся тем же DOM-узлом (его никто не вынимал из документа), поэтому видео
    // продолжает играть; play() - только страховка.
    const video = tile.querySelector('video')
    if (video && (video.srcObject || video.src) && video.paused) video.play().catch(() => {})
    return true
  }

  function enterInAppFullscreen(tile) {
    exitInAppFullscreen()
    syncViewportHeight()
    tile.classList.add('in-app-fullscreen')
    document.body.classList.add('inapp-fullscreen')
    syncFullscreenButtons()
    const video = tile.querySelector('video')
    if (video && (video.srcObject || video.src) && video.paused) video.play().catch(() => {})
  }

  function toggleTileFullscreen(tile) {
    if (document.fullscreenElement === tile) {
      document.exitFullscreen().catch(() => {})
      return
    }
    if (tile.classList.contains('in-app-fullscreen')) {
      exitInAppFullscreen()
      return
    }
    if (NATIVE_FS_SUPPORTED && typeof tile.requestFullscreen === 'function') {
      let p = null
      try { p = tile.requestFullscreen() } catch { p = null }
      if (p && typeof p.catch === 'function') {
        p.catch(() => enterInAppFullscreen(tile)) // запрет из-за жеста/политики - открываем внутренний
        return
      }
      if (p) return
    }
    const video = tile.querySelector('video')
    if (video && typeof video.webkitEnterFullscreen === 'function' && video.readyState > 0) {
      try {
        video.webkitEnterFullscreen()
        return
      } catch {}
    }
    enterInAppFullscreen(tile)
  }

  // Esc закрывает внутренний полный экран так же, как нативный
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') exitInAppFullscreen() })

  function makeScreenTile(identity, name, sid, isLocal) {
    const tile = el('div', { class: 'tile screen-tile', id: `tile-screen-${sid}` })
    const video = el('video', { autoplay: true, playsinline: true, 'webkit-playsinline': 'true', muted: true })
    const label = el('div', { class: 'tile-label' }, [el('i', { class: 'fas fa-desktop' }), el('span', {}, `Демонстрация — ${name}`)])
    // Бейдж LIVE в левом верхнем углу тайла демонстрации (технический FPS-бейдж убран)
    const liveBadge = el('div', { class: 'live-badge-group' }, [
      el('span', { class: 'live-badge' }, [el('span', { class: 'live-dot' }), 'LIVE'])
    ])
    const fsBtn = el('button', { class: 'tile-fullscreen-btn', title: 'На весь экран' }, [el('i', { class: 'fas fa-expand' })])
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleTileFullscreen(tile)
    })
    tile.appendChild(video)
    tile.appendChild(liveBadge)
    tile.appendChild(label)
    tile.appendChild(fsBtn)
    let volumeCtl = null
    if (!isLocal) {
      // Громкость звука демонстрации (звук с устройства демонстрирующего)
      volumeCtl = makeVolumeControl((v) => {
        const p = room.getParticipantByIdentity(identity)
        if (p) p.setVolume(v, LK.Track.Source.ScreenShareAudio)
      })
      tile.appendChild(volumeCtl)
    }
    tile.addEventListener('dblclick', () => toggleTileFullscreen(tile))
    // Кастомное контекстное меню (ПКМ) вместо стандартного браузерного.
    // Для своей демонстрации - действия над стримом (стоп/смена источника/звук/отдельное окно).
    // Для чужой демонстрации - просмотровые опции (отдельное окно + громкости).
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openScreenContextMenu(e.clientX, e.clientY, { tile, video, identity, sid, isLocal })
    })
    return { tile, video, label, fsBtn, volumeCtl }
  }

  // ===================== Кастомное контекстное меню тайла демонстрации (Discord-style) =====================
  let activeCtxMenu = null
  let activeCtxSubmenu = null

  function closeScreenContextSubmenu() {
    if (activeCtxSubmenu) { activeCtxSubmenu.remove(); activeCtxSubmenu = null }
  }
  function closeScreenContextMenu() {
    closeScreenContextSubmenu()
    if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null }
  }
  document.addEventListener('click', closeScreenContextMenu)
  document.addEventListener('contextmenu', (e) => {
    // Клик правой кнопкой где-то ещё (не на тайле демонстрации) - закрыть меню, если открыто
    if (activeCtxMenu && !e.target.closest('.screen-tile')) closeScreenContextMenu()
  })
  window.addEventListener('resize', closeScreenContextMenu)
  window.addEventListener('blur', closeScreenContextMenu)
  // При входе/выходе из fullscreen (в т.ч. если пользователь нажал Esc прямо с открытым меню)
  // закрываем меню - его хост (body/fullscreenElement) меняется, проще переоткрыть заново по ПКМ
  document.addEventListener('fullscreenchange', closeScreenContextMenu)

  function ctxItem({ icon, label, checked, chevron, destructive, onClick, selected }) {
    const classes = ['screen-ctx-item']
    if (checked) classes.push('checked')
    if (destructive) classes.push('destructive')
    if (selected) classes.push('selected')
    const effectiveIcon = selected ? 'fas fa-check' : icon
    const item = el('div', { class: classes.join(' ') }, [
      checked !== undefined
        ? el('span', { class: 'ctx-checkbox' })
        : el('span', { class: 'ctx-icon' }, effectiveIcon ? [el('i', { class: effectiveIcon })] : []),
      el('span', { class: 'ctx-label' }, label),
      chevron ? el('i', { class: 'fas fa-chevron-right ctx-chevron' }) : null
    ])
    if (onClick) {
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick(e)
      })
    }
    return item
  }

  // Пункт-слайдер внутри контекстного меню (регулятор громкости). В отличие от ctxItem() не
  // закрывает меню при взаимодействии - клики/движения по самому слайдеру не должны всплывать
  // до document-обработчика closeScreenContextMenu().
  function ctxSlider({ icon, label, initial = 1, onChange }) {
    const slider = el('input', { type: 'range', min: '0', max: '150', value: String(Math.round(initial * 100)) })
    const valueLabel = el('span', { class: 'ctx-slider-value' }, `${Math.round(initial * 100)}%`)
    const item = el('div', { class: 'screen-ctx-item screen-ctx-slider' }, [
      el('span', { class: 'ctx-icon' }, [el('i', { class: icon })]),
      el('div', { class: 'ctx-slider-body' }, [
        el('div', { class: 'ctx-slider-top' }, [el('span', { class: 'ctx-label' }, label), valueLabel]),
        slider
      ])
    ])
    slider.addEventListener('input', (e) => {
      e.stopPropagation()
      const v = Number(slider.value) / 100
      valueLabel.textContent = `${Math.round(v * 100)}%`
      onChange(v)
    })
    item.addEventListener('click', (e) => e.stopPropagation())
    item.addEventListener('mousedown', (e) => e.stopPropagation())
    return item
  }

  // ВАЖНО ("баг: ПКМ не работает в fullscreen"): пока какой-то тайл в фактическом fullscreen
  // (document.fullscreenElement), браузер рендерит ТОЛЬКО поддерево этого элемента - всё остальное,
  // включая document.body, физически не отображается (уходит "за" fullscreen-элемент), хотя и
  // остаётся в DOM. Раньше меню всегда добавлялось в document.body - оно создавалось (contextmenu
  // срабатывал), но было невидимым, если открывалось поверх тайла в fullscreen. Поэтому меню нужно
  // класть внутрь текущего fullscreen-элемента (если он есть), а не всегда в body.
  function getFloatingHost() {
    return document.fullscreenElement || document.body
  }

  function positionFloating(node, x, y) {
    getFloatingHost().appendChild(node)
    const vw = window.innerWidth, vh = window.innerHeight
    const rect = node.getBoundingClientRect()
    let left = x, top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    node.style.left = left + 'px'
    node.style.top = top + 'px'
  }

  function openSubmenu(anchorEl, buildItems) {
    closeScreenContextSubmenu()
    const submenu = el('div', { class: 'screen-ctx-submenu' }, buildItems())
    const rect = anchorEl.getBoundingClientRect()
    positionFloating(submenu, rect.right + 4, rect.top)
    submenu.addEventListener('click', (e) => e.stopPropagation())
    submenu.addEventListener('contextmenu', (e) => e.preventDefault())
    activeCtxSubmenu = submenu
  }

  function openScreenContextMenu(x, y, ctx) {
    closeScreenContextMenu()
    const { identity, sid, isLocal } = ctx
    const items = []

    if (isLocal) {
      items.push(ctxItem({
        icon: 'fas fa-stop-circle', label: 'Прекратить стрим', destructive: true,
        onClick: () => { closeScreenContextMenu(); stopScreenShare() }
      }))
      items.push(el('div', { class: 'screen-ctx-divider' }))
      items.push(ctxItem({
        icon: 'fas fa-arrows-rotate', label: 'Изменить источник',
        onClick: () => { closeScreenContextMenu(); changeScreenSource() }
      }))
      // Выбор частоты кадров живёт только здесь - в меню ПКМ на своём тайле демонстрации.
      // Подменю открывается по наведению (как в нативных меню) и по клику - на тач-экранах
      // mouseenter не приходит, и без клика пункт был бы недоступен.
      const qualityItem = ctxItem({
        icon: 'fas fa-gauge-high', label: 'Качество передачи', chevron: true
      })
      const openFpsSubmenu = () => openSubmenu(qualityItem, () => SCREEN_SHARE_FPS_OPTIONS.map((fps) => ctxItem({
        label: `${fps} FPS`,
        selected: fps === state.screenShareFps,
        onClick: () => { setScreenShareFps(fps); closeScreenContextMenu() }
      })))
      qualityItem.addEventListener('mouseenter', openFpsSubmenu)
      qualityItem.addEventListener('click', openFpsSubmenu)
      items.push(qualityItem)
      items.push(el('div', { class: 'screen-ctx-divider' }))
      items.push(ctxItem({
        label: 'Поделиться звуком стрима',
        checked: state.screenShareAudioShared,
        onClick: () => { toggleScreenShareAudio(); openScreenContextMenu(x, y, ctx) }
      }))
      items.push(ctxItem({
        icon: 'fas fa-up-right-from-square', label: 'Стрим в отдельном окне',
        onClick: () => { closeScreenContextMenu(); openScreenSharePiP(ctx.video) }
      }))
      // Подменю "Другие настройки" -> "Оптимизировать: движение/чёткость" убрано: выбор был
      // непонятным, а для звонка всегда нужен один и тот же режим (motion - плавность).
      // Значение зафиксировано в SCREEN_SHARE_CONTENT_HINT и применяется при старте демонстрации.
    } else {
      // Чужая демонстрация - просмотровые действия + два регулятора громкости.
      // "Качество приёма" (какой simulcast-слой видео подписываться) специально не выведено в меню -
      // это техническая настройка, которую обычный пользователь практически никогда не станет
      // трогать руками, поэтому вместо селектора мы просто всегда принудительно запрашиваем
      // максимальное качество (см. forceHighRemoteScreenQuality(), вызывается при подписке на трек).
      items.push(ctxItem({
        icon: 'fas fa-up-right-from-square', label: 'Стрим в отдельном окне',
        onClick: () => { closeScreenContextMenu(); openScreenSharePiP(ctx.video) }
      }))
      items.push(el('div', { class: 'screen-ctx-divider' }))

      // Громкость звука самой демонстрации (то, что играет с устройства демонстрирующего - музыка,
      // видео и т.п.) и громкость голоса самого участника (его микрофон) - это две независимые
      // аудио-дорожки LiveKit (ScreenShareAudio и Microphone), поэтому у них отдельные слайдеры.
      // Начальное значение берём из уже существующих регуляторов на тайлах (если такие тайлы сейчас
      // на экране), чтобы слайдер в меню и слайдер на тайле всегда показывали одно и то же значение.
      const screenTileRef = screenTilesMap.get(sid)
      const camTileRef = cameraTilesMap.get(identity)
      const screenVolInput = screenTileRef && screenTileRef.volumeCtl ? screenTileRef.volumeCtl.querySelector('input[type="range"]') : null
      const micVolInput = camTileRef && camTileRef.volumeCtl ? camTileRef.volumeCtl.querySelector('input[type="range"]') : null
      const screenVolInitial = screenVolInput ? Number(screenVolInput.value) / 100 : 1
      const micVolInitial = micVolInput ? Number(micVolInput.value) / 100 : 1

      items.push(ctxSlider({
        icon: 'fas fa-desktop', label: 'Громкость стрима', initial: screenVolInitial,
        onChange: (v) => {
          const p = room.getParticipantByIdentity(identity)
          if (p) p.setVolume(v, LK.Track.Source.ScreenShareAudio)
          if (screenTileRef && screenTileRef.volumeCtl) syncVolumeControlUI(screenTileRef.volumeCtl, v)
        }
      }))
      items.push(ctxSlider({
        icon: 'fas fa-microphone', label: 'Громкость пользователя', initial: micVolInitial,
        onChange: (v) => {
          const p = room.getParticipantByIdentity(identity)
          if (p) p.setVolume(v, LK.Track.Source.Microphone)
          if (camTileRef && camTileRef.volumeCtl) syncVolumeControlUI(camTileRef.volumeCtl, v)
        }
      }))
    }

    // Наведение на любой другой пункт закрывает открытое подменю - иначе оно бы висело
    // поверх меню до самого закрытия и перекрывало соседние пункты.
    items.forEach((it) => {
      if (!it || !it.classList || !it.classList.contains('screen-ctx-item')) return
      if (it.querySelector('.ctx-chevron')) return
      it.addEventListener('mouseenter', closeScreenContextSubmenu)
    })

    const menu = el('div', { class: 'screen-ctx-menu' }, items)
    menu.addEventListener('click', (e) => e.stopPropagation())
    menu.addEventListener('contextmenu', (e) => e.preventDefault())
    positionFloating(menu, x, y)
    activeCtxMenu = menu
  }

  // ---- "Качество приёма" демонстрации чужого экрана ----
  // LiveKit при подписке на видео-трек умеет запрашивать один из нескольких simulcast-слоёв
  // (HIGH/MEDIUM/LOW - грубо говоря, полное разрешение/среднее/сильно сжатое видео, которое шлёт
  // сам браузер демонстрирующего). Раньше это было отдельным подменю в контекстном меню ("Высокое/
  // Среднее/Низкое"), но угадать, когда обычному пользователю понадобится вручную занижать себе
  // качество показа экрана собеседника, довольно сложно - на практике почти никто это не трогает,
  // а adaptiveStream (см. настройки Room выше) уже сам адаптирует качество под размер тайла на
  // экране. Поэтому убрали селектор из меню и просто всегда принудительно запрашиваем максимальное
  // качество (HIGH) как только подписываемся на чужую демонстрацию - чтобы никто не унаследовал
  // низкое качество от предыдущей версии кода без возможности вернуть его обратно через UI.
  function forceHighRemoteScreenQuality(identity) {
    const p = room.getParticipantByIdentity(identity)
    if (!p) return
    const pub = p.getTrackPublication(LK.Track.Source.ScreenShare)
    if (pub && typeof pub.setVideoQuality === 'function') pub.setVideoQuality(LK.VideoQuality.HIGH)
  }

  document.addEventListener('fullscreenchange', syncFullscreenButtons)
  // webkit-префикс: старые версии iOS/Safari шлют только это событие
  document.addEventListener('webkitfullscreenchange', syncFullscreenButtons)

  const cameraTilesMap = new Map() // identity -> {tile, video, placeholder, label}
  const screenTilesMap = new Map() // trackSid -> {tile, video, label, fsBtn, volumeCtl}

  // Определить, является ли участник создателем комнаты, по его metadata ({"isHost":true}, задаётся в JWT на сервере)
  function isParticipantHost(participant) {
    try {
      return !!(participant.metadata && JSON.parse(participant.metadata).isHost)
    } catch {
      return false
    }
  }

  function ensureCameraTile(identity, name, isLocal, hostBadge = false) {
    if (cameraTilesMap.has(identity)) return cameraTilesMap.get(identity)
    const t = makeCameraTile(identity, name, isLocal, hostBadge)
    cameraTilesMap.set(identity, t)
    document.body.appendChild(t.tile) // temp, relayout moves it
    relayout()
    return t
  }

  function removeCameraTile(identity) {
    const t = cameraTilesMap.get(identity)
    if (t) { t.tile.remove(); cameraTilesMap.delete(identity) }
    relayout()
  }

  // ---- Тайл демонстрации экрана: идемпотентное создание по trackSid ----
  // Раньше makeScreenTile() вызывался напрямую из нескольких мест (TrackSubscribed, рендер уже
  // подключённых участников при входе, старт своей демки) без проверки на существование тайла с
  // таким же trackSid. Из-за гонки событий (например, TrackSubscribed срабатывал одновременно с
  // ручным рендером существующих публикаций участника при подключении) один и тот же поток экрана
  // мог получить два DOM-тайла одновременно - "демка раздваивалась". ensureScreenTile() гарантирует
  // единственный тайл на trackSid и переиспользует существующий, если он уже есть.
  function ensureScreenTile(identity, name, sid, isLocal = false) {
    const existing = screenTilesMap.get(sid)
    if (existing) return existing
    const t = makeScreenTile(identity, name, sid, isLocal)
    screenTilesMap.set(sid, t)
    document.body.appendChild(t.tile) // temp, relayout moves it
    state.screenShares.set(sid, { identity, name })
    relayout()
    return t
  }

  function removeScreenTile(sid) {
    const t = screenTilesMap.get(sid)
    if (t) { t.tile.remove(); screenTilesMap.delete(sid) }
    state.screenShares.delete(sid)
    relayout()
  }

  // ---- Убрать ЧУЖИЕ тайлы демонстрации того же участника, если у него появился НОВЫЙ trackSid ----
  // ВАЖНО ("баг: демки копятся, некорректно завершаются"): у одного участника может быть только
  // ОДНА активная демонстрация экрана одновременно (бизнес-правило приложения). Если на клиента
  // приходит TrackSubscribed с новым trackSid для identity, у которого уже есть тайл со старым
  // trackSid (например, после нестабильной сети участник разорвал соединение и переопубликовал
  // демку без того, чтобы этот клиент успел получить TrackUnsubscribed на старый трек), старый
  // тайл-призрак остаётся висеть навечно, пока explicit ParticipantDisconnected не прилетит (а он
  // может не прилететь вовсе при resume-реконнекте без полного разрыва). Явно убираем все чужие
  // тайлы того же participant.identity, кроме keepSid, при каждой (пере)подписке на его демку.
  function removeStaleScreenTilesOf(identity, keepSid) {
    for (const [sid, info] of Array.from(state.screenShares.entries())) {
      if (info.identity === identity && sid !== keepSid) removeScreenTile(sid)
    }
  }

  // ---- Полная сверка тайлов демонстрации экрана с фактическим состоянием LiveKit-комнаты ----
  // Вызывается после (пере)подключения (RoomEvent.Reconnected) и периодически как защитная сетка -
  // при потере части событий TrackSubscribed/Unsubscribed во время нестабильного соединения (см.
  // логи LiveKit: множественные "channel congestion" + "resuming RTC session" на этом проекте)
  // тайлы могут накопиться (устаревшие остаются) или пропасть (актуальные не отрисовались).
  // Строим множество "актуальных" trackSid из реального состояния room и удаляем всё остальное.
  function reconcileScreenTiles() {
    const liveSids = new Set()
    if (isScreenSharing && currentScreenTrackSid) liveSids.add(currentScreenTrackSid)
    room.remoteParticipants.forEach((participant) => {
      const pub = participant.getTrackPublication(LK.Track.Source.ScreenShare)
      if (pub && pub.track && !pub.isMuted) {
        liveSids.add(pub.trackSid)
        // Если у этого участника уже отрисован тайл со старым sid - убираем его (см. removeStaleScreenTilesOf)
        removeStaleScreenTilesOf(participant.identity, pub.trackSid)
        if (!screenTilesMap.has(pub.trackSid)) {
          const t = ensureScreenTile(participant.identity, participant.name || participant.identity, pub.trackSid)
          pub.track.attach(t.video)
          forceHighRemoteScreenQuality(participant.identity)
        }
      }
    })
    // Убираем тайлы, для которых больше нет актуального живого трека (участник вышел, демка
    // остановлена, или это был "призрак" от разорванного соединения)
    for (const sid of Array.from(screenTilesMap.keys())) {
      if (!liveSids.has(sid)) removeScreenTile(sid)
    }
  }

  // ---- Track handling ----
  room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const name = participant.name || participant.identity
    if (track.source === LK.Track.Source.Camera) {
      const t = ensureCameraTile(participant.identity, name, false, isParticipantHost(participant))
      track.attach(t.video)
      t.placeholder.style.display = 'none'
      updateCamIndicator(participant.identity, false)
    } else if (track.source === LK.Track.Source.Microphone) {
      const audioEl = document.body.appendChild(el('audio', { autoplay: true, style: 'display:none' }))
      track.attach(audioEl)
      if (state.selectedSpeakerId && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(state.selectedSpeakerId).catch(() => {})
      }
      ensureCameraTile(participant.identity, name, false, isParticipantHost(participant))
      updateMicIndicator(participant.identity, publication.isMuted)
    } else if (track.source === LK.Track.Source.ScreenShare) {
      const alreadyExisted = screenTilesMap.has(publication.trackSid)
      // См. removeStaleScreenTilesOf(): у participant.identity могла остаться демка-призрак
      // со старым trackSid (после разрыва/переподключения по нестабильной сети) - убираем её,
      // прежде чем показать новую, чтобы тайлы не копились.
      removeStaleScreenTilesOf(participant.identity, publication.trackSid)
      const t = ensureScreenTile(participant.identity, name, publication.trackSid)
      track.attach(t.video)
      forceHighRemoteScreenQuality(participant.identity)
      if (!alreadyExisted) showToast(`${name} начал демонстрацию экрана`)
    } else if (track.source === LK.Track.Source.ScreenShareAudio) {
      const audioEl = document.body.appendChild(el('audio', { autoplay: true, style: 'display:none' }))
      track.attach(audioEl)
      if (state.selectedSpeakerId && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(state.selectedSpeakerId).catch(() => {})
      }
    }
  })

  room.on(LK.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (track.source === LK.Track.Source.Camera) {
      const t = cameraTilesMap.get(participant.identity)
      if (t) t.placeholder.style.display = 'flex'
      updateCamIndicator(participant.identity, true)
    } else if (track.source === LK.Track.Source.ScreenShare) {
      removeScreenTile(publication.trackSid)
    }
    track.detach()
  })

  room.on(LK.RoomEvent.TrackMuted, (publication, participant) => {
    if (publication.source === LK.Track.Source.Camera) {
      const t = cameraTilesMap.get(participant.identity)
      if (t) t.placeholder.style.display = 'flex'
      updateCamIndicator(participant.identity, true)
    } else if (publication.source === LK.Track.Source.Microphone) {
      updateMicIndicator(participant.identity, true)
    }
  })
  room.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
    if (publication.source === LK.Track.Source.Camera) {
      const t = cameraTilesMap.get(participant.identity)
      if (t) t.placeholder.style.display = 'none'
      updateCamIndicator(participant.identity, false)
    } else if (publication.source === LK.Track.Source.Microphone) {
      updateMicIndicator(participant.identity, false)
    }
  })

  room.on(LK.RoomEvent.ParticipantConnected, (participant) => {
    showToast(`${participant.name || participant.identity} присоединился`)
    ensureCameraTile(participant.identity, participant.name || participant.identity, false, isParticipantHost(participant))
  })

  room.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
    showToast(`${participant.name || participant.identity} покинул звонок`)
    removeCameraTile(participant.identity)
    // Clean up any of their screen shares
    for (const [sid, info] of Array.from(state.screenShares.entries())) {
      if (info.identity === participant.identity) removeScreenTile(sid)
    }
  })

  room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const speakingIds = new Set(speakers.map((p) => p.identity))
    for (const [identity, t] of cameraTilesMap.entries()) {
      t.tile.classList.toggle('speaking', speakingIds.has(identity))
    }
  })

  room.on(LK.RoomEvent.Disconnected, (reason) => {
    setStatus('Отключено', 'disconnected')
    if (reason === LK.DisconnectReason.PARTICIPANT_REMOVED) {
      showToast('Вас выгнал из звонка создатель комнаты', 'error')
    } else {
      showToast('Вы отключены от звонка', reason ? 'error' : 'info')
    }
    cleanupAndGoLobby()
  })

  room.on(LK.RoomEvent.Reconnecting, () => setStatus('Переподключение...', 'connecting'))
  // ВАЖНО ("баг: демки копятся, некорректно завершаются"): после успешного восстановления
  // соединения (частое явление на этом проекте - см. логи LiveKit с "channel congestion" при
  // нестабильной сети) часть событий TrackSubscribed/TrackUnsubscribed, произошедших ВО ВРЕМЯ
  // разрыва, может не долететь до этого клиента. reconcileScreenTiles() сверяет тайлы демонстрации
  // с фактическим состоянием room сразу после Reconnected, убирая тайлы-призраки и добавляя
  // пропущенные - это защитная сетка сверх точечных фиксов в TrackSubscribed/ParticipantDisconnected.
  room.on(LK.RoomEvent.Reconnected, () => { setStatus('Подключено', ''); reconcileScreenTiles() })

  // ---- Connect ----
  try {
    await room.connect(url, token)
    setStatus('Подключено', '')

    // Публикуем камеру/микрофон согласно выбору пользователя в лобби (можно войти с выключенными)
    await room.localParticipant.setCameraEnabled(state.cameraEnabled)
    await room.localParticipant.setMicrophoneEnabled(state.micEnabled)

    const localTile = ensureCameraTile(room.localParticipant.identity, state.displayName, true, state.isHost)
    const camPub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera)
    if (camPub && camPub.track) camPub.track.attach(localTile.video)
    localTile.placeholder.style.display = state.cameraEnabled ? 'none' : 'flex'
    localTile.camIcon.style.display = state.cameraEnabled ? 'none' : 'inline'

    // Синхронизируем кнопки управления с фактическим стартовым состоянием
    micBtn.classList.toggle('active', state.micEnabled)
    micBtn.classList.toggle('off', !state.micEnabled)
    micBtn.querySelector('i').className = state.micEnabled ? 'fas fa-microphone' : 'fas fa-microphone-slash'
    camBtn.classList.toggle('active', state.cameraEnabled)
    camBtn.classList.toggle('off', !state.cameraEnabled)
    camBtn.querySelector('i').className = state.cameraEnabled ? 'fas fa-video' : 'fas fa-video-slash'

    // Render existing remote participants
    room.remoteParticipants.forEach((participant) => {
      ensureCameraTile(participant.identity, participant.name || participant.identity, false, isParticipantHost(participant))
      participant.trackPublications.forEach((pub) => {
        if (pub.source === LK.Track.Source.Microphone) {
          updateMicIndicator(participant.identity, pub.isMuted)
        }
        if (pub.source === LK.Track.Source.Camera) {
          updateCamIndicator(participant.identity, !pub.track || pub.isMuted)
        }
        if (pub.track) {
          if (pub.source === LK.Track.Source.Camera) {
            const t = cameraTilesMap.get(participant.identity)
            pub.track.attach(t.video)
            t.placeholder.style.display = 'none'
          } else if (pub.source === LK.Track.Source.ScreenShare) {
            const t = ensureScreenTile(participant.identity, participant.name || participant.identity, pub.trackSid)
            pub.track.attach(t.video)
            forceHighRemoteScreenQuality(participant.identity)
          }
        }
      })
    })
  } catch (e) {
    console.error(e)
    showToast('Не удалось подключиться к звонку: ' + e.message, 'error')
    setTimeout(() => renderLobby(), 1500)
    return
  }

  // ---- Controls wiring ----
  micBtn.addEventListener('click', async () => {
    state.micEnabled = !state.micEnabled
    await room.localParticipant.setMicrophoneEnabled(state.micEnabled)
    micBtn.classList.toggle('active', state.micEnabled)
    micBtn.classList.toggle('off', !state.micEnabled)
    micBtn.querySelector('i').className = state.micEnabled ? 'fas fa-microphone' : 'fas fa-microphone-slash'
  })

  camBtn.addEventListener('click', async () => {
    state.cameraEnabled = !state.cameraEnabled
    const pub = await room.localParticipant.setCameraEnabled(state.cameraEnabled)
    camBtn.classList.toggle('active', state.cameraEnabled)
    camBtn.classList.toggle('off', !state.cameraEnabled)
    camBtn.querySelector('i').className = state.cameraEnabled ? 'fas fa-video' : 'fas fa-video-slash'
    const t = cameraTilesMap.get(room.localParticipant.identity)
    if (t) {
      // Если камера включается впервые за это подключение (входили с выключенной), трек создаётся только сейчас -
      // его нужно прикрепить к <video>; при повторном вкл/выкл трек уже прикреплён и просто мьютится/анмьютится
      if (state.cameraEnabled && pub && pub.track && !t.video.srcObject) {
        pub.track.attach(t.video)
      }
      t.placeholder.style.display = state.cameraEnabled ? 'none' : 'flex'
      t.camIcon.style.display = state.cameraEnabled ? 'none' : 'inline'
    }
  })

  let isScreenSharing = false
  let screenShareBusy = false // защита от повторного/двойного клика во время async старта - вторая причина "раздвоения" демки
  let currentScreenTrackSid = null

  // Битрейт подбираем под выбранную частоту кадров: чем больше кадров в секунду, тем
  // больше данных нужно, чтобы картинка не рассыпалась; на 15 кадрах 8 Мбит/с - излишество.
  function bitrateForFps(fps) {
    if (fps <= 15) return 4_000_000
    if (fps <= 30) return 6_000_000
    return 8_000_000 // 8 Мбит/с - запас для 60 кадров без просадок
  }

  // ---- Применить выбранный FPS к уже идущей демонстрации "живьём" ----
  // Меняем и реальные constraints захвата (applyConstraints), и предел кодировщика
  // (RTCRtpSender encodings[].maxFramerate) - иначе повышение FPS не даст эффекта, если сендер
  // уже был ограничен более низким значением на старте публикации.
  function applyScreenShareFps(fps) {
    if (!isScreenSharing) return
    const pub = room.localParticipant.getTrackPublication(LK.Track.Source.ScreenShare)
    const track = pub && pub.track
    if (!track) return
    const msTrack = track.mediaStreamTrack
    if (msTrack && typeof msTrack.applyConstraints === 'function') {
      msTrack.applyConstraints({ frameRate: { ideal: fps, min: Math.min(fps, 30) } }).catch(() => {})
    }
    const sender = track.sender
    if (sender && typeof sender.getParameters === 'function') {
      try {
        const params = sender.getParameters()
        if (params.encodings && params.encodings.length) {
          params.encodings.forEach((enc) => { enc.maxFramerate = fps; enc.maxBitrate = bitrateForFps(fps) })
          Promise.resolve(sender.setParameters(params)).catch(() => {})
        }
      } catch {}
    }
  }

  // Вызывается из подменю "Качество передачи" (ПКМ на своём тайле демонстрации):
  // запоминаем выбор и сразу применяем его к текущему стриму.
  function setScreenShareFps(fps) {
    if (state.screenShareFps === fps) return
    state.screenShareFps = fps
    try { localStorage.setItem('screenShareFps', String(fps)) } catch {}
    applyScreenShareFps(fps)
    showToast(`Качество передачи: ${fps} FPS`)
  }

  // ===================== Демонстрация экрана: start/stop/change-source отдельными функциями =====================
  // Вынесено из единого screenBtn-обработчика, чтобы этими же действиями можно было управлять
  // и из кастомного контекстного меню (ПКМ на тайле демонстрации): "Прекратить стрим", "Изменить источник".

  // ---- Запустить демонстрацию экрана ----
  // Единый путь для веба и Electron: LiveKit вызывает navigator.mediaDevices.getDisplayMedia().
  // В браузере это открывает системный диалог "Поделиться экраном" с чекбоксом "Поделиться аудио".
  // В Electron этот вызов перехватывается session.setDisplayMediaRequestHandler (main.js) - там
  // открывается наш пикер (picker.html) со своим чекбоксом "Поделиться звуком стрима" (по умолчанию
  // включён), и звук захватывается через audio: 'loopback' (поддерживается на Windows).
  // ВАЖНО про звук: запрашиваем audio:true ВСЕГДА, независимо от текущего state.screenShareAudioShared -
  // так гарантируется, что аудио-трек демонстрации ВСЕГДА захватывается и публикуется (по явному
  // требованию "всегда должно быть слышно звук демки"); если пользователь выключил чекбокс "Поделиться
  // звуком стрима" в контекстном меню, мы просто мьютим уже существующий трек (toggleScreenShareAudio),
  // а не отказываемся от его захвата - так его можно включить обратно "живьём", без пересоздания демки.
  async function startScreenShare() {
    if (screenShareBusy || isScreenSharing) return
    // Check global limit before starting
    try {
      const res = await fetch(`/api/rooms/${state.roomCode}/screen-shares`)
      const data = await res.json()
      if (data.available <= 0) {
        showToast(`Достигнут лимит демонстраций экрана (максимум ${state.maxScreenShares} одновременно)`, 'error')
        return
      }
    } catch {
      // если проверка не удалась - разрешаем попытку, сервер/LiveKit не блокирует физически,
      // но по договоренности лимит соблюдается на уровне приложения
    }

    screenShareBusy = true
    try {
      // ВАЖНО про кадры: пресеты LiveKit (например LK.ScreenSharePresets.h1080fps30) жёстко
      // ограничивают frameRate 30 кадрами ещё на уровне getDisplayMedia(), независимо от
      // videoEncoding.maxFramerate ниже. Поэтому resolution задаём вручную с выбранной частотой кадров.
      // Значение берём из выбора в меню ПКМ (state.screenShareFps, по умолчанию 60).
      const fps = state.screenShareFps
      const hint = SCREEN_SHARE_CONTENT_HINT
      const pub = await room.localParticipant.setScreenShareEnabled(true, {
        video: { displaySurface: 'monitor' },
        // ВАЖНО ("баг: сам себя слышно, если включен звук на демке"): при захвате системного звука
        // всего экрана (не отдельной вкладки) браузер по умолчанию захватывает В ТОМ ЧИСЛЕ звук,
        // который выводит сама эта вкладка/приложение - то есть голос собеседников, воспроизводимый
        // через колонки локально, попадает обратно в исходящий поток демонстрации и мы слышим эхо
        // самого себя. restrictOwnAudio: true (стандартный W3C-констрейнт Screen Capture API) просит
        // браузер вычесть из системного аудио звук, произведённый самим этим документом/вкладкой -
        // именно то, что нужно для звонков (Chrome/Chromium поддерживает; на неподдерживающих
        // браузерах констрейнт просто игнорируется, без ошибки).
        audio: { restrictOwnAudio: true }, // всегда запрашиваем звук - живое вкл/выкл делается позже мьютом трека, не пересозданием
        systemAudio: 'include',
        resolution: { width: 1920, height: 1080, frameRate: fps },
        contentHint: hint
      }, {
        videoEncoding: { maxBitrate: bitrateForFps(fps), maxFramerate: fps },
        // degradationPreference по умолчанию для ScreenShare = "maintain-resolution" - при перегрузке
        // CPU/сети WebRTC-энкодер режет именно FPS, сохраняя разрешение, отсюда и проседание до 40-50
        // на 60 FPS. Для плавности важнее стабильный FPS, чем максимальная резкость - переключаем на
        // "balanced", чтобы энкодер мог слегка снизить резкость/битрейт, но удерживал частоту кадров.
        degradationPreference: 'balanced',
        simulcast: false,
        // H264 имеет аппаратное ускорение кодирования на Windows (наша целевая платформа для Electron) -
        // при наличии GPU это даёт заметно более плавную и лёгкую по CPU демонстрацию, ближе к тому,
        // как это работает в Discord. В браузере (не Electron) большинство десктопов также поддерживают
        // аппаратный H264-энкодер в Chromium, поэтому применяем это ко всем платформам.
        videoCodec: 'h264'
      })

      if (!pub) return // пользователь отменил выбор источника

      // Дополнительная защита: явно применяем те же настройки к реальному видео-треку/сендеру
      // (contentHint + попытка выставить frameRate через applyConstraints), т.к. некоторые браузеры
      // игнорируют frameRate в getDisplayMedia() constraints и отдают дефолтные ~30 FPS потока.
      try {
        const msTrack = pub.track && pub.track.mediaStreamTrack
        if (msTrack) {
          msTrack.contentHint = hint
          if (typeof msTrack.applyConstraints === 'function') {
            await msTrack.applyConstraints({ frameRate: { ideal: fps, min: Math.min(fps, 30) } }).catch(() => {})
          }
        }
      } catch {}

      isScreenSharing = true
      currentScreenTrackSid = pub.trackSid
      screenBtn.classList.add('active')

      const t = ensureScreenTile(room.localParticipant.identity, state.displayName + ' (Вы)', pub.trackSid, true)
      pub.track.attach(t.video)

      // Применяем текущее состояние "Поделиться звуком стрима" к только что созданному аудио-треку
      // (если пользователь ранее выключил звук через контекстное меню - он остаётся выключенным и
      // для новой демонстрации, пока не включит явно обратно)
      applyScreenShareAudioState()

      // ВАЖНО ("баг: демки копятся, некорректно завершаются"): если ПРЕДЫДУЩАЯ демонстрация ЭТОГО
      // ЖЕ участника завершилась некорректно (разрыв сети/крэш/force-quit, без штатного unpublish),
      // на сервере LiveKit могла остаться "висящая" публикация со старым trackSid - сервер её
      // физически видит и учитывает в лимите /api/rooms/:code/screen-shares, хотя показывать её
      // больше некому. Явно просим backend замьютить любые чужие (по trackSid) ScreenShare/
      // ScreenShareAudio публикации ЭТОГО identity сразу после того, как новая демка успешно
      // стартовала - надёжная точка, потому что мы точно знаем актуальный keepTrackSid именно тут.
      fetch(`/api/rooms/${state.roomCode}/screen-shares/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: room.localParticipant.identity, keepTrackSid: pub.trackSid })
      }).catch(() => {})

      // Если пользователь остановил демку через системный UI браузера/ОС
      pub.track.mediaStreamTrack.addEventListener('ended', () => {
        if (currentScreenTrackSid === pub.trackSid) {
          isScreenSharing = false
          currentScreenTrackSid = null
          screenBtn.classList.remove('active')
          removeScreenTile(pub.trackSid)
        }
      })
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        showToast('Не удалось начать демонстрацию экрана', 'error')
        console.error(e)
      }
    } finally {
      screenShareBusy = false
    }
  }

  // ---- Остановить свою демонстрацию экрана ----
  async function stopScreenShare() {
    if (screenShareBusy || !isScreenSharing) return
    screenShareBusy = true
    try {
      await room.localParticipant.setScreenShareEnabled(false)
    } finally {
      screenShareBusy = false
    }
    isScreenSharing = false
    screenBtn.classList.remove('active')
    if (currentScreenTrackSid) {
      removeScreenTile(currentScreenTrackSid)
      currentScreenTrackSid = null
    }
  }

  // ---- Сменить источник демонстрации (другой экран/окно), без выхода из режима демонстрации ----
  // Останавливаем текущий трек и сразу запускаем новый - для веба откроется системный диалог выбора
  // экрана повторно, для Electron - наш picker.html повторно (через setDisplayMediaRequestHandler).
  async function changeScreenSource() {
    if (screenShareBusy) return
    if (isScreenSharing) await stopScreenShare()
    await startScreenShare()
  }

  // ---- Живое вкл/выкл звука демонстрации (чекбокс "Поделиться звуком стрима" в контекстном меню) ----
  // Мьютим/анмьютим уже опубликованный аудио-трек ScreenShareAudio, НЕ пересоздавая демонстрацию -
  // так переключение мгновенное и не прерывает видео.
  function applyScreenShareAudioState() {
    const pub = room.localParticipant.getTrackPublication(LK.Track.Source.ScreenShareAudio)
    if (!pub) return
    if (state.screenShareAudioShared) pub.unmute()
    else pub.mute()
  }

  function toggleScreenShareAudio() {
    state.screenShareAudioShared = !state.screenShareAudioShared
    localStorage.setItem('screenShareAudioShared', state.screenShareAudioShared ? '1' : '0')
    applyScreenShareAudioState()
    showToast(state.screenShareAudioShared ? 'Звук стрима включён' : 'Звук стрима выключен')
  }

  // ---- "Стрим в отдельном окне" - Document Picture-in-Picture API ----
  // Поддерживается в Chromium (обычный браузер на его основе, а также сам Electron - тоже Chromium),
  // позволяет вынести произвольный <video> в отдельное всегда-поверх-окно, которое можно двигать
  // независимо от основного окна приложения/вкладки.
  async function openScreenSharePiP(video) {
    if (!('documentPictureInPicture' in window)) {
      showToast('Режим "отдельное окно" не поддерживается этим браузером', 'error')
      return
    }
    try {
      const pipWindow = await window.documentPictureInPicture.requestWindow({
        width: video.videoWidth || 960,
        height: video.videoHeight || 540
      })
      // Копируем базовые стили, чтобы видео заполняло PiP-окно целиком
      const style = pipWindow.document.createElement('style')
      style.textContent = 'html,body{margin:0;background:#000;height:100%;} video{width:100%;height:100%;object-fit:contain;display:block;}'
      pipWindow.document.head.appendChild(style)

      const originalParent = video.parentElement
      const placeholder = document.createComment('pip-placeholder')
      originalParent.insertBefore(placeholder, video)
      pipWindow.document.body.appendChild(video)

      pipWindow.addEventListener('pagehide', () => {
        // Возвращаем видео обратно в основной документ, когда PiP-окно закрыто
        placeholder.replaceWith(video)
      }, { once: true })
    } catch (e) {
      showToast('Не удалось открыть отдельное окно', 'error')
      console.error(e)
    }
  }

  screenBtn.addEventListener('click', async () => {
    if (screenShareBusy) return // клик во время уже идущего старта/остановки - игнорируем, чтобы не запустить процесс дважды
    if (isScreenSharing) await stopScreenShare()
    else await startScreenShare()
  })

  leaveBtn.addEventListener('click', () => {
    cleanupAndGoLobby()
  })

  // ---- Панель участников (кнопка в правом верхнем углу) ----
  // Раньше кнопка была декоративной и ничего не делала. Теперь она открывает боковую панель
  // со списком тех, кто сейчас в звонке: имя, инициалы, отметка создателя и состояние микрофона.
  function closeParticipantsPanel() {
    const existing = document.querySelector('.panel-overlay')
    if (!existing) return false
    existing.remove()
    return true
  }

  function participantRow(name, isLocal, isHost, micMuted) {
    const children = [
      el('div', { class: 'avatar-circle' }, initials(name)),
      el('span', {}, name + (isLocal ? ' (Вы)' : ''))
    ]
    if (isHost) children.push(el('i', { class: 'fas fa-crown host-crown', title: 'Создатель комнаты' }))
    if (micMuted) children.push(el('i', { class: 'fas fa-microphone-slash', title: 'Микрофон выключен', style: 'color:var(--danger-soft)' }))
    return el('div', { class: 'panel-participant' }, children)
  }

  function openParticipantsPanel() {
    if (closeParticipantsPanel()) return // повторный клик закрывает панель

    const panel = el('div', { class: 'panel' })
    const closeBtn = el('button', { class: 'panel-close', type: 'button', 'aria-label': 'Закрыть' }, [el('i', { class: 'fas fa-times' })])
    panel.appendChild(closeBtn)
    panel.appendChild(el('h3', {}, `Участники · ${room.remoteParticipants.size + 1}`))
    panel.appendChild(participantRow(state.displayName, true, state.isHost, !state.micEnabled))
    room.remoteParticipants.forEach((p) => {
      const micPub = p.getTrackPublication(LK.Track.Source.Microphone)
      const micMuted = !micPub || micPub.isMuted
      panel.appendChild(participantRow(p.name || p.identity, false, isParticipantHost(p), micMuted))
    })

    const overlay = el('div', { class: 'panel-overlay' }, [panel])
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeParticipantsPanel() })
    closeBtn.addEventListener('click', closeParticipantsPanel)
    document.body.appendChild(overlay)
  }

  participantsBtn.addEventListener('click', openParticipantsPanel)
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeParticipantsPanel() })

  // ---- Периодическая защитная сверка тайлов демонстрации экрана (safety net) ----
  // ВАЖНО ("баг: демки копятся, некорректно завершаются"): reconcileScreenTiles() уже вызывается
  // точечно на RoomEvent.Reconnected, но иногда соединение "зависает" в промежуточном состоянии
  // без полноценного Reconnecting/Reconnected цикла (например, при кратковременной потере пакетов
  // сигнального WS без разрыва) - события TrackSubscribed/Unsubscribed могут быть потеряны молча.
  // Раз в 15 секунд дополнительно сверяем тайлы с фактическим состоянием room - дешёвая операция
  // (просто перебор уже загруженных в память participants/publications, без сетевых запросов),
  // страхует от накопления тайлов-призраков в длительных звонках.
  const screenTilesReconcileInterval = setInterval(() => { try { reconcileScreenTiles() } catch {} }, 15000)

  function cleanupAndGoLobby() {
    clearInterval(screenTilesReconcileInterval)
    try { room.disconnect() } catch {}
    document.querySelectorAll('audio').forEach((a) => a.remove())
    history.pushState({}, '', '/')
    renderLobby()
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(screenTilesReconcileInterval)
    try { room.disconnect() } catch {}
  })
}

// ===================== Инициализация =====================
if (location.pathname.startsWith('/room/')) {
  const code = location.pathname.split('/room/')[1]
  renderLobby(code)
} else {
  renderLobby()
}
