/* ═══════════════════════════════════════════════════════════════════════════
   anker.js — слой микровзаимодействий Voice Lobby поверх готового интерфейса.

   Принцип: скрипт НИЧЕГО не рендерит сам и не трогает бизнес-логику app.js.
   Он только «дооснащает» уже отрисованные узлы:
     · кнопки   — двойной перекатывающийся лейбл, точка-маркер, магнит к курсору;
     · поля     — всплывающая подпись, подчёркивание, печатающаяся подсказка,
                  подсветка при ошибке;
     · экраны   — однократное появление блоков, параллакс, знак продукта;
     · курсор   — мягкий след за мышью.

   Служебных надписей (техническая сноска о хранении пароля, номера разделов,
   таймер сеанса и часы) здесь больше нет: интерфейс показывает пользователю
   только то, что ему нужно.

   app.js перерисовывает экраны целиком (root.innerHTML = ''), поэтому все
   улучшения навешиваются повторно через MutationObserver. Собственные вставки
   помечаются data-ank, чтобы наблюдатель не зацикливался на своих же мутациях.
   Всё, что анимируется, отключается при prefers-reduced-motion.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict'

  var calmQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  function calm() { return calmQuery.matches }
  function fine() { return window.matchMedia('(hover: hover) and (pointer: fine)').matches }

  function $(sel, ctx) { return (ctx || document).querySelector(sel) }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)) }

  function mark(node) { node.setAttribute('data-ank', '1'); return node }

  function make(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return mark(n)
  }

  /* ─────────────── 1. Кнопки ─────────────── */

  // Кнопки, которые оформляем «как на витрине»: текст перекатывается, точка раздувается.
  var BTN_SEL = '.auth-submit-btn, .auth-ghost-btn, .lobby-logout-btn, .test-sound-btn, .leave-btn, .join-toggle-btn, .lobby-card > button'
  // Кнопки, которые нельзя трогать: их подпись/содержимое меняет сам app.js или они иконочные
  var BTN_SKIP = '.password-toggle-btn, .tile-fullscreen-btn, .tile-kick-btn, .panel-close, .auth-switch-link, .screen-ctx-item, .solo-copy-btn'

  function enhanceButton(btn) {
    if (btn.matches(BTN_SKIP)) return

    // Собираем текстовую подпись из «чужих» узлов (иконки .fa оставляем на месте)
    var own = $('.btn__x b', btn)
    var plain = ''
    var drop = []
    Array.prototype.forEach.call(btn.childNodes, function (n) {
      if (n.nodeType === 3) {
        if (n.textContent.trim()) plain += n.textContent
        drop.push(n)
      } else if (n.nodeType === 1 && n.tagName === 'SPAN' && !n.hasAttribute('data-ank') &&
                 !n.className && !n.children.length && n.textContent.trim()) {
        // Забираем только «безымянные» подписи: у служебных span-ов (бейдж счётчика
        // демонстраций, метка FPS) есть класс — их трогать нельзя.
        plain += n.textContent
        drop.push(n)
      }
    })
    plain = plain.trim()

    if (!plain) {
      // Уже оснащена и подпись не менялась — выходим
      if (own) { attachMagnet(btn); return }
      // Иконочная кнопка (например .ctrl-btn) — только курсор и магнит
      btn.classList.add('ank-btn')
      attachMagnet(btn)
      return
    }

    // Подпись изменилась (app.js подставил «Вход...») — пересобираем внутренности
    $$('.btn__x, .btn__dot', btn).forEach(function (n) { n.remove() })
    drop.forEach(function (n) { n.remove() })

    var roll = make('span', 'btn__x')
    var a = mark(document.createElement('b'))
    a.textContent = plain
    var b = mark(document.createElement('b'))
    b.textContent = plain
    b.setAttribute('aria-hidden', 'true')
    roll.appendChild(a)
    roll.appendChild(b)
    btn.appendChild(roll)
    btn.appendChild(make('span', 'btn__dot'))
    btn.classList.add('ank-btn')
    attachMagnet(btn)
  }

  // Магнит: кнопка слегка тянется к курсору и упруго возвращается на место
  function attachMagnet(btn) {
    if (btn.__ankMagnet || !fine() || calm()) return
    if (btn.matches('.ctrl-btn, .join-toggle-btn')) return // в плотных рядах смещение мешает
    btn.__ankMagnet = true
    var raf = 0
    btn.addEventListener('pointermove', function (e) {
      var r = btn.getBoundingClientRect()
      var dx = (e.clientX - (r.left + r.width / 2)) / r.width
      var dy = (e.clientY - (r.top + r.height / 2)) / r.height
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(function () {
        btn.style.transform = 'translate(' + (dx * 7).toFixed(2) + 'px,' + (dy * 5).toFixed(2) + 'px)'
      })
    })
    btn.addEventListener('pointerleave', function () {
      cancelAnimationFrame(raf)
      btn.style.transform = ''
    })
    btn.addEventListener('blur', function () { btn.style.transform = '' })
  }

  /* ─────────────── 2. Поля ввода ─────────────── */

  // Короткие моноширинные подсказки под строкой: подбираются по плейсхолдеру,
  // чтобы не дублировать его же текст всплывающей подписью.
  var HINTS = [
    [/^юзернейм \(для входа\)/i, 'английские буквы, цифры, _ и -'],
    [/^юзернейм/i, 'тот, с которым регистрировались'],
    [/^пароль \(мин/i, 'минимум 6 символов'],
    [/^пароль/i, 'пароль от аккаунта'],
    [/^отображаемое имя/i, 'его видят другие участники звонка'],
    [/^код комнаты/i, 'оставьте пустым — создадим новую']
  ]

  function hintFor(ph) {
    for (var i = 0; i < HINTS.length; i++) if (HINTS[i][0].test(ph)) return HINTS[i][1]
    return ph
  }

  var fldSeq = 0

  function enhanceField(input) {
    if (input.__ankField) return
    var type = (input.getAttribute('type') || 'text').toLowerCase()
    if (['text', 'password', 'email', 'tel', 'search', 'number'].indexOf(type) < 0) return
    var host = input.closest('.auth-form-panel, .lobby-card')
    if (!host) return
    input.__ankField = true

    var ph = input.getAttribute('placeholder') || ''
    // Длинный плейсхолдер («Код комнаты (оставьте пустым — создать новую)») разбираем:
    // короткая часть идёт во всплывающую подпись, пояснение в скобках — в подсказку под строкой.
    var paren = ph.match(/^([^(]{2,26})\s*\((.+)\)\s*$/)
    var phShort = paren ? paren[1].trim() : ph
    var phNote = paren ? paren[2].trim() : ''
    // Плейсхолдер заменяем пробелом: :placeholder-shown продолжает работать,
    // а видимую роль подписи берёт на себя всплывающий label.
    input.setAttribute('placeholder', ' ')
    input.dataset.ph = ph

    // Обёртка поля: у пароля она уже есть (.password-field с «глазиком»)
    var wrap = input.parentElement && input.parentElement.classList.contains('password-field')
      ? input.parentElement
      : null
    if (!wrap) {
      wrap = make('div', 'fld')
      input.parentElement.insertBefore(wrap, input)
      wrap.appendChild(input)
    }
    wrap.classList.add('fld')

    if (!input.id) input.id = 'ank-f' + (++fldSeq)

    var label = make('label', 'fld__lbl', phShort)
    label.setAttribute('for', input.id)
    var bar = make('span', 'fld__bar')
    bar.setAttribute('aria-hidden', 'true')
    var msg = make('span', 'fld__msg')
    var hint = phNote || hintFor(ph)
    msg.dataset.hint = hint
    msg.textContent = hint

    // Порядок важен: label и bar должны идти ПОСЛЕ input — на этом держатся
    // CSS-селекторы всплытия подписи (input:focus ~ .fld__lbl).
    var after = input.nextSibling
    wrap.insertBefore(label, after)
    wrap.insertBefore(bar, after)
    wrap.appendChild(msg)

    input.addEventListener('focus', function () {
      wrap.classList.add('is-focus')
      typeOut(msg, msg.dataset.hint)
    })
    input.addEventListener('blur', function () {
      wrap.classList.remove('is-focus')
      stopType(msg)
      msg.textContent = msg.dataset.hint
    })
    input.addEventListener('input', function () {
      wrap.classList.toggle('is-filled', !!input.value)
      wrap.classList.remove('is-err')
    })
    if (input.value) wrap.classList.add('is-filled')
  }

  // «Печатающаяся» подсказка: дешёвый setInterval на 26 мс, гасится на blur
  function stopType(node) { if (node.__ankTimer) { clearInterval(node.__ankTimer); node.__ankTimer = 0 } }
  function typeOut(node, text) {
    stopType(node)
    if (calm() || !text) { node.textContent = text || ''; return }
    var i = 0
    node.textContent = ''
    node.__ankTimer = setInterval(function () {
      i++
      node.textContent = text.slice(0, i)
      if (i >= text.length) stopType(node)
    }, 26)
  }

  // Ошибка в форме: слот приезжает слева (CSS) + поля коротко вздрагивают
  function watchErrorSlot(slot) {
    if (slot.__ankWatched) return
    slot.__ankWatched = true
    var panel = slot.closest('.auth-form-panel')
    new MutationObserver(function () {
      var shown = slot.style.display !== 'none' && slot.textContent.trim()
      if (!shown) {
        if (panel) $$('.fld', panel).forEach(function (f) { f.classList.remove('is-err', 'is-ok') })
        return
      }
      var ok = slot.classList.contains('success')
      if (panel) {
        $$('.fld', panel).forEach(function (f) {
          f.classList.toggle('is-err', !ok)
          f.classList.toggle('is-ok', ok)
        })
      }
      if (calm() || !slot.animate) return
      slot.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }],
        { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)' }
      )
    }).observe(slot, { attributes: true, attributeFilter: ['style', 'class'], childList: true, characterData: true, subtree: true })
  }

  /* ─────────────── 3. Знак продукта ─────────────── */

  // Знак вместо логотипа: эмодзи трубки, которое «звонит» (анимация в CSS).
  // Эмодзи лежит внутри span, чтобы дрожал только глиф, а волны — вокруг него.
  function makeSigil(size) {
    var d = make('span', 'ank-sigil')
    d.setAttribute('role', 'img')
    d.setAttribute('aria-label', 'звонок')
    if (size) d.style.setProperty('--d', size + 'px')
    var g = mark(document.createElement('span'))
    g.className = 'ank-sigil__g'
    g.textContent = '\ud83d\udcde'
    d.appendChild(g)
    return d
  }

  /* ─────────────── 4. След за курсором ─────────────── */

  // Вместо кольца вокруг стрелки — сужающаяся синяя лента и мягкое свечение.
  // Лента: цепочка узлов, каждый догоняет предыдущий, поэтому движение выходит
  // плавным и слегка запаздывающим; толщина и длина растут со скоростью мыши.
  var NODES = 9
  var trail = null

  function initTrail() {
    if (trail || !fine() || calm()) return

    trail = make('div', 'ank-pointer')
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    mark(svg)
    svg.setAttribute('aria-hidden', 'true')
    var segs = []
    for (var i = 0; i < NODES - 1; i++) {
      var ln = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      svg.appendChild(ln)
      segs.push(ln)
    }
    var aura = make('span', 'ank-aura')
    trail.appendChild(aura)
    trail.appendChild(svg)
    document.body.appendChild(trail)

    var tx = window.innerWidth / 2, ty = window.innerHeight / 2
    var px = tx, py = ty            // прошлая позиция мыши — для скорости
    var speed = 0
    var ax = tx, ay = ty            // пятно идёт мягче самой ленты
    var nx = [], ny = []
    for (var k = 0; k < NODES; k++) { nx.push(tx); ny.push(ty) }

    window.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return
      tx = e.clientX; ty = e.clientY
      trail.classList.add('is-on')
      var t = e.target
      // Над видео, ползунками и меню след мешает смотреть — гасим
      var mute = t.closest('.tile, video, input[type="range"], .screen-ctx-menu, .screen-ctx-submenu, select')
      trail.classList.toggle('is-off', !!mute)
      trail.classList.toggle('is-hot', !mute && !!t.closest('a, button, label, .room-code-badge, input'))
    }, { passive: true })

    var hide = function () { trail.classList.remove('is-on') }
    window.addEventListener('blur', hide)
    document.addEventListener('mouseleave', hide)

    ;(function loop() {
      // мгновенная скорость, сглаженная по кадрам
      var vx = tx - px, vy = ty - py
      px = tx; py = ty
      var v = Math.min(Math.sqrt(vx * vx + vy * vy), 90)
      speed += (v - speed) * 0.18

      // голова цепочки догоняет мышь, остальные — предыдущий узел
      nx[0] += (tx - nx[0]) * 0.34
      ny[0] += (ty - ny[0]) * 0.34
      for (var i = 1; i < NODES; i++) {
        var k = 0.4 - i * 0.012
        nx[i] += (nx[i - 1] - nx[i]) * k
        ny[i] += (ny[i - 1] - ny[i]) * k
      }

      var boost = 1 + speed / 30
      for (var j = 0; j < segs.length; j++) {
        var s = segs[j]
        s.setAttribute('x1', nx[j].toFixed(1))
        s.setAttribute('y1', ny[j].toFixed(1))
        s.setAttribute('x2', nx[j + 1].toFixed(1))
        s.setAttribute('y2', ny[j + 1].toFixed(1))
        // лента сужается к хвосту и толстеет на быстрых движениях
        s.setAttribute('stroke-width', (Math.max(0.5, 3 - j * 0.32) * boost).toFixed(2))
        s.setAttribute('stroke-opacity', (Math.max(0.05, 0.62 - j * 0.066) * Math.min(1, 0.42 + speed / 16)).toFixed(3))
      }

      // пятно света: мягче и с лёгким растяжением по вектору движения
      ax += (tx - ax) * 0.09
      ay += (ty - ay) * 0.09
      var stretch = Math.min(speed / 150, 0.34)
      var ang = Math.atan2(vy, vx) * 180 / Math.PI
      aura.style.transform = 'translate3d(' + ax.toFixed(1) + 'px,' + ay.toFixed(1) + 'px,0) rotate(' +
        ang.toFixed(1) + 'deg) scale(' + (1 + stretch).toFixed(3) + ',' + (1 - stretch * 0.62).toFixed(3) + ')'

      requestAnimationFrame(loop)
    })()
  }

  /* ─────────────── 5. Появление блоков и параллакс ─────────────── */

  function reveal(nodes) {
    if (calm() || !nodes.length) return
    nodes.forEach(function (n, i) {
      n.classList.add('rv')
      n.style.setProperty('--i', i)
    })
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        nodes.forEach(function (n) { n.classList.add('is-in') })
      })
    })
    setTimeout(function () {
      nodes.forEach(function (n) {
        n.classList.remove('rv', 'is-in')
        n.style.removeProperty('--i')
      })
    }, 1400 + nodes.length * 70)
  }

  function attachParallax(screen) {
    if (screen.__ankPx || calm() || !fine()) return
    screen.__ankPx = true
    screen.addEventListener('pointermove', function (e) {
      var x = (e.clientX / window.innerWidth - 0.5) * 2
      var y = (e.clientY / window.innerHeight - 0.5) * 2
      screen.style.setProperty('--px', x.toFixed(3))
      screen.style.setProperty('--py', y.toFixed(3))
    }, { passive: true })
  }

  /* ─────────────── 6. Сборка экранов ─────────────── */

  function decorateAuth(screen) {
    var container = $('.auth-container', screen)
    if (!container || container.__ankDone) return
    container.__ankDone = true

    // Знак продукта на акцентной панели. Технических сносок (как хранится пароль,
    // сколько живёт сессия, номера разделов) в интерфейсе быть не должно.
    var right = $('.auth-overlay-right', container)
    var left = $('.auth-overlay-left', container)
    if (right && !$('.ank-sigil', right)) right.insertBefore(makeSigil(60), right.firstChild)
    if (left && !$('.ank-sigil', left)) left.insertBefore(makeSigil(60), left.firstChild)

    attachParallax(screen)
    reveal([container])
  }

  function decorateLobby(screen) {
    var card = $('.lobby-card', screen)
    if (!card || card.__ankDone) return
    card.__ankDone = true

    // Шапка: знак продукта + название
    var h1 = $('h1', card)
    if (h1 && !$('.ank-brand', card)) {
      var brand = make('div', 'ank-brand')
      var tx = make('div', 'ank-brand__tx')
      card.insertBefore(brand, h1)
      brand.appendChild(makeSigil(44))
      brand.appendChild(tx)
      tx.appendChild(h1)
    }

    attachParallax(screen)
    reveal($$(':scope > *', card))
  }

  function decorateRoom(screen) {
    if (screen.__ankDone) return
    screen.__ankDone = true
    var topbar = $('.room-topbar', screen)
    if (topbar && !$('.ank-sigil', topbar)) {
      topbar.insertBefore(makeSigil(30), topbar.firstChild)
    }
    reveal([topbar, $('.controls-bar', screen)].filter(Boolean))
  }

  /* ─────────────── 7. Проход по узлам + наблюдатель ─────────────── */

  function enhance(scope) {
    var ctx = scope && scope.nodeType === 1 ? scope : document
    initTrail()

    $$(BTN_SEL, ctx).forEach(enhanceButton)
    if (ctx.matches && ctx.matches(BTN_SEL)) enhanceButton(ctx)
    $$('.ctrl-btn', ctx).forEach(enhanceButton)

    $$('.auth-form-panel input, .lobby-card input', ctx).forEach(enhanceField)
    $$('.auth-error', ctx).forEach(watchErrorSlot)

    var auth = $('.auth-screen', document)
    if (auth) decorateAuth(auth)
    var lobby = $('.lobby-screen', document)
    if (lobby) decorateLobby(lobby)
    var room = $('.room-screen', document)
    if (room) decorateRoom(room)
  }

  var pending = false
  function schedule() {
    if (pending) return
    pending = true
    requestAnimationFrame(function () { pending = false; enhance(document) })
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      var own = true
      for (var j = 0; j < r.addedNodes.length; j++) {
        var n = r.addedNodes[j]
        if (n.nodeType === 1 && !n.hasAttribute('data-ank')) { own = false; break }
        if (n.nodeType === 3 && n.parentElement && !n.parentElement.hasAttribute('data-ank')) { own = false; break }
      }
      if (!own || !r.addedNodes.length) { schedule(); return }
    }
  }).observe(document.body, { childList: true, subtree: true })

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule)
  else schedule()
})()
