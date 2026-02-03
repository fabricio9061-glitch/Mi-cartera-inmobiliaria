// Firebase Messaging Service Worker v2.0
// Este archivo DEBE estar en la raíz del sitio (junto a index.html)

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

const messaging = firebase.messaging();

// URL base del sitio
const SITE_URL = self.location.origin + self.location.pathname.replace('firebase-messaging-sw.js', '');

// Maneja notificaciones cuando la app está en BACKGROUND o CERRADA
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Mensaje en background recibido:', payload);

  const notification = payload.notification || {};
  const data = payload.data || {};
  
  const notificationTitle = notification.title || data.title || '📅 Recordatorio';
  const notificationOptions = {
    body: notification.body || data.body || 'Tienes un evento próximo',
    icon: notification.icon || 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
    badge: 'https://cdn-icons-png.flaticon.com/128/1946/1946488.png',
    image: notification.image || null,
    vibrate: [200, 100, 200, 100, 200],
    tag: data.tag || data.visitId || 'reminder-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: {
      url: data.url || SITE_URL,
      visitId: data.visitId,
      type: data.type,
      dateOfArrival: Date.now()
    },
    actions: [
      { action: 'open', title: '📅 Ver Agenda', icon: 'https://cdn-icons-png.flaticon.com/32/747/747310.png' },
      { action: 'dismiss', title: '✖ Cerrar' }
    ]
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Evento: clic en la notificación
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notificación clickeada:', event.action);
  
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  const urlToOpen = event.notification.data?.url || SITE_URL;

  event.waitUntil(
    clients.matchAll({ 
      type: 'window', 
      includeUncontrolled: true 
    }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('Mi-cartera-inmobiliaria') || client.url.includes('mi-cartera')) {
          client.focus();
          client.postMessage({ action: 'openCalendar', visitId: event.notification.data?.visitId });
          return client;
        }
      }
      return clients.openWindow(urlToOpen);
    })
  );
});

// Evento: notificación cerrada sin clic
self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notificación cerrada:', event.notification.tag);
});

// Evento: push recibido (fallback)
self.addEventListener('push', (event) => {
  console.log('[SW] Push event recibido');
  
  if (event.data) {
    try {
      const payload = event.data.json();
      console.log('[SW] Push data:', payload);
      
      if (!payload.notification && payload.data) {
        const notificationPromise = self.registration.showNotification(
          payload.data.title || '📅 Recordatorio',
          {
            body: payload.data.body || 'Tienes un evento próximo',
            icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
            badge: 'https://cdn-icons-png.flaticon.com/128/1946/1946488.png',
            vibrate: [200, 100, 200],
            tag: payload.data.visitId || 'push-' + Date.now(),
            data: payload.data
          }
        );
        event.waitUntil(notificationPromise);
      }
    } catch (e) {
      console.error('[SW] Error procesando push:', e);
    }
  }
});

// Evento: instalación del Service Worker
self.addEventListener('install', (event) => {
  console.log('[SW] Service Worker instalado');
  self.skipWaiting();
});

// Evento: activación del Service Worker
self.addEventListener('activate', (event) => {
  console.log('[SW] Service Worker activado');
  event.waitUntil(clients.claim());
});

// Escuchar mensajes desde la página principal
self.addEventListener('message', (event) => {
  console.log('[SW] Mensaje recibido:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
