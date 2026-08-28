// ===================== Звонки: клиентское приложение =====================
// Работает как в браузере, так и внутри Electron (window.electronAPI, если доступен)
const LK = window.LivekitClient
const IS_ELECTRON = !!window.electronAPI

const state = {
  room: null,
  roomCode: null,
  displayName: '',
  cameraEnabled: true,
  micEnabled: true,
  screenShares: new Map(), // trackSid -> { participantIdentity, participantName }
  maxScreenShares: 2,
  maxParticipants: 5,
  previewStream: null,
  selectedCamId: null,
  selectedMicId: null,
  selectedSpeakerId: null
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
  const toast = el('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, message)
  container.appendChild(toast)
  setTimeout(() => toast.remove(), 4500)
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase()
}

// ===================== ЛОББИ (экран входа) =====================

async function renderLobby(prefillRoomCode = '') {
  root.innerHTML = ''
  const params = new URLSearchParams(location.search)
  const urlRoom = prefillRoomCode || (location.pathname.startsWith('/room/') ? location.pathname.split('/room/')[1] : '') || params.get('room') || ''

  const savedName = localStorage.getItem('displayName') || ''

  const screen = el('div', { class: 'lobby-screen' })
  const card = el('div', { class: 'lobby-card' })

  card.appendChild(el('h1', {}, IS_ELECTRON ? 'Звонки' : 'Звонки (веб)'))
  card.appendChild(el('div', { class: 'subtitle' }, 'Качественная связь без ВПН · до 5 участников · 2 демонстрации экрана в 60 FPS'))

  const errorSlot = el('div', { style: 'display:none' })
  card.appendChild(errorSlot)

  // Device preview
  const preview = el('div', { class: 'device-preview' })
  const previewVideo = el('video', { autoplay: true, muted: true, playsinline: true })
  const noCam = el('div', { class: 'no-cam' }, 'Камера отключена')
  preview.appendChild(previewVideo)
  preview.appendChild(noCam)
  card.appendChild(preview)

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

  const nameInput = el('input', { type: 'text', placeholder: 'Ваше имя', value: savedName, maxlength: '30' })
  card.appendChild(nameInput)

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
    await switchCamera(state.selectedCamId)
  })

  micSelect.addEventListener('change', async () => {
    state.selectedMicId = micSelect.value || null
    if (state.selectedMicId) localStorage.setItem('micDeviceId', state.selectedMicId)
    await startMicMonitor(state.selectedMicId)
  })

  spkSelect.addEventListener('change', () => {
    state.selectedSpeakerId = spkSelect.value || null
    if (state.selectedSpeakerId) localStorage.setItem('speakerDeviceId', state.selectedSpeakerId)
  })

  testBtn.addEventListener('click', () => playTestSound(state.selectedSpeakerId))

  const onDeviceChange = () => populateDeviceLists()
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)

  // start local camera preview (best effort), затем получить лейблы устройств и запустить индикатор микрофона
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    state.previewStream = stream
    previewVideo.srcObject = stream
    noCam.style.display = 'none'
  } catch (e) {
    noCam.style.display = 'flex'
  }

  await populateDeviceLists()
  await startMicMonitor(state.selectedMicId)
  await populateDeviceLists() // обновить лейблы аудиоустройств после получения разрешения на микрофон

  function stopPreview() {
    if (state.previewStream) {
      state.previewStream.getTracks().forEach((t) => t.stop())
      state.previewStream = null
    }
    stopMicMonitor()
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
  }

  async function doJoin() {
    const name = nameInput.value.trim() || `Гость-${Math.floor(Math.random() * 1000)}`
    localStorage.setItem('displayName', name)
    const roomCode = roomInput.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

    joinBtn.disabled = true
    joinBtn.textContent = 'Подключение...'
    errorSlot.style.display = 'none'

    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode, displayName: name })
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Не удалось подключиться')
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
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin() })
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin() })
}

// ===================== КОМНАТА (звонок) =====================

async function enterRoom(joinData) {
  const { token, url, roomCode, displayName, maxParticipants, maxScreenShares } = joinData
  state.roomCode = roomCode
  state.displayName = displayName
  state.maxParticipants = maxParticipants || 5
  state.maxScreenShares = maxScreenShares || 2

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
  topbar.appendChild(roomInfo)

  const topRight = el('div', {})
  const participantsBtn = el('button', {
    class: 'ctrl-btn',
    style: 'width:36px;height:36px;font-size:14px',
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

  const divider1 = el('div', { class: 'ctrl-divider' })
  const leaveBtn = el('button', { class: 'leave-btn' }, [el('i', { class: 'fas fa-phone-slash' }), ' Выйти'])

  controls.appendChild(micBtn)
  controls.appendChild(camBtn)
  controls.appendChild(screenBtn)
  controls.appendChild(divider1)
  controls.appendChild(leaveBtn)
  screen.appendChild(controls)

  root.appendChild(screen)

  // ---- LiveKit Room ----
  const room = new LK.Room({
    adaptiveStream: true,
    dynacast: true,
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
    // Камеры/аватары участников -> stage (grid). Демки экрана -> stage приоритетно, камеры уходят в сайдбар если есть демки
    const hasScreenShares = state.screenShares.size > 0
    const cameraTiles = Array.from(document.querySelectorAll('.camera-tile'))
    const screenTiles = Array.from(document.querySelectorAll('.screen-tile'))

    stage.innerHTML = ''
    sidebar.innerHTML = ''

    if (hasScreenShares) {
      screenTiles.forEach((t) => stage.appendChild(t))
      cameraTiles.forEach((t) => sidebar.appendChild(t))
      sidebar.style.display = cameraTiles.length ? 'flex' : 'none'
      const n = screenTiles.length
      stage.style.gridTemplateColumns = n > 1 ? 'repeat(2, 1fr)' : '1fr'
    } else {
      sidebar.style.display = 'none'
      cameraTiles.forEach((t) => stage.appendChild(t))
      const n = cameraTiles.length || 1
      const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
      stage.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    }

    screenCountBadge.style.display = state.screenShares.size > 0 ? 'block' : 'none'
    screenCountBadge.textContent = String(state.screenShares.size)
  }

  function makeCameraTile(identity, name, isLocal) {
    const tile = el('div', { class: 'tile camera-tile', id: `tile-cam-${identity}` })
    const video = el('video', { autoplay: true, playsinline: true, ...(isLocal ? { muted: true } : {}) })
    if (isLocal) video.style.transform = 'scaleX(-1)'
    const placeholder = el('div', { class: 'no-video-placeholder' }, [el('div', { class: 'avatar-circle' }, initials(name))])
    const label = el('div', { class: 'tile-label' }, [el('i', { class: 'fas fa-microphone-slash', style: 'display:none' }), el('span', {}, name + (isLocal ? ' (Вы)' : ''))])
    tile.appendChild(video)
    tile.appendChild(placeholder)
    tile.appendChild(label)
    return { tile, video, placeholder, label }
  }

  // ---- Полноэкранный режим для тайла (демонстрация экрана) ----
  function toggleTileFullscreen(tile) {
    if (document.fullscreenElement === tile) {
      document.exitFullscreen().catch(() => {})
    } else {
      tile.requestFullscreen().catch(() => showToast('Не удалось открыть полноэкранный режим', 'error'))
    }
  }

  function makeScreenTile(identity, name, sid) {
    const tile = el('div', { class: 'tile screen-tile', id: `tile-screen-${sid}` })
    const video = el('video', { autoplay: true, playsinline: true, muted: true })
    const label = el('div', { class: 'tile-label' }, [el('i', { class: 'fas fa-desktop' }), el('span', {}, `Демонстрация — ${name}`)])
    const fsBtn = el('button', { class: 'tile-fullscreen-btn', title: 'На весь экран' }, [el('i', { class: 'fas fa-expand' })])
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleTileFullscreen(tile)
    })
    tile.appendChild(video)
    tile.appendChild(label)
    tile.appendChild(fsBtn)
    tile.addEventListener('dblclick', () => toggleTileFullscreen(tile))
    return { tile, video, label, fsBtn }
  }

  document.addEventListener('fullscreenchange', () => {
    document.querySelectorAll('.screen-tile').forEach((t) => {
      const icon = t.querySelector('.tile-fullscreen-btn i')
      if (!icon) return
      icon.className = document.fullscreenElement === t ? 'fas fa-compress' : 'fas fa-expand'
      t.classList.toggle('is-fullscreen', document.fullscreenElement === t)
    })
  })

  const cameraTilesMap = new Map() // identity -> {tile, video, placeholder, label}

  function ensureCameraTile(identity, name, isLocal) {
    if (cameraTilesMap.has(identity)) return cameraTilesMap.get(identity)
    const t = makeCameraTile(identity, name, isLocal)
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

  // ---- Track handling ----
  room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const name = participant.name || participant.identity
    if (track.source === LK.Track.Source.Camera) {
      const t = ensureCameraTile(participant.identity, name, false)
      track.attach(t.video)
      t.placeholder.style.display = 'none'
    } else if (track.source === LK.Track.Source.Microphone) {
      const audioEl = document.body.appendChild(el('audio', { autoplay: true, style: 'display:none' }))
      track.attach(audioEl)
      if (state.selectedSpeakerId && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(state.selectedSpeakerId).catch(() => {})
      }
    } else if (track.source === LK.Track.Source.ScreenShare) {
      const t = makeScreenTile(participant.identity, name, publication.trackSid)
      track.attach(t.video)
      document.body.appendChild(t.tile)
      state.screenShares.set(publication.trackSid, { identity: participant.identity, name })
      relayout()
      showToast(`${name} начал демонстрацию экрана`)
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
    } else if (track.source === LK.Track.Source.ScreenShare) {
      const tile = document.getElementById(`tile-screen-${publication.trackSid}`)
      if (tile) tile.remove()
      state.screenShares.delete(publication.trackSid)
      relayout()
    }
    track.detach()
  })

  room.on(LK.RoomEvent.TrackMuted, (publication, participant) => {
    if (publication.source === LK.Track.Source.Camera) {
      const t = cameraTilesMap.get(participant.identity)
      if (t) t.placeholder.style.display = 'flex'
    }
  })
  room.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
    if (publication.source === LK.Track.Source.Camera) {
      const t = cameraTilesMap.get(participant.identity)
      if (t) t.placeholder.style.display = 'none'
    }
  })

  room.on(LK.RoomEvent.ParticipantConnected, (participant) => {
    showToast(`${participant.name || participant.identity} присоединился`)
    ensureCameraTile(participant.identity, participant.name || participant.identity, false)
  })

  room.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
    showToast(`${participant.name || participant.identity} покинул звонок`)
    removeCameraTile(participant.identity)
    // Clean up any of their screen shares
    for (const [sid, info] of Array.from(state.screenShares.entries())) {
      if (info.identity === participant.identity) {
        const tile = document.getElementById(`tile-screen-${sid}`)
        if (tile) tile.remove()
        state.screenShares.delete(sid)
      }
    }
    relayout()
  })

  room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const speakingIds = new Set(speakers.map((p) => p.identity))
    for (const [identity, t] of cameraTilesMap.entries()) {
      t.tile.classList.toggle('speaking', speakingIds.has(identity))
    }
  })

  room.on(LK.RoomEvent.Disconnected, (reason) => {
    setStatus('Отключено', 'disconnected')
    showToast('Вы отключены от звонка', reason ? 'error' : 'info')
    cleanupAndGoLobby()
  })

  room.on(LK.RoomEvent.Reconnecting, () => setStatus('Переподключение...', 'connecting'))
  room.on(LK.RoomEvent.Reconnected, () => setStatus('Подключено', ''))

  // ---- Connect ----
  try {
    await room.connect(url, token)
    setStatus('Подключено', '')

    // Publish local camera + mic
    await room.localParticipant.setCameraEnabled(true)
    await room.localParticipant.setMicrophoneEnabled(true)

    const localTile = ensureCameraTile(room.localParticipant.identity, state.displayName, true)
    const camPub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera)
    if (camPub && camPub.track) camPub.track.attach(localTile.video)

    // Render existing remote participants
    room.remoteParticipants.forEach((participant) => {
      ensureCameraTile(participant.identity, participant.name || participant.identity, false)
      participant.trackPublications.forEach((pub) => {
        if (pub.track) {
          if (pub.source === LK.Track.Source.Camera) {
            const t = cameraTilesMap.get(participant.identity)
            pub.track.attach(t.video)
            t.placeholder.style.display = 'none'
          } else if (pub.source === LK.Track.Source.ScreenShare) {
            const t = makeScreenTile(participant.identity, participant.name || participant.identity, pub.trackSid)
            pub.track.attach(t.video)
            document.body.appendChild(t.tile)
            state.screenShares.set(pub.trackSid, { identity: participant.identity, name: participant.name })
            relayout()
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
    await room.localParticipant.setCameraEnabled(state.cameraEnabled)
    camBtn.classList.toggle('active', state.cameraEnabled)
    camBtn.classList.toggle('off', !state.cameraEnabled)
    camBtn.querySelector('i').className = state.cameraEnabled ? 'fas fa-video' : 'fas fa-video-slash'
    const t = cameraTilesMap.get(room.localParticipant.identity)
    if (t) t.placeholder.style.display = state.cameraEnabled ? 'none' : 'flex'
  })

  let isScreenSharing = false
  let currentScreenTrackSid = null

  screenBtn.addEventListener('click', async () => {
    if (isScreenSharing) {
      // Stop own screen share
      await room.localParticipant.setScreenShareEnabled(false)
      isScreenSharing = false
      screenBtn.classList.remove('active')
      if (currentScreenTrackSid) {
        const tile = document.getElementById(`tile-screen-${currentScreenTrackSid}`)
        if (tile) tile.remove()
        state.screenShares.delete(currentScreenTrackSid)
        currentScreenTrackSid = null
        relayout()
      }
      return
    }

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

    try {
      let pub
      if (IS_ELECTRON) {
        // В Electron используем нативный desktopCapturer через preload API
        const sourceId = await window.electronAPI.chooseScreenSource()
        if (!sourceId) return // отмена пользователем
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: 60,
              maxWidth: 1920,
              maxHeight: 1080
            }
          }
        })
        const track = stream.getVideoTracks()[0]
        track.contentHint = 'motion'
        pub = await room.localParticipant.publishTrack(track, {
          source: LK.Track.Source.ScreenShare,
          simulcast: false,
          videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 }
        })
      } else {
        pub = await room.localParticipant.setScreenShareEnabled(true, {
          video: { displaySurface: 'monitor' },
          audio: false,
          resolution: LK.ScreenSharePresets.h1080fps30.resolution,
          contentHint: 'motion'
        }, {
          videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
          simulcast: false
        })
      }

      if (!pub) return // пользователь отменил выбор источника
      isScreenSharing = true
      currentScreenTrackSid = pub.trackSid
      screenBtn.classList.add('active')

      const t = makeScreenTile(room.localParticipant.identity, state.displayName + ' (Вы)', pub.trackSid)
      pub.track.attach(t.video)
      document.body.appendChild(t.tile)
      state.screenShares.set(pub.trackSid, { identity: room.localParticipant.identity, name: state.displayName })
      relayout()

      // Если пользователь остановил демку через системный UI браузера/ОС
      pub.track.mediaStreamTrack.addEventListener('ended', () => {
        if (currentScreenTrackSid === pub.trackSid) {
          isScreenSharing = false
          currentScreenTrackSid = null
          screenBtn.classList.remove('active')
          const tile = document.getElementById(`tile-screen-${pub.trackSid}`)
          if (tile) tile.remove()
          state.screenShares.delete(pub.trackSid)
          relayout()
        }
      })
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        showToast('Не удалось начать демонстрацию экрана', 'error')
        console.error(e)
      }
    }
  })

  leaveBtn.addEventListener('click', () => {
    cleanupAndGoLobby()
  })

  function cleanupAndGoLobby() {
    try { room.disconnect() } catch {}
    document.querySelectorAll('audio').forEach((a) => a.remove())
    history.pushState({}, '', '/')
    renderLobby()
  }

  window.addEventListener('beforeunload', () => {
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
