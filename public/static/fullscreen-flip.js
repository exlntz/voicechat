/* ═══════════════════════════════════════════════════════════════════════════
   fullscreen-flip.js — плитка раскрывается из своего места. issue #22, п.3

   Техника FLIP (First → Last → Invert → Play):
     1. в фазе захвата события (до того, как app.js переключит классы)
        запоминаем геометрию плитки;
     2. после смены состояния считываем новую;
     3. ставим обратный transform и проигрываем его до единицы.

   Правила: 220 мс, cubic-bezier(0.22, 1, 0.36, 1), только transform/opacity,
   без переноса узлов и без пересоздания <video> — поток не прерывается.
   При prefers-reduced-motion: reduce анимаций нет.

   Кейфреймы из style.css (vl-fs-in / vl-fs-settle / vl-fs-collapse) гасятся
   классом html.vl-flip: иначе две анимации наложатся и дадут скачок.
   ═══════════════════════════════════════════════════════════════════════════ */

;(function () {
  'use strict'

  if (window.__vlFsFlip) return
  if (!window.Element || !Element.prototype.animate) return // нет WAAPI — оставляем CSS
  window.__vlFsFlip = true

  var DUR = 220 // мс, в пределах 180–250 из задачи
  var EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
  var reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

  function reduced() { return reduceQuery.matches }

  /* ─────────── гасим старые кейфреймы ─────────── */

  document.documentElement.classList.add('vl-flip')
  var style = document.createElement('style')
  style.setAttribute('data-vl-flip', '1')
  style.textContent = [
    'html.vl-flip .tile:fullscreen,',
    'html.vl-flip .tile:-webkit-full-screen,',
    'html.vl-flip .tile.in-app-fullscreen,',
    'html.vl-flip .tile.is-fullscreen,',
    'html.vl-flip .tile.is-fs-leaving,',
    'html.vl-flip .tile.is-fs-closing { animation: none !important; }',
    'html.vl-flip .tile.vl-flipping { will-change: transform; }'
  ].join('\n')
  document.head.appendChild(style)

  /* ─────────── геометрия ─────────── */

  function rectOf(el) {
    var r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, width: r.width, height: r.height }
  }

  var pending = null // { tile, rect } — геометрия до смены состояния

  function remember(tile) {
    if (!tile || !tile.classList || !tile.classList.contains('tile')) return
    pending = { tile: tile, rect: rectOf(tile) }
  }

  function take(tile) {
    var rect = pending && pending.tile === tile ? pending.rect : null
    pending = null
    return rect
  }

  function cancel(tile) {
    try { if (tile.__vlAnim) tile.__vlAnim.cancel() } catch (e) {}
    tile.__vlAnim = null
    tile.classList.remove('vl-flipping')
  }

  function play(tile, frames) {
    cancel(tile)
    tile.classList.add('vl-flipping')
    var anim = tile.animate(frames, { duration: DUR, easing: EASE, fill: 'forwards' })
    tile.__vlAnim = anim
    var done = function () {
      if (tile.__vlAnim !== anim) return
      // fill: forwards нужен только на время анимации; дальше никаких
      // остаточных transform на плитке быть не должно.
      if (!tile.__vlHoldFill) cancel(tile)
    }
    if (anim.addEventListener) {
      anim.addEventListener('finish', done)
      anim.addEventListener('cancel', function () { tile.classList.remove('vl-flipping') })
    } else {
      anim.onfinish = done
    }
    return anim
  }

  // Переход from → текущее положение плитки.
  function flipFrom(tile, from) {
    if (!tile || !from || reduced()) return
    var to = rectOf(tile)
    if (!from.width || !from.height || !to.width || !to.height) return
    var sx = from.width / to.width
    var sy = from.height / to.height
    var dx = (from.left + from.width / 2) - (to.left + to.width / 2)
    var dy = (from.top + from.height / 2) - (to.top + to.height / 2)
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return
    tile.__vlHoldFill = false
    play(tile, [
      {
        transform: 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' +
          sx.toFixed(4) + ',' + sy.toFixed(4) + ')',
        opacity: 0.94
      },
      { transform: 'translate3d(0,0,0) scale(1,1)', opacity: 1 }
    ])
  }

  // Сворачивание in-app fullscreen. app.js сначала вешает .is-fs-closing и только
  // через FS_ANIM_MS снимает .in-app-fullscreen. Чтобы не было паузы, сразу
  // считаем будущую геометрию (одно принудительное измерение) и играем
  // обратный FLIP, пока плитка ещё зафиксирована на весь экран.
  function collapse(tile) {
    if (reduced()) return
    var from = rectOf(tile)
    var cls = tile.classList
    var hadFs = cls.contains('in-app-fullscreen')
    var hadClosing = cls.contains('is-fs-closing')
    cls.remove('in-app-fullscreen', 'is-fs-closing')
    var to = rectOf(tile) // место в сетке
    if (hadFs) cls.add('in-app-fullscreen')
    if (hadClosing) cls.add('is-fs-closing')
    if (!from.width || !from.height || !to.width || !to.height) return
    var sx = to.width / from.width
    var sy = to.height / from.height
    var dx = (to.left + to.width / 2) - (from.left + from.width / 2)
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2)
    // fill держим до того момента, как app.js снимет классы, иначе плитка
    // мигнёт назад в полный экран на пару кадров.
    tile.__vlHoldFill = true
    play(tile, [
      { transform: 'translate3d(0,0,0) scale(1,1)', opacity: 1 },
      {
        transform: 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' +
          sx.toFixed(4) + ',' + sy.toFixed(4) + ')',
        opacity: 0.96
      }
    ])
    // Страховка: если наблюдатель по какой-то причине не увидит снятие класса.
    setTimeout(function () {
      if (tile.__vlHoldFill) { tile.__vlHoldFill = false; cancel(tile) }
    }, DUR + 500)
  }

  /* ─────────── входы в полноэкранный режим ─────────── */

  // Фаза захвата: снимаем геометрию ДО обработчиков app.js.
  document.addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    var btn = t.closest('.tile-fullscreen-btn')
    if (btn) remember(btn.closest('.tile'))
  }, true)

  document.addEventListener('dblclick', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    remember(t.closest('.tile'))
  }, true)

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return
    var el = document.fullscreenElement || document.webkitFullscreenElement ||
      document.querySelector('.tile.in-app-fullscreen')
    if (el && el.classList && el.classList.contains('tile')) remember(el)
  }, true)

  /* ─────────── реакция на смену состояния ─────────── */

  // Нативный fullscreen: браузер сам меняет размер элемента.
  function onNativeChange() {
    var el = document.fullscreenElement || document.webkitFullscreenElement
    var tile = (el && el.classList && el.classList.contains('tile')) ? el : (pending && pending.tile)
    if (!tile) return
    var from = take(tile)
    if (!from) return
    requestAnimationFrame(function () { flipFrom(tile, from) })
  }
  document.addEventListener('fullscreenchange', onNativeChange)
  document.addEventListener('webkitfullscreenchange', onNativeChange)

  // Режим «на весь экран внутри страницы»: app.js переключает классы плитки.
  var wasFs = new WeakMap()

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var tile = records[i].target
      if (!tile || tile.nodeType !== 1 || !tile.classList || !tile.classList.contains('tile')) continue

      var now = tile.classList.contains('in-app-fullscreen')
      var was = !!wasFs.get(tile)
      var closing = tile.classList.contains('is-fs-closing')

      if (now && !was) {
        wasFs.set(tile, true)
        tile.__vlCollapsing = false
        flipFrom(tile, take(tile))
      } else if (now && closing && !tile.__vlCollapsing) {
        tile.__vlCollapsing = true
        collapse(tile)
      } else if (!now && was) {
        wasFs.set(tile, false)
        if (tile.__vlCollapsing) {
          // плитка уже визуально на своём месте — снимаем остаточный transform
          tile.__vlCollapsing = false
          tile.__vlHoldFill = false
          cancel(tile)
        } else {
          flipFrom(tile, take(tile))
        }
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true })
})()
