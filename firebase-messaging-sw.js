// Service worker de MALAVE: notificaciones push (Firebase Cloud Messaging).
// Este archivo DEBE estar en la raíz del sitio (junto a index.html).
//
// Qué cambió (v3):
// - UNA sola notificación por aviso. Antes salían dos: la que muestra solo el SDK
//   de Firebase (cuando el mensaje trae "notification") y otra más que armaba
//   onBackgroundMessage. Ahora este archivo maneja el push él mismo, antes que el
//   SDK, y el SDK queda solo para renovar el token.
// - El clic lleva al lugar correcto según el tipo de aviso (la consulta en la
//   campanita, Clientes, Mis Finanzas, el panel…) y reusa la pestaña de la app si
//   ya está abierta. Antes buscaba "mi-cartera" en la dirección (nunca coincidía),
//   abría siempre una ventana nueva y ofrecía "Ver Agenda" para cualquier cosa.
// - Ícono correcto (el servidor pedía /icon192.png, que no existe).
// - Con la app abierta y a la vista no se muestra la notificación del sistema: se
//   le pasa el aviso a la página, que muestra el suyo y contesta "lo mostré". Si
//   ninguna contesta (una página sin la campanita o una versión vieja guardada en
//   el navegador), sale la notificación del sistema igual: el aviso no se pierde.

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Configuración de Firebase (misma que en index.html)
firebase.initializeApp({
  apiKey: "AIzaSyDnCQLlJuBtZqXNwYILio9a8ltb972bXzQ",
  authDomain: "mi-cartera-inmobiliaria.firebaseapp.com",
  projectId: "mi-cartera-inmobiliaria",
  storageBucket: "mi-cartera-inmobiliaria.firebasestorage.app",
  messagingSenderId: "923595024127",
  appId: "1:923595024127:web:b7104adcba6387a5a84eca"
});

const ICONO = 'icon-192.png';
const INSIGNIA = 'iso-malave-white.png';   // silueta blanca: Android la usa en la barra de estado
// Estos quedan en pantalla hasta que se tocan (en la compu): alguien espera respuesta.
const URGENTES = ['ml_lead', 'consulta_infocasas', 'lead_portal', 'despublicar_confirmar'];
const PANEL_SUBTIPO = { alta: 'equipo', testimonio: 'sitio-testimonios', solicitud: 'sitio-solicitudes', revision: 'revisiones' };
const ESPERA_PAGINA = 1500;   // cuánto se espera a que la página confirme que lo mostró (ms)

// Adónde lleva cada aviso. Lo que se resuelve en la campanita (consultas con sus
// botones de WhatsApp, decisiones de despublicación, errores de portales) abre el
// inicio con ese aviso a la vista.
function esRecordatorio(d) {
  return !!d.visitId || /recordatorio|reminder|visita|agenda|evento/i.test(d.type || '');
}
function rutaDe(d) {
  const pid = d.propertyId ? encodeURIComponent(d.propertyId) : '';
  // Recordatorios de la agenda (visitas, reuniones): a la agenda.
  if (esRecordatorio(d)) return 'agenda.html';
  // Si el aviso trae su propia dirección del mismo sitio, se respeta.
  if (d.url) {
    try { const u = new URL(d.url, self.registration.scope); if (u.origin === new URL(self.registration.scope).origin) return u.href; } catch (e) { /* dirección inválida */ }
  }
  switch (d.type) {
    case 'crm_seguimiento':
    case 'crm_pausa': return 'clientes.html';
    case 'retiro': return 'retiros-admin.html';
    case 'retiro_estado': return 'finanzas.html';
    case 'postulacion': return 'admin.html#sitio-postulaciones';
    case 'admin_pendiente': return 'admin.html#' + (PANEL_SUBTIPO[d.subtipo] || 'bandeja');
    case 'ficha_incompleta': return pid ? 'propiedad-form.html?id=' + pid : 'index.html';
    case 'vencimiento_alquiler':
    case 'baja_resuelta':
    case 'propiedad_reservada':
    case 'destacado_vencido':
    case 'portal_publicada': return pid ? 'propiedad.html?id=' + pid : 'index.html';
    default: return 'index.html';
  }
}
function destinoDe(d) {
  const u = new URL(rutaDe(d), self.registration.scope);
  // ?aviso=ID: la página lo marca leído (y el inicio lo muestra en la campanita).
  if (d.notifId) u.searchParams.set('aviso', d.notifId);
  else if (esInicio(u.href)) u.searchParams.set('avisos', '1');
  return u.href;
}
function esInicio(url) {
  try { return /\/(index\.html)?$/.test(new URL(url).pathname); } catch (e) { return false; }
}
// Misma etiqueta que usa la página para el mismo aviso (mv-ID): si el mismo
// aviso llega dos veces al dispositivo, el segundo reemplaza al primero sin sonar.
function etiquetaDe(d, titulo, cuerpo) {
  if (d.notifId) return 'mv-' + d.notifId;
  if (d.tag) return String(d.tag);
  if (d.visitId) return 'mv-visita-' + d.visitId;
  const s = (d.type || '') + '|' + titulo + '|' + cuerpo;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'mv-' + (d.type || 'aviso') + '-' + (h >>> 0).toString(36);
}

// Le pasa el aviso a las pestañas A LA VISTA y espera que alguna conteste que lo
// mostró. Devuelve false si no hay ninguna a la vista o si nadie contesta a tiempo.
function lePasaALaPagina(ventanas, msg) {
  const visibles = ventanas.filter((c) => c.visibilityState === 'visible');
  if (!visibles.length || typeof MessageChannel === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const canales = [];
    let listo = false;
    const fin = (v) => {
      if (listo) return;
      listo = true;
      canales.forEach((c) => { try { c.port1.close(); } catch (e) { /* ya cerrado */ } });
      resolve(v);
    };
    setTimeout(() => fin(false), ESPERA_PAGINA);
    visibles.forEach((c) => {
      try {
        const canal = new MessageChannel();
        canales.push(canal);
        canal.port1.onmessage = (ev) => { if (ev.data && ev.data.mostrado) fin(true); };
        c.postMessage(msg, [canal.port2]);
      } catch (e) { /* esa pestaña no recibe mensajes */ }
    });
  });
}

async function alRecibirPush(event) {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) {
    p = { data: { body: event.data ? event.data.text() : '' } };
  }
  const n = p.notification || {};
  const d = p.data || {};
  const titulo = n.title || d.title || 'MALAVE';
  const cuerpo = n.body || d.body || '';
  const url = destinoDe(d);
  const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // App abierta y a la vista: la página muestra su propio aviso (y lo confirma).
  if (await lePasaALaPagina(ventanas, { mvPush: true, titulo, cuerpo, url, datos: d })) return;
  await self.registration.showNotification(titulo, {
    body: cuerpo,
    icon: ICONO,
    badge: INSIGNIA,
    tag: etiquetaDe(d, titulo, cuerpo),
    renotify: false,
    requireInteraction: URGENTES.indexOf(d.type) >= 0 || esRecordatorio(d),
    timestamp: Date.now(),
    data: { url, tipo: d.type || '', notifId: d.notifId || '' }
  });
}

// Push: se atiende ANTES que el SDK de Firebase y se corta ahí, para que el SDK
// no muestre su propia copia. (Por eso este listener va antes de firebase.messaging().)
self.addEventListener('push', (event) => {
  event.stopImmediatePropagation();
  event.waitUntil(alRecibirPush(event).catch((e) => {
    console.error('[SW] Error mostrando el push:', e);
    // Nunca un push "mudo": el navegador lo castiga y podría dar de baja la suscripción.
    return self.registration.showNotification('MALAVE', { body: 'Tenés una novedad', icon: ICONO, badge: INSIGNIA, tag: 'mv-respaldo', data: { url: new URL('index.html?avisos=1', self.registration.scope).href } });
  }));
});

// Clic en la notificación: si la app ya está abierta en esa página, la trae al
// frente; si no, la abre ahí. Nunca navega una pestaña que está en otra cosa
// (podría haber un formulario a medio llenar).
async function abrirDestino(url) {
  const destino = new URL(url);
  const clave = (href) => {
    const x = new URL(href);
    x.searchParams.delete('aviso'); x.searchParams.delete('avisos');
    let ruta = x.pathname;
    if (ruta.endsWith('/')) ruta += 'index.html';
    return x.origin + ruta + x.search + x.hash;
  };
  const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const propias = ventanas.filter((c) => { try { return new URL(c.url).origin === destino.origin; } catch (e) { return false; } });
  // El inicio resuelve el aviso sin recargar (abre la campanita en ese aviso).
  const misma = propias.find((c) => clave(c.url) === clave(url)) || (esInicio(url) && propias.find((c) => esInicio(c.url)));
  if (misma) {
    try { await misma.focus(); } catch (e) { /* sin foco */ }
    misma.postMessage({ mvAbrir: url });
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(url);
}
self.addEventListener('notificationclick', (event) => {
  const datos = (event.notification && event.notification.data) || {};
  // La mostró el SDK con la versión anterior de este archivo: la maneja él.
  if (datos.FCM_MSG) return;
  event.notification.close();
  if (event.action === 'dismiss' || event.action === 'cerrar') return;
  const url = new URL(datos.url || 'index.html?avisos=1', self.registration.scope).href;
  event.waitUntil(abrirDestino(url));
});

// El SDK queda activo SOLO para renovar la suscripción cuando el navegador la
// cambia (pushsubscriptionchange). Tiene que crearse DESPUÉS de los listeners
// de arriba.
try { firebase.messaging(); } catch (e) { console.warn('[SW] Messaging no disponible:', e && e.message); }

// Instalación y activación: la versión nueva toma el control enseguida.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Mensajes desde la página
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
