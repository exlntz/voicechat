/* ════════════════════════════════════════════════════════════════════════
   anker.js — слой микровзаимодействий Voice Lobby поверх готового интерфейса.

   Принцип: скрипт НИЧЕГО не рендерит сам и не трогает бизнес-логику app.js.
   Он только «дооснащает» уже отрисованные узлы:
     · кнопки   — магнит к курсору и заливка кругом от точки наведения;
     · поля     — всплывающая подпись, подчёркивание, печатающаяся подсказка,
                  подсветка при ошибке;
     · экраны   — однократное появление блоков, параллакс, знак продукта.
   Анимации за курсором (след, свечение) нет — убрана по решению владельца.

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

  // Кнопки, которые оформляем: класс .ank-btn и «магнит» к курсору. Перекатывающейся
  // подписи (текст уезжает вверх, снизу выезжает копия) больше нет — подпись кнопки
  // остаётся обычным текстом, её по-прежнему меняет только app.js.
  var BTN_SEL = '.auth-submit-btn, .auth-ghost-btn, .lobby-logout-btn, .leave-btn, .join-toggle-btn, .lobby-card > button, .solo-copy-btn'
  // Кнопки, которые нельзя трогать: их подпись/содержимое меняет сам app.js или они иконочные
  var BTN_SKIP = '.password-toggle-btn, .tile-fullscreen-btn, .tile-kick-btn, .panel-close, .auth-switch-link, .screen-ctx-item'

  function enhanceButton(btn) {
    if (btn.matches(BTN_SKIP)) return
    btn.classList.add('ank-btn')
    attachMagnet(btn)
    attachFill(btn)
  }

  // Заливка от курсора: при входе мыши из точки входа вырастает круг и заполняет кнопку
  // цветом её наведённого состояния (--ank-fill в style.css); при уходе круг сжимается
  // в точку выхода. Только мышь: на телефоне наведения нет.
  // Круг лежит в .ank-fill (inset: 0, overflow: hidden) — сама кнопка не обрезается,
  // бейджи вроде счётчика демонстраций остаются снаружи.
  var FILL_MS = 420
  function attachFill(btn) {
    if (!fine() || calm()) return
    var st = btn.__ankFill
    if (!st) {
      var wrap = make('span', 'ank-fill')
      wrap.setAttribute('aria-hidden', 'true')
      var dot = make('span', 'ank-fill__dot')
      wrap.appendChild(dot)
      st = btn.__ankFill = { wrap: wrap, dot: dot, t0: 0 }

      var place = function (e) {
        var r = btn.getBoundingClientRect()
        var x = e.clientX - r.left, y = e.clientY - r.top
        var rad = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y)) + 2
        dot.style.left = (x - rad).toFixed(1) + 'px'
        dot.style.top = (y - rad).toFixed(1) + 'px'
        dot.style.width = dot.style.height = (rad * 2).toFixed(1) + 'px'
      }
      // Мгновенно поставить круг в состояние scale (без анимации)
      var jump = function (scale) {
        dot.classList.add('is-instant')
        dot.style.transform = 'scale(' + scale + ')'
        void dot.offsetWidth
        dot.classList.remove('is-instant')
      }
      btn.addEventListener('pointerenter', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return
        if (btn.disabled) return
        place(e)
        jump(0)
        dot.style.transform = 'scale(1)'
        st.t0 = performance.now()
      }, { passive: true })
      btn.addEventListener('pointerleave', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return
        // Круг уже заполнил кнопку — переносим его центр в точку выхода (визуально
        // ничего не меняется: он по-прежнему покрывает всё) и сжимаем туда.
        // Если ушли раньше, чем круг дорос, — просто сжимаем на месте.
        if (performance.now() - st.t0 >= FILL_MS) { place(e); jump(1) }
        dot.style.transform = 'scale(0)'
      }, { passive: true })
    }
    // app.js меняет подпись через textContent — это стирает заливку; возвращаем её
    if (st.wrap.parentNode !== btn) btn.insertBefore(st.wrap, btn.firstChild)
    btn.classList.add('has-fill')
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
    [/^юзернейм \(для входа\)/i, 'с английской буквы; дальше буквы, цифры, _ и -'],
    [/^юзернейм друга/i, 'регистр букв не важен'],
    [/^новый юзернейм/i, 'с английской буквы; дальше буквы, цифры, _ и -'],
    [/^как записать/i, 'например: Саша с работы'],
    [/^имя или юзернейм/i, 'Enter откроет первого в списке'],
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
    // .vl-fld-host — поля оболочки «друзья и чаты» (добавить друга, поиск, профиль)
    var host = input.closest('.auth-form-panel, .lobby-card, .vl-fld-host')
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

  // Знак — открытый MacBook с видеозвонком на двоих. Вся анимация в CSS (.ank-sigil):
  // по умолчанию статичный кадр и анимация при наведении, с классом is-live — всё время.
  // Размер — высота знака в --d; без size берётся из CSS (у экрана и шапки свои значения).
  var PERSON = '<svg class="lp-pp" viewBox="0 0 60 50" aria-hidden="true">' +
    '<circle cx="30" cy="20" r="9.5"/><path d="M11 50C11 37 20 31.5 30 31.5S49 37 49 50Z"/></svg>'
  var CHIP = '<span class="lp-chip"><span class="lp-bar"></span><span class="lp-bar"></span><span class="lp-bar"></span></span>'
  var LAPTOP =
    '<span class="lp-lid"><span class="lp-bezel"><span class="lp-notch"></span><span class="lp-screen">' +
      '<span class="lp-tiles">' +
        '<span class="lp-tile lp-a">' + PERSON + CHIP + '</span>' +
        '<span class="lp-tile lp-b">' + PERSON + CHIP + '</span>' +
      '</span>' +
      '<span class="lp-ctrl"><span class="lp-btn"></span><span class="lp-btn"></span><span class="lp-btn lp-end"></span></span>' +
      '<span class="lp-glare"></span><span class="lp-flash"></span>' +
    '</span></span></span>' +
    '<span class="lp-base"><span class="lp-scoop"></span></span>'

  function makeSigil(size, live) {
    var d = make('span', 'ank-sigil' + (live ? ' is-live' : ''))
    d.setAttribute('role', 'img')
    d.setAttribute('aria-label', 'Voice Lobby')
    if (size) d.style.setProperty('--d', size + 'px')
    d.innerHTML = LAPTOP
    $$('*', d).forEach(mark)
    return d
  }

  // Основной логотип — «Живой голос»: облачко речи с полосками голоса, которые сжимаются
  // в точки «печатает…» и обратно. Полоска = две круглые шапки + середина. Анимация в CSS (.ank-pulse), режимы те же, что у ноутбука.
  var PULSE =
    '<svg viewBox="0 0 120 120" aria-hidden="true">' +
      '<g class="pl-bubble"><rect x="8" y="12" width="104" height="80" rx="28"/>' +
      '<path d="M26 86 L22 108 L48 90 Z" stroke="#0458cf" stroke-width="4" stroke-linejoin="round"/></g>' +
      '<g class="pl-bar pl-b1"><circle class="pl-top" cx="38.5" cy="52" r="4.5"/><rect class="pl-mid" x="34" y="36.5" width="9" height="31"/><circle class="pl-bot" cx="38.5" cy="52" r="4.5"/></g>' +
      '<g class="pl-bar pl-b2"><circle class="pl-top" cx="53.5" cy="52" r="4.5"/><rect class="pl-mid" x="49" y="36.5" width="9" height="31"/><circle class="pl-bot" cx="53.5" cy="52" r="4.5"/></g>' +
      '<g class="pl-bar pl-b3"><circle class="pl-top" cx="68.5" cy="52" r="4.5"/><rect class="pl-mid" x="64" y="36.5" width="9" height="31"/><circle class="pl-bot" cx="68.5" cy="52" r="4.5"/></g>' +
      '<g class="pl-bar pl-b4"><circle class="pl-top" cx="83.5" cy="52" r="4.5"/><rect class="pl-mid" x="79" y="36.5" width="9" height="31"/><circle class="pl-bot" cx="83.5" cy="52" r="4.5"/></g>' +
    '</svg>'

  function makePulse(size, live) {
    var d = make('span', 'ank-pulse' + (live ? ' is-live' : ''))
    d.setAttribute('role', 'img')
    d.setAttribute('aria-label', 'Voice Lobby')
    if (size) d.style.setProperty('--d', size + 'px')
    d.innerHTML = PULSE
    $$('*', d).forEach(mark)
    return d
  }

  /* ─────────────── 5. Появление блоков и параллакс ─────────────── */

  // fadeOnly: только проявление без сдвига — для экрана звонка, где проезд
  // панелей на 12px при подключении выглядел как подёргивание страницы.
  function reveal(nodes, fadeOnly) {
    if (calm() || !nodes.length) return
    nodes.forEach(function (n, i) {
      n.classList.add('rv')
      if (fadeOnly) n.classList.add('rv-fade')
      n.style.setProperty('--i', i)
    })
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        nodes.forEach(function (n) { n.classList.add('is-in') })
      })
    })
    setTimeout(function () {
      nodes.forEach(function (n) {
        n.classList.remove('rv', 'rv-fade', 'is-in')
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
    // На входе и регистрации знак анимирован всё время
    if (right && !$('.ank-sigil', right)) right.insertBefore(makeSigil(0, true), right.firstChild)
    if (left && !$('.ank-sigil', left)) left.insertBefore(makeSigil(0, true), left.firstChild)

    attachParallax(screen)
    reveal([container])
  }

  function decorateLobby(screen) {
    var card = $('.lobby-card', screen)
    if (!card || card.__ankDone) return
    card.__ankDone = true

    // Шапка: логотип «Живой голос» + название. В лобби логотип анимирован всё время
    var h1 = $('h1', card)
    if (h1 && !$('.ank-brand', card)) {
      var brand = make('div', 'ank-brand')
      var tx = make('div', 'ank-brand__tx')
      card.insertBefore(brand, h1)
      brand.appendChild(makePulse(44, true))
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
      // Пока идёт подключение — анимация всё время; в звонке — статично, при наведении
      // (класс переключает setStatus в app.js)
      line.appendChild(makePulse(0, !!$('.status-dot.connecting', screen)))
      line.appendChild(make('span', 'ank-brandline__name', 'Voice Lobby'))
      topbar.insertBefore(line, topbar.firstChild)
    }
    reveal([topbar, $('.controls-bar', screen)].filter(Boolean), true)
  }

  /* ─────────────── 7. Проход по узлам + наблюдатель ─────────────── */

  function enhance(scope) {
    var ctx = scope && scope.nodeType === 1 ? scope : document

    $$(BTN_SEL, ctx).forEach(enhanceButton)
    if (ctx.matches && ctx.matches(BTN_SEL)) enhanceButton(ctx)
    $$('.ctrl-btn', ctx).forEach(enhanceButton)

    $$('.auth-form-panel input, .lobby-card input, .vl-fld-host input', ctx).forEach(enhanceField)
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
