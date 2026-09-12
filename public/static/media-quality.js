/* ═══════════════════════════════════════════════════════════════════════════
   media-quality.js — качество демонстрации экрана. issue #22, п.1

   Подключается ДО app.js (см. src/renderer.tsx), поэтому обёртки готовы к
   первому запуску демонстрации. Один и тот же файл работает и на сайте, и в
   .exe — Electron грузит этот же сайт, различия сводятся к IS_DESKTOP_APP.

   Что снимаем:
     · потолок разрешения захвата (было 1280×720 / 1920×1080) → родное
       разрешение экрана с учётом devicePixelRatio;
     · потолок частоты кадров → просим 60 FPS;
     · scaleResolutionDownBy (принудительный downscale в RTP-отправителе);
     · низкий maxBitrate → 5–10 Мбит/с в зависимости от FPS;
     · simulcast для дорожки экрана (лишние слои отбирают битрейт у главного).

   Промежуточного canvas/перекодирования в цепочке нет: кадры идут с захвата
   сразу в энкодер, приоритет кодека — аппаратный H.264, затем VP9.

   Профиль качества переключается одной переменной:
     window.VL_SCREEN_PROFILE = 'detail'  // по умолчанию: держим разрешение
     window.VL_SCREEN_PROFILE = 'motion'  // держим плавность
   ═══════════════════════════════════════════════════════════════════════════ */

;(function () {
  'use strict'

  if (window.__vlMediaQuality) return
  window.__vlMediaQuality = true

  var IS_DESKTOP_APP = !!window.electronAPI // .exe: Chromium с аппаратным энкодером
  var TARGET_FPS = 60

  var PROFILES = {
    // По задаче: contentHint 'detail' + maintain-resolution — приоритет резкости.
    detail: { hint: 'detail', degradation: 'maintain-resolution' },
    // Альтернатива: если на слабой сети/CPU важнее плавность, чем резкость.
    motion: { hint: 'motion', degradation: 'maintain-framerate' }
  }

  function profile() {
    var name = String(window.VL_SCREEN_PROFILE || '').toLowerCase()
    return PROFILES[name] || PROFILES.detail
  }

  // 1080p60 просит 6–10 Мбит/с; на 30/15 FPS столько не нужно.
  function bitrateFor(fps) {
    if (fps <= 15) return 5000000
    if (fps <= 30) return 7000000
    return IS_DESKTOP_APP ? 10000000 : 8000000
  }

  function num(v) {
    if (v == null) return 0
    if (typeof v === 'number') return v
    if (typeof v !== 'object') return Number(v) || 0
    return Number(v.exact || v.ideal || v.max || v.min || 0) || 0
  }

  // Максимум, который реально может отдать источник: логический размер экрана × DPR.
  function nativeSize() {
    var dpr = window.devicePixelRatio || 1
    var scr = window.screen || {}
    var w = Math.round((scr.width || 1920) * dpr)
    var h = Math.round((scr.height || 1080) * dpr)
    // Ниже 1080p не опускаемся даже на маленьких экранах: апскейл дешевле мыла.
    return { w: Math.max(1920, w), h: Math.max(1080, h) }
  }

  /* ─────────── contentHint: закрепляем профиль на дорожке ─────────── */

  // app.js после публикации выставляет свой contentHint ('motion'), а в .exe то же
  // делает site-boost.js. Чтобы профиль не зависел от порядка вызовов, ставим
  // значение в движок и закрываем свойство: чтение отдаёт профиль, запись
  // чужого значения игнорируется. Единственная точка правды — VL_SCREEN_PROFILE.
  var hintDesc = null
  try {
    hintDesc = Object.getOwnPropertyDescriptor(window.MediaStreamTrack.prototype, 'contentHint')
  } catch (e) { /* нет MediaStreamTrack — нечего закреплять */ }

  function pinScreenTrack(track) {
    if (!track || track.kind !== 'video') return
    track.__vlScreen = true
    if (track.__vlHintPinned) return
    var hint = profile().hint
    try {
      if (hintDesc && hintDesc.set) hintDesc.set.call(track, hint)
      Object.defineProperty(track, 'contentHint', {
        configurable: true,
        get: function () { return hint },
        set: function () { if (hintDesc && hintDesc.set) hintDesc.set.call(track, hint) }
      })
      track.__vlHintPinned = true
    } catch (e) {
      try { track.contentHint = hint } catch (e2) { /* браузер не поддерживает */ }
    }
  }

  /* ─────────── 1. Захват экрана без потолков ─────────── */

  var md = navigator.mediaDevices
  if (md && typeof md.getDisplayMedia === 'function') {
    var origGetDisplayMedia = md.getDisplayMedia.bind(md)
    md.getDisplayMedia = function (constraints) {
      var c = constraints && typeof constraints === 'object' ? Object.assign({}, constraints) : {}
      var v = c.video && typeof c.video === 'object' ? Object.assign({}, c.video) : {}

      // FPS: если сайт осознанно попросил меньше (меню демонстрации: 15/30) —
      // уважаем выбор, во всех остальных случаях просим 60.
      var asked = num(v.frameRate)
      var fps = asked >= 1 && asked < TARGET_FPS ? Math.round(asked) : TARGET_FPS
      v.frameRate = { ideal: fps, max: fps }

      // Разрешение: снимаем искусственный потолок, просим родное разрешение.
      var size = nativeSize()
      v.width = { ideal: size.w }
      v.height = { ideal: size.h }
      // Жёсткие пропорции тоже режут разрешение — источник сам знает свои.
      delete v.aspectRatio

      c.video = v
      window.__vlScreenFps = fps

      return Promise.resolve(origGetDisplayMedia(c)).then(function (stream) {
        try { stream.getVideoTracks().forEach(pinScreenTrack) } catch (e) {}
        return stream
      })
    }
  }

  /* ─────────── 2. Параметры RTP-отправителя ─────────── */

  function tuneSender(sender) {
    if (!sender || typeof sender.getParameters !== 'function') return
    try {
      var p = sender.getParameters()
      if (!p.encodings || !p.encodings.length) p.encodings = [{}]
      var fps = window.__vlScreenFps || TARGET_FPS
      p.degradationPreference = profile().degradation
      p.encodings.forEach(function (enc) {
        enc.active = true
        enc.scaleResolutionDownBy = 1 // никакого downscale: отдаём как захватили
        enc.maxFramerate = Math.max(num(enc.maxFramerate), fps)
        enc.maxBitrate = Math.max(num(enc.maxBitrate), bitrateFor(fps))
      })
      sender.setParameters(p)
    } catch (e) { /* браузер может запретить часть правок — не критично */ }
  }

  // app.js (меню FPS) и site-boost.js тоже вызывают setParameters. Нормализуем
  // любые такие правки для дорожки демонстрации, чтобы ограничения не вернулись.
  var SenderProto = window.RTCRtpSender && window.RTCRtpSender.prototype
  if (SenderProto && SenderProto.setParameters && !SenderProto.__vlPatched) {
    var origSetParameters = SenderProto.setParameters
    SenderProto.setParameters = function (params) {
      try {
        var t = this.track
        if (t && t.kind === 'video' && t.__vlScreen && params) {
          params.degradationPreference = profile().degradation
          var encodings = params.encodings || []
          for (var i = 0; i < encodings.length; i++) {
            var enc = encodings[i]
            // FPS берём из самой правки: явный выбор 15/30 в меню остаётся в силе.
            var fps = num(enc.maxFramerate) || window.__vlScreenFps || TARGET_FPS
            enc.active = true
            enc.scaleResolutionDownBy = 1
            enc.maxBitrate = Math.max(num(enc.maxBitrate), bitrateFor(fps))
          }
        }
      } catch (e) {}
      return origSetParameters.call(this, params)
    }
    SenderProto.__vlPatched = true
  }

  /* ─────────── 3. Публикация дорожки экрана в LiveKit ─────────── */

  function isScreenTrack(track, options) {
    try {
      if (options && options.source === 'screen_share') return true
      if (!track || (track.kind && track.kind !== 'video')) return false
      if (track.source === 'screen_share') return true
      var ms = track.mediaStreamTrack
      return !!(ms && ms.__vlScreen)
    } catch (e) { return false }
  }

  function patchLiveKit() {
    var LK = window.LivekitClient
    if (!LK || !LK.LocalParticipant || !LK.LocalParticipant.prototype) return false
    if (LK.__vlQualityPatched) return true
    var proto = LK.LocalParticipant.prototype
    var origPublish = proto.publishTrack
    if (typeof origPublish !== 'function') return false

    proto.publishTrack = function (track, options) {
      var opts = Object.assign({}, options || {})
      var screen = isScreenTrack(track, opts)

      if (screen) {
        var fps = window.__vlScreenFps || TARGET_FPS
        var bitrate = bitrateFor(fps)
        var encoding = Object.assign({}, opts.videoEncoding, {
          maxFramerate: Math.max(num(opts.videoEncoding && opts.videoEncoding.maxFramerate), fps),
          maxBitrate: Math.max(num(opts.videoEncoding && opts.videoEncoding.maxBitrate), bitrate),
          priority: 'high'
        })
        opts.simulcast = false // один слой в максимальном качестве
        opts.videoEncoding = encoding
        opts.screenShareEncoding = encoding
        opts.degradationPreference = profile().degradation
        opts.videoCodec = opts.videoCodec || 'h264' // аппаратный энкодер, затем VP9
        opts.backupCodec = opts.backupCodec || { codec: 'vp9' }
        if (track && track.mediaStreamTrack) pinScreenTrack(track.mediaStreamTrack)
      }

      var res = origPublish.call(this, track, opts)

      if (screen && res && typeof res.then === 'function') {
        res.then(function (pub) {
          var published = (pub && (pub.track || pub.videoTrack)) || track
          if (published && published.mediaStreamTrack) pinScreenTrack(published.mediaStreamTrack)
          if (published && published.sender) tuneSender(published.sender)
          return pub
        }).catch(function () { /* публикацию обрабатывает app.js */ })
      }

      return res
    }

    LK.__vlQualityPatched = true
    return true
  }

  // livekit-client подключён в <head> выше, так что обычно патч встаёт сразу.
  // Короткий ретрай — страховка от гонок загрузки CDN.
  if (!patchLiveKit()) {
    var tries = 0
    var timer = setInterval(function () {
      if (patchLiveKit() || ++tries > 100) clearInterval(timer)
    }, 200)
  }
})()
