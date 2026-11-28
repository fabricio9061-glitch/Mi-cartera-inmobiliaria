/* =====================================================================
   NIEVE NAVIDEÑA — solo en las páginas públicas
   ---------------------------------------------------------------------
   Caen unos pocos copos suaves (blancos con borde azul apenas visible, y
   alguno dorado) desde el 1 de diciembre hasta el 1 de enero inclusive,
   según la hora de Uruguay. El 2 de enero deja de aparecer solo; el año
   siguiente vuelve solo. No hay nada que prender ni apagar a mano.

   - No tapa nada: el dibujo no recibe clics (pointer-events:none) y los
     copos se desvanecen al llegar a la parte de abajo de la pantalla, donde
     están los botones de WhatsApp y la barra del celular.
   - Liviano: un solo <canvas>, ~40 copos en compu y ~16 en celular, y se
     frena cuando la pestaña no está a la vista.
   - Si la persona pidió "reducir movimiento" en su equipo, no aparece.
   - En el inicio, cuando un agente tiene la sesión abierta (ve el CRM),
     tampoco aparece.
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

  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {}

  // En el inicio con sesión de agente se ve el CRM: ahí no va la nieve.
  function hayAgente() {
    var de = document.documentElement;
    if (de.classList.contains('mv-sesion')) return true;
    var u = document.getElementById('nav-user');
    return !!(u && !u.classList.contains('hidden'));
  }

  function arrancar() {
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

    var antes = 0, oculto = false, ultimoChequeo = 0;
    function cuadro(t) {
      var dt = antes ? Math.min((t - antes) / 1000, 0.05) : 0;
      antes = t;

      if (t - ultimoChequeo > 1000) {        // una vez por segundo alcanza
        ultimoChequeo = t;
        oculto = hayAgente();
        cv.style.display = oculto ? 'none' : '';
      }
      if (!oculto) {
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

  if (document.body) arrancar();
  else document.addEventListener('DOMContentLoaded', arrancar);
})();
