/* ════════════════════════════════════════════════════════════════════════
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

   Производительность (issue #22, п.5). Всё, что живёт на pointermove, подчинено
   трём правилам, иначе в звонке (кодирование + декод видео в том же процессе)
   интерфейс начинает рваться:
     1. слушатели пассивные и ничего не пишут — только складывают координаты;
     2. все записи в DOM — ровно один раз в кадр и только transform/opacity;
     3. никаких измерений геометрии в обработчиках движения и rAF-цикл, который
        останавливается, как только анимация успокоилась или скрылась.
   ════════════════════════════════════════════════════════════════════════ */

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
    $$('.btn__x', btn).forEach(function (n) { n.remove() })
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
    btn.classList.add('ank-btn')
    attachMagnet(btn)
  }

  // Магнит: кнопка слегка тянется к курсору и упруго возвращается на место.
  // Геометрия кнопки считывается один раз на входе курсора, а не на каждом
  // движении: getBoundingClientRect() в обработчике — это принудительный reflow,
  // да ещё и по уже сдвинутой кнопке (самовозбуждение смещения).
  function attachMagnet(btn) {
    if (btn.__ankMagnet || !fine() || calm()) return
    if (btn.matches('.ctrl-btn, .join-toggle-btn')) return // в плотных рядах смещение мешает
    btn.__ankMagnet = true

    var rect = null
    var raf = 0
    var mx = 0, my = 0

    function write() {
      raf = 0
      if (!rect) return
      var dx = (mx - (rect.left + rect.width / 2)) / rect.width
      var dy = (my - (rect.top + rect.height / 2)) / rect.height
      btn.style.transform = 'translate3d(' + (dx * 7).toFixed(2) + 'px,' + (dy * 5).toFixed(2) + 'px,0)'
    }

    function measure() { rect = btn.getBoundingClientRect() }

    function reset() {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      rect = null
      btn.style.transform = ''
    }

    btn.addEventListener('pointerenter', measure, { passive: true })
    btn.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return
      mx = e.clientX; my = e.clientY
      if (!rect) measure()
      if (!raf) raf = requestAnimationFrame(write)
    }, { passive: true })
    btn.addEventListener('pointerleave', reset, { passive: true })
    btn.addEventListener('blur', reset)
    // При перекладке или прокрутке сохранённые координаты устаревают.
    window.addEventListener('resize', function () { rect = null }, { passive: true })
    window.addEventListener('scroll', function () { rect = null }, { passive: true, capture: true })
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

  // Вместо кольца вокруг стрелки — сужающийся синий след и мягкое свечение.
  // След — цепочка узлов, каждый догоняет предыдущий, поэтому движение выходит
  // плавным и слегка запаздывающим; толщина и яркость растут со скоростью мыши.
  //
  // Раньше цепочка рисовалась восьмью SVG-линиями, и каждый кадр у них
  // переписывалось по шесть атрибутов — вектор перестраивался и перерисовывался
  // на CPU. Сейчас след собран из точек, которые двигаются только transform:
  // translate3d()+scale() — это работа композитора, без layout и paint.
  var NODES = 9
  var trail = null

  function initTrail() {
    if (trail || !fine() || calm()) return

    // Свои стили для точек. Правила старой SVG-ленты (.ank-pointer svg / line)
    // в style.css просто перестали к чему-либо применяться.
    var st = make('style', null, [
      '.ank-pointer .ank-dot{position:absolute;top:0;left:0;width:12px;height:12px;',
      'margin:-6px 0 0 -6px;border-radius:50%;background:var(--accent-soft, #2f6fd0);',
      'opacity:0;transform:translate3d(-9999px,-9999px,0);',
      'will-change:transform, opacity;pointer-events:none;contain:layout style paint}',
      '.ank-pointer.is-hot .ank-dot{background:#fff}',
      '.ank-pointer .ank-aura{will-change:transform}'
    ].join(''))
    document.head.appendChild(st)

    trail = make('div', 'ank-pointer')
    trail.setAttribute('aria-hidden', 'true')
    var aura = make('span', 'ank-aura')
    trail.appendChild(aura)

    var dots = []
    for (var i = 0; i < NODES; i++) dots.push(make('i', 'ank-dot'))
    // С конца цепочки к голове: голова должна лежать сверху.
    for (var j = NODES - 1; j >= 0; j--) trail.appendChild(dots[j])
    document.body.appendChild(trail)

    var tx = window.innerWidth / 2, ty = window.innerHeight / 2
    var px = tx, py = ty            // прошлая позиция мыши — для скорости
    var speed = 0
    var ang = 0                     // последний вектор движения
    var ax = tx, ay = ty            // пятно идёт мягче самой ленты
    var nx = [], ny = [], op = []
    for (var k = 0; k < NODES; k++) { nx.push(tx); ny.push(ty); op.push(-1) }

    var raf = 0
    var on = false                  // курсор в окне
    var muted = false               // след скрыт (видео, ползунки, меню)
    var stale = false               // позиции устарели, нужно собрать цепочку у курсора
    var target = null               // последний элемент под мышью
    var targetDirty = false

    function resetChain() {
      for (var i2 = 0; i2 < NODES; i2++) { nx[i2] = tx; ny[i2] = ty }
      ax = tx; ay = ty; px = tx; py = ty; speed = 0
    }

    function start() {
      if (raf || document.hidden) return
      raf = requestAnimationFrame(loop)
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    // Дорогие closest() считаем не чаще раза в кадр и только при смене цели.
    function syncClasses() {
      if (!target || !target.closest) return
      var mute = target.closest('.tile, video, input[type="range"], .screen-ctx-menu, .screen-ctx-submenu, select')
      muted = !!mute
      trail.classList.toggle('is-off', muted)
      trail.classList.toggle('is-hot', !muted && !!target.closest('a, button, label, .room-code-badge, input'))
    }

    function loop() {
      raf = 0

      if (targetDirty) {
        targetDirty = false
        var wasMuted = muted
        syncClasses()
        if (wasMuted && !muted) { stale = true }
      }
      // Над видео и меню след не виден — крутить цикл незачем (главный выигрыш
      // в звонке: курсор почти всегда над плитками).
      if (muted || !on) return

      if (stale) { stale = false; resetChain() }

      // мгновенная скорость, сглаженная по кадрам
      var vx = tx - px, vy = ty - py
      px = tx; py = ty
      var v = Math.min(Math.sqrt(vx * vx + vy * vy), 90)
      speed += (v - speed) * 0.18
      if (v > 0.5) ang = Math.atan2(vy, vx) * 180 / Math.PI

      // голова цепочки догоняет мышь, остальные — предыдущий узел
      nx[0] += (tx - nx[0]) * 0.34
      ny[0] += (ty - ny[0]) * 0.34
      var rest = Math.abs(tx - nx[0]) + Math.abs(ty - ny[0])
      for (var i3 = 1; i3 < NODES; i3++) {
        var kk = 0.4 - i3 * 0.012
        nx[i3] += (nx[i3 - 1] - nx[i3]) * kk
        ny[i3] += (ny[i3 - 1] - ny[i3]) * kk
        rest += Math.abs(nx[i3 - 1] - nx[i3]) + Math.abs(ny[i3 - 1] - ny[i3])
      }

      // Одна запись transform на точку; opacity правим только при заметном изменении.
      var thick = 0.45 + speed / 260
      var bright = Math.min(1, 0.42 + speed / 16)
      for (var d = 0; d < NODES; d++) {
        var s = Math.max(0.18, 1 - d * 0.085) * thick
        dots[d].style.transform = 'translate3d(' + nx[d].toFixed(1) + 'px,' + ny[d].toFixed(1) +
          'px,0) scale(' + s.toFixed(3) + ')'
        var o = Math.max(0.05, 0.62 - d * 0.066) * bright
        if (Math.abs(o - op[d]) > 0.015) { op[d] = o; dots[d].style.opacity = o.toFixed(3) }
      }

      // пятно света: мягче и с лёгким растяжением по вектору движения
      ax += (tx - ax) * 0.09
      ay += (ty - ay) * 0.09
      rest += Math.abs(tx - ax) + Math.abs(ty - ay)
      var stretch = Math.min(speed / 150, 0.34)
      aura.style.transform = 'translate3d(' + ax.toFixed(1) + 'px,' + ay.toFixed(1) + 'px,0) rotate(' +
        ang.toFixed(1) + 'deg) scale(' + (1 + stretch).toFixed(3) + ',' + (1 - stretch * 0.62).toFixed(3) + ')'

      // Цепочка догнала курсор — гасим цикл до следующего движения мыши.
      if (rest < 0.6 && speed < 0.4) return
      raf = requestAnimationFrame(loop)
    }

    // Обработчик движения только складывает данные: ни чтения, ни записи стилей.
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return
      tx = e.clientX; ty = e.clientY
      if (!on) { on = true; stale = true; trail.classList.add('is-on') }
      if (e.target !== target) { target = e.target; targetDirty = true }
      start()
    }, { passive: true })

    var hide = function () {
      on = false
      stale = true
      trail.classList.remove('is-on')
      stop()
    }
    window.addEventListener('blur', hide)
    document.addEventListener('mouseleave', hide)
    // В фоновой вкладке/свёрнутом окне анимация не нужна вообще.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stale = true; stop() }
    })
    // Переключили prefers-reduced-motion на «меньше движения» — снимаем след.
    if (calmQuery.addEventListener) {
      calmQuery.addEventListener('change', function () {
        if (calm()) { hide(); trail.style.display = 'none' }
        else trail.style.display = ''
      })
    }
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

  // Параллакс тоже пишет переменные не чаще раза в кадр: каждая запись в --px/--py
  // инвалидирует стили поддерева, а событий мыши бывает до 500/с.
  function attachParallax(screen) {
    if (screen.__ankPx || calm() || !fine()) return
    screen.__ankPx = true
    var raf = 0, x = 0, y = 0
    function write() {
      raf = 0
      screen.style.setProperty('--px', x.toFixed(3))
      screen.style.setProperty('--py', y.toFixed(3))
    }
    screen.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return
      x = (e.clientX / window.innerWidth - 0.5) * 2
      y = (e.clientY / window.innerHeight - 0.5) * 2
      if (!raf) raf = requestAnimationFrame(write)
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
    // Шапка звонка: знак продукта слева и название "Voice Lobby" рядом с ним.
    // Раньше здесь была только иконка звонка, без подписи.
    if (topbar && !$('.ank-brandline', topbar)) {
      var line = make('div', 'ank-brandline')
      line.appendChild(makeSigil(30))
      line.appendChild(make('span', 'ank-brandline__name', 'Voice Lobby'))
      topbar.insertBefore(line, topbar.firstChild)
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
