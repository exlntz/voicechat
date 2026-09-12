/* ═══════════════════════════════════════════════════════════════════════════
   camera-mirror.js — зеркало только для фронтальной камеры. issue #22, п.6

   Селфи-камеру принято показывать зеркально (человек видит себя так, как в
   зеркале), а заднюю — нельзя: там кадр уже совпадает с тем, что человек
   видит глазами, и зеркало ломает надписи и стороны.

   Откуда бралось зеркало до этого файла:
     · app.js: makeCameraTile() для своей плитки ставил video.style.transform = 'scaleX(-1)';
     · style.css: .device-preview video { transform: scaleX(-1) }.
   Оба места не смотрели на то, какая камера включена. Здесь решение
   принимается по фактическому треку и пересчитывается при переключении камеры.

   Важно: зеркалится только локальное превью (CSS-трансформ у <video>).
   Исходящий трек не трогаем никогда — собеседники видят обычную картинку.
   ═══════════════════════════════════════════════════════════════════════════ */

;(function () {
  'use strict'

  if (window.__vlCameraMirror) return
  window.__vlCameraMirror = true

  // Только свои превью: настройка устройств в лобби и своя плитка в звонке.
  var SEL = '.device-preview video, .tile.camera-tile video'
  var BACK = /(^|[^a-z])(back|rear|environment)([^a-z]|$)|задн|основная камера/i
  var FRONT = /(^|[^a-z])(front|user|face|selfie)([^a-z]|$)|фронт|передн/i

  function videoTrack(video) {
    try {
      var ms = video.srcObject
      if (!ms || !ms.getVideoTracks) return null
      return ms.getVideoTracks()[0] || null
    } catch (e) { return null }
  }

  // Какая камера сейчас: 'environment' | 'user' | null (неизвестно).
  function facingOf(video) {
    var track = videoTrack(video)
    if (!track) return null
    try {
      var s = track.getSettings ? track.getSettings() : null
      if (s && s.facingMode) return s.facingMode
    } catch (e) {}
    try {
      // Safari иногда не отдаёт facingMode в getSettings(), но отдаёт в getCapabilities().
      var caps = track.getCapabilities ? track.getCapabilities() : null
      if (caps && caps.facingMode && caps.facingMode.length === 1) return caps.facingMode[0]
    } catch (e) {}
    // Последняя зацепка — имя устройства («Back Camera», «Задняя камера»).
    var label = track.label || ''
    if (BACK.test(label)) return 'environment'
    if (FRONT.test(label)) return 'user'
    return null
  }

  // Своё превью всегда без звука (иначе было бы эхо), чужие плитки — со звуком.
  function isLocalPreview(video) {
    if (video.closest('.device-preview')) return true
    var tile = video.closest('.tile')
    if (!tile) return false
    if (tile.classList.contains('local') || tile.classList.contains('is-local')) return true
    if (tile.dataset && (tile.dataset.local === 'true' || tile.dataset.isLocal === 'true')) return true
    return video.muted === true
  }

  function apply(video) {
    if (!video.isConnected || !isLocalPreview(video)) return
    var facing = facingOf(video)
    // Заднюю камеру не зеркалим. Неизвестное значение (вебкамера на десктопе)
    // трактуем как селфи — так было и раньше.
    var want = facing === 'environment' ? 'none' : 'scaleX(-1)'
    if (video.style.transform === want && video.__vlMirror === want) return
    video.__vlMirror = want
    video.__vlWriting = true
    video.style.transform = want
    video.__vlWriting = false
  }

  function watch(video) {
    if (video.__vlMirrorWatched) return
    video.__vlMirrorWatched = true

    var recheck = function () {
      apply(video)
      // facingMode у трека иногда появляется чуть позже первого кадра.
      setTimeout(function () { apply(video) }, 300)
    }

    ;['loadedmetadata', 'loadeddata', 'play', 'playing', 'resize'].forEach(function (ev) {
      video.addEventListener(ev, recheck, { passive: true })
    })

    // app.js при перерисовке плитки снова ставит инлайн-зеркало — возвращаем своё.
    new MutationObserver(function () {
      if (!video.__vlWriting) apply(video)
    }).observe(video, { attributes: true, attributeFilter: ['style', 'class', 'srcobject'] })

    recheck()
  }

  function scan() {
    var list = document.querySelectorAll(SEL)
    for (var i = 0; i < list.length; i++) watch(list[i])
  }

  var pending = false
  function schedule() {
    if (pending) return
    pending = true
    requestAnimationFrame(function () { pending = false; scan() })
  }

  // Новые <video> появляются при входе в лобби и при пересборке сетки звонка.
  function boot() {
    scan()
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
    // Переключение камеры и смена состояния звонка.
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', schedule)
    }
    window.addEventListener('vl-call-state', schedule)
    window.addEventListener('orientationchange', schedule, { passive: true })
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) schedule()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
