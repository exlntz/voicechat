/* ═══════════════════════════════════════════════════════════════════════════
   anker.js — слой микровзаимодействий «АНКЕР» поверх готового интерфейса.

   Принцип: скрипт НИЧЕГО не рендерит сам и не трогает бизнес-логику app.js.
   Он только «дооснащает» уже отрисованные узлы:
     · кнопки   — двойной перекатывающийся лейбл, точка-маркер, магнит к курсору;
     · поля     — всплывающая подпись, латунное подчёркивание, печатающаяся
                  подсказка, тряска при ошибке;
     · экраны   — однократное появление блоков, параллакс фонового слова,
                  живые часы и циферблат-марка (стрелки крутятся по реальному
                  времени, секундная — «полутиками», 8 шагов в секунду);
     · курсор   — кольцо-компаньон с подписью текущего действия.

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
  var BTN_SKIP = '.password-toggle-btn, .fps-toggle-btn, .fps-menu-item, .tile-fullscreen-btn, .tile-kick-btn, .panel-close, .auth-switch-link, .screen-ctx-item'

  var CURSOR_LABELS = [
    ['.auth-signup .auth-submit-btn', 'аккаунт'],
    ['.auth-signin .auth-submit-btn', 'вход'],
    ['.auth-overlay-right .auth-ghost-btn', 'регистрация'],
    ['.auth-overlay-left .auth-ghost-btn', 'вход'],
    ['.lobby-logout-btn', 'выход'],
    ['.test-sound-btn', 'проверка'],
    ['.leave-btn', 'завершить'],
    ['.room-code-badge', 'скопировать'],
    ['.join-toggle-btn', 'вкл / выкл'],
    ['.lobby-card > button', 'подключиться']
  ]

  function cursorLabelFor(node) {
    if (node.dataset && node.dataset.cursor) return node.dataset.cursor
    for (var i = 0; i < CURSOR_LABELS.length; i++) {
      if (node.matches(CURSOR_LABELS[i][0])) return CURSOR_LABELS[i][1]
    }
    if (node.getAttribute && node.getAttribute('title')) return node.getAttribute('title')
    return ''
  }

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
                 !n.children.length && n.textContent.trim()) {
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
      if (!btn.dataset.cursor) {
        var lbl = cursorLabelFor(btn)
        if (lbl) btn.dataset.cursor = lbl
      }
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
    if (!btn.dataset.cursor) {
      var lab = cursorLabelFor(btn)
      if (lab) btn.dataset.cursor = lab
    }
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
    [/^юзернейм \(для входа\)/i, 'латиница, цифры, _ и -, 3–24 символа'],
    [/^юзернейм/i, 'тот, с которым регистрировались'],
    [/^пароль \(мин/i, 'минимум 6 символов'],
    [/^пароль/i, 'пароль от аккаунта'],
    [/^отображаемое имя/i, 'его видят другие участники звонка'],
    [/^код комнаты/i, 'пусто — создадим новую комнату']
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
    var caret = make('span', 'fld__caret')
    caret.setAttribute('aria-hidden', 'true')
    var bar = make('span', 'fld__bar')
    bar.setAttribute('aria-hidden', 'true')
    var msg = make('span', 'fld__msg')
    var hint = phNote || hintFor(ph)
    msg.dataset.hint = hint
    msg.textContent = hint

    // Порядок важен: label/caret/bar должны идти ПОСЛЕ input — на этом держатся
    // CSS-селекторы всплытия подписи (input:focus ~ .fld__lbl).
    var after = input.nextSibling
    wrap.insertBefore(label, after)
    wrap.insertBefore(caret, after)
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

  /* ─────────────── 3. Часы и циферблат-марка ─────────────── */

  var dials = []
  var chips = []

  function makeDial(size) {
    var d = make('span', 'dialmark')
    d.setAttribute('aria-hidden', 'true')
    if (size) d.style.setProperty('--d', size + 'px')
    var face = make('span', 'dialmark__face')
    var h = mark(document.createElement('i')); h.className = 'h'
    var m = mark(document.createElement('i')); m.className = 'm'
    var s = mark(document.createElement('i')); s.className = 's'
    face.appendChild(h); face.appendChild(m); face.appendChild(s)
    d.appendChild(face)
    d.appendChild(make('span', 'dialmark__pin'))
    d.__hands = { h: h, m: m, s: s }
    dials.push(d)
    return d
  }

  function makeChip(caption) {
    var c = make('span', 'clockchip')
    var dot = mark(document.createElement('i'))
    var cap = mark(document.createElement('b'))
    cap.textContent = caption
    var time = mark(document.createElement('span'))
    c.appendChild(dot); c.appendChild(cap); c.appendChild(time)
    c.__time = time
    chips.push(c)
    return c
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n }

  function tick() {
    var now = new Date()
    var hh = now.getHours(), mm = now.getMinutes(), ss = now.getSeconds(), ms = now.getMilliseconds()
    // Секундная стрелка «полутиками»: 8 шагов в секунду, как у механизма на 28 800 п/ч
    var beat = calm() ? ss : ss + Math.floor(ms / 125) / 8
    for (var i = dials.length - 1; i >= 0; i--) {
      var d = dials[i]
      if (!d.isConnected) { dials.splice(i, 1); continue }
      var hands = d.__hands
      hands.h.style.transform = 'rotate(' + ((hh % 12) * 30 + mm * 0.5) + 'deg)'
      hands.m.style.transform = 'rotate(' + (mm * 6 + ss * 0.1) + 'deg)'
      hands.s.style.transform = 'rotate(' + (beat * 6) + 'deg)'
    }
    for (var j = chips.length - 1; j >= 0; j--) {
      var c = chips[j]
      if (!c.isConnected) { chips.splice(j, 1); continue }
      c.__time.textContent = pad(hh) + ':' + pad(mm) + ':' + pad(ss)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  /* ─────────────── 4. Курсор-компаньон ─────────────── */

  var cursor = null
  function initCursor() {
    if (cursor || !fine() || calm()) return
    cursor = make('div', 'ank-cursor')
    var ring = make('span', 'ank-cursor__ring')
    var dot = make('span', 'ank-cursor__dot')
    var lbl = make('span', 'ank-cursor__lbl')
    cursor.appendChild(ring); cursor.appendChild(dot); cursor.appendChild(lbl)
    document.body.appendChild(cursor)

    var tx = window.innerWidth / 2, ty = window.innerHeight / 2, rx = tx, ry = ty
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return
      tx = e.clientX; ty = e.clientY
      cursor.classList.add('is-on')
      var t = e.target
      // Над видео, ползунками и меню кольцо мешает — прячем
      var mute = t.closest('.tile, video, input[type="range"], .screen-ctx-menu, .screen-ctx-submenu, select')
      cursor.classList.toggle('is-off', !!mute)
      var hot = t.closest('a, button, label, [data-cursor], .room-code-badge')
      cursor.classList.toggle('is-hot', !!hot && !mute)
      lbl.textContent = hot && !mute ? (hot.dataset.cursor || cursorLabelFor(hot) || '') : ''
    }, { passive: true })
    window.addEventListener('pointerleave', function () { cursor.classList.remove('is-on') })
    document.addEventListener('mouseleave', function () { cursor.classList.remove('is-on') })

    ;(function loop() {
      rx += (tx - rx) * 0.16
      ry += (ty - ry) * 0.16
      ring.style.transform = 'translate(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px)' +
        (cursor.classList.contains('is-hot') ? ' scale(1.8)' : '')
      dot.style.transform = 'translate(' + tx + 'px,' + ty + 'px)'
      lbl.style.transform = 'translate(' + (rx + 18).toFixed(1) + 'px,' + (ry + 16).toFixed(1) + 'px)'
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

    var signin = $('.auth-signin', container)
    var signup = $('.auth-signup', container)
    if (signin) signin.setAttribute('data-index', '01 / вход')
    if (signup) signup.setAttribute('data-index', '02 / регистрация')

    // Циферблат-марка и техническая сноска на «бумажной» панели
    var right = $('.auth-overlay-right', container)
    var left = $('.auth-overlay-left', container)
    if (right && !$('.dialmark', right)) {
      right.insertBefore(makeDial(62), right.firstChild)
      right.appendChild(make('p', 'ank-note', 'аккаунт нужен, чтобы вас видели по имени, а не «гость-3f8a»'))
    }
    if (left && !$('.dialmark', left)) {
      left.insertBefore(makeDial(62), left.firstChild)
      left.appendChild(make('p', 'ank-note', 'пароль храним хэшем pbkdf2 · 100 000 итераций · сессия 30 дней'))
    }

    attachParallax(screen)
    reveal([container])
  }

  function decorateLobby(screen) {
    var card = $('.lobby-card', screen)
    if (!card || card.__ankDone) return
    card.__ankDone = true

    // Шапка: циферблат + нумерованный колонтитул + плакатный заголовок
    var h1 = $('h1', card)
    if (h1 && !$('.ank-brand', card)) {
      var brand = make('div', 'ank-brand')
      var tx = make('div', 'ank-brand__tx')
      tx.appendChild(make('div', 'ank-brand__idx', '01 / связь без впн'))
      card.insertBefore(brand, h1)
      brand.appendChild(makeDial(46))
      brand.appendChild(tx)
      tx.appendChild(h1)
    }

    // Живые часы рядом с именем пользователя
    var bar = $('.lobby-userbar', card)
    if (bar && !$('.clockchip', bar)) {
      var nameRow = $(':scope > span', bar)
      if (nameRow) {
        var row = make('div', 'ank-userrow')
        bar.insertBefore(row, nameRow)
        row.appendChild(nameRow)
        row.appendChild(makeChip('сейчас'))
      }
    }

    attachParallax(screen)
    reveal($$(':scope > *', card))
  }

  function decorateRoom(screen) {
    if (screen.__ankDone) return
    screen.__ankDone = true
    var topbar = $('.room-topbar', screen)
    if (topbar && !$('.dialmark', topbar)) {
      topbar.insertBefore(makeDial(28), topbar.firstChild)
      var last = topbar.lastElementChild
      topbar.insertBefore(makeChip('сеанс'), last)
    }
    reveal([topbar, $('.controls-bar', screen)].filter(Boolean))
  }

  /* ─────────────── 7. Проход по узлам + наблюдатель ─────────────── */

  function enhance(scope) {
    var ctx = scope && scope.nodeType === 1 ? scope : document
    initCursor()

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
