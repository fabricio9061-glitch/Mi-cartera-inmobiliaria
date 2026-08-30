/* ============================================================================
 * malave-config.js — Configuración compartida del CRM.
 *
 * QUÉ RESUELVE: la config de Firebase estaba copiada en 19 archivos y
 * ADMIN_EMAIL escrito a mano en 15. Cambiar un valor obligaba a editar todos
 * y una página olvidada quedaba rota entera, no en un botón suelto.
 *
 * POR QUÉ USA window.* Y NO const:
 *   Una propiedad común del objeto global NO bloquea una declaración léxica
 *   posterior. O sea: si alguna página todavía conserva su
 *   `const firebaseConfig = {...}` local, esa copia local gana y la página
 *   sigue andando igual. No hay SyntaxError de redeclaración posible.
 *   Con `const` acá arriba, en cambio, cualquier página sin limpiar tiraría
 *   SyntaxError y se caería completa. Por eso la migración se puede hacer
 *   página por página, probando entre medio.
 *
 * QUÉ NO HACE: no llama a firebase.initializeApp(). Cada página conserva su
 *   propia llamada, porque conviven SDKs distintos (9.22.2 en admin.html,
 *   9.23.0 en agenda.html y vender.html, 10.7.1 en el resto) y mover la
 *   inicialización cambiaría el arranque de 16 páginas de una sola vez.
 *   Al ser solo datos, este archivo NO depende de firebase-app-compat.js:
 *   puede cargarse antes que cualquier otra cosa.
 *
 * DÓNDE VA: antes del <script> inline que use firebaseConfig o ADMIN_EMAIL.
 *   En index.html, antes de rangos.js y app.js.
 *
 * EXCEPCIÓN DOCUMENTADA: firebase-messaging-sw.js NO lee este archivo y
 *   mantiene su copia embebida. Es un service worker: no puede cargar un
 *   <script> normal (necesitaría importScripts) y tiene ciclo de caché propio,
 *   así que podría quedar sirviendo config vieja durante horas. Si algún día
 *   cambian las claves de Firebase, ese archivo hay que tocarlo a mano.
 *
 * SI CAMBIÁS ESTE ARCHIVO: subí el ?v= en los 17 HTML que lo cargan, igual
 *   que con styles.css. Si no, el navegador sirve la versión vieja.
 * ==========================================================================*/

window.firebaseConfig = {
  apiKey: "AIzaSyDnCQLlJuBtZqXNwYILio9a8ltb972bXzQ",
  authDomain: "mi-cartera-inmobiliaria.firebaseapp.com",
  projectId: "mi-cartera-inmobiliaria",
  storageBucket: "mi-cartera-inmobiliaria.firebasestorage.app",
  messagingSenderId: "923595024127",
  appId: "1:923595024127:web:b7104adcba6387a5a84eca"
};

window.ADMIN_EMAIL = "fabricio9061@gmail.com";

/* ============================================================================
 * DESTACADO EFECTIVO
 * ----------------------------------------------------------------------------
 * El backend apaga los destacados vencidos con un cron que corre 7:05. Entre el
 * vencimiento real y esa hora, la propiedad sigue con featured:true y seguiria
 * mostrandose arriba y con la chapa DESTACADA. Quien esta vencido lo decide la
 * FECHA, no el cron: el cron solo limpia.
 *
 * Vive aca y no en app.js porque propiedad.html es publica y NO carga app.js.
 * Si cada una tuviera su propia version, la web publica y el panel podrian
 * discrepar sobre que esta destacado.
 * ==========================================================================*/

window.parseFeaturedDate = function (v) {
  if (!v) return null;
  // Puede venir como ISO (lo que escribe la Cloud Function) o como Timestamp de
  // Firestore si algun dia se migra el campo.
  if (typeof v === "object" && typeof v.toMillis === "function") {
    return new Date(v.toMillis());
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
};

window.isEffectivelyFeatured = function (p) {
  if (!p || p.featured !== true) return false;
  if ((p.status || "available") !== "available") return false;
  const hasta = window.parseFeaturedDate(p.featuredHasta);
  return hasta !== null && hasta.getTime() > Date.now();
};

/** Dias enteros que faltan para que venza. Devuelve 0 si ya vencio. */
window.diasDeDestacado = function (p) {
  const hasta = window.parseFeaturedDate(p && p.featuredHasta);
  if (!hasta) return 0;
  return Math.max(0, Math.ceil((hasta.getTime() - Date.now()) / 86400000));
};
