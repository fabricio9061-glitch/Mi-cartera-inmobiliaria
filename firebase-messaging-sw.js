// Firebase Messaging Service Worker
// Este archivo DEBE estar en la misma carpeta que index.html

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDnCQLlJuBtZqXNwYILio9a8ltb972bXzQ",
  authDomain: "mi-cartera-inmobiliaria.firebaseapp.com",
  projectId: "mi-cartera-inmobiliaria",
  storageBucket: "mi-cartera-inmobiliaria.firebasestorage.app",
  messagingSenderId: "923595024127",
  appId: "1:923595024127:web:b7104adcba6387a5a84eca"
});

const messaging = firebase.messaging();

// Maneja notificaciones cuando la app está en BACKGROUND o CERRADA
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Notificación en background:', payload);

  const notificationTitle = payload.notification?.title || payload.data?.title || 'Recordatorio';
  const notificationOptions = {
    body: payload.notification?.body || payload.data?.body || 'Tienes un evento próximo',
    icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
    vibrate: [200, 100, 200, 100, 200],
    tag: payload.data?.visitId || 'reminder',
    renotify: true,
    requireInteraction: true,
    data: {
      url: self.location.origin + self.location.pathname.replace('firebase-messaging-sw.js', ''),
      visitId: payload.data?.visitId
    },
    actions: [
      { action: 'open', title: 'Ver Agenda' },
      { action: 'dismiss', title: 'Cerrar' }
    ]
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Al hacer clic en la notificación, abrir la app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Si ya hay una ventana abierta, enfocarla
      for (const client of windowClients) {
        if (client.url.includes('Mi-cartera-inmobiliaria') && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, abrir nueva ventana
      return clients.openWindow(urlToOpen);
    })
  );
});
