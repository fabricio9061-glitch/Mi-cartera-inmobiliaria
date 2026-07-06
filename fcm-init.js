/* ============================================================================
 * fcm-init.js — Registro de notificaciones push (FCM) para TODO el panel.
 *
 * PROBLEMA QUE RESUELVE: antes el token FCM solo se generaba en index.html
 * (única página que cargaba app.js). Un agente que entraba directo a la agenda,
 * clientes, mapa de cierres, etc. —o que guardaba una de esas páginas en el
 * celular— nunca registraba token, y sin token el backend no tiene a dónde
 * mandar el push. Este módulo se incluye en todas las páginas del panel y
 * garantiza que, apenas hay sesión, el token quede guardado en users/{uid}.
 *
 * REQUISITOS en la página que lo incluya:
 *   - firebase-app-compat.js y firebase-auth-compat.js ya cargados.
 *   - firebase.initializeApp(...) ya ejecutado (o se inicializa acá si falta).
 *   - firebase-messaging-sw.js en la raíz del sitio.
 * El SDK de messaging lo carga este script por su cuenta si no está presente.
 * ==========================================================================*/
(function () {
  'use strict';

  var VAPID_KEY = 'BK8DjPgkooF91Ou9js1FOaX9VtJwVDqFaXpGePoYosqWcmpy5MBrtW0YauhWjWpYP1yUVvM9IzT4toFYLdEI8Ko';
  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDnCQLlJuBtZqXNwYILio9a8ltb972bXzQ',
    authDomain: 'mi-cartera-inmobiliaria.firebaseapp.com',
    projectId: 'mi-cartera-inmobiliaria',
    storageBucket: 'mi-cartera-inmobiliaria.firebasestorage.app',
    messagingSenderId: '923595024127',
    appId: '1:923595024127:web:b7104adcba6387a5a84eca'
  };

  // Evita doble ejecución si el script se incluye dos veces o convive con app.js.
  if (window.__fcmInitLoaded) return;
  window.__fcmInitLoaded = true;

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

  async function ensureMessagingSDK() {
    if (typeof firebase === 'undefined') throw new Error('firebase (compat) no está cargado en la página');
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    if (!firebase.messaging) {
      await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');
    }
    // Algunos navegadores (iOS < 16.4, modo incógnito) no soportan FCM web.
    if (firebase.messaging && firebase.messaging.isSupported) {
      try { if (!(await firebase.messaging.isSupported())) return null; } catch (e) { /* seguimos e intentamos */ }
    }
    return firebase.messaging();
  }

  // Guarda el token en el perfil del usuario (solo si cambió, para no escribir de más).
  async function guardarToken(uid, token) {
    var db = firebase.firestore();
    var ref = db.collection('users').doc(uid);
    var snap = await ref.get();
    var actual = snap.exists ? snap.data().fcmToken : null;
    if (actual === token) return false;
    await ref.set({
      fcmToken: token,
      fcmTokenUpdatedAt: new Date().toISOString(),
      notificationsEnabled: true,
      deviceInfo: { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language }
    }, { merge: true });
    return true;
  }

  async function registrar(uid) {
    try {
      if (!('serviceWorker' in navigator) || !('Notification' in window)) return;

      // El permiso se pide una sola vez; si ya fue denegado, no insistimos acá
      // (el usuario lo reactiva desde el candado del navegador). Si está en
      // "default", se lo pedimos.
      var permiso = Notification.permission;
      if (permiso === 'denied') return;
      if (permiso === 'default') {
        permiso = await Notification.requestPermission();
        if (permiso !== 'granted') return;
      }

      var messaging = await ensureMessagingSDK();
      if (!messaging) return; // navegador sin soporte

      // El SW debe estar en la raíz. Si otra página ya lo registró, register()
      // devuelve el registro existente sin duplicar.
      var reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      await navigator.serviceWorker.ready;

      var token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (!token) { console.warn('[fcm-init] getToken no devolvió token'); return; }

      var guardado = await guardarToken(uid, token);
      console.log('[fcm-init] token FCM ' + (guardado ? 'guardado/actualizado' : 'ya vigente') + ' (' + token.slice(0, 16) + '…)');

      // Notificaciones en primer plano: aviso nativo (además del que muestre la página).
      messaging.onMessage(function (payload) {
        var n = (payload && payload.notification) || {};
        var d = (payload && payload.data) || {};
        try {
          if (Notification.permission === 'granted') {
            new Notification(n.title || d.title || 'MALAVE', {
              body: n.body || d.body || 'Tenés una novedad',
              icon: 'icon-192.png',
              tag: d.tag || ('fg-' + Date.now())
            });
          }
        } catch (e) { /* algunos navegadores exigen mostrarla desde el SW */ }
      });
    } catch (err) {
      console.warn('[fcm-init] no se pudo registrar el token:', err && err.message);
    }
  }

  // Arranca cuando hay sesión. Si el usuario aún no está aprobado, igual se
  // registra: el backend decide a quién notifica; tener el token listo no molesta.
  function init() {
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
