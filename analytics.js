/* =====================================================================
   GOOGLE ANALYTICS — solo en las páginas públicas
   ---------------------------------------------------------------------
   Lo cargan (con defer, en el <head>): index, propiedad, vender, trabaja,
   gastos, calculadora de garantías, privacidad y 404. Las páginas del CRM
   no lo cargan, así que ahí no se mide nada.

   1. PERMISO. Hasta que la persona toca "Aceptar" en el aviso no se carga
      nada de Google: ni cookies ni pedidos. Así lo pide la guía de la URCDP
      (Ley 18.331). La elección se recuerda un año; en privacidad.html se
      puede cambiar (mvCookiesElegir).
   2. EQUIPO. Los navegadores donde alguien del equipo inició sesión no se
      miden ni ven el aviso. app.js deja la marca "mvEquipo" al iniciar
      sesión (mvNoMedir) y la sesión recordada "mvSesion" también cuenta.
   3. CONSULTAS. Cada clic en un enlace de WhatsApp con número
      (wa.me/598…) cuenta como consulta_whatsapp y cada clic en un teléfono
      (tel:) como consulta_telefono. Los botones que abren WhatsApp con
      JavaScript (Contactar en las tarjetas, Consultar en la ficha) y los
      formularios avisan por su cuenta con mvMedir(). Un enlace de WhatsApp
      sin número (wa.me/?text=…) es "compartir" y no cuenta.
   4. VISTA DE PÁGINA. La manda este archivo. La ficha de una propiedad pone
      window.mvEsperarTitulo = true y avisa con el evento "mv:titulo" cuando
      ya tiene el nombre de la propiedad: así en Analytics cada ficha
      aparece con su nombre y no todas como "Propiedad | MALAVE".

   Nunca se manda lo que la persona escribe (nombre, teléfono, mensaje).
   Si cambia el ID de Analytics, se cambia solo acá.
   ===================================================================== */
(function () {
  'use strict';

  var ID = 'G-XWV50RR79B';
  var CLAVE = 'mvCookies';              // {"v":"si"|"no","t":fecha}
  var VIGENCIA = 365 * 864e5;           // al año se vuelve a preguntar
  var PRIVACIDAD = '/privacidad.html';  // con "/" para que sirva también en la 404

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function leer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  function esEquipo() { return !!(leer('mvEquipo') || leer('mvSesion')); }
  function eleccion() {
    try {
      var c = JSON.parse(leer(CLAVE) || 'null');
      if (c && (c.v === 'si' || c.v === 'no') && Date.now() - (Number(c.t) || 0) < VIGENCIA) return c.v;
    } catch (e) { }
    return '';
  }

  // ===== Encender y apagar la medición =====
  var midiendo = false, cargado = false;
  var vistaLista = false, vistaMandada = false;

  function encender() {
    if (midiendo || esEquipo()) return;
    midiendo = true;
    window['ga-disable-' + ID] = false;
    if (cargado) {                       // volvió a aceptar sin recargar la página
      gtag('consent', 'update', { analytics_storage: 'granted' });
    } else {
      cargado = true;
      // Solo medición: nada de publicidad ni de Google Signals.
      gtag('consent', 'default', {
        analytics_storage: 'granted',
        ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'
      });
      gtag('js', new Date());
      gtag('config', ID, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
      document.head.appendChild(s);
    }
    mandarVista();
  }

  function apagar() {
    if (cargado) gtag('consent', 'update', { analytics_storage: 'denied' });
    window['ga-disable-' + ID] = true;
    midiendo = false;
    borrarCookies();
  }

  // Las cookies de Analytics (_ga y _ga_…) quedan en el dominio principal.
  function borrarCookies() {
    var host = location.hostname, base = host.replace(/^www\./, '');
    document.cookie.split(';').forEach(function (c) {
      var n = c.split('=')[0].trim();
      if (n !== '_ga' && n.indexOf('_ga_') !== 0) return;
      ['', ';domain=' + host, ';domain=.' + base].forEach(function (d) {
        document.cookie = n + '=;Max-Age=0;path=/' + d;
      });
    });
  }

  // ===== Vista de página =====
  function mandarVista() {
    if (!midiendo || !vistaLista || vistaMandada) return;
    vistaMandada = true;
    gtag('event', 'page_view', { page_title: document.title, page_location: location.href.split('#')[0] });
  }
  function vistaEstaLista() { vistaLista = true; mandarVista(); }

  // ===== Consultas =====
  // Sin permiso (o en un navegador del equipo) no hace nada.
  function medir(evento, datos) {
    if (!midiendo) return;
    gtag('event', evento, datos || {});
  }
  var WHATSAPP = /^https?:\/\/(?:wa\.me\/\+?\d|(?:api\.|web\.)?whatsapp\.com\/send\/?\?(?:[^#]*&)?phone=\+?\d)/i;
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.href || '';
    if (/^tel:/i.test(href)) medir('consulta_telefono');
    else if (WHATSAPP.test(href)) medir('consulta_whatsapp');
  }, true);

  // ===== Aviso de cookies =====
  // El estilo va primero en el <head>: así una página puede ajustarlo con su
  // propio CSS (la ficha lo sube para que no tape la barra de "Consultar").
  var ESTILO =
    '#mvAvisoCookies{position:fixed;z-index:990;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));' +
    'max-width:460px;margin:0 auto;box-sizing:border-box;background:#fff;color:#16273f;border:1px solid #e4dfd2;border-radius:14px;' +
    'box-shadow:0 12px 36px rgba(22,39,63,.2);padding:16px 18px;font-size:14.5px;line-height:1.5;text-align:left}' +
    '#mvAvisoCookies *{box-sizing:border-box}' +
    '#mvAvisoCookies p{margin:0 0 12px;color:#3d4a5c}' +
    '#mvAvisoCookies p b{color:#16273f}' +
    '#mvAvisoCookies a{color:#8a6d12;text-decoration:underline;text-underline-offset:2px}' +
    '#mvAvisoCookies .mvac-botones{display:flex;gap:10px}' +
    '#mvAvisoCookies button{flex:1;min-height:44px;margin:0;padding:10px 14px;border-radius:10px;border:1.5px solid #16273f;' +
    'font:inherit;font-weight:600;cursor:pointer;-webkit-appearance:none;appearance:none}' +
    '#mvAvisoCookies button[data-mvac="si"]{background:#16273f;color:#fff}' +
    '#mvAvisoCookies button[data-mvac="no"]{background:#fff;color:#16273f}' +
    '#mvAvisoCookies button:focus-visible,#mvAvisoCookies a:focus-visible{outline:3px solid #C9A227;outline-offset:2px}' +
    '@media (min-width:720px){#mvAvisoCookies{left:24px;right:auto;bottom:24px;margin:0}}';

  function quitarAviso() {
    var c = document.getElementById('mvAvisoCookies');
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }

  function mostrarAviso() {
    if (document.getElementById('mvAvisoCookies') || !document.body) return;
    if (!document.getElementById('mvAvisoCookiesEstilo')) {
      var st = document.createElement('style');
      st.id = 'mvAvisoCookiesEstilo';
      st.textContent = ESTILO;
      document.head.insertBefore(st, document.head.firstChild);
    }
    var caja = document.createElement('div');
    caja.id = 'mvAvisoCookies';
    caja.setAttribute('role', 'region');
    caja.setAttribute('aria-label', 'Aviso de cookies');
    caja.innerHTML =
      '<p><b>¿Nos dejás medir tu visita?</b> Usamos cookies de Google Analytics para saber cuántas personas entran al sitio ' +
      'y qué propiedades miran. No guardan tu nombre ni tu teléfono. <a href="' + PRIVACIDAD + '">Más información</a></p>' +
      '<div class="mvac-botones"><button type="button" data-mvac="si">Aceptar</button>' +
      '<button type="button" data-mvac="no">No, gracias</button></div>';
    caja.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button[data-mvac]') : null;
      if (!b) return;
      var v = b.getAttribute('data-mvac');
      guardar(CLAVE, JSON.stringify({ v: v, t: Date.now() }));
      quitarAviso();
      if (v === 'si') encender(); else apagar();
    });
    document.body.appendChild(caja);
  }

  // ===== Lo que usan las páginas =====
  window.mvMedir = medir;
  // app.js la llama al iniciar sesión: este navegador es del equipo.
  window.mvNoMedir = function () { guardar('mvEquipo', '1'); apagar(); quitarAviso(); };
  // Botón "Cambiar mi elección" de privacidad.html.
  window.mvCookiesElegir = function () { quitarAviso(); mostrarAviso(); };

  // ===== Arranque =====
  if (window.mvEsperarTitulo && !window.mvTituloListo) {
    document.addEventListener('mv:titulo', vistaEstaLista);
    setTimeout(vistaEstaLista, 8000);   // si la ficha no carga, la visita igual cuenta
  } else {
    vistaEstaLista();
  }

  if (esEquipo()) { window['ga-disable-' + ID] = true; return; }
  var ya = eleccion();
  if (ya === 'si') encender();
  else if (ya === '') mostrarAviso();
})();
