/* =====================================================================
   @deontech/glass — sheets you can drag, the tab bar's lens, and pull to
   refresh, for every Smart DeonTech app (12 Oct 2026, from IFAIMA)

   Load after the app's own scripts:
     <link rel="stylesheet" href="/vendor/glass/glass.css">
     <script src="/vendor/glass/glass.js" defer></script>

   It starts by itself with the mainframe's markup. An app with other markup
   calls DeontechGlass.init({ ... }) itself (set window.DEONTECH_GLASS_MANUAL
   = true before loading to stop the automatic start):

     overlays  '.modal-overlay, .sheet-overlay'   what dims the page
     panels    '.modal, .sheet'                   the box inside it
     tabbar    '#tabbar'   tabs '.tab'   active 'active'
     phone     '(max-width: 820px)'               where sheets and the lens apply
     close     function (overlay) -> true if it closed it (else the kit tries
               the app's own ways: a click on the backdrop, a Cancel/Close
               button, Escape, and last of all hiding it)
     refresh   function () — pull to refresh (default: reload the page);
               false to turn pull to refresh off

   SHEETS. On a phone every dialog is a sheet from the bottom with a grab
   handle. A tall one opens at about half the screen; drag it up and it takes
   the screen, down and it goes back to half, then away. It follows the
   finger the whole way and, let go, settles where the finger was heading. A
   list inside scrolls; the sheet moves only from its top or its handle.

   THE TAB BAR. Floating glass. Press it and the selected pill lifts into a
   lens that follows the finger along the bar, magnifying what it passes
   over; let go and it drops onto the tab under it. A plain tap does the same.

   PULL TO REFRESH. Only when opened from the Home Screen (a browser tab does
   its own), only from the top of the page, never while a sheet is open.

   "Reduce motion" turns the movement off.
   ===================================================================== */
(function () {
  'use strict';
  var started = false;
  var C = null;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');

  function init(opts) {
    if (started) return;
    started = true;
    C = Object.assign({
      overlays: '.modal-overlay, .sheet-overlay, dialog', panels: '.modal, .sheet',
      tabbar: '#tabbar', tabs: '.tab', active: 'active',
      phone: '(max-width: 820px)', close: null, refresh: null,
    }, opts || {});
    C.mq = window.matchMedia(C.phone);
    sheets(); tabbar(); ptr();
  }

  /* ================================================================ sheets === */
  function sheets() {
    var state = new WeakMap();   // overlay -> { panel, detent }
    var HALF = 0.56;
    function visible(o) { if (o.tagName === 'DIALOG') return o.isConnected && o.open; return o.isConnected && getComputedStyle(o).display !== 'none' && !o.hidden && !o.classList.contains('hidden'); }
    // A native <dialog> is its own panel.
    function panelOf(o) { return o.tagName === 'DIALOG' ? o : [].find.call(o.children, function (c) { return c.matches(C.panels); }); }
    function lockPage() {
      var any = [].some.call(document.querySelectorAll(C.overlays), function (o) { return state.has(o) && visible(o); });
      document.documentElement.classList.toggle('dg-lock', any && C.mq.matches);
    }
    function halfOffset(p) {
      if (!C.mq.matches) return 0;
      var vh = window.innerHeight, h = p.offsetHeight;
      var off = h - vh * HALF;
      return h > vh * 0.68 && off > 80 ? off : 0;
    }
    function setDetent(s, name, instant) {
      var p = s.panel;
      s.detent = name;
      p.classList.toggle('dg-half', name === 'half');
      if (instant) p.style.transition = 'none';
      p.style.setProperty('--dg-y', (name === 'half' ? halfOffset(p) : 0) + 'px');
      if (instant) { void p.offsetHeight; p.style.transition = ''; }
    }
    // What was pressed last, and where: a card grows out of it and, closing,
    // shrinks back into it (as the globe's member card does in IFAIMA).
    var press = null;
    document.addEventListener('pointerdown', function (e) {
      var t = e.target.closest && e.target.closest('button, a, [role=button], tr, li, .card, [onclick], [data-id]');
      if (!t || t.closest(C.overlays)) return;
      var r = t.getBoundingClientRect();
      press = { el: t, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, t: Date.now() };
    }, true);
    function recentPress() { return press && Date.now() - press.t < 1500 ? press : null; }
    function rectOf(pr) {
      if (!pr) return null;
      if (pr.el && pr.el.isConnected) { var r = pr.el.getBoundingClientRect(); if (r.width) return r; }
      return pr.rect;
    }
    function towards(p, r, to) {
      var dx = (to.left + to.width / 2) - (r.left + r.width / 2), dy = (to.top + to.height / 2) - (r.top + r.height / 2);
      return 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + Math.max(0.05, to.width / r.width).toFixed(3) + ',' + Math.max(0.03, to.height / r.height).toFixed(3) + ')';
    }
    function grow(p, from) {
      if (still.matches || !from) return;
      var r = p.getBoundingClientRect(), to = rectOf(from);
      if (!r.width || !to) return;
      p.style.animation = 'none'; p.style.transition = 'none';
      p.style.transform = towards(p, r, to); p.style.opacity = '0.35';
      void p.offsetWidth;
      p.style.transition = 'transform .5s cubic-bezier(.32, 1.25, .5, 1), opacity .22s ease';
      p.style.transform = ''; p.style.opacity = '';
      setTimeout(function () { p.style.transition = ''; p.style.animation = ''; }, 540);
    }
    // Closing: the app has already hidden or removed it, so a picture of it
    // shrinks back into what opened it, and the dimming fades.
    function shrink(s) {
      if (still.matches || !s.rect || s.flung) return;
      var to = rectOf(s.from);
      if (!to) return;
      var p = s.panel, cs = getComputedStyle(p), r = s.rect;
      var dim = document.createElement('div');
      dim.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none;transition:opacity .3s ease;background:' + (s.dim || 'rgba(0,18,40,.34)');
      var g = document.createElement('div');
      g.innerHTML = p.innerHTML;
      g.setAttribute('aria-hidden', 'true');
      g.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;overflow:hidden;margin:0;box-sizing:border-box;'
        + 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;'
        + 'background:' + (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : 'var(--dg-sheet)') + ';color:' + cs.color + ';'
        + 'border-radius:' + cs.borderRadius + ';padding:' + cs.padding + ';box-shadow:' + cs.boxShadow + ';font:' + cs.font + ';'
        + 'transition:transform .32s cubic-bezier(.4, 0, .6, 1), opacity .3s ease;';
      document.body.append(dim, g);
      void g.offsetWidth;
      g.style.transform = towards(g, r, to); g.style.opacity = '0'; dim.style.opacity = '0';
      setTimeout(function () { g.remove(); dim.remove(); }, 360);
    }
    // Short: a confirmation, a detail, a form of a field or two. Long forms
    // stay sheets on a phone, where the keyboard and scrolling need room.
    function isShort(p) {
      if (p.matches('.sheet')) return false;
      var fields = p.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea');
      return p.offsetHeight <= window.innerHeight * 0.62 && !p.querySelector('textarea') && fields.length <= 2;
    }
    function opened(o) {
      var p = panelOf(o);
      if (!p) return;
      var s = state.get(o);
      if (!s || s.panel !== p) { s = { panel: p, detent: 'full', overlay: o }; state.set(o, s); }
      s.flung = false; s.rect = null;
      s.from = recentPress();
      o.classList.remove('dg-on', 'dg-zoomon');
      p.classList.remove('dg-sheet', 'dg-card', 'dg-half', 'dg-gone', 'dg-drag');
      p.style.removeProperty('--dg-y');
      if (C.mq.matches && !isShort(p)) {
        s.mode = 'sheet';
        if (o !== p) o.classList.add('dg-on');
        p.classList.add('dg-sheet');
        // The app's own handle, if it drew one; otherwise ours.
        if (!p.querySelector(':scope > .dg-grab, [class*="grab"], [class*="handle"]')) { var g = document.createElement('div'); g.className = 'dg-grab'; g.setAttribute('aria-hidden', 'true'); p.prepend(g); }
        p.scrollTop = 0;
        requestAnimationFrame(function () { setDetent(s, halfOffset(p) > 0 ? 'half' : 'full', true); });
      } else {
        s.mode = 'zoom';
        if (C.mq.matches) { if (o !== p) o.classList.add('dg-zoomon'); p.classList.add('dg-card'); }
        grow(p, s.from);
        setTimeout(function () { if (visible(o)) { s.rect = p.getBoundingClientRect(); s.dim = o !== p ? getComputedStyle(o).backgroundColor : null; } }, 560);
        s.rect = null;
      }
      if (!s.bound) { s.bound = true; bindDrag(s); bindTapOutside(s); }
      lockPage();
    }
    // A card on a phone closes when you tap outside it.
    function bindTapOutside(s) {
      var o = s.overlay;
      if (o === s.panel) {
        // A native <dialog>: a tap on its backdrop lands on the dialog itself, outside its box.
        o.addEventListener('click', function (e) {
          if (!e.isTrusted || e.target !== o || s.mode !== 'zoom' || !C.mq.matches) return;
          var r = o.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeOverlay(o);
        });
        return;
      }
      o.addEventListener('click', function (e) {
        if (!e.isTrusted || e.target !== o || s.mode !== 'zoom' || !C.mq.matches) return;
        setTimeout(function () { if (visible(o)) closeOverlay(o); }, 30);
      });
    }
    // Watch the page: dialogs are added, shown, hidden and removed in many ways.
    var open = [];
    function scan() {
      [].forEach.call(document.querySelectorAll(C.overlays), function (o) {
        if (visible(o) && open.indexOf(o) < 0) { open.push(o); opened(o); }
      });
      open = open.filter(function (o) {
        if (visible(o)) return true;
        var s = state.get(o);
        if (s) { if (s.mode === 'zoom') shrink(s); s.rect = null; }
        return false;
      });
      lockPage();
    }
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; scan(); });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
    scan();
    window.addEventListener('resize', function () {
      [].forEach.call(document.querySelectorAll(C.overlays), function (o) { var s = state.get(o); if (s && s.mode === 'sheet' && visible(o)) setDetent(s, s.detent === 'half' && halfOffset(s.panel) ? 'half' : 'full', true); });
      lockPage();
    });

    // Closing it the app's own way, so whatever it does on closing still happens.
    function closeOverlay(o) {
      if (C.close && C.close(o)) return;
      if (o.tagName === 'DIALOG') { o.close(); return; }
      if (o.id === 'moreSheetOverlay' && typeof window.closeMoreSheet === 'function') { window.closeMoreSheet(); return; }
      var steps = [
        function () { ['mousedown', 'pointerdown', 'mouseup', 'click'].forEach(function (t) { o.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); },
        function () {
          var p = panelOf(o);
          var b = p && [].find.call(p.querySelectorAll('[data-close], .modal-close, .close, .btn-close, [data-x="no"], [data-dismiss], button'), function (x) {
            return x.matches('[data-close], .modal-close, .close, .btn-close, [data-x="no"], [data-dismiss]') || /^\s*(cancel|close|×|✕|not now|no)\s*$/i.test(x.textContent || '') || /^(close|cancel)$/i.test(x.getAttribute('aria-label') || '');
          });
          if (b) b.click();
        },
        function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); },
        function () { if (o.classList.contains('app-dialog') || !o.id) o.remove(); else o.style.display = 'none'; },
      ];
      (function next(i) {
        if (i >= steps.length || !visible(o)) { scan(); return; }
        steps[i]();
        setTimeout(function () { next(i + 1); }, 40);
      })(0);
    }

    function bindDrag(s) {
      var p = s.panel, o = s.overlay;
      var y0 = 0, t0 = 0, yPrev = 0, tPrev = 0, base = 0, y = 0, live = false, fromBody = false, decided = false;
      p.addEventListener('touchstart', function (e) {
        if (!C.mq.matches || s.mode !== 'sheet' || e.touches.length !== 1) return;
        if (e.target.closest('input, textarea, select, button, a, label, [contenteditable], .no-drag')) return;
        // From the handle or the heading the sheet always moves; from the content only when it is at its top.
        var top = e.target.closest('.dg-grab, [class*="grab"], [class*="handle"], [class*="-head"], header, h2, h3');
        fromBody = !(top && p.contains(top) && (top.getBoundingClientRect().top - p.getBoundingClientRect().top) < 120);
        if (fromBody && s.detent === 'full' && p.scrollTop > 0) return;
        y0 = yPrev = e.touches[0].clientY; t0 = tPrev = Date.now();
        base = s.detent === 'half' ? halfOffset(p) : 0; y = base; live = true; decided = false;
      }, { passive: true });
      p.addEventListener('touchmove', function (e) {
        if (!live) return;
        var cy = e.touches[0].clientY, dy = cy - y0;
        if (!decided) {
          if (Math.abs(dy) < 4) return;
          decided = true;
          if (fromBody && s.detent === 'full' && dy < 0) { live = false; return; }
        }
        if (e.cancelable) e.preventDefault();
        if (!p.classList.contains('dg-drag')) p.classList.add('dg-drag');
        y = base + dy;
        if (y < 0) y = -Math.sqrt(-y) * 2;
        p.style.setProperty('--dg-y', y + 'px');
        var half = halfOffset(p), gone = Math.max(0, y - half);
        if (o !== p) o.style.backgroundColor = 'rgba(0, 18, 40, ' + (0.34 * Math.max(0, 1 - gone / Math.max(1, p.offsetHeight - half))).toFixed(3) + ')';
        tPrev = Date.now(); yPrev = cy;
      }, { passive: false });
      function end() {
        if (!live) return;
        live = false;
        p.classList.remove('dg-drag');
        if (!decided) return;
        var v = (yPrev - y0) / Math.max(16, tPrev - t0);
        var aim = y + v * 160, half = halfOffset(p), h = p.offsetHeight;
        var away = half ? half + (h - half) * 0.35 : h * 0.33;
        if (aim > away || (v > 0.9 && y > half)) {
          if (still.matches) { o.style.backgroundColor = ''; closeOverlay(o); return; }
          s.flung = true;
          p.classList.add('dg-gone');
          setTimeout(function () { o.style.backgroundColor = ''; closeOverlay(o); setTimeout(function () { p.classList.remove('dg-gone'); p.style.removeProperty('--dg-y'); }, 80); }, 230);
          return;
        }
        o.style.backgroundColor = '';
        setDetent(s, half && aim > half / 2 ? 'half' : 'full');
      }
      p.addEventListener('touchend', end);
      p.addEventListener('touchcancel', end);
      // Typing into a half-open sheet: it takes the screen, so the keyboard
      // does not cover the field.
      p.addEventListener('focusin', function (e) { if (s.mode === 'sheet' && s.detent === 'half' && e.target.matches('input, textarea, select, [contenteditable]')) setDetent(s, 'full'); });
    }
  }

  /* =============================================================== tab bar === */
  function tabbar() {
    // Every tab bar the app draws, now or later: an app that redraws its
    // whole screen on each page (Pulse) gets a new bar each time.
    function look() {
      [].forEach.call(document.querySelectorAll(C.tabbar), function (b) {
        if (!b.classList.contains('dg-bar') && b.querySelector(C.tabs)) setup(b);
      });
    }
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
    look();
    function setup(bar) {
      function tabs() { return [].slice.call(bar.querySelectorAll(C.tabs)); }
      bar.classList.add('dg-bar');
      tabs().forEach(function (t) { t.classList.add('dg-tab'); });
      document.body.classList.add('dg-has-bar');
      var bub = document.createElement('span'); bub.className = 'dg-bubble'; bub.setAttribute('aria-hidden', 'true');
      bar.prepend(bub);
      if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
      function current() {
        var on = tabs().find(function (t) { return t.classList.contains(C.active); });
        // Only when it changes: classList.add rewrites the attribute even when
        // nothing changes, which would wake the observer below forever.
        tabs().forEach(function (t) { if (t.classList.contains('dg-active') !== (t === on)) t.classList.toggle('dg-active', t === on); if (!t.classList.contains('dg-tab')) t.classList.add('dg-tab'); });
        return on;
      }
      function place(anim, x) {
        if (!bar.offsetWidth) return;
        var on = current();
        var br = bar.getBoundingClientRect();
        if (!on && x == null) { bub.style.opacity = '0'; return; }
        bub.style.opacity = '';
        var w = on ? on.getBoundingClientRect().width : br.width / Math.max(1, tabs().length);
        var left = x == null ? on.getBoundingClientRect().left - br.left : Math.max(4, Math.min(br.width - w - 4, x - br.left - w / 2));
        if (!anim) bub.style.transition = 'none';
        bub.style.left = left + 'px'; bub.style.width = w + 'px';
        if (!anim) { void bub.offsetWidth; bub.style.transition = ''; }
        var c = br.left + left + w / 2;
        tabs().forEach(function (t) { var r = t.getBoundingClientRect(); t.classList.toggle('dg-under', x != null && c > r.left && c < r.right); });
      }
      // Touch is followed with touch events: on iPhone a finger on a link can
      // otherwise be taken for a link drag or a press-and-hold, and the
      // pointer events stop. The mouse uses pointer events.
      var down = null;
      tabs().forEach(function (t) { t.setAttribute('draggable', 'false'); });
      function start(x, tab) {
        if (!C.mq.matches) return false;
        down = { x: x, last: x, tab: tab, moved: false };
        if (!still.matches) bub.classList.add('dg-lift');
        place(true, x);
        return true;
      }
      function move(x) {
        if (!down) return;
        if (Math.abs(x - down.x) > 6) down.moved = true;
        down.last = x;
        place(true, x);
      }
      // Returns true when the kit chose the tab itself (the browser's click must not).
      function end(x, cancel) {
        if (!down) return false;
        var d = down; down = null;
        bub.classList.remove('dg-lift');
        tabs().forEach(function (t) { t.classList.remove('dg-under'); });
        if (cancel) { place(true); return false; }
        var best = null, bd = Infinity;
        tabs().forEach(function (t) { var r = t.getBoundingClientRect(); var dd = Math.abs(r.left + r.width / 2 - x); if (dd < bd) { bd = dd; best = t; } });
        if (!best) { place(true); return false; }
        if (!best.matches('button')) tabs().forEach(function (t) { t.classList.toggle(C.active, t === best); });
        place(true);
        if (navigator.vibrate) navigator.vibrate(6);
        // A plain tap on a tab: the browser's own click follows. Slid onto another: choose it.
        if (best === d.tab && !d.moved) return false;
        setTimeout(function () { best.click(); }, 0);
        return true;
      }
      bar.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        start(e.touches[0].clientX, e.target.closest(C.tabs));
      }, { passive: true });
      bar.addEventListener('touchmove', function (e) {
        if (!down) return;
        if (e.cancelable) e.preventDefault();
        move(e.touches[0].clientX);
      }, { passive: false });
      bar.addEventListener('touchend', function (e) {
        if (!down) return;
        var x = e.changedTouches[0] ? e.changedTouches[0].clientX : down.last;
        if (end(x) && e.cancelable) e.preventDefault();
      }, { passive: false });
      bar.addEventListener('touchcancel', function () { end(0, true); });
      bar.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      bar.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        start(e.clientX, e.target.closest(C.tabs));
      });
      window.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' && down) move(e.clientX); });
      window.addEventListener('pointerup', function (e) { if (e.pointerType === 'mouse' && down) end(e.clientX); });
      window.addEventListener('resize', function () { place(false); });
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { place(false); });
      // The app moving the highlight (a new page, a badge): follow it, but not mid-drag.
      new MutationObserver(function () { if (!down) place(true); }).observe(bar, { subtree: true, attributes: true, attributeFilter: ['class'] });
      setTimeout(function () { place(false); }, 50);
    }
  }

  /* ======================================================= pull to refresh === */
  function ptr() {
    var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (!standalone || C.refresh === false) return;
    var dot = document.createElement('div'); dot.className = 'dg-ptr'; dot.setAttribute('aria-hidden', 'true');
    dot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>';
    document.body.append(dot);
    var y0 = null, pulled = 0, lastScroll = 0, LINE = 110;
    window.addEventListener('scroll', function () { lastScroll = Date.now(); }, { passive: true });
    function blocked(e) {
      if (document.documentElement.classList.contains('dg-lock')) return true;
      if (window.scrollY > 0 || Date.now() - lastScroll < 350) return true;
      for (var n = e.target; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return true;
      return e.touches[0].clientY > 180;
    }
    window.addEventListener('touchstart', function (e) { y0 = e.touches.length === 1 && !blocked(e) ? e.touches[0].clientY : null; pulled = 0; }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      pulled = Math.max(0, e.touches[0].clientY - y0);
      var k = Math.min(1, pulled / LINE);
      dot.style.transition = 'none';
      dot.style.opacity = String(k);
      dot.style.transform = 'translateY(' + (-60 + Math.min(pulled, LINE) * 0.9) + 'px) rotate(' + (pulled * 2) + 'deg)';
    }, { passive: true });
    window.addEventListener('touchend', function () {
      if (y0 == null) return;
      y0 = null;
      dot.style.transition = 'transform .3s, opacity .3s';
      if (pulled < LINE) { dot.style.opacity = '0'; dot.style.transform = 'translateY(-60px)'; return; }
      dot.classList.add('dg-spin'); dot.style.transform = 'translateY(' + (env() + 18) + 'px)';
      Promise.resolve(C.refresh ? C.refresh() : location.reload()).then(function () {
        setTimeout(function () { dot.classList.remove('dg-spin'); dot.style.opacity = '0'; dot.style.transform = 'translateY(-60px)'; }, 300);
      });
    });
    function env() { return 30; }
  }

  window.DeontechGlass = { init: init };
  // Settings can also ride on the script tag itself, for apps whose Content
  // Security Policy forbids inline scripts (Pulse):
  //   <script src="/vendor/glass/glass.js" data-tabbar="nav.tabbar" data-tabs="a" data-active="on" defer>
  var tag = document.currentScript;
  var fromTag = {};
  if (tag) ['overlays', 'panels', 'tabbar', 'tabs', 'active', 'phone'].forEach(function (k) { if (tag.dataset[k]) fromTag[k] = tag.dataset[k]; });
  function auto() { if (!window.DEONTECH_GLASS_MANUAL) init(Object.assign({}, fromTag, window.DEONTECH_GLASS || {})); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
})();
