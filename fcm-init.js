/* ============================================================================
 * fcm-init.js — Notificaciones push (FCM) en TODAS las páginas del panel.
 *
 * - Registra el token de push del dispositivo apenas hay sesión (sin token el
 *   servidor no tiene a dónde mandar el aviso). Lo guarda en users/{uid}:
 *   fcmToken (el del último dispositivo, como siempre) y fcmTokens (TODOS los
 *   dispositivos del usuario, para que el push llegue al celular y a la compu).
 * - Usa la MISMA app 'messaging' que app.js: un solo token por dispositivo.
 *   Antes usaba la app principal, y cada dispositivo tenía dos tokens distintos
 *   que se pisaban en el perfil a cada carga (y podían duplicar avisos).
 * - NO pide permiso al cargar la página: se pide con el botón "Activar" del
 *   inicio (iOS solo lo permite con un toque del usuario y Chrome castiga a los
 *   sitios que lo piden de entrada). Si el permiso ya está dado, registra.
 * - Push con la página a la vista: muestra un aviso chico dentro de la página
 *   (el service worker no muestra la notificación del sistema en ese caso).
 * - Dirección con ?aviso=ID (viene de tocar una notificación): la marca leída.
 *
 * En index.html no hace nada: app.js ya registra y muestra sus propios avisos
 * (lo avisa con window.__mvAvisosPropios).
 *
 * REQUISITOS en la página que lo incluya:
 *   - firebase-app-compat.js, firebase-auth-compat.js y firebase-firestore-compat.js.
 *   - firebase-messaging-sw.js en la raíz del sitio.
 * El SDK de messaging lo carga este script por su cuenta si no está presente.
 * ==========================================================================*/
(function () {
  'use strict';

  var VAPID_KEY = 'BK8DjPgkooF91Ou9js1FOaX9VtJwVDqFaXpGePoYosqWcmpy5MBrtW0YauhWjWpYP1yUVvM9IzT4toFYLdEI8Ko';
  // La config vive en malave-config.js. Se deja una copia de respaldo porque
  // este script se carga al final del body y no queremos que una pagina sin el
  // <script> compartido pierda las notificaciones push en silencio.
  var FIREBASE_CONFIG = window.firebaseConfig || {
    apiKey: 'AIzaSyDnCQLlJuBtZqXNwYILio9a8ltb972bXzQ',
    authDomain: 'mi-cartera-inmobiliaria.firebaseapp.com',
    projectId: 'mi-cartera-inmobiliaria',
    storageBucket: 'mi-cartera-inmobiliaria.firebasestorage.app',
    messagingSenderId: '923595024127',
    appId: '1:923595024127:web:b7104adcba6387a5a84eca'
  };

  // Evita doble ejecución si el script se incluye dos veces.
  if (window.__fcmInitLoaded) return;
  window.__fcmInitLoaded = true;

  // index.html: app.js hace todo (token, toasts, campanita).
  function paginaConAvisosPropios() { return window.__mvAvisosPropios === true; }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      // ¿ya está cargado?
      var ya = Array.prototype.some.call(document.scripts, function (s) { return s.src.indexOf(src) >= 0; });
      if (ya) return resolve();
      var el = document.createElement('script');
      el.src = src; el.async = false;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('No se pudo cargar ' + src)); };
      document.head.appendChild(el);
    });
  }

  // Messaging en una app APARTE llamada 'messaging' (igual que app.js): así el
  // SDK de Cloud Functions de la app principal no intenta usar el push (en Brave
  // u Opera eso rompía las llamadas) y el token es el mismo en todas las páginas.
  async function obtenerMessaging() {
    if (typeof firebase === 'undefined') throw new Error('firebase (compat) no está cargado en la página');
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    if (!firebase.messaging) {
      await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');
    }
    if (!firebase.messaging) return null;
    // Algunos navegadores (iOS < 16.4, modo incógnito) no soportan FCM web.
    if (firebase.messaging.isSupported) {
      try { if (!(await firebase.messaging.isSupported())) return null; } catch (e) { /* seguimos e intentamos */ }
    }
    var app = null;
    for (var i = 0; i < firebase.apps.length; i++) if (firebase.apps[i].name === 'messaging') app = firebase.apps[i];
    if (!app) app = firebase.initializeApp(FIREBASE_CONFIG, 'messaging');
    return app.messaging();
  }

  // Guarda el token en el perfil del usuario (solo si cambió, para no escribir de más).
  async function guardarToken(uid, token) {
    var ref = firebase.firestore().collection('users').doc(uid);
    var snap = await ref.get();
    var d = (snap.exists && snap.data()) || {};
    var cambio = false;
    if (d.fcmToken !== token) {
      await ref.set({
        fcmToken: token,
        fcmTokenUpdatedAt: new Date().toISOString(),
        notificationsEnabled: true,
        deviceInfo: { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language }
      }, { merge: true });
      cambio = true;
    }
    if (!(Array.isArray(d.fcmTokens) && d.fcmTokens.indexOf(token) >= 0)) {
      // Escritura aparte: si las reglas no dejaran escribir este campo, lo de
      // arriba ya quedó guardado y el push sigue andando como antes.
      try {
        await ref.set({ fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true });
        cambio = true;
      } catch (e) { console.warn('[fcm-init] no se pudo sumar el dispositivo a fcmTokens:', e && e.message); }
    }
    return cambio;
  }

  async function registrar(uid) {
    try {
      if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;   // se activa desde el inicio

      var messaging = await obtenerMessaging();
      if (!messaging) return; // navegador sin soporte

      // El SW debe estar en la raíz. Si otra página ya lo registró, register()
      // devuelve el registro existente sin duplicar.
      var reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      await navigator.serviceWorker.ready;

      var token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (!token) { console.warn('[fcm-init] getToken no devolvió token'); return; }
      window.__mvTokenPush = token;

      var guardado = await guardarToken(uid, token);
      console.log('[fcm-init] token FCM ' + (guardado ? 'guardado/actualizado' : 'ya vigente') + ' (' + token.slice(0, 16) + '…)');

      // Solo lo usa la versión ANTERIOR del service worker (la nueva manda 'mvPush').
      messaging.onMessage(function (payload) {
        var n = (payload && payload.notification) || {};
        var d = (payload && payload.data) || {};
        avisoEnPagina(n.title || d.title, n.body || d.body, null);
      });
    } catch (err) {
      console.warn('[fcm-init] no se pudo registrar el token:', err && err.message);
    }
  }

  // ---- Aviso chico dentro de la página (push con la página a la vista) ----
  function estilos() {
    if (document.getElementById('mvAvisoCss')) return;
    var st = document.createElement('style');
    st.id = 'mvAvisoCss';
    st.textContent =
      '#mvAvisos{position:fixed;right:16px;bottom:16px;z-index:100000;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 32px))}' +
      '.mva{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e7eaef;border-radius:14px;box-shadow:0 12px 34px rgba(16,29,48,.2);padding:12px 12px 12px 14px;font-family:inherit;color:#16273f;animation:mvaIn .25s ease;cursor:pointer}' +
      '.mva.sin{cursor:default}' +
      '.mva-ic{width:36px;height:36px;border-radius:50%;background:#f6efd9;color:#a5801a;display:flex;align-items:center;justify-content:center;flex:none}' +
      '.mva-tx{flex:1;min-width:0}.mva-tx b{display:block;font-size:.88rem;font-weight:600}' +
      '.mva-tx span{display:block;font-size:.78rem;color:#6b7480;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}' +
      '.mva-x{border:none;background:transparent;color:#9aa3ad;font-size:1.2rem;line-height:1;cursor:pointer;padding:4px 6px;flex:none}' +
      '.mva.fuera{opacity:0;transform:translateY(8px);transition:.25s}' +
      '@keyframes mvaIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
      '@media(max-width:640px){#mvAvisos{left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));max-width:none}}';
    document.head.appendChild(st);
  }
  function avisoEnPagina(titulo, cuerpo, url) {
    if (!document.body) return;
    estilos();
    var c = document.getElementById('mvAvisos');
    if (!c) { c = document.createElement('div'); c.id = 'mvAvisos'; document.body.appendChild(c); }
    var t = document.createElement('div');
    t.className = 'mva' + (url ? '' : ' sin');
    t.setAttribute('role', 'status');
    t.innerHTML = '<div class="mva-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z"/></svg></div>' +
      '<div class="mva-tx"><b></b><span></span></div><button class="mva-x" aria-label="Cerrar">×</button>';
    t.querySelector('b').textContent = titulo || 'MALAVE';
    t.querySelector('span').textContent = cuerpo || '';
    function cerrar() { t.classList.add('fuera'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260); }
    t.querySelector('.mva-x').addEventListener('click', function (ev) { ev.stopPropagation(); cerrar(); });
    if (url) t.addEventListener('click', function () { window.location.href = url; });
    c.appendChild(t);
    setTimeout(cerrar, 7000);
  }

  // ---- Marcar leído el aviso que trajo al usuario hasta acá ----
  function marcarLeida(id) {
    if (!id || typeof firebase === 'undefined' || !firebase.auth || !firebase.firestore) return;
    function hacer() {
      try { firebase.firestore().collection('notifications').doc(id).update({ read: true }).catch(function () {}); } catch (e) { /* sin permiso */ }
    }
    if (firebase.auth().currentUser) { hacer(); return; }
    var off = firebase.auth().onAuthStateChanged(function (u) {
      if (u) hacer();
      if (off) { off(); off = null; }
    });
  }
  function avisoEnLaDireccion() {
    try {
      var u = new URL(window.location.href);
      var id = u.searchParams.get('aviso');
      if (!id && !u.searchParams.has('avisos')) return;
      u.searchParams.delete('aviso'); u.searchParams.delete('avisos');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
      marcarLeida(id);
    } catch (e) { /* navegador viejo */ }
  }

  // Mensajes del service worker (push con la página a la vista, o clic en una
  // notificación con esta página ya abierta).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      if (paginaConAvisosPropios()) return;
      var m = ev.data || {};
      if (m.mvPush) {
        avisoEnPagina(m.titulo, m.cuerpo, m.url);
        // "Lo mostré": si ninguna pestaña contesta, el service worker muestra la notificación del sistema.
        try { if (ev.ports && ev.ports[0]) ev.ports[0].postMessage({ mostrado: true }); } catch (e) { /* sin canal */ }
      }
      else if (m.mvAbrir) {
        try {
          var u = new URL(m.mvAbrir, window.location.href);
          marcarLeida(u.searchParams.get('aviso'));
        } catch (e) { /* dirección inválida */ }
      }
    });
  }

  // Arranca cuando hay sesión. Si el usuario aún no está aprobado, igual se
  // registra: el backend decide a quién notifica; tener el token listo no molesta.
  function init() {
    if (paginaConAvisosPropios()) return;
    avisoEnLaDireccion();
    if (typeof firebase === 'undefined' || !firebase.auth) {
      console.warn('[fcm-init] firebase-auth no disponible; no se registra FCM');
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      if (user) registrar(user.uid);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
