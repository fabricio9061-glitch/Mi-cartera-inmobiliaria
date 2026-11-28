/* =====================================================================
   NAVIDAD — nieve y decoración, solo en temporada
   ---------------------------------------------------------------------
   Además de la nieve, agrega una guirnalda de luces bajo el encabezado,
   un gorrito en el logo y adornos con "Felices fiestas" en la portada
   (ver DECORACIÓN más abajo). Todo sigue las mismas fechas.

   Caen unos pocos copos suaves (blancos con borde azul apenas visible, y
   alguno dorado) desde el 1 de diciembre hasta el 1 de enero inclusive,
   según la hora de Uruguay. El 2 de enero deja de aparecer solo; el año
   siguiente vuelve solo. No hay nada que prender ni apagar a mano.

   - No tapa nada: el dibujo no recibe clics (pointer-events:none) y los
     copos se desvanecen al llegar a la parte de abajo de la pantalla, donde
     están los botones de WhatsApp y la barra del celular.
   - Liviano: un solo <canvas>, ~40 copos en compu y ~16 en celular, y se
     frena cuando la pestaña no está a la vista.
   - Si la persona pidió "reducir movimiento" en su equipo, no cae nieve
     (la decoración queda, pero quieta).
   - Los agentes con sesión abierta también la ven en el inicio.
   - Para probarlo fuera de fecha: agregar ?nieve=1 a la dirección.
     ?nieve=0 lo apaga en esa visita.

   Lo cargan: index, propiedad, vender, trabaja, gastos, calculadora de
   garantías, privacidad y 404 (las mismas que analytics.js).
   ===================================================================== */
(function () {
  'use strict';

  var q = '';
  try { q = (location.search.match(/[?&]nieve=([01])/) || [])[1] || ''; } catch (e) {}
  if (q === '0') return;

  function esTemporada() {
    var mes, dia;
    try {
      var partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Montevideo', month: 'numeric', day: 'numeric'
      }).formatToParts(new Date());
      for (var i = 0; i < partes.length; i++) {
        if (partes[i].type === 'month') mes = +partes[i].value;
        if (partes[i].type === 'day') dia = +partes[i].value;
      }
    } catch (e) {
      // Navegador viejo: Uruguay es UTC-3 todo el año.
      var d = new Date(Date.now() - 3 * 3600e3);
      mes = d.getUTCMonth() + 1; dia = d.getUTCDate();
    }
    return mes === 12 || (mes === 1 && dia === 1);
  }
  if (q !== '1' && !esTemporada()) return;

  var quieto = false;
  try {
    quieto = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  /* ---------- DECORACIÓN ----------
     1. Guirnalda de luces colgando bajo el encabezado (dorado, blanco,
        rojo y verde apagados), titilando despacio.
     2. Gorrito navideño sobre el isotipo del logo.
     3. En la portada del inicio: tres adornos colgantes y un cartelito
        "Felices fiestas" arriba del título.
     Todo es decorativo: aria-hidden, sin clics, y si no encuentra dónde
     ponerse simplemente no aparece. */
  var COLORES = ['#C9A227', '#f4ecd2', '#b23a3a', '#2f6b4f'];

  function estilos() {
    var css =
      '.nv-guirnalda{position:absolute;left:0;right:0;top:100%;height:22px;pointer-events:none;z-index:5;overflow:visible}' +
      '.nv-guirnalda svg{display:block;width:100%;height:22px;overflow:visible}' +
      '.nv-foco{animation:nvTitila 2.6s ease-in-out infinite}' +
      '@keyframes nvTitila{0%,100%{opacity:1}50%{opacity:.35}}' +
      '.nv-gorro{position:absolute;pointer-events:none;z-index:2;filter:drop-shadow(0 1px 1px rgba(22,39,63,.25))}' +
      '.nv-adornos{position:absolute;top:0;left:0;right:0;height:0;pointer-events:none;z-index:3}' +
      '.nv-adorno{position:absolute;top:0;display:flex;flex-direction:column;align-items:center;transform-origin:50% 0;animation:nvHamaca 5s ease-in-out infinite}' +
      '.nv-adorno i{display:block;width:1px;background:linear-gradient(#C9A227,rgba(201,162,39,.4))}' +
      '@keyframes nvHamaca{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}' +
      '.nv-cartel{display:inline-flex;align-items:center;gap:8px;margin:0 0 14px;padding:6px 14px;border:1px solid rgba(201,162,39,.55);border-radius:999px;color:#e8cd78;font:500 .82rem/1.2 Jost,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;background:rgba(201,162,39,.08)}' +
      '@media (max-width:640px){.nv-adorno.nv-solo-compu{display:none}.nv-cartel{font-size:.72rem;padding:5px 12px}}' +
      '@media (prefers-reduced-motion:reduce){.nv-foco,.nv-adorno{animation:none}}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  // Guirnalda: arcos de cable con un foco en cada punto.
  function guirnalda(header) {
    var cs = getComputedStyle(header);
    if (cs.position === 'static') header.style.position = 'relative';
    var box = document.createElement('div');
    box.className = 'nv-guirnalda';
    box.setAttribute('aria-hidden', 'true');
    header.appendChild(box);
    function dibujar() {
      var W = Math.max(header.clientWidth, 320);
      var tramo = W < 640 ? 64 : 90;
      var n = Math.max(3, Math.round(W / tramo)), paso = W / n;
      var cable = 'M0 2', focos = '';
      for (var i = 0; i < n; i++) {
        var x0 = i * paso, x1 = x0 + paso, xm = x0 + paso / 2;
        cable += ' Q' + xm.toFixed(1) + ' 16 ' + x1.toFixed(1) + ' 2';
        var c = COLORES[i % COLORES.length];
        var demora = ((i * 0.37) % 2.6).toFixed(2);
        focos += '<g class="nv-foco" style="animation-delay:-' + demora + 's">' +
          '<rect x="' + (xm - 1.6).toFixed(1) + '" y="7.5" width="3.2" height="2.6" rx=".6" fill="#6b5a2a"/>' +
          '<ellipse cx="' + xm.toFixed(1) + '" cy="14" rx="3.2" ry="4.4" fill="' + c + '" stroke="rgba(22,39,63,.25)" stroke-width=".6"/>' +
          '<ellipse cx="' + (xm - 1).toFixed(1) + '" cy="12.6" rx=".9" ry="1.4" fill="rgba(255,255,255,.7)"/></g>';
      }
      box.innerHTML = '<svg viewBox="0 0 ' + W + ' 22" preserveAspectRatio="none">' +
        '<path d="' + cable + '" fill="none" stroke="#3a4a5e" stroke-width="1" opacity=".55"/>' + focos + '</svg>';
    }
    dibujar();
    var t;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(dibujar, 150); });
  }

  // Gorrito sobre el isotipo (la casita del logo).
  function gorro(img) {
    var cont = img.parentNode;
    if (getComputedStyle(cont).position === 'static') cont.style.position = 'relative';
    var g = document.createElement('span');
    g.className = 'nv-gorro';
    g.setAttribute('aria-hidden', 'true');
    g.innerHTML = '<svg viewBox="0 0 40 30" width="100%" height="100%">' +
      '<path d="M5 24 C9 12 18 3 30 4 C33 4 36 8 35 13 C31 9 26 10 24 13 C22 17 23 21 24 24 Z" fill="#b23a3a"/>' +
      '<path d="M5 24 C9 12 18 3 30 4" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="1.2"/>' +
      '<rect x="2" y="21.5" width="25" height="6.5" rx="3.2" fill="#fbf8ef" stroke="rgba(22,39,63,.18)" stroke-width=".6"/>' +
      '<circle cx="35" cy="14" r="3.6" fill="#fbf8ef" stroke="rgba(22,39,63,.18)" stroke-width=".6"/></svg>';
    cont.appendChild(g);
    function ubicar() {
      var r = img.getBoundingClientRect(), rc = cont.getBoundingClientRect();
      if (!r.width) return;
      var w = r.width * 0.62;
      g.style.width = w + 'px';
      g.style.height = (w * 0.75) + 'px';
      g.style.left = (r.left - rc.left + r.width * 0.30) + 'px';
      g.style.top = (r.top - rc.top - w * 0.42) + 'px';
      g.style.transform = 'rotate(8deg)';
    }
    if (img.complete) ubicar(); else img.addEventListener('load', ubicar);
    window.addEventListener('resize', ubicar);
  }

  function bola(color, tam, hilo, izq, cls, demora) {
    return '<div class="nv-adorno ' + (cls || '') + '" style="left:' + izq + ';animation-delay:-' + demora + 's">' +
      '<i style="height:' + hilo + 'px"></i>' +
      '<svg width="' + tam + '" height="' + (tam + 5) + '" viewBox="0 0 30 35">' +
      '<rect x="11" y="0" width="8" height="6" rx="1.5" fill="#C9A227"/>' +
      '<circle cx="15" cy="20" r="14" fill="' + color + '"/>' +
      '<path d="M2 18 Q15 24 28 18" fill="none" stroke="rgba(201,162,39,.8)" stroke-width="1.4"/>' +
      '<ellipse cx="10" cy="14" rx="3.5" ry="5" fill="rgba(255,255,255,.35)" transform="rotate(30 10 14)"/></svg></div>';
  }

  function portada() {
    var hero = document.getElementById('mvHero');
    if (!hero) return;
    var ad = document.createElement('div');
    ad.className = 'nv-adornos';
    ad.setAttribute('aria-hidden', 'true');
    ad.innerHTML =
      bola('#b23a3a', 26, 70, '47%', 'nv-solo-compu', 0) +
      bola('#C9A227', 34, 120, '53%', 'nv-solo-compu', 1.7) +
      bola('#2f6b4f', 22, 45, '58%', 'nv-solo-compu', 3.1) +
      bola('#C9A227', 24, 40, '88%', '', 0.8);
    hero.appendChild(ad);
    var h1 = hero.querySelector('.mv-hero-copy h1');
    if (h1) {
      var c = document.createElement('div');
      c.className = 'nv-cartel';
      c.innerHTML = '<span aria-hidden="true">✦</span> Felices fiestas <span aria-hidden="true">✦</span>';
      h1.parentNode.insertBefore(c, h1);
    }
  }

  function decorar() {
    try { estilos(); } catch (e) {}
    try {
      var h = document.querySelector('body > header, header.header, header');
      if (h && getComputedStyle(h).overflow !== 'hidden') guirnalda(h);
    } catch (e) {}
    try {
      var logo = document.querySelector('.logo .logo-img');
      if (logo) gorro(logo);
    } catch (e) {}
    try { portada(); } catch (e) {}
  }

  function nieve() {
    var cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9998;';
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d');
    if (!ctx) { cv.remove(); return; }

    // Dos copos dibujados una sola vez; después solo se copian (rápido).
    function sprite(centro, borde) {
      var s = document.createElement('canvas'), R = 16;
      s.width = s.height = R * 2;
      var g = s.getContext('2d');
      var gr = g.createRadialGradient(R, R, 0, R, R, R);
      gr.addColorStop(0, centro);
      gr.addColorStop(0.55, centro);
      gr.addColorStop(0.75, borde);
      gr.addColorStop(1, 'rgba(22,39,63,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.fill();
      return s;
    }
    var BLANCO = sprite('rgba(255,255,255,1)', 'rgba(22,39,63,.22)');
    var DORADO = sprite('rgba(232,205,120,1)', 'rgba(201,162,39,.35)');

    var W = 0, H = 0, copos = [];
    function cantidad() { return W < 640 ? 16 : 40; }
    function nuevo(arriba) {
      return {
        x: Math.random() * W,
        y: arriba ? -10 - Math.random() * H * 0.3 : Math.random() * H,
        r: 1.6 + Math.random() * 2.6,          // radio en px
        v: 18 + Math.random() * 26,            // px por segundo
        a: 0.45 + Math.random() * 0.4,         // transparencia
        f: Math.random() * Math.PI * 2,        // fase del vaivén
        w: 0.4 + Math.random() * 0.8,          // velocidad del vaivén
        img: Math.random() < 0.12 ? DORADO : BLANCO
      };
    }
    function medir() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = cantidad();
      while (copos.length < n) copos.push(nuevo(false));
      copos.length = n;
    }
    medir();
    window.addEventListener('resize', medir);

    var antes = 0;
    function cuadro(t) {
      var dt = antes ? Math.min((t - antes) / 1000, 0.05) : 0;
      antes = t;

      {
        ctx.clearRect(0, 0, W, H);
        var fin = H * 0.72;                  // desde acá se van apagando
        for (var i = 0; i < copos.length; i++) {
          var c = copos[i];
          c.y += c.v * dt;
          c.f += c.w * dt;
          var x = c.x + Math.sin(c.f) * 14;
          if (c.y > H + 10) { copos[i] = nuevo(true); continue; }
          var al = c.a;
          if (c.y > fin) al *= Math.max(0, 1 - (c.y - fin) / (H - fin));
          if (al <= 0.02) continue;
          ctx.globalAlpha = al;
          var d = c.r * 2;
          ctx.drawImage(c.img, x - c.r, c.y - c.r, d, d);
        }
        ctx.globalAlpha = 1;
      }
      requestAnimationFrame(cuadro);
    }
    requestAnimationFrame(cuadro);

    document.addEventListener('visibilitychange', function () { antes = 0; });
  }

  function arrancar() {
    decorar();
    if (!quieto) nieve();
  }

  if (document.body) arrancar();
  else document.addEventListener('DOMContentLoaded', arrancar);
})();
