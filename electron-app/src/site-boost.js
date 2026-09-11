// ===================== Донастройка сайта внутри .exe =====================
// Этот скрипт впрыскивается в страницу главным процессом (main.js) после загрузки.
// Смысл: сайт общий для браузера и десктопа, и в браузере агрессивные настройки 60 FPS ставить
// рискованно (слабые машины, нет GPU-энкодера). В своём .exe мы знаем окружение и можем
// выкрутить всё на максимум, не меняя код сайта и не трогая сервер.
//
// Почему флагов Chromium было недостаточно (было 40-50 FPS вместо 60):
// флаги снимают лимит рендера окна, но реальный потолок задают две другие вещи:
//   1) constraints захвата в getDisplayMedia (если не попросить 60 явно - будет 30);
//   2) параметры публикации LiveKit: у демонстрации экрана пресеты по умолчанию 15/30 FPS,
//      а при нехватке битрейта WebRTC жертвует именно частотой кадров, а не разрешением.
// Именно это делает Discord: высокий битрейт, contentHint = motion и приоритет на плавность.

;(function () {
  if (window.__zvonkiBoost) return
  window.__zvonkiBoost = true

  var TARGET_FPS = 60
  var MAX_BITRATE = 8000000 // 8 Мбит/с - запас для 60 кадров без просадок

  function log() {
    try { console.log.apply(console, ['[zvonki-boost]'].concat([].slice.call(arguments))) } catch (e) {}
  }

  // ---- 1. Захват экрана сразу в 60 кадров ----
  // Обёртка над getDisplayMedia: что бы ни просил сайт, добавляем frameRate 60
  // и contentHint 'motion' (говорит WebRTC беречь плавность, а не резкость текста).
  try {
    var md = navigator.mediaDevices
    var origGDM = md && md.getDisplayMedia ? md.getDisplayMedia.bind(md) : null
    if (origGDM) {
      md.getDisplayMedia = function (constraints) {
        var c = Object.assign({}, constraints || {})
        var v = (c.video && typeof c.video === 'object') ? Object.assign({}, c.video) : {}
        v.frameRate = { ideal: TARGET_FPS, max: TARGET_FPS }
        c.video = v
        return origGDM(c).then(function (stream) {
          stream.getVideoTracks().forEach(function (t) {
            try { t.contentHint = 'motion' } catch (e) {}
            try { t.applyConstraints({ frameRate: { ideal: TARGET_FPS, max: TARGET_FPS } }) } catch (e) {}
          })
          log('захват экрана: запрошено', TARGET_FPS, 'FPS')
          return stream
        })
      }
    }
  } catch (e) { log('не удалось подменить getDisplayMedia', e) }

  // ---- 2. Публикация в LiveKit без потолка 15/30 FPS ----
  // Ключевой параметр - degradationPreference: 'maintain-framerate'. Без него WebRTC при любой
  // нагрузке режет именно FPS, что и давало плавающие 40-50 вместо ровных 60.
  // simulcast выключен: второй/третий слои едят кодирование впустую - в звонке до 5 человек
  // адаптивные слои не нужны.
  function patchLivekit() {
    var LK = window.LivekitClient
    if (!LK || !LK.LocalParticipant || !LK.LocalParticipant.prototype) return false
    if (LK.__zvonkiPatched) return true

    var proto = LK.LocalParticipant.prototype
    var origPublish = proto.publishTrack
    if (typeof origPublish !== 'function') return false

    proto.publishTrack = function (track, options) {
      var opts = Object.assign({}, options || {})
      var label = ''
      try { label = (track && track.mediaStreamTrack && track.mediaStreamTrack.label) || '' } catch (e) {}
      var isScreen =
        opts.source === 'screen_share' ||
        (track && track.source === 'screen_share') ||
        /screen|window|monitor|экран/i.test(label)

      if (isScreen) {
        opts.simulcast = false
        opts.degradationPreference = 'maintain-framerate'
        opts.screenShareEncoding = { maxFramerate: TARGET_FPS, maxBitrate: MAX_BITRATE, priority: 'high' }
        opts.videoEncoding = { maxFramerate: TARGET_FPS, maxBitrate: MAX_BITRATE, priority: 'high' }
        try { if (track && track.mediaStreamTrack) track.mediaStreamTrack.contentHint = 'motion' } catch (e) {}
        log('публикуем демонстрацию:', TARGET_FPS, 'FPS,', MAX_BITRATE / 1000000, 'Мбит/с')
      }
      return origPublish.call(this, track, opts)
    }

    LK.__zvonkiPatched = true
    log('LiveKit настроен на плавность')
    return true
  }

  // LiveKit грузится с CDN и может появиться позже нашей инъекции - ждём его до 20 секунд.
  if (!patchLivekit()) {
    var tries = 0
    var timer = setInterval(function () {
      tries++
      if (patchLivekit() || tries > 100) clearInterval(timer)
    }, 200)
  }

  // ---- 3. Кнопка рисования в интерфейсе ----
  // Раньше оверлей вызывался только горячей клавишей - если она занята другой
  // программой, рисование выглядело как «его нет». Теперь есть видимая кнопка.
  function addDrawButton() {
    if (document.getElementById('zvonki-draw-btn')) return
    if (!document.body) return

    var btn = document.createElement('button')
    btn.id = 'zvonki-draw-btn'
    btn.type = 'button'
    btn.title = 'Рисование поверх любых программ (или Ctrl+Shift+D / F8)'
    btn.textContent = '✏️ Рисовать'
    btn.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
      'padding:11px 16px', 'border-radius:12px', 'border:1px solid rgba(4,88,207,.55)',
      'background:#0458cf', 'color:#fff', 'font:600 14px/1 system-ui,sans-serif',
      'cursor:pointer', 'box-shadow:0 10px 24px rgba(4,88,207,.3)',
      'user-select:none', '-webkit-user-select:none'
    ].join(';')
    btn.addEventListener('mouseenter', function () { btn.style.background = '#0b68e8' })
    btn.addEventListener('mouseleave', function () { btn.style.background = '#0458cf' })

    btn.addEventListener('click', function () {
      try {
        if (window.electronAPI && typeof window.electronAPI.toggleDrawing === 'function') {
          window.electronAPI.toggleDrawing()
        }
      } catch (e) {}
    })

    document.body.appendChild(btn)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addDrawButton)
  } else {
    addDrawButton()
  }
  // Сайт перерисовывает интерфейс при входе в комнату - проверяем, что кнопка на месте.
  setInterval(addDrawButton, 3000)

  log('десктопные оптимизации включены')
})()
