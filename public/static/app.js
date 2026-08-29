// ===================== Звонки: клиентское приложение =====================
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
  screenShareFps: Number(localStorage.getItem('screenShareFps')) || 60, // выбранный FPS для демонстрации экрана (запоминается между звонками)
  // "Поделиться звуком стрима" - по умолчанию ВКЛЮЧЕНО (звук демонстрации должен быть слышен всегда,
  // если явно не выключен пользователем через кастомное контекстное меню на тайле демонстрации)
  screenShareAudioShared: localStorage.getItem('screenShareAudioShared') !== '0',
  screenShareContentHint: localStorage.getItem('screenShareContentHint') || 'motion' // 'motion' | 'detail'
}

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
    el('div', { class: 'auth-form-hint' }, 'Имя - любой язык · Юзернейм - латиница/цифры/_/-, 3-24 символа'),
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
    el('h1', {}, 'Привет!'),
    el('p', {}, 'Введите логин и пароль, чтобы начать пользоваться сервисом'),
    toRegisterBtn
  ])

  const toLoginBtn = el('button', { type: 'button', class: 'auth-ghost-btn' }, 'Войти')
  const overlayLeft = el('div', { class: 'auth-overlay-panel auth-overlay-left' }, [
    el('h1', {}, 'С возвращением!'),
    el('p', {}, 'Чтобы продолжить, войдите с вашим логином и паролем'),
    toLoginBtn
  ])

  const overlay = el('div', { class: 'auth-overlay' }, [overlayLeft, overlayRight])
  const overlayContainer = el('div', { class: 'auth-overlay-container' }, [overlay])

  container.appendChild(loginPanel)
  container.appendChild(registerPanel)
  container.appendChild(overlayContainer)
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

  card.appendChild(el('h1', {}, IS_ELECTRON ? 'Звонки' : 'Звонки (веб)'))
  card.appendChild(el('div', { class: 'subtitle' }, 'Качественная связь без ВПН · до 5 участников · 2 демонстрации экрана в 60 FPS'))

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
  const previewVideo = el('video', { autoplay: true, muted: true, playsinline: true })
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

  const hint = el('div', { class: 'hint-text' }, 'Поделитесь кодом комнаты с другими для совместного звонка (до 5 человек).')
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
  // Скрываем кнопку и FPS-переключатель целиком, если API физически отсутствует.
  const canScreenShare = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')

  // ---- Выбор FPS для демонстрации экрана: кнопка-шеврон открывает мини-меню с вариантами ----
  const FPS_OPTIONS = [15, 30, 60]
  const fpsGroup = el('div', { class: 'screen-fps-group' })
  const fpsBtn = el('button', { class: 'ctrl-btn fps-toggle-btn', title: 'Частота кадров демонстрации' }, [
    el('span', { class: 'fps-toggle-label' }, `${state.screenShareFps}`),
    el('i', { class: 'fas fa-chevron-up fps-toggle-caret' })
  ])
  const fpsMenu = el('div', { class: 'fps-menu', style: 'display:none' })
  FPS_OPTIONS.forEach((fps) => {
    const item = el('button', { type: 'button', class: `fps-menu-item${fps === state.screenShareFps ? ' selected' : ''}` }, `${fps} FPS`)
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      state.screenShareFps = fps
      localStorage.setItem('screenShareFps', String(fps))
      fpsMenu.querySelectorAll('.fps-menu-item').forEach((el2) => el2.classList.remove('selected'))
      item.classList.add('selected')
      fpsBtn.querySelector('.fps-toggle-label').textContent = String(fps)
      fpsMenu.style.display = 'none'
      applyScreenShareFps(fps) // если демка уже идёт - применяем новое значение "живьём"
    })
    fpsMenu.appendChild(item)
  })
  fpsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    fpsMenu.style.display = fpsMenu.style.display === 'none' ? 'flex' : 'none'
  })
  document.addEventListener('click', () => { fpsMenu.style.display = 'none' })
  fpsGroup.appendChild(screenBtn)
  fpsGroup.appendChild(fpsBtn)
  fpsGroup.appendChild(fpsMenu)

  const divider1 = el('div', { class: 'ctrl-divider' })
  const leaveBtn = el('button', { class: 'leave-btn' }, [el('i', { class: 'fas fa-phone-slash' }), ' Выйти'])

  controls.appendChild(micBtn)
  controls.appendChild(camBtn)
  if (canScreenShare) controls.appendChild(fpsGroup)
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

  function relayout() {
    // Камеры/аватары участников -> stage (центрированный flex, как в Discord). Демки экрана ->
    // stage приоритетно, камеры уходят в сайдбар если есть демки.
    const hasScreenShares = state.screenShares.size > 0
    const cameraTiles = Array.from(document.querySelectorAll('.camera-tile'))
    const screenTiles = Array.from(document.querySelectorAll('.screen-tile'))
    // На узких экранах (телефон, особенно портретная ориентация) сетке физически негде
    // расположить несколько колонок без сильного сжатия каждого тайла - принудительно
    // уменьшаем число колонок, независимо от того, сколько тайлов реально помещалось бы
    // на десктопе. Порог 860px совпадает с медиа-запросом в CSS, где сайдбар демок
    // становится горизонтальной "плёнкой" под сценой вместо вертикальной колонки справа.
    const isNarrow = window.innerWidth <= 860

    stage.innerHTML = ''
    sidebar.innerHTML = ''
    stage.classList.add('stage-centered')
    stage.classList.remove('screen-count-2')

    if (hasScreenShares) {
      screenTiles.forEach((t) => stage.appendChild(t))
      cameraTiles.forEach((t) => sidebar.appendChild(t))
      sidebar.style.display = cameraTiles.length ? 'flex' : 'none'
      const n = screenTiles.length
      // Две демки одновременно на телефоне лучше показывать друг под другом, чем сжимать
      // пополам по ширине - иначе контент демонстрации становится нечитаемым
      if (n > 1 && !isNarrow) stage.classList.add('screen-count-2')
      stage.style.gridTemplateColumns = ''
    } else {
      sidebar.style.display = 'none'
      cameraTiles.forEach((t) => stage.appendChild(t))
      stage.style.gridTemplateColumns = ''
    }

    screenCountBadge.style.display = state.screenShares.size > 0 ? 'block' : 'none'
    screenCountBadge.textContent = String(state.screenShares.size)
  }

  // Пересчитать раскладку при повороте телефона / изменении размера окна (например, вызов
  // виртуальной клавиатуры или переход портрет<->ландшафт) - без этого сетка "застревала"
  // в раскладке, посчитанной на момент последнего relayout(), а не текущей ширины экрана
  // ВАЖНО ("баг: полный экран открывается на 1мс и сразу закрывается обратно"): relayout()
  // делает stage.innerHTML = '' и appendChild() каждого тайла ЗАНОВО - то есть физически вынимает
  // DOM-узел из документа и вставляет обратно. У requestFullscreen() есть окно браузера, и когда
  // ОНО меняет размер (пропадают/появляются тулбары, адресная строка) - это САМО ПО СЕБЕ стреляет
  // window resize событием. Получается цикл: клик на fullscreen -> requestFullscreen() -> браузер
  // ужимает вьюпорт -> resize -> relayout() удаляет и заново вставляет ЭТОТ ЖЕ тайл (который сейчас
  // document.fullscreenElement) -> по спецификации Fullscreen API удаление/детач элемента из DOM
  // ПРИНУДИТЕЛЬНО завершает fullscreen -> браузер сам откатывает обратно за ~100-200мс. Из-за этого
  // выглядит как "мигает и не открывается". Фикс: если сейчас активен fullscreen (или прошло меньше
  // 400мс с момента входа/выхода из него - за это время дребезжит несколько resize подряд), просто
  // не трогаем DOM тайлов в этом цикле relayout(), а откладываем на momент, когда fullscreen точно
  // закрыт - тогда resize после реального fullscreenchange безопасен.
  let relayoutRAF = null
  window.addEventListener('resize', () => {
    if (relayoutRAF) return
    relayoutRAF = requestAnimationFrame(() => {
      relayoutRAF = null
      if (document.fullscreenElement) return // не дёргаем DOM, пока какой-то тайл в fullscreen
      relayout()
    })
  })
  // Как только fullscreen закрывается (штатно или из-за гонки выше) - пересчитываем раскладку разово,
  // чтобы вернуть тайл в его нормальное место в сетке (на случай, если resize во время fullscreen был
  // пропущен из-за проверки выше).
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      if (relayoutRAF) cancelAnimationFrame(relayoutRAF)
      relayoutRAF = requestAnimationFrame(() => { relayoutRAF = null; relayout() })
    }
  })

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

  function makeCameraTile(identity, name, isLocal, hostBadge) {
    const tile = el('div', { class: 'tile camera-tile', id: `tile-cam-${identity}` })
    const video = el('video', { autoplay: true, playsinline: true, ...(isLocal ? { muted: true } : {}) })
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

  // ---- Полноэкранный режим для тайла (демонстрация экрана) ----
  function toggleTileFullscreen(tile) {
    if (document.fullscreenElement === tile) {
      document.exitFullscreen().catch(() => {})
    } else {
      tile.requestFullscreen().catch(() => showToast('Не удалось открыть полноэкранный режим', 'error'))
    }
  }

  function makeScreenTile(identity, name, sid, isLocal) {
    const tile = el('div', { class: 'tile screen-tile', id: `tile-screen-${sid}` })
    const video = el('video', { autoplay: true, playsinline: true, muted: true })
    const label = el('div', { class: 'tile-label' }, [el('i', { class: 'fas fa-desktop' }), el('span', {}, `Демонстрация — ${name}`)])
    // Бейджи LIVE + FPS в стиле Discord, в левом верхнем углу тайла демонстрации
    const liveBadge = el('div', { class: 'live-badge-group' }, [
      el('span', { class: 'live-badge' }, [el('span', { class: 'live-dot' }), 'LIVE']),
      el('span', { class: 'fps-badge' }, `${state.screenShareFps} FPS`)
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
    // Кастомное контекстное меню (ПКМ) вместо стандартного браузерного - в стиле Discord.
    // Для своей демонстрации - полный набор действий (стоп/смена источника/звук/PiP/качество).
    // Для чужой демонстрации - только просмотровые опции (PiP + качество приёма).
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openScreenContextMenu(e.clientX, e.clientY, { tile, video, identity, sid, isLocal })
    })
    return { tile, video, label, fsBtn, volumeCtl, fpsBadge: liveBadge.querySelector('.fps-badge') }
  }

  // ---- Обновить FPS-бейдж на тайле демонстрации ----
  function updateScreenFpsBadge(sid, fps) {
    const t = screenTilesMap.get(sid)
    if (t && t.fpsBadge) t.fpsBadge.textContent = `${fps} FPS`
  }

  // ===================== Кастомное контекстное меню тайла демонстрации (Discord-style) =====================
  let activeCtxMenu = null
  let activeCtxSubmenu = null

  function closeScreenContextMenu() {
    if (activeCtxSubmenu) { activeCtxSubmenu.remove(); activeCtxSubmenu = null }
    if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null }
  }
  document.addEventListener('click', closeScreenContextMenu)
  document.addEventListener('contextmenu', (e) => {
    // Клик правой кнопкой где-то ещё (не на тайле демонстрации) - закрыть меню, если открыто
    if (activeCtxMenu && !e.target.closest('.screen-tile')) closeScreenContextMenu()
  })
  window.addEventListener('resize', closeScreenContextMenu)
  window.addEventListener('blur', closeScreenContextMenu)

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

  function positionFloating(node, x, y) {
    document.body.appendChild(node)
    const vw = window.innerWidth, vh = window.innerHeight
    const rect = node.getBoundingClientRect()
    let left = x, top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    node.style.left = left + 'px'
    node.style.top = top + 'px'
  }

  function openSubmenu(anchorEl, buildItems) {
    if (activeCtxSubmenu) { activeCtxSubmenu.remove(); activeCtxSubmenu = null }
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
      const qualityItem = ctxItem({
        icon: 'fas fa-gauge-high', label: 'Качество передачи', chevron: true
      })
      qualityItem.addEventListener('mouseenter', () => {
        openSubmenu(qualityItem, () => FPS_OPTIONS.map((fps) => ctxItem({
          label: `${fps} FPS`,
          selected: fps === state.screenShareFps,
          onClick: () => {
            state.screenShareFps = fps
            localStorage.setItem('screenShareFps', String(fps))
            fpsBtn.querySelector('.fps-toggle-label').textContent = String(fps)
            fpsMenu.querySelectorAll('.fps-menu-item').forEach((el2) => el2.classList.toggle('selected', el2.textContent === `${fps} FPS`))
            applyScreenShareFps(fps)
            if (currentScreenTrackSid) updateScreenFpsBadge(currentScreenTrackSid, fps)
            closeScreenContextMenu()
          }
        })))
      })
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
      items.push(el('div', { class: 'screen-ctx-divider' }))
      const otherItem = ctxItem({ icon: 'fas fa-sliders', label: 'Другие настройки', chevron: true })
      otherItem.addEventListener('mouseenter', () => {
        openSubmenu(otherItem, () => [
          ctxItem({
            label: 'Оптимизировать: движение', selected: state.screenShareContentHint === 'motion',
            onClick: () => { setScreenShareContentHint('motion'); closeScreenContextMenu() }
          }),
          ctxItem({
            label: 'Оптимизировать: чёткость', selected: state.screenShareContentHint === 'detail',
            onClick: () => { setScreenShareContentHint('detail'); closeScreenContextMenu() }
          })
        ])
      })
      items.push(otherItem)
    } else {
      // Чужая демонстрация - только просмотровые действия
      items.push(ctxItem({
        icon: 'fas fa-up-right-from-square', label: 'Стрим в отдельном окне',
        onClick: () => { closeScreenContextMenu(); openScreenSharePiP(ctx.video) }
      }))
      items.push(el('div', { class: 'screen-ctx-divider' }))
      const qualityItem = ctxItem({ icon: 'fas fa-gauge-high', label: 'Качество приёма', chevron: true })
      qualityItem.addEventListener('mouseenter', () => {
        openSubmenu(qualityItem, () => [
          ctxItem({ label: 'Высокое', onClick: () => { setRemoteScreenQuality(identity, LK.VideoQuality.HIGH); closeScreenContextMenu() } }),
          ctxItem({ label: 'Среднее', onClick: () => { setRemoteScreenQuality(identity, LK.VideoQuality.MEDIUM); closeScreenContextMenu() } }),
          ctxItem({ label: 'Низкое', onClick: () => { setRemoteScreenQuality(identity, LK.VideoQuality.LOW); closeScreenContextMenu() } })
        ])
      })
      items.push(qualityItem)
    }

    const menu = el('div', { class: 'screen-ctx-menu' }, items)
    menu.addEventListener('click', (e) => e.stopPropagation())
    menu.addEventListener('contextmenu', (e) => e.preventDefault())
    positionFloating(menu, x, y)
    activeCtxMenu = menu
  }

  function setRemoteScreenQuality(identity, quality) {
    const p = room.getParticipantByIdentity(identity)
    if (!p) return
    const pub = p.getTrackPublication(LK.Track.Source.ScreenShare)
    if (pub && typeof pub.setVideoQuality === 'function') pub.setVideoQuality(quality)
  }

  document.addEventListener('fullscreenchange', () => {
    document.querySelectorAll('.screen-tile, .camera-tile').forEach((t) => {
      const icon = t.querySelector('.tile-fullscreen-btn i')
      if (!icon) return
      icon.className = document.fullscreenElement === t ? 'fas fa-compress' : 'fas fa-expand'
      t.classList.toggle('is-fullscreen', document.fullscreenElement === t)
    })
  })

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

  // Битрейт подбираем под выбранный FPS - чем выше частота кадров, тем больше данных нужно
  // передавать в секунду для сохранения резкости; на 15 FPS высокий битрейт не нужен.
  function bitrateForFps(fps) {
    if (fps <= 15) return 4_000_000
    if (fps <= 30) return 6_000_000
    return 8_000_000
  }

  // ---- Применить выбранный FPS к уже идущей демонстрации "живьём", без пересоздания трека ----
  // Меняем и реальные constraints захвата (applyConstraints), и предел кодировщика (RTCRtpSender
  // encodings[].maxFramerate) - иначе повышение FPS не даст эффекта, если сендер уже был ограничен
  // более низким значением на старте публикации.
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
    showToast(`FPS демонстрации изменён на ${fps}`)
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
      // ВАЖНО про FPS: раньше здесь передавался LK.ScreenSharePresets.h1080fps30.resolution - у этого
      // пресета frameRate жёстко равен 30, и он попадает в getDisplayMedia() как ideal/max frameRate -
      // то есть сама браузерная захватка кадра ограничивалась 30 FPS ещё до энкодера, независимо от
      // videoEncoding.maxFramerate ниже. Задаём resolution вручную с frameRate = выбранное пользователем
      // значение (state.screenShareFps, переключатель 15/30/60 рядом с кнопкой демонстрации).
      const fps = state.screenShareFps
      const hint = state.screenShareContentHint
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

  // ---- "Другие настройки" -> оптимизация контента (движение/чёткость) ----
  function setScreenShareContentHint(hint) {
    state.screenShareContentHint = hint
    localStorage.setItem('screenShareContentHint', hint)
    if (!isScreenSharing) return
    const pub = room.localParticipant.getTrackPublication(LK.Track.Source.ScreenShare)
    const msTrack = pub && pub.track && pub.track.mediaStreamTrack
    if (msTrack) msTrack.contentHint = hint
    showToast(hint === 'motion' ? 'Оптимизация: движение' : 'Оптимизация: чёткость')
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
