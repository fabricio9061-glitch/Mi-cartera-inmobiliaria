/**
 * MALAVE — Integración con Mercado Libre
 * Cloud Functions (Firebase, 2da generación)
 *
 * Piezas:
 *  1) iniciarAuthML          -> abrís esta URL UNA vez para conectar tu cuenta de ML.
 *  2) callbackML             -> Mercado Libre vuelve acá con el código; guardamos los tokens.
 *  3) publicarEnML           -> se dispara al crear una propiedad y la publica en ML.
 *  3b) sincronizarEdicionML  -> al editar: actualiza el aviso y espeja el ESTADO
 *                               (Disponible→activo, Reservada→pausado, Vendida/Alquilada/
 *                               Archivada→cerrado). Si la publicación había fallado y la
 *                               propiedad se edita, REINTENTA publicar sola.
 *  3c) cerrarMLAlBorrar      -> al borrar una propiedad, cierra su aviso en ML
 *                               (antes quedaban avisos huérfanos publicados para siempre).
 *  5) notificarNuevoUsuario  -> cuando alguien se registra, le avisa al admin
 *                               (campanita + push FCM) que hay una cuenta para aprobar.
 *
 * Los tokens se guardan en Firestore: ml_config/tokens
 * Cada acción contra ML deja rastro en la colección ml_logs.
 */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
// La API v2 no tiene triggers de Auth (onCreate/onDelete de usuarios): se usan
// los de v1, que conviven sin problema con las funciones v2 de este archivo.
const functionsV1 = require("firebase-functions/v1");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();

// =====================================================================
// CRM — Chequeo de teléfono duplicado entre clientes de TODOS los agentes.
// Se ejecuta en el backend para poder ver clientes de otros agentes sin
// exponer sus datos al frontend (solo devuelve nombre del agente y del cliente).
// =====================================================================
function normalizarTel(raw) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("598")) d = d.slice(3);
  d = d.replace(/^0+/, "");
  return d ? "+598" + d : "";
}

exports.checkClientPhone = onCall(async (request) => {
  const phone = normalizarTel(request.data && request.data.phone);
  const uid = request.auth && request.auth.uid;
  const excludeId = (request.data && request.data.excludeId) || null;
  if (!phone || !uid) return { exists: false };
  const snap = await admin.firestore().collection("clients").get();
  for (const doc of snap.docs) {
    if (doc.id === excludeId) continue;
    const c = doc.data();
    if (normalizarTel(c.phone) === phone) {
      return {
        exists: true,
        isOwn: c.ownerId === uid,
        ownerName: c.ownerName || "otro agente",
        clientName: c.name || "un cliente",
      };
    }
  }
  return { exists: false };
});
const db = admin.firestore();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// ---- Configuración (viene del archivo .env) ----
const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;
const SITE = process.env.ML_SITE || "MLU";
const AUTH_DOMAIN = process.env.ML_AUTH_DOMAIN || "https://auth.mercadolibre.com.uy";
const CAT_SALE = process.env.ML_CAT_SALE || "";
const CAT_RENT = process.env.ML_CAT_RENT || "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "fabricio9061@gmail.com").toLowerCase();

// ===== Dirección (CEO y COO) =====
// Espejo de rangos.js del lado del navegador. Va duplicado a propósito: las
// Functions no comparten bundle con el front, y bajar el permiso a mano acá es
// preferible a que el backend confíe en algo que dice el cliente.
//
// OJO con la distinción, que es la que evita romper los avisos: ADMIN_EMAIL se
// usa para DOS cosas distintas en este archivo. Como PERMISO (quién puede hacer
// algo) pasa a ser Dirección. Como DESTINATARIO (a quién le avisamos de un
// retiro o de un alta) sigue siendo el CEO y sólo el CEO: si eso se ampliara,
// el sistema dejaría de saber a quién mandarle la notificación.
const RANGOS_DIRECCION = ["ceo", "coo"];

/** ¿El que llama es Dirección? Por correo (CEO) o por rango en su perfil. */
async function esDireccion(uid, email) {
  if (String(email || "").toLowerCase() === ADMIN_EMAIL) return true;
  if (!uid) return false;
  try {
    const s = await db.doc(`users/${uid}`).get();
    const d = s.exists ? s.data() : null;
    if (!d || d.status !== "approved") return false;
    return RANGOS_DIRECCION.includes(String(d.rank || ""));
  } catch (e) {
    // Ante la duda, NO se concede: un error de lectura no puede volverse un permiso.
    logger.warn("esDireccion: no se pudo leer el perfil", e);
    return false;
  }
}
// Datos de la inmobiliaria que se muestran como contacto en los avisos de ML.
const NOMBRE_INMOBILIARIA = process.env.ML_NOMBRE_INMOBILIARIA || "Inmobiliaria Malave";
const EMAIL_INMOBILIARIA = process.env.ML_EMAIL_INMOBILIARIA || "inmobiliariamalave@gmail.com";

const API = "https://api.mercadolibre.com";
const TOKENS_DOC = db.collection("ml_config").doc("tokens");

// =====================================================================
// Bitácora — cada acción contra ML queda registrada en ml_logs para poder
// auditar qué pasó con cada propiedad sin bucear en los logs de Cloud Functions.
// =====================================================================
async function registrarLog(propertyId, accion, ok, detalle) {
  try {
    await db.collection("ml_logs").add({
      propertyId: propertyId || "",
      accion,
      ok: !!ok,
      detalle: String(detalle || "").slice(0, 800),
      at: new Date().toISOString(),
    });
  } catch (e) { /* la bitácora nunca debe tirar el flujo principal */ }
}

// Resume el error crudo de ML en una frase legible para mostrar al agente.
function resumirErrorML(detail) {
  if (!detail) return "Error desconocido.";
  if (typeof detail === "string") return detail.slice(0, 300);
  const causas = Array.isArray(detail.cause)
    ? detail.cause.map((c) => c.message || c.code).filter(Boolean)
    : [];
  const msg = [detail.message, ...causas].filter(Boolean).join(" · ");
  return (msg || JSON.stringify(detail)).slice(0, 300);
}

// =====================================================================
// Admin — se busca UNA vez (y se cachea) el perfil del administrador para
// poder mandarle notificaciones (campanita + push FCM).
// =====================================================================
let _adminCache = { at: 0, data: null };
async function getAdminUser() {
  if (_adminCache.data && Date.now() - _adminCache.at < 5 * 60 * 1000) return _adminCache.data;
  let data = null;
  try {
    const q = await db.collection("users").where("email", "==", ADMIN_EMAIL).limit(1).get();
    if (!q.empty) data = { uid: q.docs[0].id, ...q.docs[0].data() };
    if (!data) {
      // Respaldo por si el email quedó guardado con otra capitalización.
      const all = await db.collection("users").get();
      const d = all.docs.find((x) => String(x.data().email || "").toLowerCase() === ADMIN_EMAIL);
      if (d) data = { uid: d.id, ...d.data() };
    }
  } catch (e) {
    logger.warn("No se pudo buscar al admin:", e.message);
  }
  if (data) _adminCache = { at: Date.now(), data };
  else logger.warn(`No se encontró al admin (${ADMIN_EMAIL}) en la colección users.`);
  return data;
}

/* ============================================================================
   DESTINATARIOS DE DIRECCIÓN (CEO + COO)
   ----------------------------------------------------------------------------
   getAdminUser() de arriba devuelve UN usuario y hay 16 lugares que lo usan así
   (`crearNotificacion(adm, ...)`). Cambiarlo para devolver varios rompería los
   16 en silencio: crearNotificacion recibiría un arreglo donde espera un objeto
   y escribiría documentos inválidos, sin que nadie se entere hasta notar que no
   llega nada. Por eso NO se toca y se agrega esto al lado.

   Cada aviso se migra de a uno cambiando `crearNotificacion(adm, ...)` por
   `notificarDireccion(...)`. Lo que no se migra sigue funcionando igual.
   ========================================================================== */
let _dirCache = { at: 0, data: null };
const RANGOS_QUE_RECIBEN = ["ceo", "coo"];

/** CEO y COO aprobados. Nunca devuelve vacío si existe el admin por correo. */
async function getDireccion() {
  if (_dirCache.data && Date.now() - _dirCache.at < 5 * 60 * 1000) return _dirCache.data;
  const porUid = new Map();
  try {
    const q = await db.collection("users").where("rank", "in", RANGOS_QUE_RECIBEN).get();
    q.docs.forEach((d) => {
      const u = d.data();
      if (u.status === "approved") porUid.set(d.id, { uid: d.id, ...u });
    });
  } catch (e) {
    logger.warn("getDireccion: no se pudo consultar por rango:", e.message);
  }
  // RED DE SEGURIDAD: el CEO va SIEMPRE, aunque su documento no tenga el rango
  // cargado o la consulta de arriba haya fallado. Un error acá no puede dejar al
  // sistema sin avisarle a nadie.
  const adm = await getAdminUser();
  if (adm && !porUid.has(adm.uid)) porUid.set(adm.uid, adm);

  const lista = Array.from(porUid.values());
  if (lista.length) _dirCache = { at: Date.now(), data: lista };
  else logger.error("getDireccion: no se encontró NINGÚN destinatario de Dirección.");
  return lista;
}

/** Crea la notificación para cada uno de Dirección. Un documento por persona,
    así cada uno marca leído por su cuenta sin apagarle el aviso al otro. */
async function notificarDireccion(datos, push, opts = {}) {
  const destinos = await getDireccion();
  if (!destinos.length) return false;
  for (const u of destinos) {
    // 'excluir' evita avisarle a quien generó el hecho: no tiene sentido que te
    // llegue una notificación de algo que acabás de hacer vos.
    if (opts.excluir && u.uid === opts.excluir) continue;
    try {
      await crearNotificacion(u, datos, push);
    } catch (e) {
      // Que le falle a uno no puede impedir que le llegue al otro.
      logger.warn(`notificarDireccion: falló para ${u.uid}:`, e.message);
    }
  }
  return true;
}

// Crea una notificación en la campanita (colección notifications) y, si hay
// token FCM, manda también un push. Nunca tira error hacia afuera.
//
// 'idUnico' (opcional) hace la creación IDEMPOTENTE: en vez de .add() -que genera
// un id nuevo en cada llamada- se usa .doc(id).create(), que falla si el documento
// ya existe. Sirve para los avisos que pueden dispararse dos veces por el mismo
// hecho (reintentos de Cloud Functions, webhooks repetidos de un portal).
//
// Importante: si el documento ya existía NO se manda el push. Sin ese corte
// tendrías una sola campanita pero dos push en el teléfono, que es peor.
//
// Los llamadores que no pasan 'idUnico' se comportan exactamente igual que antes.
async function crearNotificacion(destino, campos, push, idUnico) {
  if (!destino || !destino.uid) return;
  const doc = {
    ownerId: destino.uid,
    read: false,
    createdAt: new Date().toISOString(),
    ...campos,
  };
  if (idUnico) {
    try {
      await db.collection("notifications").doc(idUnico).create(doc);
    } catch (e) {
      // ALREADY_EXISTS (código 6) = entrega repetida del mismo hecho. No es un
      // error: es exactamente lo que queremos frenar. Se corta acá, sin push.
      if (e && (e.code === 6 || String(e.message).includes("ALREADY_EXISTS"))) {
        logger.info(`crearNotificacion: duplicado ignorado (${idUnico}).`);
        return;
      }
      logger.warn("No se pudo crear la notificación:", e.message);
      return;
    }
  } else {
    try {
      await db.collection("notifications").add(doc);
    } catch (e) { logger.warn("No se pudo crear la notificación:", e.message); }
  }
  if (push && destino.fcmToken) {
    try {
      await admin.messaging().send({
        token: destino.fcmToken,
        notification: { title: push.title, body: push.body },
        data: {
          type: campos.type || "info",
          // El service worker necesita estos datos para armar la notificación
          // cuando la app está CERRADA: en segundo plano no tiene acceso al
          // bloque 'notification', solo a 'data'.
          title: String(push.title || ""),
          body: String(push.body || ""),
          propertyId: String(campos.propertyId || ""),
        },
        // Sin 'webpush.headers.Urgency: high' los navegadores pueden retrasar o
        // directamente descartar el push cuando la pestaña no está activa. Es la
        // causa habitual de que solo lleguen con la app abierta.
        webpush: {
          headers: { Urgency: "high", TTL: "86400" },
          notification: {
            title: push.title,
            body: push.body,
            icon: "/icon192.png",
            badge: "/icon192.png",
            requireInteraction: false,
          },
          fcmOptions: { link: "https://malaveinmobiliaria.com/index.html" },
        },
        android: { priority: "high" },
        apns: { headers: { "apns-priority": "10" } },
      });
    } catch (e) { logger.warn("No se pudo enviar el push FCM:", e.message); }
  }
}

// Avisa de un error de Mercado Libre al agente dueño de la propiedad y al admin.
async function notificarErrorML(p, propertyId, titulo, resumen) {
  const texto = `${titulo}: ${resumen}`;
  const aviso = {
    type: "ml_error",
    propertyId: propertyId,
    propertyTitle: p.title || "Propiedad",
    userName: "Mercado Libre",
    userPhoto: null,
    text: texto,
  };
  const push = { title: "⚠️ Mercado Libre", body: `${p.title || "Propiedad"} — ${titulo}` };
  const destinos = [];
  if (p.ownerId) {
    try {
      const u = await db.doc(`users/${p.ownerId}`).get();
      if (u.exists) destinos.push({ uid: u.id, fcmToken: u.data().fcmToken });
    } catch (e) { /* sin perfil, solo admin */ }
  }
  const adm = await getAdminUser();
  if (adm && !destinos.some((d) => d.uid === adm.uid)) destinos.push(adm);
  for (const d of destinos) await crearNotificacion(d, aviso, push);
}

// =====================================================================
// WEBHOOK DE NOTIFICACIONES DE MERCADO LIBRE
// Registrá esta URL en https://developers.mercadolibre.com.uy/devcenter
// (tu aplicación -> editar -> campo "Notificaciones callbacks URL"):
//   https://us-central1-mi-cartera-inmobiliaria.cloudfunctions.net/mlNotificaciones
// Tópicos a tildar: "questions" y los de leads de inmuebles (vis_leads / leads).
// ML exige HTTP 200 en menos de 500 ms o desactiva los tópicos: acá SOLO se
// guarda el evento y se responde; el trigger de abajo hace el trabajo pesado.
// =====================================================================
exports.mlNotificaciones = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") { res.status(200).send("mlNotificaciones OK"); return; }
    const ev = req.body || {};
    const topic = String(ev.topic || "");
    const resource = String(ev.resource || "");
    if (!resource || !["questions", "vis_leads", "leads", "messages"].some((t) => topic.startsWith(t))) {
      res.status(200).send("ignorado"); return;
    }
    // Dedupe por id determinístico: los reintentos de ML no crean eventos nuevos.
    const evId = (topic + "_" + resource).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 400);
    try {
      await db.collection("mlEventos").doc(evId).create({
        topic, resource, mlUserId: ev.user_id || null,
        recibido: new Date().toISOString(), estado: "pendiente",
      });
    } catch (e) { /* ya existía: reintento de ML, se ignora */ }
    res.status(200).send("OK");
  } catch (e) {
    logger.error("[mlNotificaciones]", e.message);
    res.status(200).send("error registrado");
  }
});

// Procesa cada evento guardado: resuelve el recurso en la API de ML, encuentra la
// propiedad por su aviso y le crea la notificación (app + push) al agente dueño.
exports.procesarEventoML = onDocumentCreated("mlEventos/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const ev = snap.data() || {};
  const topic = String(ev.topic || ""), resource = String(ev.resource || "");

  // GUARDIA DE ENTRADA. Los triggers de Firestore son "al menos una vez": la misma
  // creación puede entregarse dos veces y antes eso significaba dos consultas a la
  // API de ML y dos notificaciones por destinatario.
  //
  // 'event.data' es la foto del documento AL CREARSE, así que mirar ev.estado no
  // sirve: en la segunda entrega también diría "pendiente". Hay que releerlo, y
  // hacerlo dentro de una transacción para que dos entregas simultáneas no pasen
  // las dos.
  //
  // Contrapartida asumida: si la función se cae de forma dura (timeout, OOM) el
  // evento queda en "procesando" y ningún reintento lo retoma. Queda visible en
  // mlEventos para reprocesarlo a mano. Es preferible a seguir duplicando.
  try {
    const tomado = await db.runTransaction(async (tx) => {
      const d = await tx.get(snap.ref);
      if (!d.exists) return false;
      const est = String(d.data().estado || "pendiente");
      if (est !== "pendiente") return false;
      tx.update(snap.ref, { estado: "procesando", tomadoAt: new Date().toISOString() });
      return true;
    });
    if (!tomado) {
      logger.info(`[procesarEventoML] entrega repetida ignorada: ${topic} ${resource}`);
      return;
    }
  } catch (e) {
    logger.warn("[procesarEventoML] no se pudo reclamar el evento:", e.message);
    return;
  }

  try {
    const token = await getValidToken();
    const headers = { Authorization: `Bearer ${token}` };

    let itemId = null, texto = "", titulo = "";
    if (topic.startsWith("questions")) {
      const q = (await axios.get(`${API}${resource}`, { headers })).data || {};
      itemId = q.item_id;
      texto = q.text || "";
      titulo = "Nueva pregunta en Mercado Libre";
    } else {
      // Leads de inmuebles ("persona interesada"). El detalle del contacto exige el
      // permiso de inmobiliaria (el mismo del 403 de métricas): si ML lo niega,
      // igual se avisa al agente, sin el detalle.
      titulo = "Persona interesada en Mercado Libre";
      try {
        const l = (await axios.get(`${API}${resource}`, { headers })).data || {};
        itemId = l.item_id || (l.item && l.item.id) || null;
        const quien = [l.name || l.contact_name, l.phone || l.contact_phone, l.email || l.contact_email]
          .filter(Boolean).join(" · ");
        if (quien) texto = `Contacto: ${quien}`;
      } catch (e) { /* sin permiso todavía: se notifica sin detalle */ }
    }
    if (!itemId) { const m = resource.match(/MLU\d+/); if (m) itemId = m[0]; }
    if (!itemId) { await snap.ref.update({ estado: "sin_item" }); return; }

    const qs = await db.collection("properties").where("mlItemId", "==", itemId).limit(1).get();
    if (qs.empty) { await snap.ref.update({ estado: "sin_propiedad", itemId }); return; }
    const pDoc = qs.docs[0], p = pDoc.data();

    const aviso = {
      type: "ml_lead",
      propertyId: pDoc.id,
      propertyTitle: p.title || "Propiedad",
      userName: "Mercado Libre",
      userPhoto: null,
      text: `${titulo}${texto ? " — " + texto : ""}. Respondé desde la cuenta de Mercado Libre.`,
    };
    const push = { title: "📩 " + titulo, body: `${p.title || "Propiedad"}${texto ? " — " + texto.slice(0, 90) : ""}` };
    const destinos = [];
    if (p.ownerId) {
      try { const u = await db.doc(`users/${p.ownerId}`).get(); if (u.exists) destinos.push({ uid: u.id, fcmToken: u.data().fcmToken }); } catch (e) {}
    }
    // La consulta va al agente dueño Y a la Dirección (CEO y COO), que supervisan
    // que nadie quede sin responder. Antes acá solo se sumaba getAdminUser(), o sea
    // el CEO: por eso al COO no le llegaban las consultas de los demás agentes.
    for (const u of await getDireccion()) {
      if (!destinos.some((d) => d.uid === u.uid)) destinos.push(u);
    }
    // Segunda red, independiente de la guardia de arriba: el id de la notificación
    // se deriva del RECURSO de ML y del destinatario. Aunque este bloque llegara a
    // correr dos veces, el segundo intento choca contra un documento existente y
    // no crea nada ni manda push.
    const claveRecurso = ("ml_" + resource).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
    for (const d of destinos) {
      await crearNotificacion(d, aviso, push, `${claveRecurso}__${d.uid}`);
    }
    await snap.ref.update({ estado: "procesado", itemId, propertyId: pDoc.id, agente: p.ownerId || null });
    logger.info(`[procesarEventoML] ${topic} -> ${itemId} -> "${p.title || pDoc.id}" (${destinos.length} destinos)`);
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    logger.error("[procesarEventoML]", detail);
    try { await snap.ref.update({ estado: "error", error: String(detail).slice(0, 500) }); } catch (_e) {}
  }
});

// =====================================================================
// 1) INICIAR AUTORIZACIÓN  — abrí esta URL en el navegador una sola vez
// =====================================================================
exports.iniciarAuthML = onRequest(async (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    res.status(500).send("Faltan credenciales (ML_CLIENT_ID / ML_REDIRECT_URI) en el archivo .env");
    return;
  }
  const url = `${AUTH_DOMAIN}/authorization?response_type=code` +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

// =====================================================================
// 2) CALLBACK  — Mercado Libre vuelve acá con ?code=...; guardamos tokens
// =====================================================================
exports.callbackML = onRequest(async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send("No llegó el código de autorización.");
    return;
  }
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: String(code),
      redirect_uri: REDIRECT_URI,
    });
    const r = await axios.post(`${API}/oauth/token`, body.toString(), {
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    });
    const d = r.data;
    await TOKENS_DOC.set({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      user_id: d.user_id,
      expires_at: Date.now() + (d.expires_in - 120) * 1000, // margen de 2 min
      updated_at: new Date().toISOString(),
    });
    logger.info("Tokens de Mercado Libre guardados. user_id:", d.user_id);
    res.send("<h2>✅ Cuenta de Mercado Libre conectada correctamente.</h2><p>Ya podés cerrar esta pestaña.</p>");
  } catch (e) {
    logger.error("Error obteniendo token:", e.response?.data || e.message);
    res.status(500).send("Error al conectar con Mercado Libre: " + JSON.stringify(e.response?.data || e.message));
  }
});

// =====================================================================
// Helper: devuelve un access_token válido (renueva si está por vencer).
//
// IMPORTANTE: el refresh_token de Mercado Libre es de UN SOLO USO. Si dos
// funciones renuevan a la vez (dos agentes publicando al mismo tiempo, o un
// trigger duplicado), ML invalida el token de una de las dos y a partir de
// ahí TODAS las publicaciones fallan con "invalid_grant" hasta reconectar la
// cuenta a mano. Por eso el refresco se serializa con un candado atómico en
// el propio documento de tokens: renueva UNO solo y los demás esperan y usan
// el token nuevo. Este era el motivo más probable de que las propiedades de
// algunos agentes "no se publicaran".
// =====================================================================
async function getValidToken() {
  const snap = await TOKENS_DOC.get();
  if (!snap.exists) throw new Error("No hay cuenta de Mercado Libre conectada. Abrí la función iniciarAuthML primero.");
  let t = snap.data();
  if (Date.now() < t.expires_at) return t.access_token; // todavía válido

  const LOCK_MS = 30000; // un candado más viejo que esto se considera colgado
  let renuevoYo = false;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(TOKENS_DOC);
    const d = s.data() || {};
    if (Date.now() < (d.expires_at || 0)) { t = d; return; }                       // otro ya renovó
    if (d.refreshing_at && Date.now() - d.refreshing_at < LOCK_MS) { t = d; return; } // otro está renovando
    tx.update(TOKENS_DOC, { refreshing_at: Date.now() });
    t = d;
    renuevoYo = true;
  });

  if (!renuevoYo) {
    // Otro proceso está renovando: esperar a que termine y usar su token.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const d = (await TOKENS_DOC.get()).data() || {};
      if (Date.now() < (d.expires_at || 0)) return d.access_token;
    }
    throw new Error("El token de Mercado Libre se está renovando; reintentá en unos segundos.");
  }

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: t.refresh_token,
    });
    const r = await axios.post(`${API}/oauth/token`, body.toString(), {
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    });
    const d = r.data;
    // set() SIN merge: pisa todo el documento y de paso limpia el candado refreshing_at.
    await TOKENS_DOC.set({
      access_token: d.access_token,
      refresh_token: d.refresh_token || t.refresh_token,
      user_id: d.user_id || t.user_id,
      expires_at: Date.now() + (d.expires_in - 120) * 1000,
      updated_at: new Date().toISOString(),
    });
    logger.info("Token de Mercado Libre renovado.");
    return d.access_token;
  } catch (e) {
    const detail = e.response?.data || e.message;
    // Liberar el candado para que el próximo intento pueda reintentar.
    try {
      await TOKENS_DOC.update({
        refreshing_at: admin.firestore.FieldValue.delete(),
        last_refresh_error: resumirErrorML(detail),
        last_refresh_error_at: new Date().toISOString(),
      });
    } catch (e2) { /* nada */ }
    logger.error("Error renovando token de ML:", JSON.stringify(detail));
    if (detail && (detail.error === "invalid_grant" || /invalid_grant/.test(JSON.stringify(detail)))) {
      throw new Error("La conexión con Mercado Libre se invalidó (invalid_grant). Volvé a conectar la cuenta abriendo la URL de iniciarAuthML.");
    }
    throw new Error("No se pudo renovar el token de Mercado Libre: " + resumirErrorML(detail));
  }
}

// =====================================================================
// DIAGNÓSTICO — abrí esta URL en el navegador para ver, en texto claro,
// por qué Mercado Libre no te deja publicar.
// =====================================================================
exports.diagnosticoML = onRequest(async (req, res) => {
  try {
    const token = await getValidToken();
    const headers = { Authorization: `Bearer ${token}` };

    const me = (await axios.get(`${API}/users/me`, { headers })).data;
    const userId = me.id;

    let addresses = [];
    try {
      addresses = (await axios.get(`${API}/users/${userId}/addresses`, { headers })).data || [];
    } catch (e) {
      addresses = [{ error: JSON.stringify(e.response?.data || e.message) }];
    }

    const list = me.status?.list || {};
    const puede = list.allow === true;
    const motivos = list.codes || [];

    const traducir = (c) => {
      const map = {
        address_pending: "Falta completar la dirección de tu cuenta (calle, número, ciudad y departamento).",
        phone_pending: "Falta verificar tu número de teléfono.",
        phone_number_pending: "Falta verificar tu número de teléfono.",
        identification_pending: "Falta validar tu identidad (documento de identidad).",
        identification_no_score: "Tu identidad necesita validación adicional.",
        identification_min_length_not_satisfied: "El número de documento cargado está incompleto.",
        rejected_by_regulations: "Tu cuenta necesita completar la validación de datos (KYC) de Mercado Libre.",
        billing_pending: "Faltan completar datos de facturación.",
        user_not_allowed_to_list_in_category:
          "Tu cuenta no está habilitada para publicar en esta categoría (puede requerir activación de Mercado Libre).",
      };
      return map[c] || c;
    };

    const motivosHtml = motivos.length
      ? motivos.map((c) => `<li><b>${c}</b><br><span style="color:#555">${traducir(c)}</span></li>`).join("")
      : '<li class="ok">Mercado Libre no reporta ningún impedimento explícito.</li>';

    const dirHtml =
      Array.isArray(addresses) && addresses.length
        ? addresses
            .map((a) => {
              if (a.error) return `<li class="no">Error al leer direcciones: ${a.error}</li>`;
              return `<li>
                Calle: <b>${a.address_line || a.street_name || "(vacío)"}</b><br>
                Ciudad: <b>${a.city?.name || "(vacío)"}</b><br>
                Estado/Depto: <b>${a.state?.name || "(vacío)"}</b><br>
                Código postal: <b>${a.zip_code || "(vacío)"}</b>
              </li>`;
            })
            .join("")
        : '<li class="no">Tu cuenta NO tiene ninguna dirección guardada.</li>';

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;line-height:1.5;color:#222}
      h1{font-size:20px}h2{font-size:16px;margin-top:24px}li{margin:8px 0}
      .ok{color:#0a7a0a;font-weight:bold}.no{color:#b00020;font-weight:bold}
      .box{background:#f6f6f6;border-radius:8px;padding:12px 16px}
      pre{white-space:pre-wrap;font-size:12px}</style></head><body>
      <h1>Diagnóstico de tu cuenta de Mercado Libre</h1>
      <div class="box">
        <p>Cuenta: <b>${me.nickname || ""}</b> (ID ${userId})</p>
        <p>¿Puede publicar avisos?: <span class="${puede ? "ok" : "no"}">${puede ? "SÍ ✅" : "NO ❌"}</span></p>
      </div>
      <h2>Motivos por los que Mercado Libre bloquea la publicación</h2>
      <ul>${motivosHtml}</ul>
      <h2>Direcciones guardadas en tu cuenta</h2>
      <ul>${dirHtml}</ul>
      <h2>Estado general (técnico)</h2>
      <div class="box"><pre>${JSON.stringify(me.status || {}, null, 2)}</pre></div>
      </body></html>`);
  } catch (e) {
    res.status(500).send("Error en el diagnóstico: " + JSON.stringify(e.response?.data || e.message));
  }
});

// Diagnóstico: devuelve la ficha (atributos) de la categoría de un tipo de inmueble,
// para alinear el formulario sin depender de publicaciones. Abrí en el navegador:
//   /fichaCategoriaML?tipo=apartamento           (op opcional: venta|alquiler)
//   /fichaCategoriaML?tipo=local&op=alquiler
//   /fichaCategoriaML?cat=MLU1472                (categoría directa por ID)
exports.fichaCategoriaML = onRequest(async (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  try {
    const token = await getValidToken();
    const headers = { Authorization: `Bearer ${token}` };
    let catId = req.query.cat;
    const tipo = req.query.tipo;
    const op = req.query.op === "alquiler" ? "rent" : "sale";
    if (!catId && tipo) {
      catId = await getRealEstateCategory({ realEstateType: tipo, type: op }, token);
    }
    if (!catId) {
      res.status(400).send("Pasá ?tipo=apartamento (o ?cat=MLU1472).\nTipos: casa, apartamento, terreno, local, oficina, galpon, campo.\nOpcional ?op=venta (o alquiler).");
      return;
    }
    const cat = (await axios.get(`${API}/categories/${catId}`, { headers })).data || {};
    const attrs = (await axios.get(`${API}/categories/${catId}/attributes`, { headers })).data || [];
    const linea = attrs.map((a) => {
      const r = (a.tags && (a.tags.required ? "*" : (a.tags.conditional_required ? "?" : ""))) || "";
      const vals = (a.value_type === "list" && Array.isArray(a.values) && a.values.length) ? `{${a.values.map((v) => v.name).join("/")}}` : "";
      return `${a.id}=${a.name}[${a.value_type}]${r}${vals}`;
    }).join(" | ");
    res.status(200).send(`[CAT ${catId}] ${cat.name || ""} (${attrs.length})\n\n${linea}`);
  } catch (e) {
    res.status(500).send("Error: " + (e.response ? JSON.stringify(e.response.data) : e.message));
  }
});

// =====================================================================
// Helper: arma el aviso de Mercado Libre a partir de la propiedad
// =====================================================================
// Busca la categoría correcta dentro de Inmuebles (MLU1459), navegando el árbol
// hasta una categoría hoja, según el tipo de propiedad y la operación.
async function getRealEstateCategory(p, token) {
  // El tipo de inmueble real (casa, apartamento, terreno...). Para propiedades viejas
  // sin este dato, lo aproximamos desde el padrón (PH suele ser apartamento).
  const ret = p.realEstateType || (p.propertyType === "ph" ? "apartamento" : "casa");
  // Mapa fijo de categorías de Inmuebles (MLU1459), verificado contra el árbol de ML.
  // Lo usamos como punto de partida (determinístico, sin depender del nombre/predictor);
  // después igual bajamos hasta la hoja. Los tipos desconocidos caen a la navegación.
  const CAT_MLU = {
    casa: "MLU1466",        // Casas
    apartamento: "MLU1472", // Apartamentos
    terreno: "MLU1493",     // Terrenos y Lotes
    local: "MLU1478",       // Locales
    oficina: "MLU50633",    // Oficinas
    galpon: "MLU455466",    // Depósitos y Galpones
    campo: "MLU1496",       // Campos
    chacra: "MLU50547",     // Chacras
    cochera: "MLU50636",    // Cocheras
    habitacion: "MLU211280" // Habitaciones
  };
  const typeMap = { casa: "casas", apartamento: "apartamento", terreno: "terreno", local: "local", oficina: "oficina", galpon: "galp", campo: "campo" };
  const want = typeMap[ret] || "casas";
  const opWord = p.type === "rent" ? "alquiler" : "venta";
  // Evitamos categorías de emprendimientos/proyectos: exigen atributos de desarrollo
  // (DEVELOPMENT_NAME, UNIT_NAME, MODEL_NAME) que no aplican a una propiedad individual.
  const avoid = ["emprendimiento", "proyecto", "pozo", "desarrollo", "loteo"];
  const isAvoided = (name) => avoid.some((w) => (name || "").toLowerCase().includes(w));
  const headers = { Authorization: `Bearer ${token}` };
  try {
    // Punto de partida: el mapa fijo si el tipo es conocido; si no, navegar desde MLU1459.
    let catId, catName;
    if (CAT_MLU[ret]) {
      catId = CAT_MLU[ret];
      catName = ret;
    } else {
      const root = await axios.get(`${API}/categories/MLU1459`, { headers });
      const children = (root.data.children_categories || []).filter((c) => !isAvoided(c.name));
      const cat =
        children.find((c) => c.name.toLowerCase().includes(want)) ||
        children.find((c) => c.name.toLowerCase().includes("casas")) ||
        children[0];
      if (!cat) return null;
      catId = cat.id;
      catName = cat.name;
    }
    // IMPORTANTE: ML exige publicar en una categoría HOJA. Bajamos hasta una sin
    // subcategorías, eligiendo la de la operación (venta/alquiler) y esquivando
    // emprendimientos. Para Apartamentos/Casas (ya son hoja) el bucle no hace nada;
    // para Locales/Oficinas/Terrenos baja al nivel correcto (p. ej. MLU1478 no es hoja).
    for (let i = 0; i < 6; i++) {
      const cr = await axios.get(`${API}/categories/${catId}`, { headers });
      const sub = (cr.data.children_categories || []).filter((c) => !isAvoided(c.name));
      if (sub.length === 0) break;
      const next = sub.find((c) => c.name.toLowerCase().includes(opWord)) || sub[0];
      catId = next.id;
      catName = next.name;
    }
    logger.info(`Categoría ML elegida: ${catId} (${catName}) para ${ret}/${opWord}`);
    return catId;
  } catch (e) {
    logger.warn("Error obteniendo categoría de inmuebles:", e.response?.data || e.message);
    return null;
  }
}

// Condición que acepta la categoría (los inmuebles suelen exigir "new").
async function pickCondition(categoryId, token) {
  try {
    const r = await axios.get(`${API}/categories/${categoryId}`, { headers: { Authorization: `Bearer ${token}` } });
    const conds = (r.data.settings && r.data.settings.item_conditions) || [];
    if (conds.includes("new")) return "new";
    if (conds.length) return conds[0];
  } catch (e) { /* usar el valor por defecto */ }
  return "new";
}

// =====================================================================
// Tipo de publicación — "free" tiene CUPO limitado y no existe en todas las
// categorías ("Listing type free is not available for category MLU1467").
// Se consulta a ML qué tipos tiene disponibles ESTA cuenta en ESTA categoría
// y se elige el primero según el orden de preferencia (configurable en .env
// con ML_LISTING_TYPE, ej: "free,bronze,silver"). Ojo: los tipos pagos pueden
// tener costo por aviso; el tipo usado queda guardado en mlListingType.
// =====================================================================
// =====================================================================
// Tipo de publicación.
// REGLA DE LA CASA: la publicación AUTOMÁTICA usa SOLO los tipos permitidos
// en ML_LISTING_TYPE del .env (por defecto "silver": la cuenta inmobiliaria
// no tiene avisos gratis, así que se publica directo en Plata). El agente
// puede cambiar el tipo a mano desde el selector del botón de Mercado Libre.
// =====================================================================
// Tipos que ofrece ESTA cuenta inmobiliaria: Plata (silver), Oro (gold) y Oro
// Premium (gold_premium). NO tiene avisos gratis ni Bronce, así que esos quedan
// fuera: la publicación automática usa "silver" (Plata) por defecto. Igual se
// consulta a ML qué hay disponible en cada categoría; esta lista es el universo
// permitido y el orden de preferencia. Configurable con ML_LISTING_TYPE del .env.
const TIPOS_AVISO_VALIDOS = ["silver", "gold", "gold_premium"];
const LISTING_TYPE_PREF = (process.env.ML_LISTING_TYPE || "silver")
  .split(",").map((s) => s.trim()).filter((s) => TIPOS_AVISO_VALIDOS.includes(s));
const _ltCache = new Map();   // categoryId -> { at, ids } disponibles de la cuenta (cache 10 min)
const _ltVetados = new Map(); // categoryId -> Map(tipo -> timestamp) de tipos rechazados por ML

// Marca un tipo como rechazado por ML para esa categoría durante 6 horas
// (p. ej. "free" en MLU1467) para no volver a tropezar con él en cada publicación.
function vetarListingType(categoryId, tipo) {
  if (!_ltVetados.has(categoryId)) _ltVetados.set(categoryId, new Map());
  _ltVetados.get(categoryId).set(tipo, Date.now());
}
function estaVetado(categoryId, tipo) {
  const ts = _ltVetados.get(categoryId) && _ltVetados.get(categoryId).get(tipo);
  return !!(ts && Date.now() - ts < 6 * 60 * 60 * 1000);
}

// Tipos que la CUENTA tiene disponibles en esta categoría según ML, excluyendo
// cupo agotado (remaining_listings = 0), ordenados de barato a caro. Esta lista
// también alimenta el selector manual del modal de Mercado Libre.
async function listingTypesCuenta(categoryId, token) {
  const c = _ltCache.get(categoryId);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.ids;
  let ids = [];
  try {
    const t = (await TOKENS_DOC.get()).data() || {};
    if (t.user_id) {
      const r = await axios.get(`${API}/users/${t.user_id}/available_listing_types?category_id=${categoryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const lista = (r.data && r.data.available) || (Array.isArray(r.data) ? r.data : []);
      ids = lista
        .filter((x) => x && x.id && x.remaining_listings !== 0) // 0 = cupo agotado; null = sin límite informado
        .map((x) => x.id);
      ids = [...TIPOS_AVISO_VALIDOS.filter((t2) => ids.includes(t2)), ...ids.filter((t2) => !TIPOS_AVISO_VALIDOS.includes(t2))];
      logger.info(`Listing types de la cuenta en ${categoryId}: ${ids.join(", ") || "ninguno informado"}`);
    }
  } catch (e) {
    logger.warn(`No se pudieron consultar los listing types de ${categoryId}:`, e.response?.data || e.message);
  }
  _ltCache.set(categoryId, { at: Date.now(), ids });
  return ids;
}

// Candidatos para la publicación AUTOMÁTICA: únicamente los permitidos en
// ML_LISTING_TYPE (primero los confirmados por la cuenta), sin los vetados.
// Un tipo pago jamás entra acá salvo que lo agregues vos al .env.
async function listingTypesDisponibles(categoryId, token) {
  const cuenta = await listingTypesCuenta(categoryId, token);
  const orden = [
    ...LISTING_TYPE_PREF.filter((t) => cuenta.includes(t)),
    ...LISTING_TYPE_PREF.filter((t) => !cuenta.includes(t)),
  ];
  const sinVetados = orden.filter((t) => !estaVetado(categoryId, t));
  return [...new Set(sinVetados.length ? sinVetados : orden)];
}

async function pickListingType(categoryId, token) {
  return (await listingTypesDisponibles(categoryId, token))[0] || "silver";
}

// Valor razonable para un atributo obligatorio que no mapeamos explícitamente.
function defaultAttrValue(a, p) {
  const id = a.id;
  const numMap = {
    BEDROOMS: p.bedrooms, ROOMS: p.bedrooms,
    FULL_BATHROOMS: p.bathrooms, BATHROOMS: p.bathrooms,
    PARKING_LOTS: p.garage === "yes" ? 1 : 0,
    TOTAL_AREA: p.totalArea, COVERED_AREA: p.builtArea, MAINTENANCE_FEE: p.commonExpenses,
  };
  if (id in numMap && numMap[id] != null && numMap[id] !== "") {
    if (a.value_type === "number_unit") {
      let unit = (a.allowed_units && a.allowed_units[0] && a.allowed_units[0].id) || a.default_unit || "";
      // MAINTENANCE_FEE: unidad = moneda de la propiedad (USD/UYU), no la primera unidad.
      if (id === "MAINTENANCE_FEE" && a.allowed_units && a.allowed_units.length) {
        const wanted = (p && p.currency === "UYU") ? "UYU" : "USD";
        const match = a.allowed_units.find((u) => u.id === wanted || norm(u.name) === norm(wanted));
        if (match) unit = match.id;
      }
      const num = Number(numMap[id]);
      // value_name "80 m²" en vez de value_struct: cuando la unidad viene vacía,
      // ML descarta el atributo ("value_id and value_name are null...").
      return { id, value_name: unit ? `${num} ${unit}` : String(num) };
    }
    return { id, value_name: String(numMap[id]) };
  }
  // Atributo de lista: preferir un valor NEUTRO (Otro / No informado / A definir)
  // antes que inventar el primero de la lista (p. ej. LAND_ACCESS no debería
  // afirmar "Asfalto" si el agente no lo cargó).
  if (Array.isArray(a.values) && a.values.length) {
    const neutro = a.values.find((v) => /^(otro|otra|no informado|a definir|sin definir|ninguno|ninguna)$/.test(norm(v.name)));
    return { id, value_id: (neutro || a.values[0]).id };
  }
  const vt = a.value_type;
  if (vt === "number" || vt === "number_unit") return { id, value_name: "0" };
  if (vt === "boolean") return null;
  // Texto libre (p. ej. nombres de emprendimiento/unidad cuando la categoría los pide).
  return { id, value_name: (p.title || "Consultar").slice(0, 40) };
}

// Completa los atributos OBLIGATORIOS de la categoría que falten, leyéndolos en vivo
// desde ML. Así la publicación no falla aunque la categoría pida atributos nuevos.
// (catAttrs es opcional: si buildItem ya los leyó, se reutilizan sin otra llamada.)
async function fillRequiredAttributes(categoryId, p, baseAttributes, token, catAttrs) {
  const out = baseAttributes.slice();
  const have = new Set(out.map((a) => a.id));
  try {
    const data = catAttrs || (await axios.get(`${API}/categories/${categoryId}/attributes`, { headers: { Authorization: `Bearer ${token}` } })).data;
    for (const a of data || []) {
      const tags = a.tags || {};
      if (tags.read_only || tags.fixed || tags.hidden) continue; // la categoría lo fija: no se envía
      if (!(tags.required || tags.catalog_required)) continue;
      if (have.has(a.id)) continue;
      const v = defaultAttrValue(a, p);
      if (v) { out.push(v); have.add(a.id); }
    }
  } catch (e) {
    logger.warn(`No se pudieron leer atributos de la categoría ${categoryId}:`, e.response?.data || e.message);
  }
  return out;
}

// Saca el ID de un video de YouTube desde cualquier formato de link.
// Video institucional de la agencia: se usa en ML cuando la propiedad no tiene
// uno propio (igual que en la ficha web). Mantener igual al VIDEO_DEFAULT del front.
const VIDEO_DEFAULT_ML = "https://youtube.com/shorts/KcGr0S0Yx9A";
function videoIdParaML(p) {
  return extractYouTubeId(p && p.videoUrl) || extractYouTubeId(VIDEO_DEFAULT_ML);
}
function extractYouTubeId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// La descripción se carga en un paso aparte: Mercado Libre NO la toma del POST del item.
// PUT actualiza una descripción existente (necesario para las EDICIONES); si el aviso
// todavía no tiene descripción, el PUT falla y se crea con POST.
async function setItemDescription(itemId, text, token) {
  if (!text) return;
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    await axios.put(`${API}/items/${itemId}/description`, { plain_text: text }, { headers });
    return;
  } catch (e) { /* todavía no tiene descripción: crearla */ }
  try {
    await axios.post(`${API}/items/${itemId}/description`, { plain_text: text }, { headers });
  } catch (e) {
    logger.warn(`No se pudo cargar la descripción de ${itemId}:`, e.response?.data || e.message);
  }
}

// Normaliza texto para comparar: separa camelCase, saca acentos y pasa a minúsculas.
function norm(s) {
  return String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Cada comodidad del formulario apuntando a su atributo booleano en Mercado Libre.
// Mapea la ficha técnica de la propiedad (p.ficha, con los IDs de atributos de ML)
// a los atributos del item, validando contra los atributos REALES de la categoría y
// usando el tipo de cada atributo para darle el formato correcto. Defensivo: si un
// atributo no existe en la categoría o el valor no matchea, simplemente no se manda.
// (catAttrs es opcional: si buildItem ya los leyó, se reutilizan sin otra llamada.)
async function addFeatureAttributes(categoryId, p, baseAttributes, token, catAttrs) {
  const out = baseAttributes.slice();
  const have = new Set(out.map((a) => a.id));
  const ficha = Object.assign({}, p.ficha || {});
  // HOUSE_NUMBER ("Número de la casa") se toma SOLO de Ubicación → Número: es el
  // mismo dato y no se le pide dos veces al agente. Ubicación manda incluso si un
  // resto viejo quedó en la ficha. Solo viaja si la categoría lo acepta (el filtro
  // byId de abajo se encarga de eso).
  const _nroPuerta = String((p.ubicacion && p.ubicacion.numero) || "").trim();
  if (_nroPuerta) ficha.HOUSE_NUMBER = _nroPuerta;
  if (!Object.keys(ficha).length) return out;
  let attrsData = catAttrs;
  if (!attrsData) {
    try {
      const r = await axios.get(`${API}/categories/${categoryId}/attributes`, { headers: { Authorization: `Bearer ${token}` } });
      attrsData = r.data || [];
    } catch (e) {
      logger.warn(`No se pudo leer atributos de ${categoryId}:`, e.response?.data || e.message);
      return out;
    }
  }
  const byId = {};
  attrsData.forEach((a) => { byId[a.id] = a; });

  // === DIAGNÓSTICO TEMPORAL (sacar después de revisar) ===========================
  // Imprime en los logs de Functions: (1) TODOS los atributos booleanos/lista que ML
  // acepta para esta categoría (id=nombre) y (2) los IDs de la ficha que ML NO reconoce
  // (esos son los que "no se marcan"). Con esto alineamos el formulario sin adivinar.
  try {
    const _all = attrsData.map((a) => {
      const req = (a.tags && (a.tags.required ? "*" : (a.tags.conditional_required ? "?" : ""))) || "";
      const vals = (a.value_type === "list" && Array.isArray(a.values) && a.values.length) ? `{${a.values.map((v) => v.name).join("/")}}` : "";
      return `${a.id}=${a.name}[${a.value_type}]${req}${vals}`;
    });
    logger.info(`[ATRIBUTOS ${categoryId}] (${_all.length}) ${_all.join(" | ")}`);
    const _drop = Object.keys(ficha).filter((id) => !byId[id] && !id.startsWith("IC_"));
    logger.info(`[FICHA-DESCARTADOS ${categoryId}] ${_drop.join(", ") || "(ninguno)"}`);
    // Diagnóstico por campo: qué tipo espera ML y qué valor tiene en la ficha.
    // Ayuda a ver por qué un 0 no se toma (ej: el campo es 'list', no 'number').
    const _detalle = Object.keys(ficha).filter((id) => byId[id]).map((id) => `${id}[${byId[id].value_type}]=${JSON.stringify(ficha[id])}`);
    logger.info(`[FICHA-VALORES ${categoryId}] ${_detalle.join(" | ")}`);
  } catch (_e) {}
  // ===============================================================================

  // Los ids IC_* son extras de InfoCasas cargados desde el form: no existen en ML,
  // los consume únicamente el feed (feedInfocasas). Se saltean acá a propósito.

  for (const [id, val] of Object.entries(ficha)) {
    const attr = byId[id];
    // Saltear solo si el atributo no existe, ya está, o el valor es vacío/nulo.
    // OJO: el número 0 es un valor VÁLIDO (0 cocheras, torre 0, etc.) — antes se
    // colaba en filtros tipo "!val" y no se enviaba. Acá se compara explícito
    // contra "" y null/undefined, nunca contra 0.
    if (!attr || have.has(id)) continue;
    // Si la categoría fija el atributo (lo calcula ella, o lo tiene oculto), no se
    // manda: en el mejor caso lo ignora y en el peor rechaza la publicación. Los
    // otros dos lugares del archivo que arman atributos ya hacían este chequeo;
    // este se lo había salteado.
    const _tg = attr.tags || {};
    if (_tg.read_only || _tg.fixed || _tg.hidden) continue;
    if (val === "" || val === null || val === undefined) continue;
    const vt = attr.value_type;
    if (vt === "boolean") {
      const siVal = val === true || val === "true" || val === 1;
      const noVal = val === false || val === "false" || val === 0;
      if (siVal || noVal) {
        const vlist = attr.values || [];
        if (siVal) {
          const si = vlist.find((x) => /^s[ií]$/.test(norm(x.name)));
          out.push({ id, value_id: si ? si.id : "242085" });
        } else {
          const no = vlist.find((x) => /^no$/.test(norm(x.name)));
          out.push({ id, value_id: no ? no.id : "242084" });
        }
        have.add(id);
      }
    } else if (vt === "list") {
      const t = norm(val);
      const vals = attr.values || [];
      const v = vals.find((x) => norm(x.name) === t) || vals.find((x) => norm(x.name).includes(t) || t.includes(norm(x.name)));
      if (v) { out.push({ id, value_id: v.id }); have.add(id); }
    } else if (vt === "number_unit") {
      let unit = (attr.allowed_units && attr.allowed_units[0] && attr.allowed_units[0].id) || attr.default_unit || "";
      // Gastos comunes y precio por área: la unidad es una MONEDA. Hay que usar la
      // moneda de la propiedad (USD/UYU) si la categoría la permite, no la primera unidad.
      if ((id === "MAINTENANCE_FEE" || id === "PRICE_PER_AREA_UNIT") && attr.allowed_units && attr.allowed_units.length) {
        const wanted = (p && p.currency === "UYU") ? "UYU" : "USD";
        const match = attr.allowed_units.find((u) => u.id === wanted || norm(u.name) === norm(wanted));
        if (match) unit = match.id;
      }
      const num = Number(val);
      // value_name "5 m²" en vez de value_struct: con la unidad vacía ML descartaba el
      // atributo (el caso BALCONY_AREA: "value_id and value_name are null... not sent").
      if (!isNaN(num)) { out.push({ id, value_name: unit ? `${num} ${unit}` : String(num) }); have.add(id); }
    } else if (vt === "number") {
      // Numérico puro: incluye el 0 (torre 0, apto 0, etc.). Number("") es 0, pero
      // el "" ya se filtró arriba, así que acá solo llegan valores reales.
      const num = Number(val);
      if (!isNaN(num)) { out.push({ id, value_name: String(num) }); have.add(id); }
    } else {
      out.push({ id, value_name: String(val) }); // string u otros
      have.add(id);
    }
  }
  return out;
}

// Normaliza un teléfono uruguayo a dígitos nacionales (sin +598 ni 0 inicial).
function parsePhone(raw) {
  return String(raw || "").replace(/\D/g, "").replace(/^598/, "").replace(/^0/, "");
}

// Arma el contacto del aviso. El NOMBRE de contacto es SIEMPRE la inmobiliaria
// (para que en Mercado Libre nunca aparezca el nombre del agente); el TELÉFONO,
// en cambio, es el del agente dueño, para que cada consulta le llegue a él.
async function buildSellerContact(p) {
  let tel = "";        // teléfono del agente dueño (del perfil)
  let waPerfil = "";   // whatsapp del perfil del agente
  if (p.ownerId) {
    try {
      const u = await admin.firestore().doc(`users/${p.ownerId}`).get();
      const d = u.exists ? u.data() : {};
      tel = parsePhone(d.whatsapp || d.phone); // teléfono del agente dueño
      waPerfil = parsePhone(d.whatsapp || d.phone);
    } catch (e) { logger.warn("No se pudo leer el perfil del agente:", e.message); }
  }
  if (!tel) tel = parsePhone(p.ownerWhatsapp); // respaldo si el perfil no tiene número
  // WhatsApp del aviso: el "WhatsApp de Contacto" puntual si se cargó; si no, el del perfil.
  const wa = parsePhone(p.ownerWhatsapp) || waPerfil || tel;
  const sc = {
    contact: NOMBRE_INMOBILIARIA, // SIEMPRE la inmobiliaria, nunca el agente
    area_code: "",
    phone: tel,
    country_code: "598",
    email: EMAIL_INMOBILIARIA,
  };
  // Botón de WhatsApp del aviso: Mercado Libre guarda el número de WhatsApp en
  // country_code2 / area_code2 / phone2 (con un número válido aparece el botón).
  if (wa) {
    sc.country_code2 = "598";
    sc.area_code2 = "598";
    sc.phone2 = wa;
  }
  return sc;
}

// =====================================================================
// UBICACIÓN — traduce departamento / ciudad / barrio a los IDs oficiales de
// Mercado Libre (API classified_locations) y agrega las coordenadas si existen.
//
// Clave para Montevideo: el campo "Ciudad/Barrio" del formulario guarda un
// BARRIO (Pocitos, Cordón...). Antes se mandaba como city por nombre y ML no
// lo podía resolver -> ubicación mal interpretada. Ahora: si el valor no es
// una ciudad real del departamento, se usa la ciudad homónima del departamento
// y el valor pasa a ser el barrio (neighborhood), que es lo correcto.
//
// Compatible hacia adelante: si la propiedad trae p.ubicacion
// { calle, numero, barrio, ciudad, departamento, lat, lng } (formulario con
// mapa, fase siguiente), se usa eso con prioridad. Si algo falla, cae al
// comportamiento por nombre de siempre: nunca rompe una publicación.
// =====================================================================
const _locCache = { states: null, cities: new Map(), barrios: new Map() };

async function resolveMLLocation(p, token) {
  const u = p.ubicacion || {};
  const calle = u.calle || p.direccion || "";
  const numero = u.numero || "";
  const departamento = u.departamento || p.departamento || "";
  const ciudadCampo = u.ciudad || p.ciudad || "";
  let barrio = u.barrio || "";

  const loc = {
    address_line: [calle, numero].filter(Boolean).join(" ").trim(),
    country: { id: "UY", name: "Uruguay" },
    state: { name: departamento },
    city: { name: ciudadCampo },
  };
  const lat = u.lat != null ? u.lat : p.lat;
  const lng = u.lng != null ? u.lng : p.lng;
  if (lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
    loc.latitude = Number(lat);
    loc.longitude = Number(lng);
  }

  const headers = { Authorization: `Bearer ${token}` };
  try {
    if (!_locCache.states) {
      _locCache.states = (await axios.get(`${API}/classified_locations/countries/UY`, { headers })).data.states || [];
    }
    const st = _locCache.states.find((s) => norm(s.name) === norm(departamento));
    if (!st) return loc;
    loc.state = { id: st.id };

    if (!_locCache.cities.has(st.id)) {
      _locCache.cities.set(st.id, (await axios.get(`${API}/classified_locations/states/${st.id}`, { headers })).data.cities || []);
    }
    const cities = _locCache.cities.get(st.id);

    // 1) ¿El campo "ciudad" es una ciudad real del departamento?
    let city = cities.find((c) => norm(c.name) === norm(ciudadCampo));
    // 2) Si no (caso Montevideo: el campo trae el BARRIO), usar la ciudad homónima
    //    del departamento y tratar el valor del campo como barrio.
    if (!city) {
      city = cities.find((c) => norm(c.name) === norm(departamento)) || (cities.length === 1 ? cities[0] : null);
      if (city && !barrio) barrio = ciudadCampo;
    }
    if (!city) return loc;
    loc.city = { id: city.id };

    if (barrio) {
      if (!_locCache.barrios.has(city.id)) {
        _locCache.barrios.set(city.id, (await axios.get(`${API}/classified_locations/cities/${city.id}`, { headers })).data.neighborhoods || []);
      }
      const bs = _locCache.barrios.get(city.id);
      const b =
        bs.find((x) => norm(x.name) === norm(barrio)) ||
        bs.find((x) => norm(x.name).includes(norm(barrio)) || norm(barrio).includes(norm(x.name)));
      loc.neighborhood = b ? { id: b.id } : { name: barrio };
    }
    return loc;
  } catch (e) {
    logger.warn("No se pudo resolver la ubicación con IDs de ML:", e.response?.data || e.message);
    return loc;
  }
}

// Ajusta el atributo PROPERTY_TYPE según la categoría de Mercado Libre:
//  - Si la categoría lo fija (read_only/fixed/hidden o trae un valor por defecto), NO se
//    envía: ML lo descarta y da "Validation error ... category fixed-value" (caso "Local").
//  - Si la categoría tiene lista cerrada de valores, se manda el value_id correcto (antes
//    iba el nombre con id nulo -> "(null:Local comercial)", que ML rechazaba).
//  - Si es de texto libre, se deja el value_name.
function reconcilePropertyType(attributes, catAttrs) {
  const idx = attributes.findIndex((a) => a.id === "PROPERTY_TYPE");
  if (idx === -1) return attributes;
  if (!Array.isArray(catAttrs)) return attributes; // sin datos de categoría: dejamos lo que había
  const attr = catAttrs.find((a) => a.id === "PROPERTY_TYPE");
  const tags = (attr && attr.tags) || {};
  if (!attr || tags.read_only || tags.fixed || tags.hidden || attr.value_id || attr.default_value) {
    attributes.splice(idx, 1); // la categoría lo fija -> no enviarlo
    return attributes;
  }
  const vals = attr.values || [];
  if (vals.length) {
    const want = norm(attributes[idx].value_name);
    const hit = vals.find((v) => norm(v.name) === want) ||
                vals.find((v) => norm(v.name).includes(want) || want.includes(norm(v.name)));
    if (hit) attributes[idx] = { id: "PROPERTY_TYPE", value_id: hit.id, value_name: hit.name };
    else attributes.splice(idx, 1); // lista cerrada sin coincidencia -> mejor no forzarlo
  }
  return attributes;
}

async function buildItem(p, token) {
  // Elegir la categoría correcta dentro de Inmuebles (MLU1459)
  let categoryId = await getRealEstateCategory(p, token);
  if (!categoryId) categoryId = p.type === "rent" ? CAT_RENT : CAT_SALE;
  if (!categoryId) throw new Error("No se pudo determinar la categoría de inmuebles de Mercado Libre.");

  const operation = p.type === "rent" ? "Alquiler" : "Venta";
  const ret = p.realEstateType || (p.propertyType === "ph" ? "apartamento" : "casa");
  const propTypeMap = { casa: "Casa", apartamento: "Apartamento", terreno: "Terreno", local: "Local comercial", oficina: "Oficina", galpon: "Galpón", campo: "Campo" };
  const propType = propTypeMap[ret] || "Casa";

  let attributes = [
    { id: "OPERATION", value_name: operation },
    { id: "PROPERTY_TYPE", value_name: propType },
  ];
  if (p.bedrooms) attributes.push({ id: "BEDROOMS", value_name: String(p.bedrooms) });
  if (p.bathrooms) attributes.push({ id: "FULL_BATHROOMS", value_name: String(p.bathrooms) });
  if (p.totalArea) attributes.push({ id: "TOTAL_AREA", value_name: `${p.totalArea} m²` });
  if (p.builtArea) attributes.push({ id: "COVERED_AREA", value_name: `${p.builtArea} m²` });
  // MAINTENANCE_FEE: NO lo forzamos acá con value_struct (ML lo descartaba en algunas
  // categorías). Lo dejamos para addFeatureAttributes/fillRequiredAttributes, que leen
  // la unidad real (allowed_units) de la categoría y usan el formato value_name correcto.
  // Lo metemos en la ficha para que esos pasos lo procesen igual que el resto.
  if (p.commonExpenses != null && p.commonExpenses !== "" && Number(p.commonExpenses) > 0) {
    p.ficha = p.ficha || {};
    if (p.ficha.MAINTENANCE_FEE == null || p.ficha.MAINTENANCE_FEE === "") {
      p.ficha.MAINTENANCE_FEE = Number(p.commonExpenses);
    }
  }
  // Horario de contacto: la inmobiliaria atiende siempre, así que si el agente no
  // cargó otro horario, TODOS los avisos van con "24 horas". Cubre también los
  // avisos viejos: lo toman en la próxima edición/sincronización.
  p.ficha = p.ficha || {};
  if (p.ficha.CONTACT_SCHEDULE == null || p.ficha.CONTACT_SCHEDULE === "") {
    p.ficha.CONTACT_SCHEDULE = "24 horas";
  }

  // Precio por unidad de área: es precio ÷ superficie, un dato que el sistema ya
  // tiene. Pedírselo al agente era trabajo al pedo y encima una fuente de
  // contradicciones (escribía 900 cuando la cuenta daba 1066, y el aviso se
  // desmentía solo). Como MAINTENANCE_FEE, se deja en la ficha y que
  // addFeatureAttributes le ponga la unidad correcta de la categoría.
  const _sup = Number(p.totalArea) || 0;
  const _precio = Number(p.price) || 0;
  if (_sup > 0 && _precio > 0) {
    p.ficha.PRICE_PER_AREA_UNIT = Math.round((_precio / _sup) * 100) / 100;
  }

  // Los atributos de la categoría se leen UNA sola vez y se comparten entre el
  // mapeo de la ficha y el relleno de obligatorios (antes eran dos llamadas).
  let catAttrs = null;
  try {
    catAttrs = (await axios.get(`${API}/categories/${categoryId}/attributes`, { headers: { Authorization: `Bearer ${token}` } })).data || [];
  } catch (e) { catAttrs = null; }

  // Límites REALES de la categoría. Inmuebles permite títulos de hasta 200 y hasta
  // 30 fotos; antes estaban hardcodeados en 60/12 y recortaban título y fotos.
  let maxTitle = 60, maxPics = 12;
  try {
    const _cat = (await axios.get(`${API}/categories/${categoryId}`, { headers: { Authorization: `Bearer ${token}` } })).data || {};
    if (_cat.settings) {
      if (_cat.settings.max_title_length) maxTitle = _cat.settings.max_title_length;
      if (_cat.settings.max_pictures_per_item) maxPics = _cat.settings.max_pictures_per_item;
    }
  } catch (e) { /* si falla, quedan los límites por defecto */ }

  // PROPERTY_TYPE según la categoría: en las que lo fijan (p. ej. "Local", "Oficina")
  // ML lo rechaza si se lo enviás, así que ahí lo quitamos; si la categoría tiene una
  // lista cerrada de valores, mandamos el value_id correcto en vez de un nombre con id
  // nulo (que ML descartaba -> "(null:Local comercial)").
  attributes = reconcilePropertyType(attributes, catAttrs);

  // Mapear todos los datos del formulario (ambientes, cocheras, antigüedad, pisos,
  // bodegas, orientación, tipo, seguridad, gastos comunes y todas las comodidades)
  // a sus atributos de Mercado Libre. Va ANTES del relleno de obligatorios para que,
  // por ejemplo, las cocheras lleven el número real y no el 1/0 por defecto.
  attributes = await addFeatureAttributes(categoryId, p, attributes, token, catAttrs);
  // Completar cualquier atributo obligatorio que la categoría exija y todavía falte.
  attributes = await fillRequiredAttributes(categoryId, p, attributes, token, catAttrs);

  // Seguridad: no enviar atributos que la categoría no reconoce (ej.: dormitorios o
  // área cubierta en un terreno). Evita rechazos de ML en tipos no residenciales.
  if (Array.isArray(catAttrs) && catAttrs.length) {
    const validos = new Set(catAttrs.map((a) => a.id));
    attributes = attributes.filter((a) => a && validos.has(a.id));
  }

  const condition = await pickCondition(categoryId, token);
  // Mercado Libre DEDUPLICA las fotos por URL: si la misma imagen aparece dos
  // veces (caso típico: suben 8 fotos pero 4 están repetidas), ML se queda con
  // una sola y el aviso muestra menos fotos que la web. Para forzar que las tome
  // todas, a cada repetición se le agrega un parámetro único en la URL (mismo
  // archivo, URL distinta => ML la trata como otra foto).
  const vistas = {};
  const pictures = (p.images || []).slice(0, maxPics).map((url) => {
    const u = String(url || "");
    if (!u) return null;
    vistas[u] = (vistas[u] || 0) + 1;
    if (vistas[u] === 1) return { source: u };
    const sep = u.indexOf("?") >= 0 ? "&" : "?";
    return { source: `${u}${sep}mldup=${vistas[u]}` };
  }).filter(Boolean);

  return {
    title: (p.title || "Propiedad").slice(0, maxTitle),
    category_id: categoryId,
    price: p.price,
    currency_id: p.currency || "USD",
    available_quantity: 1,
    buying_mode: "classified",
    listing_type_id: await pickListingType(categoryId, token),
    condition,
    channels: ["marketplace"],
    description: { plain_text: p.description || p.title || "" },
    video_id: videoIdParaML(p),
    pictures,
    location: await resolveMLLocation(p, token),
    seller_contact: await buildSellerContact(p),
    attributes,
  };
}

// =====================================================================
// CIERRE — cierra (o elimina) un aviso en Mercado Libre contemplando el caso
// especial de "pendiente de pago": ML no le acepta cambios de estado
// ("Cannot update item ... [status:payment_required]"). El procedimiento
// oficial para esos avisos es marcarlos como eliminados (PUT deleted:"true"),
// reintentando si ML devuelve el conflicto de "optimistic locking".
// Devuelve: { ok:true } cerrado · { ok:true, eliminado:true } impago eliminado
//           { ok:false, impago:true } no se pudo ni eliminar (se abandona)
//           { ok:false, error } cualquier otro error real.
// =====================================================================
async function cerrarAvisoEnML(itemId, headers) {
  let st = "";
  try { st = ((await axios.get(`${API}/items/${itemId}`, { headers })).data || {}).status || ""; } catch (e) { /* se intenta igual */ }
  if (st === "closed") return { ok: true }; // ya estaba cerrado
  if (st !== "payment_required") {
    try {
      // Mercado Libre exige pausar antes de cerrar.
      try { await axios.put(`${API}/items/${itemId}`, { status: "paused" }, { headers }); } catch (e) { /* puede ya estar pausado */ }
      await axios.put(`${API}/items/${itemId}`, { status: "closed" }, { headers });
      return { ok: true };
    } catch (e) {
      const txt = JSON.stringify(e.response?.data || e.message || "");
      if (!/payment_required/i.test(txt)) return { ok: false, error: e };
      // El estado real era pendiente de pago: seguir por la vía de eliminación.
    }
  }
  for (let intento = 0; intento < 3; intento++) {
    try {
      await axios.put(`${API}/items/${itemId}`, { deleted: "true" }, { headers });
      return { ok: true, eliminado: true };
    } catch (e) {
      const txt = JSON.stringify(e.response?.data || e.message || "");
      if (/optimistic locking|conflict/i.test(txt) && intento < 2) {
        await new Promise((r) => setTimeout(r, 3000)); // ML pide esperar unos segundos
        continue;
      }
      logger.warn(`No se pudo eliminar el aviso impago ${itemId}:`, txt.slice(0, 300));
      return { ok: false, impago: true, error: e };
    }
  }
  return { ok: false, impago: true };
}

// =====================================================================
// RESCATE — busca un aviso NUESTRO ya creado para esta propiedad que quedó
// sin vincular en Firestore. Pasa cuando ML crea el aviso pero lo devuelve
// dentro de una respuesta de error (quirk real de la API: el "error" trae el
// item entero), o cuando una ejecución murió antes de guardar el mlItemId.
// Fuentes: 1) un id de item dentro del último mlError guardado,
//          2) el SKU (los avisos nuevos llevan seller_custom_field = id de la
//             propiedad, lo que vuelve la publicación idempotente).
// Si lo encuentra (no cerrado y de nuestra cuenta), se ADOPTA en vez de
// crear un duplicado.
// =====================================================================
async function rescatarAvisoPerdido(p, propertyId, token) {
  const headers = { Authorization: `Bearer ${token}` };
  let userId = null;
  try { userId = ((await TOKENS_DOC.get()).data() || {}).user_id || null; } catch (e) { /* sin user_id igual sirve la vía 1 */ }
  // Avisos abandonados a propósito (impagos que ML descarta solo): no readoptar.
  const abandonados = new Set(Array.isArray(p.mlAbandonados) ? p.mlAbandonados : []);
  // 1) ¿El último error guardado contiene un id de aviso? (caso MLU695091061)
  const m = String(p.mlError || "").match(/MLU\d{6,}/);
  if (m && !abandonados.has(m[0])) {
    try {
      const it = (await axios.get(`${API}/items/${m[0]}`, { headers })).data;
      if (it && it.status !== "closed" && (!userId || String(it.seller_id) === String(userId))) return it;
    } catch (e) { /* no existe o no es nuestro: seguir */ }
  }
  // 2) Por SKU = id de la propiedad
  if (userId) {
    try {
      const r = await axios.get(`${API}/users/${userId}/items/search?seller_sku=${encodeURIComponent(propertyId)}`, { headers });
      const ids = (r.data && r.data.results) || [];
      for (const itemId of ids) {
        if (abandonados.has(itemId)) continue; // abandonado a propósito (impago)
        try {
          const it = (await axios.get(`${API}/items/${itemId}`, { headers })).data;
          if (it && it.status !== "closed") return it;
        } catch (e) { /* probar el siguiente */ }
      }
    } catch (e) { /* el filtro por SKU puede no estar disponible: no es grave */ }
  }
  return null;
}

// =====================================================================
// NÚCLEO DE PUBLICACIÓN — un único camino para crear el aviso, usado por:
//   - publicarEnML (al crear la propiedad)
//   - sincronizarEdicionML (reintento automático si la publicación había fallado)
//   - republicarML (botón del panel) y la vuelta a "Disponible" de un aviso cerrado
//
// Reclamo atómico para NO publicar dos veces: Cloud Functions puede entregar el
// mismo evento más de una vez (o ejecutarlo en paralelo); sin esto, dos ejecuciones
// verían mlItemId vacío a la vez y crearían DOS avisos en Mercado Libre.
// El candado tiene vencimiento (mlPublishingAt + 3 min): si una ejecución muere
// sin liberarlo, la propiedad no queda bloqueada para siempre.
// =====================================================================
// Tras publicar/actualizar: revisa qué atributos de calidad le faltan al aviso y,
// si hay, le avisa al agente (campanita + push) para que complete la ficha. NO
// bloquea la publicación: el aviso ya está en línea; esto solo empuja a mejorarlo.
// Se evita repetir el mismo aviso guardando la firma de lo que faltaba (mlFaltaHash).
async function notificarFichaIncompleta(ref, id, p, item, token) {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const catAttrs = (await axios.get(`${API}/categories/${item.category_id}/attributes`, { headers })).data || [];
    const lleno = new Set();
    (item.attributes || []).forEach((a) => {
      const tiene = (a.value_name != null && String(a.value_name) !== "") || (a.value_id != null && String(a.value_id) !== "") || (Array.isArray(a.values) && a.values.length > 0);
      if (tiene) lleno.add(a.id);
    });
    const noVa = new Set(["OPERATION", "PROPERTY_TYPE", "ITEM_CONDITION"]);
    if (!(Number(p.commonExpenses) > 0)) noVa.add("MAINTENANCE_FEE");
    const faltan = [];
    catAttrs.forEach((a) => {
      if (lleno.has(a.id) || noVa.has(a.id)) return;
      const t = a.tags || {};
      if (t.hidden || t.read_only || t.fixed) return;
      // Solo listas y datos que suman calidad; los checkboxes sin tildar significan
      // "no lo tiene", no "falta". Reclamamos listas/números y los required.
      if (a.value_type === "boolean" && !(t.required || t.conditional_required)) return;
      faltan.push({ nombre: a.name, req: !!(t.required || t.conditional_required) });
    });
    if (!faltan.length) {
      // Ficha completa: limpiar la marca por si antes estaba incompleta.
      await ref.update({ mlFaltaHash: admin.firestore.FieldValue.delete() }).catch(() => {});
      return;
    }
    // Evitar repetir el MISMO aviso: firma de los campos que faltan.
    const hash = faltan.map((f) => f.nombre).sort().join("|");
    if (p.mlFaltaHash === hash) return;

    const nombres = faltan.slice(0, 4).map((f) => f.nombre).join(", ");
    const extra = faltan.length > 4 ? ` y ${faltan.length - 4} más` : "";
    const texto = `"${p.title || "Tu propiedad"}" se publicó, pero le faltan datos para llegar al 100% de calidad en Mercado Libre: ${nombres}${extra}. Completalos en Editar propiedad → Ficha técnica.`;

    // Destinatario: el agente dueño; si no tiene perfil, el admin.
    let destino = null;
    if (p.ownerId) {
      try { const u = await db.doc(`users/${p.ownerId}`).get(); if (u.exists) destino = { uid: u.id, fcmToken: u.data().fcmToken }; } catch (e) {}
    }
    if (!destino) destino = await getAdminUser();
    if (destino) {
      await crearNotificacion(destino, {
        type: "ficha_incompleta",
        propertyId: id,
        propertyTitle: p.title || "una propiedad",
        userName: "Ficha incompleta",
        userPhoto: null,
        text: texto,
      }, {
        title: "📝 Ficha incompleta en Mercado Libre",
        body: `${p.title || "Tu propiedad"} — faltan ${faltan.length} dato${faltan.length === 1 ? "" : "s"} para el 100%`,
      });
    }
    await ref.update({ mlFaltaHash: hash }).catch(() => {});
    logger.info(`[fichaIncompleta] ${id}: ${faltan.length} campos faltantes avisados.`);
  } catch (e) { logger.warn(`[fichaIncompleta] ${e.response ? e.response.status : e.message}`); }
}

// ============================================================
// MAPEO DE FOTOS  url de origen -> id de la foto en Mercado Libre
// ------------------------------------------------------------
// Por qué existe: ML CACHEA LAS IMÁGENES POR SU URL DE ORIGEN. Si en una
// actualización le volvés a mandar `{source: url}` de una foto que ya tiene, la
// reconoce y no toca nada — por eso "edito y guardo" no refrescaba la galería,
// mientras que dar de baja y republicar sí (ahí las URLs le son todas nuevas).
//
// El método documentado para actualizar es: mandar el ID de las fotos que se
// conservan, y el source SOLO de las nuevas. Pero ML no devuelve la URL de
// origen de cada foto, así que no hay con qué emparejar: hay que guardarse el
// mapeo nosotros. Eso es `mlPics`.
// ============================================================
async function guardarMapaPics(ref, itemId, fuentes, headers) {
  try {
    const r = await axios.get(`${API}/items/${itemId}`, { headers, params: { attributes: "pictures" } });
    const pics = (r.data && r.data.pictures) || [];
    // ML respeta el orden en que se mandan, así que la correspondencia es posicional.
    // Si devuelve MENOS de las que mandamos, descartó alguna (típicamente por
    // repetida) y de ahí en adelante el emparejamiento ya no es confiable.
    if (pics.length !== fuentes.length) {
      logger.warn(`[FOTOS ${itemId}] se enviaron ${fuentes.length} y Mercado Libre guardó ${pics.length}.`);
    }
    const mlPics = [];
    for (let i = 0; i < Math.min(pics.length, fuentes.length); i++) {
      if (pics[i] && pics[i].id) mlPics.push({ src: fuentes[i], id: pics[i].id });
    }
    await ref.update({ mlPics, mlPicsAt: new Date().toISOString() });
    return pics.length;
  } catch (e) {
    logger.warn(`No se pudo guardar el mapeo de fotos de ${itemId}:`, e.message);
    return null;
  }
}

// Arma el arreglo `pictures` de una ACTUALIZACIÓN: id para las conocidas, source
// para las nuevas. Sin esto ML ignora el PUT por completo.
function picturesParaUpdate(prop, pictures) {
  const mapa = new Map((prop.mlPics || []).map((x) => [x.src, x.id]));
  return pictures.map((pic) => {
    const id = mapa.get(pic.source);
    return id ? { id } : { source: pic.source };
  });
}

async function crearAvisoML(ref, id, extra = {}, opciones = {}) {
  const LOCK_MS = 3 * 60 * 1000;
  let p = null;
  try {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return;
      const d = fresh.data();
      if (d.status && d.status !== "available") return; // no disponible
      if (d.mlItemId) return;                            // ya publicada
      const lockAt = d.mlPublishingAt ? new Date(d.mlPublishingAt).getTime() : 0;
      if (d.mlPublishing && Date.now() - lockAt < LOCK_MS) return; // otra ejecución la está publicando
      tx.update(ref, { mlPublishing: true, mlPublishingAt: new Date().toISOString() });
      p = d;
    });
  } catch (e) {
    logger.error(`No se pudo reservar la publicación de ${id}:`, e.message);
    return { ok: false, error: e.message };
  }
  if (!p) {
    logger.info(`Propiedad ${id}: no se publica (ya publicada, en curso o no disponible).`);
    return { ok: false, omitido: true };
  }

  try {
    const token = await getValidToken();
    const item = await buildItem(p, token);
    const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    let r = null;

    // ¿Quedó un aviso ya creado y sin vincular de un intento anterior? Adoptarlo.
    const perdido = await rescatarAvisoPerdido(p, id, token);
    if (perdido) {
      r = { data: perdido };
      logger.info(`Propiedad ${id}: se recuperó el aviso existente ${perdido.id} en vez de crear un duplicado.`);
      await registrarLog(id, "publicar (aviso existente recuperado)", true, perdido.id);
    } else {
      // SKU = id de la propiedad: vuelve idempotente la publicación y permite
      // rescatar el aviso si alguna vez se pierde el vínculo.
      item.seller_custom_field = id;
      // Tipos a intentar: si el agente eligió uno A MANO en el modal, SOLO ese
      // (sin fallback). En automático, SOLO los permitidos del .env (por defecto,
      // gratuita y nada más): un tipo pago jamás se elige solo.
      let tipos;
      if (opciones.listingType) {
        tipos = [opciones.listingType];
      } else {
        const candidatos = await listingTypesDisponibles(item.category_id, token);
        tipos = [...new Set([item.listing_type_id, ...candidatos])].slice(0, 4);
      }
      for (let i = 0; i < tipos.length; i++) {
        item.listing_type_id = tipos[i];
        try {
          r = await axios.post(`${API}/items`, item, { headers });
          break;
        } catch (e2) {
          const data = e2.response?.data;
          // Quirk real de ML: a veces el "error" trae EL AVISO YA CREADO adentro.
          // Si el cuerpo tiene un id de item, el aviso existe: se adopta como éxito.
          if (data && typeof data === "object" && /^MLU\d+/.test(String(data.id || ""))) {
            r = { data };
            logger.warn(`El POST devolvió error pero el aviso ${data.id} quedó creado; se adopta.`);
            await registrarLog(id, "publicar (aviso creado dentro de respuesta de error)", true, data.id);
            break;
          }
          const txt = JSON.stringify(data || e2.message || "");
          const errorDeTipo = /listing[ _]?type/i.test(txt) && /not available|run out/i.test(txt);
          if (errorDeTipo) {
            vetarListingType(item.category_id, tipos[i]);
            if (i < tipos.length - 1) {
              logger.warn(`Listing type "${tipos[i]}" rechazado en ${item.category_id}; reintentando con "${tipos[i + 1]}".`);
              await registrarLog(id, "publicar (cambio de listing type)", false, `"${tipos[i]}" no disponible en ${item.category_id} -> probando "${tipos[i + 1]}"`);
              continue;
            }
            // No quedan tipos permitidos para probar: error claro y accionable.
            const msj = opciones.listingType
              ? `Mercado Libre no acepta el tipo de aviso "${opciones.listingType}" en esta categoría (${item.category_id}). Elegí otro tipo desde el botón de Mercado Libre.`
              : (tipos.length === 1 && tipos[0] === "free"
                ? `Llegaste al límite de avisos gratis de Mercado Libre, o esta categoría no tiene opción gratuita. Es normal en inmuebles: para publicarla, elegí abajo un tipo de aviso pago.`
                : `Mercado Libre no aceptó ninguno de los tipos automáticos (${tipos.join(", ")}) en ${item.category_id}. Elegí el tipo a mano desde el botón de Mercado Libre.`);
            throw new Error(msj);
          }
          throw e2; // otro tipo de error: lo maneja el catch general
        }
      }
    }
    await setItemDescription(r.data.id, p.description, token);
    // Se guarda el mapeo de fotos ya mismo: es lo que va a permitir que la próxima
    // edición pueda mandar ids en vez de sources y que ML sí actualice la galería.
    await guardarMapaPics(ref, r.data.id, (item.pictures || []).map((x) => x.source), { Authorization: `Bearer ${token}` });
    await ref.update({
      mlItemId: r.data.id,
      mlPermalink: r.data.permalink || "",
      mlStatus: r.data.status || "active",
      mlListingType: r.data.listing_type_id || item.listing_type_id || "",
      mlError: admin.firestore.FieldValue.delete(),
      mlErrorAt: admin.firestore.FieldValue.delete(),
      mlPublishing: admin.firestore.FieldValue.delete(),
      mlPublishingAt: admin.firestore.FieldValue.delete(),
      ...extra,
    });
    logger.info(`Propiedad ${id} publicada en ML: ${r.data.id} (${r.data.permalink})`);
    await registrarLog(id, "publicar", true, `${r.data.id} ${r.data.permalink || ""} [${r.data.listing_type_id || item.listing_type_id || ""}] ${r.data.status || ""}`);
    // Aviso publicado: si la ficha quedó incompleta, avisar al agente para que la complete.
    await notificarFichaIncompleta(ref, id, Object.assign({}, p, extra), item, token);
    // Tipo de publicación pago sin abonar: el aviso existe pero no se ve hasta pagarlo.
    if ((r.data.status || "") === "payment_required") {
      await notificarErrorML(p, id, "Aviso creado pero pendiente de pago en Mercado Libre",
        `Quedó con tipo de publicación "${r.data.listing_type_id || item.listing_type_id}". Para activarlo, pagalo desde tu cuenta de Mercado Libre (sección Publicaciones).`);
    }
    return { ok: true, mlItemId: r.data.id, permalink: r.data.permalink || "" };
  } catch (e) {
    const detail = e.response?.data || e.message;
    const guardado = typeof detail === "string" ? detail : JSON.stringify(detail);
    const resumen = resumirErrorML(detail);
    logger.error(`Error publicando ${id} en ML:`, guardado);
    // Guardamos el error y liberamos el candado para poder reintentar
    await ref.update({
      mlError: guardado,
      mlErrorAt: new Date().toISOString(),
      mlPublishing: admin.firestore.FieldValue.delete(),
      mlPublishingAt: admin.firestore.FieldValue.delete(),
    });
    await registrarLog(id, "publicar", false, resumen);
    // Avisar al agente y al admin (solo si el error es nuevo, para no spamear).
    if (p.mlError !== guardado) {
      await notificarErrorML(p, id, "No se pudo publicar en Mercado Libre", resumen);
    }
    return { ok: false, error: resumen };
  }
}

// =====================================================================
// 3) PUBLICAR  — se dispara solo al crear una propiedad
// =====================================================================
exports.publicarEnML = onDocumentCreated("properties/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const p = snap.data() || {};
  // RESTAURACIÓN desde la papelera: si el doc ya trae un aviso de ML, no se crea
  // otro. Si ese aviso sigue vivo en ML se re-engancha tal cual; si quedó cerrado,
  // se publica uno nuevo (ML no permite reabrir avisos cerrados).
  if (p.mlItemId) {
    try {
      const token = await getValidToken();
      const live = (await axios.get(`${API}/items/${p.mlItemId}`, { headers: { Authorization: `Bearer ${token}` } })).data;
      if (live && live.status !== "closed") {
        await registrarLog(event.params.id, "restaurar: aviso re-enganchado", true, `${p.mlItemId} (${live.status})`);
        return;
      }
    } catch (e) { /* si el aviso no se puede leer, se publica de nuevo abajo */ }
  }
  await crearAvisoML(snap.ref, event.params.id, { mlPublishedAt: new Date().toISOString() });
});

// =====================================================================
// 3b) SINCRONIZACIÓN al EDITAR una propiedad.
//     - Espeja el ESTADO en ML: Disponible→activo, Reservada→pausado,
//       Vendida/Alquilada/Archivada→cerrado. Si vuelve a Disponible y el aviso
//       estaba cerrado, se crea uno nuevo (ML no permite reabrir cerrados).
//     - Actualiza el contenido del aviso (PUT) cuando cambian los datos.
//     - Si la publicación había FALLADO, al editar la propiedad se reintenta
//       sola: el agente corrige el dato y no tiene que tocar nada más.
// =====================================================================

// Campos de CONTENIDO de la propiedad. Si cambia alguno, hay que re-sincronizar.
// Los metadatos internos (mlItemId, mlStatus, mlSyncedAt, mlError, mlPublishing...)
// quedan fuera a propósito: así nuestras propias escrituras NO disparan un bucle.
const CONTENT_FIELDS = ["title", "price", "currency", "description", "videoUrl", "images", "departamento", "ciudad", "direccion", "ubicacion", "bedrooms", "bathrooms", "totalArea", "builtArea", "commonExpenses", "garage", "type", "propertyType", "realEstateType", "ownerWhatsapp", "ownerName", "ficha"];
function contentChanged(before, after) {
  if (!before) return true;
  return CONTENT_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

// Estado interno de la app -> estado del aviso en Mercado Libre.
const ML_STATUS_MAP = { available: "active", reserved: "paused", sold: "closed", rented: "closed", archived: "closed" };
// Estados que NO deben tocar el aviso: la decisión de publicación todavía no está
// tomada. 'cerrado_externo' espera la confirmación del admin desde la campanita
// ("lo publicado se asume con permiso"), y tasación es previa a publicar. Antes
// caían en el `|| "active"` de más abajo: una propiedad RESERVADA (aviso pausado)
// cuya gestión cerraba por afuera terminaba REACTIVANDO el aviso justo en el
// momento en que la operación se había hecho sin la agencia.
const ML_ESTADOS_SIN_ESPEJO = ["cerrado_externo", "tasacion", "tasado"];

exports.sincronizarEdicionML = onDocumentUpdated("properties/{id}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const ref = event.data.after.ref;
  const id = event.params.id;

  if (!after) return;
  if (after.mlPublishing) return; // se está creando el aviso en este momento

  const stBefore = (before && before.status) || "available";
  const stAfter = after.status || "available";
  const cambioEstado = stAfter !== stBefore;
  const cambioContenido = contentChanged(before, after);
  if (!cambioEstado && !cambioContenido) return; // solo cambiaron metadatos de ML -> nada que hacer

  // ---- (A) Sin aviso en ML todavía: si está Disponible, (re)intentar publicar.
  //      Cubre el caso "la publicación falló": el agente edita/corrige y sale sola.
  if (!after.mlItemId) {
    if (stAfter === "available") {
      await crearAvisoML(ref, id, { mlPublishedAt: new Date().toISOString() });
    }
    return;
  }

  let token;
  try {
    token = await getValidToken();
  } catch (e) {
    logger.error(`Sin token para sincronizar ${id}:`, e.message);
    await ref.update({ mlError: e.message, mlErrorAt: new Date().toISOString() });
    await registrarLog(id, "sincronizar", false, e.message);
    return;
  }
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  let mlStatusActual = after.mlStatus || "";

  // ---- (B) Cambio de estado en la app -> espejarlo en Mercado Libre.
  //      Salvo los estados en limbo (ver ML_ESTADOS_SIN_ESPEJO): ahí el aviso se
  //      deja como está y se espera la decisión del admin.
  if (cambioEstado && !ML_ESTADOS_SIN_ESPEJO.includes(stAfter)) {
    const objetivo = ML_STATUS_MAP[stAfter] || "active";
    try {
      const live = (await axios.get(`${API}/items/${after.mlItemId}`, { headers })).data;
      mlStatusActual = live.status;

      if (objetivo === "closed" && live.status !== "closed") {
        const cierre = await cerrarAvisoEnML(after.mlItemId, headers);
        if (cierre.ok && cierre.eliminado) {
          // Impago eliminado: ya no existe en ML; se limpia el vínculo.
          await ref.update({
            mlItemId: admin.firestore.FieldValue.delete(),
            mlStatus: admin.firestore.FieldValue.delete(),
            mlPermalink: admin.firestore.FieldValue.delete(),
            mlBajaAt: new Date().toISOString(),
          });
          await registrarLog(id, `estado ${stAfter} -> impago eliminado en ML`, true, after.mlItemId);
        } else if (cierre.ok) {
          await ref.update({ mlStatus: "closed", mlBajaAt: new Date().toISOString() });
          await registrarLog(id, `estado ${stAfter} -> cerrado en ML`, true, after.mlItemId);
        } else if (cierre.impago) {
          // Ni cerrar ni eliminar: se abandona (ML lo descarta solo al vencer, sin costo).
          await ref.update({
            mlItemId: admin.firestore.FieldValue.delete(),
            mlStatus: admin.firestore.FieldValue.delete(),
            mlPermalink: admin.firestore.FieldValue.delete(),
            mlAbandonados: admin.firestore.FieldValue.arrayUnion(after.mlItemId),
            mlBajaAt: new Date().toISOString(),
          });
          await registrarLog(id, `estado ${stAfter} (impago abandonado)`, true, after.mlItemId);
        } else {
          throw cierre.error; // lo toma el catch de este bloque de estado
        }
        return; // dado de baja: no hay contenido que sincronizar
      }

      if (objetivo === "paused") {
        if (live.status === "active") {
          await axios.put(`${API}/items/${after.mlItemId}`, { status: "paused" }, { headers });
          await ref.update({ mlStatus: "paused" });
          mlStatusActual = "paused";
          await registrarLog(id, `estado ${stAfter} -> pausado en ML`, true, after.mlItemId);
        } else if (live.status === "closed") {
          const msj = "El aviso está cerrado en Mercado Libre; pasá la propiedad a Disponible para volver a publicarla.";
          await ref.update({ mlStatus: "closed", mlError: msj, mlErrorAt: new Date().toISOString() });
          await registrarLog(id, `estado ${stAfter}`, false, msj);
          return;
        }
      }

      if (objetivo === "active") {
        if (live.status === "paused") {
          await axios.put(`${API}/items/${after.mlItemId}`, { status: "active" }, { headers });
          await ref.update({ mlStatus: "active", mlError: admin.firestore.FieldValue.delete(), mlErrorAt: admin.firestore.FieldValue.delete() });
          mlStatusActual = "active";
          await registrarLog(id, "estado available -> reactivado en ML", true, after.mlItemId);
        } else if (live.status === "closed") {
          // ML no permite reabrir un aviso cerrado: se limpia la referencia y se crea uno nuevo.
          await ref.update({
            mlItemId: admin.firestore.FieldValue.delete(),
            mlStatus: admin.firestore.FieldValue.delete(),
            mlPermalink: admin.firestore.FieldValue.delete(),
          });
          await registrarLog(id, "estado available con aviso cerrado -> se recrea", true, after.mlItemId);
          await crearAvisoML(ref, id, { mlRepublishedAt: new Date().toISOString() });
          return;
        }
      }
    } catch (e) {
      const detail = e.response?.data || e.message;
      const resumen = resumirErrorML(detail);
      logger.error(`Error espejando estado de ${id} en ML:`, JSON.stringify(detail));
      await ref.update({ mlError: typeof detail === "string" ? detail : JSON.stringify(detail), mlErrorAt: new Date().toISOString() });
      await registrarLog(id, `estado ${stAfter}`, false, resumen);
      await notificarErrorML(after, id, "No se pudo actualizar el estado en Mercado Libre", resumen);
      return;
    }
  }

  // ---- (C) Cambio de contenido -> actualizar el aviso (PUT).
  if (!cambioContenido) return;
  if (mlStatusActual === "closed" || after.mlStatus === "closed") return; // aviso dado de baja

  try {
    const item = await buildItem(after, token);
    // En un aviso ya creado no se pueden cambiar estos campos; se quitan del PUT.
    // currency_id tampoco es modificable: si cambió la moneda, se avisa y no se toca el precio.
    const { category_id, listing_type_id, buying_mode, condition, channels, available_quantity, description, pictures, video_id, ...updatable } = item;
    const cambioMoneda = before && before.currency && before.currency !== after.currency;
    // ANTES: currency_id se quitaba siempre del PUT y, si había cambio de moneda,
    // tampoco se mandaba el precio. O sea que ni se intentaba, y el agente recibía
    // "dalo de baja y volvé a publicarlo" aunque Mercado Libre lo aceptara.
    // AHORA se intenta de verdad. Si ML lo rechaza, el catch de abajo reporta el
    // motivo REAL que devuelve ML en vez de una suposición nuestra.
    // Nota: el precio viaja junto con la moneda, porque cambiar una sin la otra
    // dejaría el aviso con el número viejo en la moneda nueva.

    // El resto del contenido (precio, título, atributos) en un PUT.
    await axios.put(`${API}/items/${after.mlItemId}`, updatable, { headers });

    // El VIDEO en su propio PUT: algunas categorías/avisos activos rechazan el
    // cambio de video_id y no queremos que eso tumbe el resto de la edición.
    if (video_id) {
      try { await axios.put(`${API}/items/${after.mlItemId}`, { video_id }, { headers }); }
      catch (ev) { logger.warn(`Video no actualizado en ML ${after.mlItemId}:`, JSON.stringify(ev.response?.data || ev.message)); }
    }

    // Las FOTOS se actualizan en su PROPIO PUT. Mercado Libre es especialmente
    // quisquilloso con las fotos de avisos activos: si mandara todo junto y ML
    // rechazara las fotos, se perdían TODOS los cambios (ese era el bug de
    // "edito y no se actualiza"). Separado, el precio/título/etc. se guardan sí
    // o sí, y si las fotos fallan queda avisado sin tumbar lo demás.
    let fotosError = null;
    if (Array.isArray(pictures) && pictures.length) {
      const fuentes = pictures.map((x) => x.source);
      const carga = picturesParaUpdate(after, pictures);
      const nuevas = carga.filter((x) => x.source).length;
      try {
        await axios.put(`${API}/items/${after.mlItemId}`, { pictures: carga }, { headers });
        logger.info(`[FOTOS ${after.mlItemId}] ${carga.length} en la galería (${nuevas} nuevas, ${carga.length - nuevas} ya conocidas).`);
        // Se relee para dejar el mapeo al día: las nuevas ahora tienen id, y si
        // ML descartó alguna, el conteo queda registrado en el log.
        await guardarMapaPics(ref, after.mlItemId, fuentes, headers);
      } catch (ef) {
        fotosError = resumirErrorML(ef.response?.data || ef.message);
        logger.error(`Fotos no actualizadas en ML ${after.mlItemId}:`, JSON.stringify(ef.response?.data || ef.message));
      }
    }
    await setItemDescription(after.mlItemId, after.description, token);

    const cambios = { mlSyncedAt: new Date().toISOString() };
    if (cambioMoneda) {
      // Llegar hasta acá con cambio de moneda significa que el PUT NO falló: ML lo
      // aceptó. Se limpia cualquier error viejo en vez de inventar uno nuevo.
      cambios.mlError = "";
      cambios.mlErrorAt = "";
      logger.info(`ML ${after.mlItemId}: moneda ${before.currency} -> ${after.currency} aceptada`);
    } else if (fotosError) {
      cambios.mlError = "Las fotos no se pudieron actualizar en Mercado Libre (el resto de los cambios sí se guardó): " + fotosError;
      cambios.mlErrorAt = new Date().toISOString();
      if (before.mlError !== cambios.mlError) {
        await notificarErrorML(after, id, "Fotos no actualizadas en Mercado Libre", "El resto de los cambios se guardó. Para renovar las fotos, puede que necesites dar de baja y volver a publicar.");
      }
    } else {
      cambios.mlError = admin.firestore.FieldValue.delete();
      cambios.mlErrorAt = admin.firestore.FieldValue.delete();
    }
    await ref.update(cambios);
    logger.info(`Propiedad ${id} sincronizada con ML (${after.mlItemId})${fotosError ? " [fotos con error]" : ""}.`);
    await registrarLog(id, "sincronizar", !fotosError, after.mlItemId);
    // Tras editar: si la ficha sigue incompleta, recordarle al agente qué falta.
    await notificarFichaIncompleta(ref, id, after, item, token);
  } catch (e) {
    const detail = e.response?.data || e.message;
    const guardado = typeof detail === "string" ? detail : JSON.stringify(detail);
    const resumen = resumirErrorML(detail);
    logger.error(`Error sincronizando ${id} con ML:`, guardado);
    await ref.update({ mlError: guardado, mlErrorAt: new Date().toISOString() });
    await registrarLog(id, "sincronizar", false, resumen);
    if ((before && before.mlError) !== guardado) {
      await notificarErrorML(after, id, "No se pudo sincronizar la edición con Mercado Libre", resumen);
    }
  }
});

// =====================================================================
// 3c) BORRADO — al eliminar una propiedad de la app, su aviso se CIERRA en ML.
//     Antes el documento se borraba y el aviso quedaba huérfano, publicado y
//     activo para siempre en Mercado Libre.
// =====================================================================
exports.cerrarMLAlBorrar = onDocumentDeleted("properties/{id}", async (event) => {
  const p = event.data ? event.data.data() : null;
  const id = event.params.id;
  if (!p) return;
  // PAPELERA: antes de tocar ML se guarda una copia entera del documento en
  // 'papelera/{id}'. Desde papelera.html el admin puede restaurar la propiedad
  // (vuelve con el mismo ID) o eliminarla definitivamente.
  try {
    await db.collection("papelera").doc(id).set(Object.assign({}, p, { _borradaEl: new Date().toISOString() }));
  } catch (e) { logger.error(`No se pudo copiar ${id} a la papelera:`, e.message); }
  // GESTIONES: las gestiones ABIERTAS que apuntaban a esta propiedad pasan a
  // "prop_eliminada" — un estado propio que conserva toda la historia (notas,
  // avances) y NO dispara el aviso de despublicación (la propiedad ya no existe;
  // "perdido" ensuciaría las estadísticas de clientes que dijeron que no).
  // Las terminales (cerrado / externo / perdido) no se tocan: su historia ya cerró.
  try {
    const gs = await db.collection("gestiones").where("propertyId", "==", id).get();
    const terminales = ["cerrado", "perdido", "externo", "prop_eliminada"];
    const nota = { tipo: "avance", valor: "Propiedad eliminada", autor: "Sistema", fecha: new Date().toISOString() };
    for (const gd of gs.docs) {
      const g = gd.data();
      if (terminales.includes(g.estadoGestion)) continue;
      await gd.ref.update({
        estadoGestion: "prop_eliminada",
        propTituloEliminada: p.title || "",
        updatedAt: new Date().toISOString(),
        historial: admin.firestore.FieldValue.arrayUnion(nota),
      });
    }
    if (!gs.empty) logger.info(`[borrado ${id}] gestiones abiertas marcadas como prop_eliminada.`);
  } catch (e) { logger.error(`[borrado ${id}] no se pudieron marcar las gestiones:`, e.message); }
  if (!p.mlItemId) return;
  try {
    const token = await getValidToken();
    const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    // Si el aviso ya estaba cerrado, no hay nada que hacer (y no se molesta a nadie).
    try {
      const live = (await axios.get(`${API}/items/${p.mlItemId}`, { headers })).data;
      if (live.status === "closed") {
        await registrarLog(id, "cerrar al borrar (ya estaba cerrado)", true, p.mlItemId);
        return;
      }
    } catch (e) { /* si no se puede leer, se intenta cerrar igual */ }
    const cierre = await cerrarAvisoEnML(p.mlItemId, headers);
    if (cierre.ok) {
      logger.info(`Propiedad ${id} borrada: aviso ${p.mlItemId} ${cierre.eliminado ? "eliminado (impago)" : "cerrado"} en ML.`);
      await registrarLog(id, "cerrar al borrar", true, `${p.mlItemId}${cierre.eliminado ? " (impago eliminado)" : ""}`);
    } else if (cierre.impago) {
      // Impago que no se pudo eliminar: ML lo descarta solo al vencer, sin costo.
      await registrarLog(id, "cerrar al borrar (impago abandonado)", true, p.mlItemId);
    } else {
      throw cierre.error;
    }
  } catch (e) {
    const detail = e.response?.data || e.message;
    const resumen = resumirErrorML(detail);
    logger.error(`No se pudo cerrar el aviso ${p.mlItemId} de la propiedad borrada ${id}:`, JSON.stringify(detail));
    await registrarLog(id, "cerrar al borrar", false, `${p.mlItemId} · ${resumen}`);
    await notificarErrorML(p, id, `La propiedad se borró pero su aviso ${p.mlItemId} sigue en Mercado Libre`, resumen);
  }
});

// =====================================================================
// 5) USUARIOS NUEVOS — cuando alguien se registra (status: 'pending'), el
//    admin recibe una notificación en la campanita y un push FCM para
//    entrar al panel y aprobarlo o rechazarlo.
// =====================================================================
// Notifica al admin cuando un agente solicita un retiro de dinero.
exports.notificarRetiro = onDocumentCreated("retiros/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const r = snap.data();
  if (!r || r.status !== "pendiente") return;
  const adm = await getAdminUser();
  if (!adm) { await registrarLog("", "solicitud de retiro SIN notificar", false, `No se encontró al admin (${ADMIN_EMAIL}) en users.`); return; }
  if (adm.uid === r.agenteUid) return;
  const simb = r.moneda === "UYU" ? "$U" : "US$";
  const monto = simb + " " + (Number(r.monto) || 0).toLocaleString("es-UY");
  const nombre = r.agenteNombre || "Un agente";
  await crearNotificacion(
    adm,
    {
      type: "retiro",
      propertyId: "",
      propertyTitle: "un retiro — confirmalo en el Panel de Administración",
      userName: `💸 ${nombre}`,
      userPhoto: null,
      text: `${nombre} solicitó retirar ${monto}${r.cuentaBanco ? " a " + r.cuentaBanco : ""}. Revisalo y confirmá el pago.`,
    },
    { title: "💸 Solicitud de retiro", body: `${nombre} pidió cobrar ${monto}.` }
  );
});

// Avisa AL AGENTE cuando su solicitud de retiro cambia de estado: aprobada
// (la plata quedó comprometida) o pagada (el dinero entró a su cuenta). Un solo
// trigger de actualización que mira la transición del status.
exports.notificarEstadoRetiro = onDocumentUpdated("retiros/{id}", async (event) => {
  const before = event.data && event.data.before ? event.data.before.data() : null;
  const after = event.data && event.data.after ? event.data.after.data() : null;
  if (!before || !after) return;
  if (before.status === after.status) return; // no cambió el estado
  if (!after.agenteUid) return;

  // Buscar al agente destinatario (para su fcmToken).
  let agente = null;
  try { const u = await db.doc(`users/${after.agenteUid}`).get(); if (u.exists) agente = { uid: u.id, ...u.data() }; } catch (e) {}
  if (!agente) return;
  if (agente.uid === (await getAdminUser().then((a) => a && a.uid).catch(() => null))) return; // no auto-notificar al admin

  const simb = after.moneda === "UYU" ? "$U" : "US$";
  const monto = simb + " " + (Number(after.monto) || 0).toLocaleString("es-UY");

  if (after.status === "aprobado") {
    await crearNotificacion(
      agente,
      {
        type: "retiro_estado",
        propertyId: "",
        propertyTitle: "tu solicitud de retiro",
        userName: "✅ Retiro aprobado",
        userPhoto: null,
        text: `Tu solicitud de retiro de ${monto} fue aprobada. La transferencia está en curso; te avisamos cuando se acredite.`,
      },
      { title: "✅ Retiro aprobado", body: `Tu retiro de ${monto} fue aprobado.` }
    );
  } else if (after.status === "pagado") {
    await crearNotificacion(
      agente,
      {
        type: "retiro_estado",
        propertyId: "",
        propertyTitle: "tu solicitud de retiro",
        userName: "💰 Dinero acreditado",
        userPhoto: null,
        text: `¡Listo! Se acreditó tu retiro de ${monto}${after.cuentaBanco ? " en tu cuenta de " + after.cuentaBanco : ""}. Ya podés descargar el recibo desde Mis Finanzas.`,
      },
      { title: "💰 Dinero acreditado", body: `Se pagó tu retiro de ${monto}.` }
    );
  } else if (after.status === "rechazado") {
    await crearNotificacion(
      agente,
      {
        type: "retiro_estado",
        propertyId: "",
        propertyTitle: "tu solicitud de retiro",
        userName: "Retiro rechazado",
        userPhoto: null,
        text: `Tu solicitud de retiro de ${monto} fue rechazada${after.motivo ? ": " + after.motivo : ""}. Consultá con la administración.`,
      },
      { title: "Retiro rechazado", body: `Tu retiro de ${monto} fue rechazado.` }
    );
  }
});

// NOTA: acá vivía notificarNuevoUsuario, que escuchaba users/{uid} y avisaba de
// los registros pendientes. Hacía EXACTAMENTE lo mismo que notificarAltaAgente
// (más abajo): mismo disparador, mismo filtro de status, mismo destinatario. El
// resultado era que por cada agente que se registraba llegaban dos avisos a la
// campanita y dos push al celular.
// Se eliminó esta y quedó notificarAltaAgente, porque su tipo 'admin_pendiente'
// tiene plantilla propia en la app (ícono y botón de aprobar); 'new_user' caía en
// la plantilla genérica y salía con el avatar "?" y el texto metido en el campo
// del título de la propiedad.
// El registro en el log de diagnóstico se conservó, movido a notificarAltaAgente.

// =====================================================================
// Permisos de las funciones llamables — antes alcanzaba con tener CUALQUIER
// sesión de Firebase (incluso una cuenta pendiente o rechazada) para republicar
// o dar de baja el aviso de CUALQUIER propiedad. Ahora se exige:
//   - sesión iniciada,
//   - cuenta aprobada (o ser el admin),
//   - y ser el agente dueño de la propiedad (o el admin).
// =====================================================================
async function exigirAgente(request, p) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const uid = request.auth.uid;
  const email = String(request.auth.token.email || "").toLowerCase();
  // Antes acá sólo pasaba el correo del CEO. Ahora pasa Dirección (CEO y COO):
  // por eso el COO puede gestionar el aviso de cualquier agente.
  const esAdmin = await esDireccion(uid, email);
  if (!esAdmin) {
    const u = await db.doc(`users/${uid}`).get();
    const d = u.exists ? u.data() : null;
    if (!d || d.status !== "approved") throw new HttpsError("permission-denied", "Tu cuenta no está aprobada.");
    if (p && p.ownerId && p.ownerId !== uid) throw new HttpsError("permission-denied", "Solo el agente dueño o la Dirección pueden gestionar este aviso.");
  }
  return { uid, esAdmin };
}

// =====================================================================
// 4) GESTIÓN del aviso desde el panel del agente (requieren login).
//    - estadoML:      estado, nivel y qué falta para mejorar la calidad.
//    - republicarML:  reactiva el aviso (o lo vuelve a crear si estaba cerrado).
//    - bajaML:        da de baja (cierra) el aviso en Mercado Libre.
// =====================================================================
exports.estadoML = onCall(async (request) => {
  const propertyId = request.data && request.data.propertyId;
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta el id de la propiedad.");
  const doc = await admin.firestore().collection("properties").doc(propertyId).get();
  if (!doc.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = doc.data();
  await exigirAgente(request, p);
  if (!p.mlItemId) {
    // El error guardado es del ÚLTIMO intento: se antepone la fecha para que se
    // note en el modal si el mensaje es viejo (anterior a la última corrección).
    let err;
    if (p.mlError) {
      const cuando = p.mlErrorAt
        ? new Date(p.mlErrorAt).toLocaleString("es-UY", { timeZone: "America/Montevideo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "";
      err = (cuando ? `[Último intento ${cuando}] ` : "") + resumirErrorML(safeParse(p.mlError));
    }
    // Tipos de aviso que la cuenta puede usar en la categoría de esta propiedad,
    // para que el selector del modal muestre opciones REALES (mejor esfuerzo).
    let tiposDisponibles = null;
    try {
      const token = await getValidToken();
      const cat = await getRealEstateCategory(p, token);
      if (cat) {
        const cuenta = await listingTypesCuenta(cat, token);
        if (cuenta && cuenta.length) tiposDisponibles = cuenta;
      }
    } catch (e) { /* sin token o sin categoría: el modal usa la lista fija */ }
    return { publicado: false, error: err, tiposDisponibles };
  }
  const token = await getValidToken();
  const headers = { Authorization: `Bearer ${token}` };
  let item;
  try {
    const r = await axios.get(`${API}/items/${p.mlItemId}`, { headers });
    item = r.data;
  } catch (e) {
    return { publicado: true, mlItemId: p.mlItemId, error: "No se pudo leer el aviso en Mercado Libre (puede haber sido eliminado)." };
  }
  let health = item.health != null ? item.health : null;
  let actions = [];
  try {
    const h = await axios.get(`${API}/items/${p.mlItemId}/health/actions`, { headers });
    if (h.data.health != null) health = h.data.health;
    actions = (h.data.actions || []).map((a) => a.id || a.name).filter(Boolean);
  } catch (e) { /* algunos avisos no exponen health/actions todavía */ }
  // Detalle de qué falta para subir la calidad: endpoint nuevo y agregado de ML
  // (OJO: ruta singular /item/.../performance). Trae buckets/variables con título
  // en español y estado COMPLETED/PENDING. Listamos solo lo PENDING.
  let mejoras = [];
  try {
    const perf = await axios.get(`${API}/item/${p.mlItemId}/performance`, { headers });
    const pd = perf.data || {};
    if (health == null && pd.score != null) health = pd.score / 100;
    const vistos = new Set();
    (pd.buckets || []).forEach((b) => {
      const vars = Array.isArray(b.variables) ? b.variables : [];
      const pend = vars.filter((v) => v && v.status && String(v.status).toUpperCase() !== "COMPLETED");
      if (pend.length) {
        pend.forEach((v) => {
          const titulo = String(v.title || v.key || "").trim();
          if (titulo && !vistos.has(titulo)) { vistos.add(titulo); mejoras.push({ titulo, grupo: b.title || "" }); }
        });
      } else if (!vars.length && b.status && String(b.status).toUpperCase() !== "COMPLETED") {
        const titulo = String(b.title || b.key || "").trim();
        if (titulo && !vistos.has(titulo)) { vistos.add(titulo); mejoras.push({ titulo, grupo: "" }); }
      }
    });
  } catch (e) { /* /performance puede no estar disponible para este aviso */ }
  // QUÉ FALTA DE VERDAD: comparamos los atributos que ESTA categoría de ML ofrece
  // contra los que el aviso ya tiene cargados. No depende del endpoint de calidad
  // (que en avisos gratuitos/clasificados no da detalle). Además logueamos la lista
  // COMPLETA de atributos de la categoría para alinear el formulario; esto se imprime
  // cada vez que se ABRE el modal (no hace falta publicar para verlo en los logs).
  let faltan = [];
  try {
    const catAttrs = (await axios.get(`${API}/categories/${item.category_id}/attributes`, { headers })).data || [];
    logger.info(`[CAT ${item.category_id}] (${catAttrs.length}) ` + catAttrs.map((a) => {
      const req = (a.tags && (a.tags.required ? "*" : (a.tags.conditional_required ? "?" : ""))) || "";
      const vals = (a.value_type === "list" && Array.isArray(a.values) && a.values.length) ? `{${a.values.map((v) => v.name).join("/")}}` : "";
      return `${a.id}=${a.name}[${a.value_type}]${req}${vals}`;
    }).join(" | "));
    const lleno = new Set();
    (item.attributes || []).forEach((a) => {
      const tiene = (a.value_name != null && String(a.value_name) !== "") || (a.value_id != null && String(a.value_id) !== "") || (Array.isArray(a.values) && a.values.length > 0);
      if (tiene) lleno.add(a.id);
    });
    const noVa = new Set(["OPERATION", "PROPERTY_TYPE", "ITEM_CONDITION"]);
    // Casas/terrenos sin gastos comunes: 0 es lo correcto, no lo marcamos como faltante.
    if (!(Number(p.commonExpenses) > 0)) noVa.add("MAINTENANCE_FEE");
    const reqM = [], optM = [];
    catAttrs.forEach((a) => {
      if (lleno.has(a.id) || noVa.has(a.id)) return;
      const t = a.tags || {};
      if (t.hidden || t.read_only || t.fixed) return;
      // Checkboxes (Sí/No): sin tildar significa que la propiedad NO lo tiene, no
      // que falte completarlo. Solo se reclama un booleano si ML lo exige obligatorio.
      if (a.value_type === "boolean" && !(t.required || t.conditional_required)) return;
      (t.required || t.conditional_required ? reqM : optM).push({ nombre: a.name, id: a.id });
    });
    faltan = reqM.map((x) => ({ ...x, req: true })).concat(optM.map((x) => ({ ...x, req: false })));
  } catch (e) { logger.warn(`[estadoML faltan] ${e.response ? e.response.status : e.message}`); }
  // Interacción del aviso (estadísticas de Inmuebles de ML), últimos 30 días.
  const _hasta = new Date().toISOString();
  const _desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const _total = (data) => {
    if (data == null) return null;
    if (typeof data === "number") return data;
    if (Array.isArray(data)) return data.reduce((s, r) => s + ((r && r.total != null) ? r.total : 0), 0);
    if (data.total != null) return data.total;
    if (data.total_visits != null) return data.total_visits;
    if (data.quantity != null) return data.quantity;
    for (const k of ["results", "visits_detail", "detail", "contacts"]) {
      if (Array.isArray(data[k])) return data[k].reduce((s, r) => s + ((r && (r.total != null ? r.total : r.quantity)) || 0), 0);
    }
    return null;
  };
  const _fetchTotal = async (intentos, etiqueta, onData) => {
    for (const it of intentos) {
      try {
        const r = await axios.get(`${API}${it.url}`, { headers, params: it.params });
        logger.info(`[metricaML ${etiqueta || ""}] ${it.url} OK ${JSON.stringify(r.data).slice(0, 250)}`);
        const t = _total(r.data);
        if (t != null) { if (onData) { try { onData(r.data); } catch (e) { } } return t; }
      } catch (e) {
        const _st = e.response ? e.response.status : "";
        const _body = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 220) : String(e.message || "").slice(0, 120);
        logger.warn(`[metricaML ${etiqueta || ""}] ${it.url} ERR ${_st} ${_body}`);
      }
    }
    return null;
  };
  let _visSerie = null;
  const visitas = await _fetchTotal([
    { url: `/items/${p.mlItemId}/visits/time_window`, params: { last: 30, unit: "day" } },
  ], "visitas", (data) => {
    if (data && Array.isArray(data.results)) {
      _visSerie = data.results.map((r) => ({ date: r.date, total: Number(r.total) || 0 }));
    }
  });
  const _pregTotal = await _fetchTotal([
    { url: `/items/${p.mlItemId}/contacts/questions`, params: { date_from: _desde, date_to: _hasta } },
    { url: `/items/${p.mlItemId}/contacts/questions/time_window`, params: { last: 30, unit: "day" } },
  ], "preguntas");
  const preguntas = _pregTotal != null ? { total: _pregTotal, sinResponder: null } : null;
  const contactosWa = await _fetchTotal([
    { url: `/items/${p.mlItemId}/contacts/whatsapp`, params: { date_from: _desde, date_to: _hasta } },
    { url: `/items/${p.mlItemId}/contacts/whatsapp/time_window`, params: { last: 30, unit: "day" } },
    { url: `/items/contacts/whatsapp/time_window`, params: { ids: p.mlItemId, last: 30, unit: "day" } },
  ], "whatsapp");
  // Se guarda en la propiedad para que la grilla pueda mostrarla sin pegarle a la
  // API de Mercado Libre por cada tarjeta. Se hace sin await a propósito: si la
  // escritura falla, el modal igual tiene que responder.
  if (health != null) {
    admin.firestore().collection("properties").doc(propertyId)
      .update({ mlHealth: health, mlHealthAt: new Date().toISOString() })
      .catch((e) => logger.warn("No se pudo cachear la salud ML:", e.message));
  }
  return {
    publicado: true,
    mlItemId: p.mlItemId,
    status: item.status,
    subStatus: item.sub_status || [],
    listingType: item.listing_type_id || "",
    permalink: item.permalink || p.mlPermalink || "",
    health,
    actions,
    mejoras,
    faltan,
    visitas: visitas,
    visitasSerie: _visSerie,
    preguntas: preguntas,
    contactosWhatsapp: contactosWa,
  };
});

// Intenta parsear el mlError guardado (suele ser JSON de ML en texto).
function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return s; }
}

exports.republicarML = onCall(async (request) => {
  const propertyId = request.data && request.data.propertyId;
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta el id de la propiedad.");
  // Tipo de aviso elegido A MANO por el agente en el modal (opcional).
  const ltRaw = request.data && request.data.listingType;
  const listingType = TIPOS_AVISO_VALIDOS.includes(ltRaw) ? ltRaw : null;
  const ref = admin.firestore().collection("properties").doc(propertyId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = doc.data();
  await exigirAgente(request, p);
  const token = await getValidToken();
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  // Si ya hay aviso, decidir según su estado y el tipo elegido.
  if (p.mlItemId) {
    let recrear = false;
    try {
      const r = await axios.get(`${API}/items/${p.mlItemId}`, { headers });
      const st = r.data.status;
      const tipoActual = r.data.listing_type_id;
      if (st === "closed") {
        recrear = true; // se recrea más abajo
      } else if (listingType && listingType !== tipoActual) {
        // El agente eligió OTRO tipo de aviso: se cierra (o elimina, si está
        // impago) el actual y se crea uno nuevo con el tipo elegido.
        const cierre = await cerrarAvisoEnML(p.mlItemId, headers);
        if (cierre.ok) {
          await registrarLog(propertyId, "baja para cambiar tipo de aviso", true, `${p.mlItemId}: ${tipoActual} -> ${listingType}${cierre.eliminado ? " (impago eliminado)" : ""}`);
        } else if (cierre.impago) {
          await ref.update({ mlAbandonados: admin.firestore.FieldValue.arrayUnion(p.mlItemId) });
          await registrarLog(propertyId, "baja para cambiar tipo de aviso (impago abandonado)", true, p.mlItemId);
        } else {
          const d2 = cierre.error && (cierre.error.response?.data || cierre.error.message);
          throw new HttpsError("internal", "No se pudo cerrar el aviso actual para cambiar el tipo: " + resumirErrorML(d2));
        }
        recrear = true;
      } else if (st === "paused") {
        await axios.put(`${API}/items/${p.mlItemId}`, { status: "active" }, { headers });
        await ref.update({ mlStatus: "active" });
        await registrarLog(propertyId, "republicar (reactivado)", true, p.mlItemId);
        return { ok: true, reactivado: true, mlItemId: p.mlItemId, permalink: r.data.permalink || "" };
      } else {
        // active, payment_required, under_review...: el aviso YA existe con ese
        // mismo tipo; no se recrea (evita duplicados).
        await ref.update({ mlStatus: st });
        return { ok: true, yaExiste: true, status: st, mlItemId: p.mlItemId, permalink: r.data.permalink || "" };
      }
    } catch (e) { if (e instanceof HttpsError) throw e; recrear = true; /* no se pudo leer; se recrea */ }
    if (recrear) {
      await ref.update({
        mlItemId: admin.firestore.FieldValue.delete(),
        mlStatus: admin.firestore.FieldValue.delete(),
        mlPermalink: admin.firestore.FieldValue.delete(),
      });
    }
  }
  // Crear el aviso, pasando por el MISMO candado que la publicación automática
  // (un doble clic en el botón ya no puede crear dos avisos).
  const res = await crearAvisoML(ref, propertyId, { mlRepublishedAt: new Date().toISOString() }, { listingType });
  if (res.ok) return { ok: true, recreado: true, mlItemId: res.mlItemId, permalink: res.permalink };
  if (res.omitido) throw new HttpsError("failed-precondition", "La propiedad no está Disponible o ya hay una publicación en curso.");
  throw new HttpsError("internal", res.error || "No se pudo republicar.");
});


// =====================================================================
// TRASPASO DE CARTERA — mueve todo lo de un agente a otro.
// ---------------------------------------------------------------------
// Cuando un agente deja la agencia no alcanza con reasignar en el CRM: el
// teléfono del aviso de Mercado Libre se graba DENTRO del aviso al publicarlo,
// así que los avisos ya publicados seguirían mostrando el número del que se
// fue. Por eso, además de reasignar, acá se empuja a ML el contacto nuevo de
// cada aviso vivo.
// InfoCasas y el propio CRM no necesitan nada: leen el dueño en cada consulta.
// =====================================================================
exports.traspasarCartera = onCall(async (request) => {
  const email = (request.auth && request.auth.token && request.auth.token.email || "").toLowerCase();
  const uid = request.auth && request.auth.uid;
  if (!await esDireccion(uid, email)) throw new HttpsError("permission-denied", "Solo la Dirección puede traspasar una cartera.");

  const { deUid, aUid, mueve } = request.data || {};
  if (!deUid || !aUid) throw new HttpsError("invalid-argument", "Faltan los agentes.");
  if (deUid === aUid) throw new HttpsError("invalid-argument", "El origen y el destino son el mismo agente.");
  const quiere = Object.assign({ propiedades: true, clientes: true, gestiones: true }, mueve || {});

  const [deSnap, aSnap] = await Promise.all([
    db.collection("users").doc(deUid).get(),
    db.collection("users").doc(aUid).get(),
  ]);
  if (!aSnap.exists) throw new HttpsError("not-found", "El agente destino no existe.");
  const de = deSnap.exists ? deSnap.data() : {};
  const a = aSnap.data();
  const aNombre = a.name || a.email || "Agente";
  const ahora = new Date().toISOString();

  const resumen = { propiedades: 0, clientes: 0, gestiones: 0, avisosActualizados: 0, avisosConError: [] };

  // ---- Propiedades ----
  let propsConAviso = [];
  if (quiere.propiedades) {
    const q = await db.collection("properties").where("ownerId", "==", deUid).get();
    for (const doc of q.docs) {
      const p = doc.data();
      const agentes = Array.isArray(p.agents) ? p.agents.filter((x) => x !== deUid) : [];
      if (!agentes.includes(aUid)) agentes.push(aUid);
      await doc.ref.update({
        ownerId: aUid,
        ownerName: aNombre,
        agents: agentes,
        // El WhatsApp propio de la propiedad pisa al del perfil: si queda el del
        // agente que se fue, el traspaso no serviría de nada.
        ownerWhatsapp: admin.firestore.FieldValue.delete(),
        traspasoAt: ahora,
        updatedAt: ahora,
      });
      resumen.propiedades++;
      if (p.mlItemId) propsConAviso.push({ id: doc.id, mlItemId: p.mlItemId });
    }
  }

  // ---- Clientes ----
  if (quiere.clientes) {
    const q = await db.collection("clients").where("createdBy", "==", deUid).get();
    for (const doc of q.docs) {
      const c = doc.data();
      const lista = (Array.isArray(c.enLista) ? c.enLista : []).filter((x) => x && x.uid !== deUid && x.uid !== aUid);
      lista.push({ uid: aUid, nombre: aNombre, desde: ahora });
      await doc.ref.update({
        createdBy: aUid,
        createdByName: aNombre,
        enLista: lista,
        updatedAt: ahora,
        traspasos: admin.firestore.FieldValue.arrayUnion({
          de: deUid, deNombre: de.name || de.email || "", a: aUid, aNombre,
          fecha: ahora, por: email, motivo: "traspaso de cartera",
        }),
      });
      resumen.clientes++;
    }
  }

  // ---- Gestiones ----
  if (quiere.gestiones) {
    // La gestión guarda el agente en varios campos y la tarjeta del CRM muestra
    // agentName: si solo se cambia createdBy, en pantalla sigue figurando el que
    // se fue. Se buscan por los dos campos porque no todas las gestiones viejas
    // tienen agentId.
    const vistos = new Set();
    for (const campo of ["createdBy", "agentId", "ownerId"]) {
      const q = await db.collection("gestiones").where(campo, "==", deUid).get();
      for (const doc of q.docs) {
        if (vistos.has(doc.id)) continue;
        vistos.add(doc.id);
        await doc.ref.update({
          createdBy: aUid, createdByName: aNombre,
          agentId: aUid, agentName: aNombre, ownerId: aUid,
          updatedAt: ahora,
        });
        resumen.gestiones++;
      }
    }
  }

  // ---- Mercado Libre: contacto nuevo en cada aviso vivo ----
  if (propsConAviso.length) {
    let token = null;
    try { token = await getValidToken(); }
    catch (e) { logger.warn("traspasarCartera: sin token de ML —", e.message); }
    if (token) {
      const headers = { Authorization: `Bearer ${token}` };
      for (const item of propsConAviso) {
        try {
          const doc = await db.collection("properties").doc(item.id).get();
          const contacto = await buildSellerContact(doc.data());
          await axios.put(`${API}/items/${item.mlItemId}`, { seller_contact: contacto }, { headers });
          resumen.avisosActualizados++;
        } catch (e) {
          const detalle = (e.response && e.response.data && (e.response.data.message || e.response.data.error)) || e.message;
          resumen.avisosConError.push({ itemId: item.mlItemId, error: String(detalle).slice(0, 120) });
          logger.warn(`traspasarCartera: no se pudo actualizar ${item.mlItemId} —`, detalle);
        }
      }
    } else {
      resumen.avisosConError.push({ itemId: "-", error: "No hay conexión con Mercado Libre" });
    }
  }

  // ---- Registro del traspaso ----
  await db.collection("traspasos").add({
    de: deUid, deNombre: de.name || de.email || "", a: aUid, aNombre,
    por: email, fecha: ahora, resumen,
  });

  logger.info(`Traspaso ${de.name || deUid} -> ${aNombre}: ${resumen.propiedades} propiedades, ${resumen.clientes} clientes, ${resumen.avisosActualizados} avisos actualizados`);
  return resumen;
});


// =====================================================================
// TRASPASO DE PROPIEDADES SUELTAS — mismo criterio que el traspaso de cartera,
// pero para un puñado de propiedades elegidas (por ejemplo, las de un cliente
// que se reasigna). Actualiza el dueño, limpia el WhatsApp propio y empuja a
// Mercado Libre el contacto nuevo de cada aviso vivo.
// =====================================================================
exports.traspasarPropiedades = onCall(async (request) => {
  const email = (request.auth && request.auth.token && request.auth.token.email || "").toLowerCase();
  const uid = request.auth && request.auth.uid;
  if (!await esDireccion(uid, email)) throw new HttpsError("permission-denied", "Solo la Dirección puede traspasar propiedades.");

  const { propertyIds, aUid, soloDe } = request.data || {};
  if (!Array.isArray(propertyIds) || !propertyIds.length) throw new HttpsError("invalid-argument", "No se indicaron propiedades.");
  if (!aUid) throw new HttpsError("invalid-argument", "Falta el agente destino.");

  const aSnap = await db.collection("users").doc(aUid).get();
  if (!aSnap.exists) throw new HttpsError("not-found", "El agente destino no existe.");
  const aNombre = aSnap.data().name || aSnap.data().email || "Agente";
  const ahora = new Date().toISOString();
  const resumen = { propiedades: 0, omitidas: 0, avisosActualizados: 0, avisosConError: [] };

  let token = null;
  try { token = await getValidToken(); } catch (e) { logger.warn("traspasarPropiedades: sin token de ML —", e.message); }
  const headers = token ? { Authorization: `Bearer ${token}` } : null;

  for (const pid of propertyIds) {
    const ref = db.collection("properties").doc(String(pid));
    const doc = await ref.get();
    if (!doc.exists) continue;
    const p = doc.data();
    if (p.ownerId === aUid) continue;            // ya es de ese agente
    // Un cliente puede tener varias propiedades con distintos agentes. Si se
    // indica de quién se está traspasando, no se tocan las de los demás.
    if (soloDe && p.ownerId !== soloDe) { resumen.omitidas = (resumen.omitidas || 0) + 1; continue; }
    const agentes = Array.isArray(p.agents) ? p.agents.filter((x) => x !== p.ownerId) : [];
    if (!agentes.includes(aUid)) agentes.push(aUid);
    await ref.update({
      ownerId: aUid, ownerName: aNombre, agents: agentes,
      ownerWhatsapp: admin.firestore.FieldValue.delete(),
      traspasoAt: ahora, updatedAt: ahora,
    });
    resumen.propiedades++;

    if (p.mlItemId && headers) {
      try {
        const fresco = await ref.get();
        const contacto = await buildSellerContact(fresco.data());
        await axios.put(`${API}/items/${p.mlItemId}`, { seller_contact: contacto }, { headers });
        resumen.avisosActualizados++;
      } catch (e) {
        const detalle = (e.response && e.response.data && (e.response.data.message || e.response.data.error)) || e.message;
        resumen.avisosConError.push({ itemId: p.mlItemId, error: String(detalle).slice(0, 120) });
      }
    } else if (p.mlItemId) {
      resumen.avisosConError.push({ itemId: p.mlItemId, error: "No hay conexión con Mercado Libre" });
    }
  }

  logger.info(`Traspaso de ${resumen.propiedades} propiedades a ${aNombre}, ${resumen.avisosActualizados} avisos actualizados`);
  return resumen;
});

exports.bajaML = onCall(async (request) => {
  const propertyId = request.data && request.data.propertyId;
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta el id de la propiedad.");
  const ref = admin.firestore().collection("properties").doc(propertyId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = doc.data();
  // SOLO ADMIN. La baja manual es irreversible en ML (el aviso no se reabre: hay
  // que crear uno nuevo, y si es de pago se vuelve a cobrar) y no toca el estado
  // de la propiedad en el CRM, así que dejaría el aviso muerto en ML con la
  // propiedad figurando "Disponible" acá y en el feed de InfoCasas. El camino del
  // agente es cerrar la gestión del cliente: el espejo de estado (ML_STATUS_MAP)
  // baja el aviso solo y queda registrado el motivo. Se valida en el backend
  // además de en la UI: el botón oculto no alcanza si alguien llama la función.
  const { esAdmin } = await exigirAgente(request, p);
  if (!esAdmin) {
    throw new HttpsError(
      "permission-denied",
      "La baja de un aviso la hace el administrador. Para sacar esta propiedad de circulación, cerrá su gestión en Clientes (Cerrado / Cerró por afuera / Perdido).",
    );
  }
  if (!p.mlItemId) throw new HttpsError("failed-precondition", "Esta propiedad no está publicada en Mercado Libre.");
  const token = await getValidToken();
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const cierre = await cerrarAvisoEnML(p.mlItemId, headers);
  if (cierre.ok && cierre.eliminado) {
    // Impago eliminado: ya no existe en ML; la propiedad queda libre para republicar.
    await ref.update({
      mlItemId: admin.firestore.FieldValue.delete(),
      mlStatus: admin.firestore.FieldValue.delete(),
      mlPermalink: admin.firestore.FieldValue.delete(),
      mlBajaAt: new Date().toISOString(),
    });
    await registrarLog(propertyId, "baja (impago eliminado)", true, p.mlItemId);
    return { ok: true, eliminado: true };
  }
  if (cierre.ok) {
    await ref.update({ mlStatus: "closed", mlBajaAt: new Date().toISOString() });
    await registrarLog(propertyId, "baja manual", true, p.mlItemId);
    return { ok: true };
  }
  if (cierre.impago) {
    // Ni cerrar ni eliminar lo dejó ML: se abandona. Los avisos impagos se
    // descartan solos al vencer, sin costo. Queda anotado para que el rescate
    // no lo readopte, y la propiedad queda libre al instante.
    await ref.update({
      mlItemId: admin.firestore.FieldValue.delete(),
      mlStatus: admin.firestore.FieldValue.delete(),
      mlPermalink: admin.firestore.FieldValue.delete(),
      mlAbandonados: admin.firestore.FieldValue.arrayUnion(p.mlItemId),
      mlBajaAt: new Date().toISOString(),
    });
    await registrarLog(propertyId, "baja (impago abandonado)", true, `${p.mlItemId}: ML lo descarta solo al vencer, sin costo`);
    return { ok: true, abandonado: true };
  }
  const detail = cierre.error && (cierre.error.response?.data || cierre.error.message);
  logger.error(`Error dando de baja ${propertyId}:`, JSON.stringify(detail));
  await registrarLog(propertyId, "baja manual", false, resumirErrorML(detail));
  throw new HttpsError("internal", typeof detail === "string" ? detail : ((detail && detail.message) || "No se pudo dar de baja."));
});

// ============================================================
// PEDIDO DE BAJA (el agente pide, el admin decide)
// ------------------------------------------------------------
// El agente no da de baja: la PIDE. El pedido le llega al admin a la campanita
// (con push) usando la MISMA notificación que el flujo automático de "cerró por
// afuera", así el admin resuelve todo desde un solo lugar y con los dos botones
// que ya conoce: Despublicar / Mantener publicada.
//
// Mientras tanto la propiedad NO se toca: sigue publicada hasta que el admin
// decida. Es la misma regla de siempre — lo publicado se asume con permiso.
// ============================================================
exports.pedirBajaPropiedad = onCall(async (request) => {
  const propertyId = request.data && request.data.propertyId;
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta el id de la propiedad.");
  const motivo = String((request.data && request.data.motivo) || "").trim().slice(0, 300);
  const ref = db.collection("properties").doc(propertyId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = doc.data();
  const { uid } = await exigirAgente(request, p); // agente dueño del aviso, o admin
  if (p.despubPendiente === true) {
    throw new HttpsError("already-exists", "Ya hay un pedido de baja esperando la decisión del administrador.");
  }
  if (p.status === "archived") throw new HttpsError("failed-precondition", "Esta propiedad ya está dada de baja.");
  const adm = await getAdminUser();
  if (!adm) throw new HttpsError("failed-precondition", "No se encontró al administrador para avisarle. Avisale por otra vía.");

  let quien = "Un agente";
  try {
    const u = await db.doc(`users/${uid}`).get();
    if (u.exists) quien = u.data().name || u.data().email || quien;
  } catch (e) { logger.warn("pedirBajaPropiedad: no se pudo leer el nombre del agente:", e.message); }

  const titulo = p.title || "sin título";
  await notificarDireccion({
    type: "despublicar_confirmar",
    propertyId,
    propertyTitle: titulo,
    userName: "Pedido de baja",
    userPhoto: null,
    text: `${quien} pide dar de baja "${titulo}"${motivo ? `. Motivo: ${motivo}` : "."} Confirmá si hay que despublicarla o mantenerla.`,
  }, {
    title: "🏠 Un agente pide dar de baja",
    body: `${titulo} — ${quien}`,
  });

  // statusPrevioDespub se guarda aunque el estado no cambie: es lo que lee
  // "Mantener publicada" para restaurar. Sin esto, una propiedad Reservada
  // volvería como Disponible al rechazarse el pedido.
  await ref.update({
    despubPendiente: true,
    statusPrevioDespub: p.status || "available",
    bajaSolicitadaPor: quien,
    bajaSolicitadaUid: uid,
    bajaSolicitadaAt: new Date().toISOString(),
    bajaSolicitadaMotivo: motivo || null,
  });
  logger.info(`[pedido de baja] ${propertyId}: ${quien}${motivo ? ` — ${motivo}` : ""}`);
  return { ok: true };
});

// El agente que pidió la baja tiene derecho a una respuesta. Cuando el admin
// resuelve (despubPendiente deja de estar), se le avisa cómo salió. Sin esto el
// pedido se siente como un pozo: se manda y nunca se sabe en qué quedó.
exports.avisarResolucionBaja = onDocumentUpdated("properties/{id}", async (event) => {
  const antes = event.data.before.data() || {};
  const ahora = event.data.after.data() || {};
  if (antes.despubPendiente !== true || ahora.despubPendiente === true) return;
  const uid = antes.bajaSolicitadaUid;
  if (!uid) return; // pedido automático (cerró por afuera), no lo pidió nadie a mano
  const titulo = ahora.title || antes.title || "una propiedad";
  const dadaDeBaja = ahora.status === "archived";
  let destino = null;
  try {
    const u = await db.doc(`users/${uid}`).get();
    if (u.exists) destino = { uid, ...u.data() };
  } catch (e) { logger.warn("avisarResolucionBaja:", e.message); }
  if (!destino) return;
  await crearNotificacion(destino, {
    type: "baja_resuelta",
    propertyId: event.params.id,
    propertyTitle: titulo,
    userName: dadaDeBaja ? "Baja aprobada" : "Baja rechazada",
    userPhoto: null,
    resultado: dadaDeBaja ? "despublicada" : "mantenida",
    text: dadaDeBaja
      ? `El administrador dio de baja "${titulo}". Ya salió de la web y de los portales.`
      : `El administrador decidió mantener publicada "${titulo}". Si hay algo que no cuadra, hablalo con él.`,
  }, {
    title: dadaDeBaja ? "✅ Baja aprobada" : "↩️ La propiedad se mantiene",
    body: titulo,
  });
  // Los datos del pedido ya cumplieron su función.
  try {
    await event.data.after.ref.update({
      bajaSolicitadaUid: admin.firestore.FieldValue.delete(),
      bajaSolicitadaPor: admin.firestore.FieldValue.delete(),
      bajaSolicitadaAt: admin.firestore.FieldValue.delete(),
      bajaSolicitadaMotivo: admin.firestore.FieldValue.delete(),
    });
  } catch (e) { logger.warn("avisarResolucionBaja limpieza:", e.message); }
});

// ============================================================
// SALUD DE VARIOS AVISOS DE UNA (lo que usa la grilla)
// ------------------------------------------------------------
// El cron diario mantiene la cartera al día, pero un aviso publicado hoy no
// tendría anillo hasta mañana — o hasta que alguien le abriera el modal, que es
// justo lo que el anillo viene a evitar. Esto lo resuelve: la grilla pide de una
// sola vez las que le faltan y Mercado Libre las devuelve de a veinte.
// ============================================================
exports.saludMLLote = onCall(async (request) => {
  await exigirAgente(request, null); // basta con ser agente aprobado: no es dato sensible
  const pedidos = (request.data && request.data.propertyIds) || [];
  if (!Array.isArray(pedidos) || !pedidos.length) return { salud: {} };
  // Tope duro: una grilla grande no debe poder disparar cien llamadas a ML.
  const ids = pedidos.slice(0, 80);

  const docs = await Promise.all(ids.map((id) => db.collection("properties").doc(id).get()));
  const porItem = new Map();
  docs.forEach((d) => { if (d.exists && d.data().mlItemId) porItem.set(d.data().mlItemId, d.id); });
  if (!porItem.size) return { salud: {} };

  let token;
  try { token = await getValidToken(); } catch (e) {
    logger.warn("saludMLLote: sin token —", e.message);
    return { salud: {} };
  }
  const headers = { Authorization: `Bearer ${token}` };
  const itemIds = [...porItem.keys()];
  const ahora = new Date().toISOString();
  const salud = {};
  const escrituras = [];

  for (let i = 0; i < itemIds.length; i += 20) {
    const lote = itemIds.slice(i, i + 20);
    try {
      const r = await axios.get(`${API}/items`, {
        headers, params: { ids: lote.join(","), attributes: "id,health" },
      });
      (r.data || []).forEach((row) => {
        const c = row && row.body;
        if (!c || !c.id || c.health == null) return;
        const propId = porItem.get(c.id);
        if (!propId) return;
        salud[propId] = c.health;
        escrituras.push(
          db.collection("properties").doc(propId)
            .update({ mlHealth: c.health, mlHealthAt: ahora })
            .catch(() => {}),
        );
      });
    } catch (e) {
      logger.warn(`saludMLLote: falló un lote de ${lote.length} —`, e.message);
    }
  }
  await Promise.all(escrituras);
  return { salud, medidoEn: ahora };
});

// ============================================================
// REFRESCO DIARIO DE LA CALIDAD DE LOS AVISOS
// ------------------------------------------------------------
// La grilla muestra un anillo con el porcentaje de calidad de cada aviso. Ese dato
// solo existe en la API de Mercado Libre, y no se le puede pegar una vez por
// tarjeta. Acá se trae de a veinte avisos por llamada (multiget) y se guarda en
// cada propiedad, así la grilla lo lee de lo que ya tiene cargado.
// ============================================================
exports.refrescarSaludML = onSchedule(
  { schedule: "30 5 * * *", timeZone: "America/Montevideo" },
  async () => {
    let token;
    try { token = await getValidToken(); } catch (e) {
      logger.warn("refrescarSaludML: sin token de Mercado Libre —", e.message); return;
    }
    const headers = { Authorization: `Bearer ${token}` };
    const snap = await db.collection("properties").where("mlItemId", "!=", null).get();
    const items = snap.docs.filter((d) => d.data().mlItemId);
    if (!items.length) { logger.info("refrescarSaludML: no hay avisos publicados"); return; }

    const porId = new Map(items.map((d) => [d.data().mlItemId, d.id]));
    const ids = [...porId.keys()];
    const ahora = new Date().toISOString();
    let ok = 0, fallos = 0;

    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      try {
        const r = await axios.get(`${API}/items`, {
          headers, params: { ids: lote.join(","), attributes: "id,health" },
        });
        const escrituras = [];
        (r.data || []).forEach((row) => {
          const cuerpo = row && row.body;
          if (!cuerpo || !cuerpo.id) return;
          const propId = porId.get(cuerpo.id);
          // health puede venir null en avisos que ML todavía no evaluó: en ese caso
          // se deja el valor anterior en vez de pisarlo con nada.
          if (!propId || cuerpo.health == null) return;
          escrituras.push(
            db.collection("properties").doc(propId)
              .update({ mlHealth: cuerpo.health, mlHealthAt: ahora })
              .then(() => { ok++; })
              .catch(() => { fallos++; }),
          );
        });
        await Promise.all(escrituras);
      } catch (e) {
        fallos += lote.length;
        logger.warn(`refrescarSaludML: falló un lote de ${lote.length} —`, e.message);
      }
    }
    logger.info(`refrescarSaludML: ${ok} avisos actualizados, ${fallos} con problemas.`);
  },
);

// ============================================================
// FEED XML PARA INFOCASAS
// InfoCasas lee esta URL periódicamente y sincroniza los avisos
// (alta, edición y baja automáticas). Se incluyen todas las
// propiedades activas con geolocalización, precio y fotos.
// URL: https://us-central1-mi-cartera-inmobiliaria.cloudfunctions.net/feedInfocasas
// ============================================================

const IC_DEPTOS = { artigas: 1, canelones: 2, "cerro largo": 3, colonia: 4, durazno: 5, flores: 6, florida: 7, lavalleja: 8, maldonado: 9, montevideo: 10, paysandu: 11, "rio negro": 12, rivera: 13, rocha: 14, salto: 15, "san jose": 16, soriano: 17, tacuarembo: 18, "treinta y tres": 19 };

// Zona por defecto de cada departamento (ciudad principal) cuando el barrio no matchea.
const IC_ZONA_DEFAULT = { 1: 188, 2: 140, 3: 201, 4: 213, 5: 238, 6: 242, 7: 246, 8: 257, 9: 84, 10: 21, 11: 263, 12: 271, 13: 287, 14: 303, 15: 309, 16: 318, 17: 328, 18: 337, 19: 340 };

// Zonas de InfoCasas (Anexo 3 del doc), claves normalizadas (minúsculas, sin acentos).
const IC_ZONAS = {
  10: { "buceo": 1, "parque batlle": 2, "parque rodo": 3, "pocitos": 4, "pocitos nuevo": 5, "puerto buceo": 6, "punta carretas": 7, "villa biarritz": 8, "villa dolores": 9, "banados de carrasco": 10, "barra de carrasco": 11, "barrios privados": 12, "carrasco": 13, "carrasco este": 14, "carrasco norte": 15, "malvin": 16, "parque miramar": 17, "punta gorda": 18, "aguada": 19, "barrio sur": 20, "centro": 21, "ciudad vieja": 22, "cordon": 23, "la comercial": 24, "palermo": 25, "puerto": 26, "tres cruces": 27, "villa munoz": 28, "aires puros": 29, "arroyo seco": 30, "atahualpa": 31, "bella vista": 32, "brazo oriental": 33, "capurro": 34, "capurro bella vista": 35, "cerrito": 36, "cerrito de la victoria": 36, "goes": 37, "jacinto vera": 38, "paso molino": 39, "prado": 40, "prado nueva savona": 41, "reducto": 42, "perez castellanos": 43, "la figurita": 44, "bella italia": 45, "bolivar": 46, "flor de maronas": 47, "ituzaingo": 48, "jardines del hipodromo": 49, "la blanqueada": 50, "larranaga": 51, "las canteras": 52, "malvin norte": 53, "manga": 54, "maronas": 55, "mercado modelo": 56, "piedras blancas": 57, "punta rieles": 58, "union": 59, "villa espanola": 60, "villa garcia manga rural": 61, "villa garcia": 61, "casavalle": 62, "colon": 63, "conciliacion": 64, "las acacias": 65, "lezica": 66, "melilla": 67, "penarol": 68, "penarol lavalleja": 69, "sayago": 70, "marconi": 71, "belvedere": 72, "casabo": 73, "casabo pajas blancas": 74, "cerro": 75, "la teja": 76, "nuevo paris": 77, "paso de la arena": 78, "tres ombues pblo victoria": 79, "tres ombues": 79, "la paloma tomkinson": 80, "pajas blancas": 81, "golf": 343, "la caleta": 347, "barrio san nicolas": 4753, "barrio parques": 4754, "los olivos": 4755, "zen pueblo jardin": 4756, "jardines de carrasco": 4757 },
  2: { "atlantida": 2177, "atlantida sur": 2177, "atlantida norte": 2178, "estacion atlantida": 2178, "balneario argentino": 137, "barra de carrasco": 138, "paso carrasco": 2547, "bello horizonte": 139, "canelones": 140, "ciudad de la costa": 141, "colinas de solymar": 142, "costa azul": 143, "cuchilla alta": 144, "el bosque": 145, "el pinar": 146, "empalme olmos": 147, "fortin de santa rosa": 148, "guazu vira": 149, "guazuvira": 149, "jaureguiberry": 150, "la floresta": 151, "la paz": 152, "la tuna": 153, "lagomar": 154, "las piedras": 155, "las toscas": 156, "lomas de solymar": 157, "los cerrillos": 158, "los titanes": 159, "marindia": 160, "medanos de solymar": 161, "migues": 162, "montes de solymar": 163, "neptunia": 164, "pando": 165, "parque de solymar": 166, "parque del plata": 2228, "parque del plata sur": 2228, "parque del plata norte": 2227, "las vegas": 2173, "pinamar": 168, "pinares de solymar": 169, "progreso": 170, "salinas": 171, "san antonio": 172, "san cristobal": 173, "san jacinto": 174, "san luis": 175, "san ramon": 176, "santa ana": 177, "santa lucia": 178, "santa lucia del este": 179, "santa rosa": 180, "sauce": 181, "shangrila": 182, "solymar": 183, "tala": 184, "toledo": 185, "villa argentina": 186, "barrios privados": 187, "la tahona": 4736, "lomas de la tahona": 4737, "altos de la tahona": 4738, "vinedos de la tahona": 4739, "mirador de la tahona": 4740, "huertas de los horneros": 4741, "pilar de los horneros": 4742, "camino de los horneros": 4743, "la juana": 4744, "carlotta": 4745, "cumbres de carrasco": 4746, "colinas de carrasco": 4747, "las higueritas": 4748, "lomas de carrasco": 4749, "carmel": 4750, "haras del lago": 4751, "la asuncion": 4752, "san jose de carrasco": 345, "colonia nicolich": 355 },
  9: { "aigua": 82, "gregorio aznares": 83, "gregorio aznarez": 83, "maldonado": 84, "pan de azucar": 85, "piriapolis": 86, "beaulieu": 87, "bella vista": 88, "cerro del toro": 90, "cerro san antonio": 91, "fuente venus": 92, "las flores": 93, "los angeles": 94, "playa grande": 95, "playa hermosa": 96, "playa verde": 97, "proa al mar": 99, "proa del mar": 99, "punta colorada": 101, "punta fria": 102, "punta negra": 103, "rinconada": 104, "san francisco": 105, "solis": 106, "portezuelo": 107, "punta ballena": 129, "lagunas del diario": 119, "laguna del diario": 2242, "laguna del sauce": 2243, "solanas": 344, "chihuahua": 2238, "ocean park": 2245, "sauce de portezuelo": 2251, "las cumbres": 2244, "el pejerrey": 2240, "la barra": 117, "la pastora": 118, "lugano": 121, "manantiales": 122, "montoya": 123, "punta piedras": 130, "balneario buenos aires": 2168, "punta del este": 108, "peninsula": 124, "pinares": 125, "playa brava": 126, "playa mansa": 127, "puerto": 128, "punta shopping": 131, "rincon del indio": 132, "roosevelt": 133, "san rafael": 134, "cantegril": 113, "golf": 115, "las delicias": 120, "beverly hills": 112, "arcobaleno": 110, "barrio cordoba": 111, "san carlos": 135, "jose ignacio": 2186, "arenas de jose ignacio": 2186, "la juanita": 2191, "laguna garzon": 2193, "pueblo garzon": 2195, "garzon": 2195, "san vicente": 2197, "santa monica": 2199 },
  14: { "aguas dulces": 290, "barra de valizas": 291, "valizas": 650, "cabo polonio": 2181, "castillos": 294, "chuy": 295, "barra del chuy": 2176, "dieciocho de julio": 296, "18 de julio": 296, "rocha": 303, "lascano": 656, "la coronilla": 655, "la esmeralda": 653, "el palmar": 297, "vuelta del palmar": 297, "punta del diablo": 302, "la paloma": 2206, "costa azul": 646, "la aguada": 647, "arachania": 645, "antoniopolis": 644, "santa maria de rocha": 651, "la pedrera": 2219, "punta rubia": 649, "san antonio": 2224, "oceania del polonio": 648 },
  1: { "artigas": 188, "baltasar brum": 189, "bella union": 190, "bernabe rivera": 191, "cuaro": 192, "javier de viana": 193, "pintadito": 194, "tomas gomensoro": 195, "topador": 196 },
  3: { "acegua": 197, "cerro de las cuentas": 198, "fraile muerto": 199, "isidoro noblia": 200, "melo": 201, "rio branco": 202, "tres islas": 203 },
  4: { "arrivillaga": 204, "artilleros": 205, "barker": 206, "blanca arena": 207, "boca del rosario": 208, "brisas del plata": 209, "carmelo": 210, "cerros de san juan": 211, "colonia cosmopolita": 212, "colonia del sacramento": 213, "colonia miguelete": 214, "colonia valdense": 215, "conchillas": 216, "cufre": 217, "el semillero": 218, "el solado": 219, "estanzuela": 220, "juan lacaze": 221, "la paz": 222, "los pinos": 223, "nueva helvecia": 224, "nueva palmira": 225, "ombues de lavalle": 226, "paraje minuano": 227, "paso minuano": 228, "paso antolin": 229, "pastoreo": 230, "playa azul": 231, "playa britopolis": 232, "playa parant": 233, "puerto ingles": 234, "rosario": 235, "santa regina": 236, "tarariras": 237 },
  5: { "durazno": 238, "san jorge": 239, "santa bernardita": 240 },
  6: { "san gregorio carrio": 241, "trinidad": 242 },
  7: { "25 de agosto": 243, "veinticinco de agosto": 243, "cardal": 244, "cerro colorado": 245, "florida": 246, "fray marcos": 247, "independencia": 248, "la cruz": 249, "pintado": 250, "sarandi grande": 251 },
  8: { "colon": 252, "illescas": 253, "jose pedro varela": 254, "la mariscala": 255, "maria albina": 256, "minas": 257, "piraraja": 258, "solis de mataojo": 259, "zapican": 260, "villa del cerro": 346, "villa serrana": 2845 },
  11: { "chapicuy": 261, "guaviyu": 262, "paysandu": 263, "piedra sola": 264, "quebracho": 265 },
  12: { "algorta": 266, "andresito": 267, "barrio anglo": 268, "cardozo": 269, "carlos reyles": 270, "fray bentos": 271, "general borges": 272, "grecco": 273, "las canas": 274, "nuevo berlin": 275, "pueblo orgoroso": 276, "rincon del bonete": 277, "san javier": 278, "villa maria": 279, "young": 280 },
  13: { "la pedrera": 281, "lagunon": 282, "mandubi": 283, "masoller": 284, "minas de corrales": 285, "paso campamento": 286, "rivera": 287, "santa teresa": 288, "tranqueras": 289 },
  15: { "arenitas blancas": 304, "belen": 306, "colonia 18 de julio": 307, "constitucion": 308, "salto": 309, "termas del arapey": 310, "termas del dayman": 311 },
  16: { "boca del cufre": 312, "delta del tigre": 313, "ecilda paullier": 314, "ituzaingo": 315, "libertad": 316, "playa pascual": 317, "san jose": 318, "san jose de mayo": 319, "scavino": 320, "villa rodriguez": 321, "ciudad del plata": 2811 },
  17: { "canada nieto": 322, "cardona": 323, "dolores": 324, "egana": 325, "florencio sanchez": 326, "jose enrique rodo": 327, "mercedes": 328, "palmitas": 329, "risso": 330, "santa catalina": 331 },
  18: { "clara": 332, "paso bonilla": 333, "paso de los toros": 334, "paso del cerro": 335, "san gregorio de polanco": 336, "tacuarembo": 337, "villa ansina": 338 },
  19: { "isla patrulla": 339, "treinta y tres": 340, "tupambae": 341, "vergara": 342 }
};

// realEstateType de la app -> tipoPropiedad de InfoCasas
const IC_TIPO_PROP = { casa: 1, apartamento: 2, apto: 2, terreno: 3, local: 4, oficina: 5, campo: 6, chacra: 6, garaje: 8, cochera: 8, edificio: 10, hotel: 11, galpon: 12 };

// Comodidades de InfoCasas (Anexo 1 del spec): el MISMO amenity tiene un ID distinto
// según el tipo de propiedad. Mapeo booleano de la ficha ML -> ID de IC por tipoProp.
// _DEPOSITO se agrega aparte cuando la ficha trae WAREHOUSES > 0.
const IC_COMODIDADES = {
  1: { HAS_AIR_CONDITIONING: 39, HAS_ATTIC: 40, HAS_BALCONY: 41, HAS_HEATING: 45, HAS_MAID_ROOM: 49, HAS_INDOOR_FIREPLACE: 50, HAS_NATURAL_GAS: 52, HAS_GYM: 53, HAS_CABLE_TV: 54, HAS_JACUZZI: 55, HAS_GRILL: 59, HAS_SWIMMING_POOL: 60, HAS_CLOSETS: 62, HAS_PLAYROOM: 63, HAS_TERRACE: 66, HAS_DRESSING_ROOM: 68, FURNISHED: 69, HAS_GARDEN: 70, HAS_PATIO: 72, HAS_LAUNDRY: 74, HAS_SAUNA: 76, _DEPOSITO: 48 },
  2: { HAS_BALCONY: 1, HAS_HEATING: 3, HAS_MAID_ROOM: 7, HAS_INDOOR_FIREPLACE: 8, HAS_JACUZZI: 10, HAS_GRILL: 13, HAS_CLOSETS: 15, HAS_TERRACE: 16, HAS_DRESSING_ROOM: 18, FURNISHED: 19, HAS_LIFT: 20, HAS_GYM: 23, HAS_COMMON_LAUNDRY: 25, HAS_SWIMMING_POOL: 27, HAS_PLAYROOM: 28, HAS_PARTY_ROOM: 29, HAS_CABLE_TV: 34, HAS_AIR_CONDITIONING: 36, HAS_NATURAL_GAS: 37, HAS_GARDEN: 71, HAS_PATIO: 73, HAS_LAUNDRY: 75, HAS_SAUNA: 77, _DEPOSITO: 6 },
  4: { HAS_BALCONY: 79, HAS_HEATING: 81, HAS_GRILL: 91, HAS_TERRACE: 94, FURNISHED: 97, HAS_GARDEN: 98, HAS_PATIO: 99, HAS_LAUNDRY: 100, HAS_SAUNA: 101, _DEPOSITO: 84 },
  5: { HAS_AIR_CONDITIONING: 103, HAS_ATTIC: 104, HAS_BALCONY: 105, HAS_HEATING: 109 },
};

/* ============================================================================
   VISITAS DE MERCADO LIBRE
   ----------------------------------------------------------------------------
   El CRM solo mide su propia web: 'views' sube cuando alguien abre
   propiedad.html. Pero el grueso del tráfico está en los portales, así que
   decidir dónde invertir mirando solo la web propia lleva a la conclusión
   equivocada.

   ML expone las visitas por publicación en /visits/items?ids=... Esta función
   las trae y las guarda en la propiedad, para que la herramienta de interés las
   pueda sumar.

   Se guarda mlVisitas (acumulado) y mlVisitasAt (cuándo se consultó). No se
   tocan 'views' ni 'contactClicks': son de la web propia y mezclarlos haría
   imposible saber de dónde vino cada interacción.
   ========================================================================== */

/* Trae las visitas de todas las propiedades publicadas en ML.
   Se llama a mano desde el panel o por el cron de abajo. */
async function traerVisitasML() {
  const token = await getValidToken();
  const snap = await db.collection("properties").where("mlItemId", "!=", "").get();
  const items = [];
  snap.forEach((d) => {
    const id = String(d.data().mlItemId || "").trim();
    if (id) items.push({ ref: d.ref, propId: d.id, itemId: id });
  });
  if (!items.length) return { ok: true, propiedades: 0, actualizadas: 0, nota: "Ninguna propiedad tiene mlItemId." };

  let actualizadas = 0, fallos = 0;
  const detalle = [];
  // De a 20: el endpoint acepta varios ids por llamada y así no lo golpeamos
  // una vez por propiedad.
  for (let i = 0; i < items.length; i += 20) {
    const lote = items.slice(i, i + 20);
    const ids = lote.map((x) => x.itemId).join(",");
    try {
      const res = await axios({
        url: `https://api.mercadolibre.com/visits/items?ids=${encodeURIComponent(ids)}`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000, validateStatus: () => true,
      });
      if (res.status !== 200) {
        fallos += lote.length;
        logger.warn(`traerVisitasML: lote ${i / 20} -> ${res.status}`, res.data);
        continue;
      }
      const d = res.data || {};
      const ahora = new Date().toISOString();
      for (const it of lote) {
        // La respuesta viene como { MLU123: 45, MLU456: 12 }.
        const v = Number(d[it.itemId]);
        if (!Number.isFinite(v)) continue;
        await it.ref.update({ mlVisitas: v, mlVisitasAt: ahora });
        actualizadas++;
        detalle.push({ propertyId: it.propId, itemId: it.itemId, visitas: v });
      }
    } catch (e) {
      fallos += lote.length;
      logger.warn(`traerVisitasML: lote ${i / 20} falló`, e.message);
    }
  }
  return { ok: true, propiedades: items.length, actualizadas, fallos,
           muestra: detalle.slice(0, 10) };
}

exports.actualizarVisitasML = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  try {
    return await traerVisitasML();
  } catch (e) {
    logger.error("actualizarVisitasML", e);
    return { ok: false, detalle: String(e.message || e) };
  }
});

/* Una vez por día. Además de mantener el número al día, deja una FOTO diaria en
   properties/{id}/metricas/{YYYY-MM-DD}.

   Esa foto es la pieza que hoy falta: los contadores son acumulados y sin fecha,
   así que no se puede decir "esta propiedad subió esta semana". Guardando el
   valor de cada día, en un mes hay tendencia real. Los datos empiezan a existir
   desde que esto corre por primera vez: no se puede reconstruir hacia atrás. */
exports.visitasMLDiario = onSchedule(
  { schedule: "20 6 * * *", timeZone: "America/Montevideo" },
  async () => {
    let r;
    try { r = await traerVisitasML(); }
    catch (e) { logger.error("visitasMLDiario", e); return; }

    const hoy = new Date().toISOString().slice(0, 10);
    let fotos = 0;
    try {
      const snap = await db.collection("properties").get();
      for (const d of snap.docs) {
        const p = d.data();
        const vistas = Number(p.views) || 0;
        const clics = Number(p.contactClicks) || 0;
        const ml = Number(p.mlVisitas) || 0;
        if (!vistas && !clics && !ml) continue;   // nada que fotografiar
        await d.ref.collection("metricas").doc(hoy).set({
          fecha: hoy, views: vistas, contactClicks: clics, mlVisitas: ml,
        });
        fotos++;
      }
    } catch (e) { logger.warn("visitasMLDiario: fotos", e.message); }
    logger.info(`visitasMLDiario: ${r ? r.actualizadas : 0} visitas actualizadas, ${fotos} fotos guardadas`);
  }
);

/* ============================================================================
   MAPEO PARA LA API NUEVA (POST /listing)
   ----------------------------------------------------------------------------
   Convive con las tablas del feed XML de arriba, que siguen vivas: InfoCasas
   confirmó que ambas integraciones van a coexistir un tiempo antes del sunset.
   NO se tocan IC_TIPO_PROP ni IC_COMODIDADES.

   Diferencia principal: el XML usaba números para todo. La API usa strings para
   tipo y oferta, y una lista ÚNICA de categorías para todos los tipos de
   propiedad. Eso elimina IC_COMODIDADES, donde el mismo balcón era 41 en casa
   y 1 en apartamento.
   ========================================================================== */

/* realEstateType del CRM -> property_type de la API. */
const IC_API_TIPO = {
  casa: "house", apartamento: "apartment", apto: "apartment",
  terreno: "lot", local: "commercial", oficina: "office",
  campo: "farm", chacra: "farm", quinta: "farm",
  galpon: "industrial", deposito: "industrial", tinglado: "industrial",
  garaje: "parking", cochera: "parking",
  edificio: "building", hotel: "hotel",
};

/* p.type del CRM -> offer. "lease" es alquiler vacacional y hoy no se usa: el
   CRM solo maneja sale y rent. Queda mapeado por si más adelante se agrega. */
const IC_API_OFERTA = { sale: "sell", rent: "rent", temporada: "lease" };

/* Booleanos de la ficha -> ids de "categories".
   Lista única del Anexo, sin variar por tipo de propiedad.
   OJO: varias claves caen en el MISMO id (balcón y terraza son 16; jardín y
   patio son 70; las dos lavanderías son 25), así que el array final se
   deduplica sí o sí.
   HAS_MAID_ROOM (servicio) no tiene equivalente en la lista nueva: se pierde. */
const IC_API_CATEGORIES = {
  HAS_AIR_CONDITIONING: 36, HAS_ATTIC: 40, FURNISHED: 69, HAS_LIFT: 20,
  HAS_BALCONY: 16, HAS_TERRACE: 16,
  HAS_HEATING: 45, HAS_INDOOR_FIREPLACE: 8, HAS_NATURAL_GAS: 37,
  HAS_GYM: 23, HAS_CABLE_TV: 34, HAS_JACUZZI: 10,
  HAS_GARDEN: 70, HAS_PATIO: 70,
  HAS_LAUNDRY: 25, HAS_COMMON_LAUNDRY: 25,
  HAS_GRILL: 13, HAS_SWIMMING_POOL: 27, HAS_PLAYROOM: 28,
  HAS_PARTY_ROOM: 29, HAS_SAUNA: 76,
  HAS_DRESSING_ROOM: 18, HAS_CLOSETS: 216,
  HAS_INTERNET_ACCESS: 31,
  // Mascotas es filtro de búsqueda en el portal: conviene no perderlo.
  IS_SUITABLE_FOR_PETS: 222,
  _DEPOSITO: 2,
};

/* Los enums de la API son escalones, no números libres: mandar 25 habitaciones
   o 12 baños es rechazo. Cada helper recorta al tope de su enum. */
function icApiTramo(n, max, masDe) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0) return 0;
  return v > max ? (masDe != null ? masDe : max) : v;
}
const icApiRooms   = (n) => icApiTramo(n, 19, 20);  // "más de 19" = 20
const icApiBaths   = (n) => icApiTramo(n, 9, 10);   // "más de nueve" = 10
const icApiGarages = (n) => icApiTramo(n, 10, 11);  // "más de 10" = 11
const icApiFloor   = (n) => { const v = icApiTramo(n, 16, 18); return v; }; // "más de 16" = 18

/* Antigüedad en años -> enum age. */
function icApiAge(anios) {
  const a = Number(anios);
  if (!Number.isFinite(a) || a < 0) return 0;   // indefinido
  if (a < 1) return 1;
  if (a <= 8) return 2;
  if (a <= 15) return 3;
  if (a <= 30) return 4;
  return 5;
}

/* Moneda. Confirmado en la doc actualizada (Juan Pablo / Frank, 01/09/2026):
   campo "currency", numérico, OPCIONAL, con 1 (USD) POR DEFECTO.

   Ese default es peligroso para nosotros: si el campo no viaja, un alquiler de
   $U 46.600 se publica como US$ 46.600. Por eso icApiCurrency() nunca devuelve
   vacío y el payload lo manda SIEMPRE explícito, aunque coincida con el default.

   Los códigos coinciden con los del feed XML (monedaAlquiler: 1 = USD, 2 = UYU),
   verificado contra el código del feed. No hay inversión.

   PENDIENTE de confirmar con InfoCasas:
     · Si ahora aceptan VENTA en pesos. El feed convierte a dólares porque solo
       admitían USD; con este campo esa conversión podría dejar de hacer falta.
     · Si administration.price hereda esta moneda. Hoy los gastos comunes van
       siempre en pesos (IDmonedagc: 2) y la API no tiene moneda propia para
       ellos: un alquiler en dólares con gastos en pesos no se puede expresar. */
const IC_API_MONEDA = { USD: 1, UYU: 2 };

function icApiCurrency(moneda) {
  return IC_API_MONEDA[String(moneda || "").toUpperCase()] || IC_API_MONEDA.USD;
}

/* stratum es un concepto colombiano. Para Uruguay va "Sin Especificar" = 110. */
const IC_API_STRATUM_UY = 110;

/* Arma el array de categories a partir de la ficha, ya deduplicado. */
function icApiCategories(ficha) {
  const f = ficha || {};
  const ids = new Set();
  for (const [clave, id] of Object.entries(IC_API_CATEGORIES)) {
    if (clave === "_DEPOSITO") continue;
    const v = f[clave];
    if (v === true || v === "true" || v === 1 || v === "1") ids.add(id);
  }
  if (Number(f.WAREHOUSES || 0) > 0) ids.add(IC_API_CATEGORIES._DEPOSITO);
  return [...ids];
}

function icNorm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
// Escapa para XML y ELIMINA caracteres de control inválidos (quedan tab/salto de
// línea, que sí son legales). Un solo carácter invisible pegado desde Word en UNA
// descripción invalida el XML ENTERO y hace que InfoCasas rechace el feed completo
// ese ciclo: por eso los precios/fotos "a veces" no se actualizaban.
function icEsc(s) { return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function icTag(t, v) { return (v === undefined || v === null || v === "") ? "" : `<${t}>${icEsc(v)}</${t}>`; }
function icZona(depId, ciudad, barrio) {
  const z = IC_ZONAS[depId] || {};
  const b = icNorm(barrio), c = icNorm(ciudad);
  if (b && z[b] != null) return z[b];
  if (c && z[c] != null) return z[c];
  return IC_ZONA_DEFAULT[depId] || null;
}

exports.feedInfocasas = onRequest(async (req, res) => {
  try {
    const debug = req.query && req.query.debug === "1";
    const detalle = []; // en modo debug: por qué entra o no cada propiedad
    const [propsSnap, usersSnap, cfgSnap] = await Promise.all([
      db.collection("properties").get(),
      db.collection("users").get(),
      db.collection("config").doc("recompensas").get(),
    ]);
    const dolar = Number((cfgSnap.exists && cfgSnap.data().dolarPesos) || 40) || 40;
    const users = {}; usersSnap.docs.forEach((d) => { users[d.id] = d.data(); });

    let out = "<?xml version=\"1.0\" encoding=\"UTF-8\" ?>\n<xml>\n";
    let n = 0, skip = 0;
    propsSnap.docs.forEach((doc) => {
      const p = doc.data();
      const fuera = (motivo) => { skip++; if (debug) detalle.push(`FUERA  ${doc.id}  ${p.title || "(sin título)"}  -> ${motivo}`); };
      // Solo propiedades realmente disponibles. Las RESERVADAS también salen del
      // feed: en la web propia se muestran con su cinta, pero en InfoCasas no hay
      // forma de marcarlas y quedarían como disponibles recibiendo consultas.
      if (p.cierreConfirmado === true) return fuera("cierre confirmado");
      if (p.status && p.status !== "available") return fuera(`estado "${p.status}"`);
      const u = p.ubicacion || {};
      const lat = u.lat, lng = u.lng;
      const price = Number(p.price) || 0;
      const imgs = (p.images || []).filter(Boolean).slice(0, 15);
      // InfoCasas no sincroniza sin geolocalización, sin precio o sin fotos.
      if (lat == null || lng == null) return fuera("sin pin de ubicación (lat/lng)");
      if (!(price > 0)) return fuera("sin precio");
      if (!imgs.length) return fuera("sin fotos");
      const depId = IC_DEPTOS[icNorm(p.departamento || u.departamento)];
      if (!depId) return fuera(`departamento no reconocido: "${p.departamento || u.departamento || ""}"`);
      if (debug) detalle.push(`OK     ${doc.id}  ${p.title || "(sin título)"}`);
      const zona = icZona(depId, p.ciudad || u.ciudad, u.barrio);
      const tipoProp = IC_TIPO_PROP[icNorm(p.realEstateType)] || 13;
      const esVenta = p.type === "sale";

      let x = "<propiedad>";
      x += icTag("id", doc.id);
      x += icTag("tipoPropiedad", tipoProp);
      x += icTag("tipoOperacion", esVenta ? 1 : 2);
      x += icTag("departamento", depId);
      x += icTag("zona", zona);
      if (tipoProp === 1 || tipoProp === 2) {
        const b = Number(p.bedrooms);
        if (!isNaN(b)) x += icTag("idDormitorios", b <= 0 ? 1 : b === 1 ? 2 : b === 2 ? 3 : b === 3 ? 4 : b === 4 ? 5 : 6);
      }
      const ba = Number(p.bathrooms) || 0;
      if (ba > 0) x += icTag("idBanios", ba >= 3 ? 3 : ba);
      const F = p.ficha || {};
      // Estado del inmueble (PROPERTY_CONDITION de la ficha -> ids del spec de IC).
      // "Usado" va a 7 (a definir): no afirma un estado que el agente no declaró.
      const IC_ESTADO = { "nuevo": 1, "renovado": 3, "buen estado": 4, "usado": 7, "en construccion": 8 };
      const est = IC_ESTADO[icNorm(F.PROPERTY_CONDITION)];
      if (est) x += icTag("estado", est);
      // Comodidades tildadas en la ficha -> IDs de IC del tipo correspondiente.
      const com = IC_COMODIDADES[tipoProp] || {};
      const comIds = Object.keys(com).filter((k) => k !== "_DEPOSITO" && F[k] === true).map((k) => com[k]);
      if ((Number(F.WAREHOUSES) || 0) > 0 && com._DEPOSITO) comIds.push(com._DEPOSITO);
      if (comIds.length) x += icTag("comodidades", comIds.join(","));
      // Seguridad (spec: 1 alarma, 2 cámaras CCTV, 4 portería 24hs, 5 portón eléctrico,
      // 7 guardia de seguridad — este último cuando hay vigilancia diurna/nocturna).
      const seg = [];
      if (F.HAS_ALARM === true) seg.push(1);
      if (F.HAS_SECURITY === true) seg.push(2);
      const segTipo = icNorm(F.SECURITY_TYPE);
      if (segTipo === "24 horas") seg.push(4);
      if (segTipo === "diurno" || segTipo === "nocturno") seg.push(7);
      if (F.HAS_ELECTRIC_GATE_OPENER === true) seg.push(5);
      if (seg.length) x += icTag("seguridad", seg.join(","));
      // Vista al mar: sale del "Tipo de vista" de la ficha (spec: vistaMar 1/0).
      if (icNorm(F.VIEW_TYPE) === "mar") x += icTag("vistaMar", 1);
      // Extras cargados en el grupo "InfoCasas" del form (ids IC_*).
      const IC_SOBRE_MAP = { "rambla": 2, "avenida": 3 };
      const sobre = IC_SOBRE_MAP[icNorm(F.IC_SOBRE)];
      if (sobre) x += icTag("sobre", sobre);
      const IC_DIST_MAP = { "frente al mar": 1, "menos de 100 m": 2, "200 m": 3, "300 m": 4, "400 m": 5 };
      const dmar = IC_DIST_MAP[icNorm(F.IC_DISTANCIA_MAR)];
      if (dmar) x += icTag("distanciaMar", dmar);
      if (F.IC_TOUR3D) x += icTag("tour3d", F.IC_TOUR3D);
      const ubiPin = icNorm(F.IC_UBICACION);
      if (ubiPin === "punto exacto") x += icTag("ubicacionAproximada", 0);
      else if (ubiPin === "punto aproximado") x += icTag("ubicacionAproximada", 1);
      const ta = Number(p.totalArea) || 0, ca = Number(p.builtArea) || 0;
      if (ta > 0) x += icTag("m2", ta);
      if (ca > 0) x += icTag("m2edificados", ca);
      // Metros del terreno: usa la "Superficie de terreno" de la ficha (LAND_AREA);
      // si no está cargada, cae a la superficie total (casas, terrenos y campos).
      const terr = Number((p.ficha && p.ficha.LAND_AREA) || 0) || ((tipoProp === 1 || tipoProp === 3 || tipoProp === 6) ? ta : 0);
      if (terr > 0) x += icTag("m2terreno", terr);
      if (tipoProp === 6 && terr >= 10000) x += icTag("hectareas", Math.round((terr / 10000) * 100) / 100);
      if (tipoProp === 2 && ca > 0) x += icTag("m2apto", ca);
      const plantas = Number(F.FLOORS) || 0;
      if (plantas > 0) x += icTag("plantas", plantas >= 3 ? 3 : plantas);
      if (typeof F.UNIT_FLOOR === "number" && F.UNIT_FLOOR >= 0) x += icTag("piso", F.UNIT_FLOOR);
      if ((Number(F.APARTMENTS_PER_FLOOR) || 0) > 0) x += icTag("aptosPorPiso", Number(F.APARTMENTS_PER_FLOOR));
      const IC_ORIENT = { "norte": 3, "sur": 2, "este": 4, "oeste": 5 };
      const ori = IC_ORIENT[icNorm(F.FACING)];
      if (ori) x += icTag("orientacion", ori);
      const IC_DISP = { "frente": 2, "contrafrente": 3, "interno": 4, "lateral": 5 };
      const dis = IC_DISP[icNorm(F.DISPOSITION)];
      if (dis) x += icTag("disposicion", dis);
      if (typeof F.PROPERTY_AGE === "number" && F.PROPERTY_AGE >= 0 && F.PROPERTY_AGE <= 200) {
        x += icTag("anioConstruccion", new Date().getFullYear() - Math.round(F.PROPERTY_AGE));
      }
      const cocheras = Number((p.ficha && p.ficha.PARKING_LOTS) || 0) || (p.garage === "yes" ? 1 : 0);
      if (cocheras > 0) x += icTag("garage", cocheras);
      const gc = Number(p.commonExpenses) || 0;
      if (gc > 0) { x += icTag("IDmonedagc", 2); x += icTag("gc", gc); }
      if (esVenta) {
        // InfoCasas solo acepta venta en USD: si el aviso está en pesos se convierte
        // con la cotización configurada en config/recompensas (dolarPesos).
        x += icTag("precioVenta", p.currency === "UYU" ? Math.round(price / dolar) : Math.round(price));
      } else {
        x += icTag("monedaAlquiler", p.currency === "UYU" ? 2 : 1);
        x += icTag("precioAlquiler", Math.round(price));
      }
      x += icTag("titulo", p.title || "");
      // El spec de IC no tiene tag de código propio: la referencia va en la descripción.
      x += icTag("descripcion", (p.description || "") + (F.PROPERTY_CODE ? `\n\nRef.: ${F.PROPERTY_CODE}` : ""));
      x += icTag("latitud", lat);
      x += icTag("longitud", lng);
      if (u.direccionVisible) { x += icTag("direccion", u.direccionVisible); x += icTag("mostrarDireccion", 0); }
      const v = String(p.videoUrl || "");
      if (/youtu\.?be/i.test(v)) x += icTag("youtube", v);
      x += "<imagenes>" + imgs.map((im) => "<url>" + icEsc(im) + "</url>").join("") + "</imagenes>";
      const ag = users[p.ownerId] || {};
      const tel = p.ownerWhatsapp || ag.whatsapp || "";
      if (ag.email || ag.name || tel) {
        x += "<vendedor>" + icTag("email", ag.email || "") + icTag("nombre", ag.name || "") + icTag("telefono", tel) + "</vendedor>";
      }
      x += "</propiedad>";
      out += x + "\n"; n++;
    });
    out += "</xml>";
    logger.info(`[feedInfocasas] ${n} propiedades en el feed, ${skip} excluidas (cerradas, reservadas o sin geo/precio/fotos).`);
    if (debug) {
      // Modo diagnóstico: /feedInfocasas?debug=1 lista qué entra y qué no, con motivo.
      res.set("Content-Type", "text/plain; charset=utf-8");
      res.set("Cache-Control", "no-store");
      res.status(200).send(`Feed InfoCasas — ${n} publicadas, ${skip} excluidas\n\n` + detalle.join("\n"));
      return;
    }
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    res.status(200).send(out);
  } catch (e) {
    logger.error("[feedInfocasas]", e);
    res.status(500).send("<?xml version=\"1.0\" encoding=\"UTF-8\" ?><xml></xml>");
  }
});

// =====================================================================
// CRM — Recordatorio de seguimiento de clientes.
// Corre lunes y jueves a las 10:00 (hora de Uruguay). Busca clientes activos
// sin contacto hace RECORDATORIO_DIAS o más y le avisa a cada agente
// (campanita + push FCM) cuántos tiene y quiénes son los más abandonados.
// Cerrados, perdidos y archivados no cuentan. Los clientes sin agente
// asignado (cargas viejas) se le avisan al admin.
// Mantener RECORDATORIO_DIAS igual a SEGUIMIENTO.diasAviso de clientes.html.
// =====================================================================
const RECORDATORIO_DIAS = 14; // umbral por defecto para etapas sin regla propia

// Umbral de silencio tolerado POR ETAPA — espejo del PULSO_ETAPA de clientes.html.
// No es lo mismo el silencio en "nuevo" (urge contactar) que en "cartera" (la
// propiedad ya está captada). El aviso salta cuando el silencio supera el umbral
// de la etapa. Nota: la excepción por visita futura agendada solo la aplica el
// front (acá no cargamos la agenda para mantener el scheduler liviano).
const UMBRAL_ETAPA = { nuevo: 1, contactado: 3, seguimiento: 3, visita: 5, negociacion: 5, tasacion: 5, cartera: 15 };

exports.recordatorioSeguimiento = onSchedule(
  { schedule: "0 10 * * 1,4", timeZone: "America/Montevideo" },
  async () => {
    const [cliSnap, gestSnap] = await Promise.all([
      db.collection("clients").get(),
      db.collection("gestiones").get(),
    ]);

    // Agregado por cliente — MISMO criterio que clientes.html: manda la gestión
    // ACTIVA más avanzada; la última actividad es lo último tocado en cualquiera.
    const PRIORIDAD = ["nuevo", "contactado", "seguimiento", "visita", "negociacion", "cartera"];
    const agg = {};
    gestSnap.docs.forEach((d) => {
      const g = d.data();
      if (!g.clientId) return;
      const a = agg[g.clientId] || (agg[g.clientId] = { total: 0, activas: 0, estado: null, prio: -1, ts: "" });
      a.total++;
      const ts = g.updatedAt || g.createdAt || "";
      if (ts > a.ts) a.ts = ts;
      const e = g.estadoGestion || "nuevo";
      if (e === "cerrado" || e === "perdido") return;
      a.activas++;
      const p = PRIORIDAD.indexOf(e);
      if (p > a.prio) { a.prio = p; a.estado = e; }
    });

    const ahora = Date.now();
    const porAgente = {}; // uid -> [{ name, dias }]
    cliSnap.docs.forEach((d) => {
      const c = d.data();
      if (c.archived) return;
      const a = agg[d.id];
      let estado;
      if (a && a.total) {
        if (!a.activas) return; // todas las gestiones cerradas/perdidas: nada para recordar
        estado = a.estado;
      } else {
        estado = c.status || "nuevo";
        if (estado === "cerrado" || estado === "perdido") return;
      }
      // El eje SITUACIÓN manda: pausados, cerrados por afuera y perdidos no reciben
      // el aviso de "sin contacto" (los pausados tienen su propio recordatorio).
      const sit = c.situacion || "activo";
      if (sit !== "activo") return;
      // "Cartera" es etapa avanzada (la propiedad ya está captada): el silencio
      // ahí es normal, no abandono. Mantener igual a estadosSinAviso de clientes.html.
      if (estado === "cartera") return;
      const ts = [(a && a.ts) || "", c.updatedAt || "", c.createdAt || ""].sort().pop();
      const t = new Date(ts).getTime();
      const dias = isNaN(t) ? 9999 : Math.floor((ahora - t) / 86400000);
      const umbral = UMBRAL_ETAPA[estado] != null ? UMBRAL_ETAPA[estado] : RECORDATORIO_DIAS;
      if (dias < umbral) return;
      // Un cliente puede estar en la cartera de VARIOS agentes: además del que lo
      // creó, los que se lo sumaron a su lista (campo 'enLista', que es donde el
      // CRM guarda los compartidos — ver esMio() en clientes.html).
      // Antes esta línea se quedaba con uno solo por cadena de respaldos, así que
      // el segundo agente nunca se enteraba de que su cliente estaba frío.
      const destinatarios = new Set();
      const dueno = c.createdBy || c.agentId || c.ownerId;
      if (dueno) destinatarios.add(dueno);
      if (Array.isArray(c.enLista)) {
        c.enLista.forEach((x) => { if (x && x.uid) destinatarios.add(x.uid); });
      }
      if (!destinatarios.size) destinatarios.add("__sin_agente__");
      destinatarios.forEach((uid) => {
        (porAgente[uid] = porAgente[uid] || []).push({ name: c.name || "Sin nombre", dias });
      });
    });

    const adm = await getAdminUser();
    for (const uid of Object.keys(porAgente)) {
      const lista = porAgente[uid].sort((a, b) => b.dias - a.dias);
      let destino = null;
      if (uid === "__sin_agente__") {
        // Antes esto caía en el admin. El recordatorio de seguimiento es una tarea
        // del agente que atiende al cliente: mandárselo a la Dirección no hace que
        // alguien lo retome, solo llena la campanita de gente que no conoce.
        // Los huérfanos quedan en el log para poder asignarlos, no se avisan.
        logger.warn(`[recordatorioSeguimiento] ${lista.length} cliente(s) SIN AGENTE asignado: ${lista.map((x) => x.name).join(", ")}`);
        continue;
      } else {
        try {
          const uDoc = await db.doc(`users/${uid}`).get();
          if (uDoc.exists) destino = { uid: uDoc.id, fcmToken: uDoc.data().fcmToken };
        } catch (e) { /* sin perfil */ }
        // Agente sin perfil legible: se registra y se saltea. Antes se lo mandaba al
        // admin, que recibía recordatorios de clientes que no son suyos.
        if (!destino) {
          logger.warn(`[recordatorioSeguimiento] agente ${uid} sin perfil; ${lista.length} cliente(s) sin avisar.`);
          continue;
        }
      }
      if (!destino) continue;

      const nombres = lista.slice(0, 3).map((x) => x.name).join(", ");
      const extra = lista.length > 3 ? ` y ${lista.length - 3} más` : "";
      const texto = lista.length === 1
        ? `${nombres} lleva ${lista[0].dias} días sin contacto. Entrá a Clientes para retomarlo.`
        : `${lista.length} clientes llevan más de ${RECORDATORIO_DIAS} días sin contacto: ${nombres}${extra}. Entrá a Clientes para retomarlos.`;
      await crearNotificacion(
        destino,
        {
          type: "crm_seguimiento", userName: "Seguimiento", userPhoto: null, text: texto,
          // Los nombres y el conteo van aparte del texto para que la tarjeta pueda
          // resaltarlos en el titular en vez de dejarlos enterrados en la frase.
          clientes: lista.slice(0, 6).map((x) => x.name),
          cuantos: lista.length,
          diasMax: lista[0] ? lista[0].dias : 0,
        },
        { title: "📋 Clientes para recontactar", body: texto }
      );
      logger.info(`[recordatorioSeguimiento] aviso a ${uid}: ${lista.length} cliente(s) sin contacto.`);
    }
  }
);

// =====================================================================
// CRM — Recordatorio de clientes EN PAUSA.
// Cada día revisa los pausados; a los que cumplieron MESES_PAUSA desde que se
// pausaron (o desde el último "posponer") les avisa al agente para decidir si
// retoma o pospone otros 3 meses. La decisión se toma en la app (menú del badge
// o banner). Mantener MESES_PAUSA igual al de clientes.html.
// =====================================================================
const MESES_PAUSA_FN = 3;

exports.recordatorioPausados = onSchedule(
  { schedule: "0 10 * * *", timeZone: "America/Montevideo" },
  async () => {
    const cliSnap = await db.collection("clients").get();
    const ahora = Date.now();
    const porAgente = {};
    cliSnap.docs.forEach((d) => {
      const c = d.data();
      if (c.archived || c.situacion !== "pausa") return;
      // "Despierta" si venció el snooze, o si pasaron 3 meses desde la pausa.
      let vencido;
      if (c.pausaSnoozeUntil) {
        vencido = new Date(c.pausaSnoozeUntil).getTime() <= ahora;
      } else {
        const ref = c.pausadoEn || c.updatedAt || "";
        const t = new Date(ref).getTime();
        vencido = !isNaN(t) && (ahora - t) >= MESES_PAUSA_FN * 30 * 86400000;
      }
      if (!vencido) return;
      const uid = c.createdBy || c.agentId || c.ownerId || "__sin_agente__";
      (porAgente[uid] = porAgente[uid] || []).push(c.name || "Sin nombre");
    });

    const adm = await getAdminUser();
    for (const uid of Object.keys(porAgente)) {
      const lista = porAgente[uid];
      let destino = null;
      // Mismo criterio que el recordatorio de seguimiento: el aviso es del agente
      // dueño del aviso pausado. Sin dueño identificable se registra y se saltea,
      // en vez de derivarlo a la Dirección, que no puede hacer nada con eso.
      if (uid === "__sin_agente__") {
        logger.warn(`[recordatorioPausados] ${lista.length} propiedad(es) pausadas SIN dueño identificable.`);
        continue;
      }
      try { const u = await db.doc(`users/${uid}`).get(); if (u.exists) destino = { uid: u.id, fcmToken: u.data().fcmToken }; } catch (e) { /* sin perfil */ }
      if (!destino) {
        logger.warn(`[recordatorioPausados] agente ${uid} sin perfil; ${lista.length} propiedad(es) sin avisar.`);
        continue;
      }
      if (!destino) continue;
      const nombres = lista.slice(0, 3).join(", ");
      const extra = lista.length > 3 ? ` y ${lista.length - 3} más` : "";
      const texto = lista.length === 1
        ? `${nombres} está en pausa desde hace ${MESES_PAUSA_FN} meses. ¿Lo retomás o lo dejás guardado otro tiempo?`
        : `${lista.length} clientes en pausa cumplieron ${MESES_PAUSA_FN} meses: ${nombres}${extra}. Revisá si conviene retomarlos.`;
      await crearNotificacion(
        destino,
        { type: "crm_pausa", userName: "Pausados", userPhoto: null, text: texto },
        { title: "⏸️ Clientes en pausa para revisar", body: texto }
      );
      logger.info(`[recordatorioPausados] aviso a ${uid}: ${lista.length} pausado(s).`);
    }
  }
);

// =====================================================================
// PROPIEDADES — Aviso de vencimiento de contratos de alquiler.
// Un alquiler es una pausa CON fecha: la propiedad salió del mercado pero vuelve
// al terminar el contrato. Cada día revisa los contratos vigentes y, cuando faltan
// 90 / 60 / 30 días para el fin, avisa (una vez por hito, sin repetir) al agente
// dueño. La propiedad NO se reactiva sola: el aviso es para que el agente hable con
// el propietario y decida (renovar / volver al mercado / archivar) desde la ficha.
// =====================================================================
const HITOS_VENCIMIENTO = [90, 60, 30];

exports.avisoVencimientoAlquiler = onSchedule(
  { schedule: "0 9 * * *", timeZone: "America/Montevideo" },
  async () => {
    const propsSnap = await db.collection("properties").get();
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const adm = await getAdminUser();

    for (const doc of propsSnap.docs) {
      const p = doc.data();
      if (p.status !== "rented" || !Array.isArray(p.contratos)) continue;
      const idx = p.contratos.findIndex((c) => c && c.vigente);
      if (idx < 0) continue;
      const c = p.contratos[idx];
      if (!c.fechaFin) continue;
      const fin = new Date(c.fechaFin); fin.setHours(0, 0, 0, 0);
      const dias = Math.round((fin - hoy) / 86400000);
      // Buscar el hito correspondiente: el mayor de {90,60,30} que ya se alcanzó
      // y todavía no se avisó. (dias<=90 && no avisado 90; etc.)
      const avisados = c.hitosAvisados || [];
      let hito = null;
      for (const h of HITOS_VENCIMIENTO) {
        if (dias <= h && avisados.indexOf(h) < 0) { hito = h; break; }
      }
      if (hito == null) continue;

      const ownerId = p.ownerId || null;
      let destino = null, ownerName = "";
      if (ownerId) {
        try { const u = await db.doc(`users/${ownerId}`).get(); if (u.exists) { ownerName = u.data().name || ""; destino = { uid: u.id, fcmToken: u.data().fcmToken }; } } catch (e) { /* sin perfil */ }
      }
      if (!destino) destino = adm;
      if (!destino) continue;

      const cuando = dias <= 0 ? "ya venció" : `vence en ${dias} día${dias === 1 ? "" : "s"}`;
      const texto = `El alquiler de "${p.title || "una propiedad"}" ${cuando} (fin de contrato ${c.fechaFin}). Contactá al propietario para confirmar si renueva o vuelve al mercado.`;
      await crearNotificacion(destino, {
        type: "vencimiento_alquiler",
        propertyId: doc.id,
        propertyTitle: p.title || "una propiedad",
        userName: "Vencimiento",
        userPhoto: null,
        text: texto,
      }, {
        title: "🏠 Alquiler por vencer",
        body: `${p.title || "Una propiedad"} — ${cuando}`,
      });

      // Marcar el hito como avisado para no repetirlo (persistir en el contrato).
      const nuevos = p.contratos.slice();
      nuevos[idx] = Object.assign({}, c, { hitosAvisados: avisados.concat([hito]) });
      await doc.ref.update({ contratos: nuevos });
      logger.info(`[avisoVencimientoAlquiler] ${doc.id}: hito ${hito}d (faltan ${dias}).`);
    }
  }
);

// =====================================================================
// Registro a prueba de fallos — garantía del lado del servidor.
// El cliente ya intenta crear users/{uid} al registrarse (con reintentos y
// rollback), pero puede fallar por caché de una versión vieja, cortes de red
// o timing de permisos, dejando cuentas en Authentication invisibles para el
// panel del admin. Este trigger corre en el servidor apenas se crea la cuenta
// de Auth: si a los pocos segundos el perfil no existe, lo crea como pendiente.
// La espera evita pisar la escritura del cliente (que trae más datos, como el
// WhatsApp) y también crear un doc para registros que el cliente revierte.
// =====================================================================
exports.crearPerfilAlRegistrarse = functionsV1.auth.user().onCreate(async (user) => {
  await new Promise((r) => setTimeout(r, 8000)); // le damos tiempo al cliente
  const ref = db.collection("users").doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) return; // el cliente ya lo escribió: no tocar nada
  // ¿La cuenta sigue existiendo? Si el cliente hizo rollback, no crear huérfanos.
  try { await admin.auth().getUser(user.uid); } catch (e) { return; }
  const esAdmin = (user.email || "").toLowerCase() === ADMIN_EMAIL;
  await ref.set({
    uid: user.uid,
    email: user.email || "",
    name: user.displayName || (user.email ? user.email.split("@")[0] : "Usuario"),
    whatsapp: "",
    status: esAdmin ? "approved" : "pending",
    // Mismo rango de alta que escribe el navegador. Sin esto, el perfil creado
    // por este respaldo quedaba SIN rango y el agente no entraba en ninguna
    // regla por rango: invisible para todo el sistema de permisos.
    rank: esAdmin ? "ceo" : "asesor_junior",
    createdAt: new Date().toISOString(),
    creadoPorServidor: true
  });
  logger.info(`[crearPerfilAlRegistrarse] perfil creado en el servidor para ${user.email}`);
});

// Si la cuenta de Auth se borra (rollback del registro o borrado desde la
// consola), el perfil de Firestore se va con ella: sin cuenta no hay login,
// y un perfil suelto solo genera confusión en el panel.
exports.limpiarPerfilAlBorrarse = functionsV1.auth.user().onDelete(async (user) => {
  try {
    await db.collection("users").doc(user.uid).delete();
    logger.info(`[limpiarPerfilAlBorrarse] perfil eliminado para ${user.email || user.uid}`);
  } catch (e) { /* si no existía, no hay nada que limpiar */ }
});

// =====================================================================
// CRM ⇄ Propiedad — cerrar la gestión finaliza la propiedad.
// Hasta ahora, cerrar una gestión en el CRM no tocaba la propiedad: quedaba
// "available", seguía publicada en la web y en el feed de InfoCasas. Este
// trigger sincroniza: gestión CERRADA => propiedad Vendida/Alquilada (según
// sea venta o alquiler), lo que la saca del feed en la próxima lectura.
// Si la gestión se reabre, revierte SOLO si fue este trigger quien la marcó
// (flag finalizadaPorGestion): nunca pisa una decisión del admin ni del
// Mapa de cierres, que sigue siendo el flujo de comisiones de siempre.
// =====================================================================
// ¿Qué es el cliente respecto a la propiedad de esta gestión? Si la gestión no
// lo dice (legado), se infiere por el ORIGEN del cliente: los que entraron solos
// por portales/web/contratos son interesados; los cargados a mano por la agencia
// son, por regla de la casa, propietarios (así se construye la cartera).
function rolGestionInferido(g, cliente) {
  if (g && (g.rol === "propietario" || g.rol === "interesado")) return g.rol;
  const src = ((cliente && cliente.source) || "").toLowerCase();
  if (["infocasas", "ml", "mercadolibre", "web", "inquilino", "lead"].includes(src)) return "interesado";
  return "propietario";
}

// La agencia perdió al propietario (gestión perdida, cerró por afuera o perdido a
// nivel cliente): su propiedad NO puede seguir publicada sin permiso, pero nada se
// baja solo. Se le manda al admin una confirmación con botones (campanita + push);
// hasta que él decida, la propiedad se mantiene ("lo publicado se asume con permiso").
// El flag despubPendiente evita duplicar el pedido si varios eventos coinciden.
async function pedirConfirmacionDespublicar(propId, quienNombre, motivoTexto, tipoTerminal) {
  const ref = db.collection("properties").doc(propId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const p = snap.data();
  if (p.status && p.status !== "available" && p.status !== "reserved") return; // ya no está en el mercado
  if (p.despubPendiente === true) return; // ya hay una confirmación esperando
  const adm = await getAdminUser();
  if (!adm) return;
  const texto = `${quienNombre} (propietario) ${motivoTexto}. Su propiedad "${p.title || "sin título"}" sigue publicada: confirmá si hay que despublicarla o mantenerla.`;
  await notificarDireccion({
    type: "despublicar_confirmar",
    propertyId: propId,
    propertyTitle: p.title || "una propiedad",
    userName: "Despublicar",
    userPhoto: null,
    text: texto,
  }, {
    title: "🏠 Confirmá una despublicación",
    body: `${p.title || "Una propiedad"} — el propietario ${motivoTexto}`,
  });
  // La propiedad toma YA su estado terminal (para que el selector no muestre algo
  // sin sentido como "Pendiente de tasación"), guardando cuál era su estado de
  // publicación por si el admin decide mantenerla. Sigue en los portales hasta
  // que el admin confirme la baja desde la campanita.
  const upd = { despubPendiente: true, statusPrevioDespub: p.status || "available" };
  if (tipoTerminal === "externo") { upd.status = "cerrado_externo"; upd.motivoBaja = "cerro_externo"; upd.motivoBajaTexto = "Cerró por afuera de la agencia"; }
  else if (tipoTerminal === "perdido") { upd.status = "cerrado_externo"; upd.motivoBaja = "propietario_perdido"; upd.motivoBajaTexto = "Propietario perdido"; }
  await ref.update(upd);
  logger.info(`[despublicar?] ${propId}: pedido de confirmación al admin (${motivoTexto}).`);
}

exports.sincronizarPropiedadAlCerrarGestion = onDocumentUpdated("gestiones/{gid}", async (event) => {
  const antes = (event.data.before && event.data.before.data()) || {};
  const ahora = (event.data.after && event.data.after.data()) || {};
  const estAntes = antes.estadoGestion || "nuevo";
  const estAhora = ahora.estadoGestion || "nuevo";
  if (estAntes === estAhora) return; // cambió otra cosa (una nota, etc.)
  const pid = ahora.propertyId;
  if (!pid) return;
  const ref = db.collection("properties").doc(pid);
  const snap = await ref.get();
  if (!snap.exists) return;
  const p = snap.data();

  if (estAhora === "cerrado") {
    // Solo si la propiedad estaba disponible o reservada: un estado ya
    // definido (vendida por el Mapa de cierres, en tasación, etc.) se respeta.
    if (p.status && p.status !== "available" && p.status !== "reserved") return;
    const esAlquiler = p.type === "rent";
    const nuevoEstado = esAlquiler ? "rented" : "sold";
    const upd = {
      status: nuevoEstado,
      finalizadaPorGestion: { gestionId: event.params.gid, fecha: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
    // Alquiler = pausa con fecha. Si todavía no tiene un contrato vigente cargado,
    // marcamos contratoPendiente: el front pedirá fecha de fin e inquilino. La venta
    // no lleva contrato (es terminal de verdad).
    if (esAlquiler) {
      const hayVigente = Array.isArray(p.contratos) && p.contratos.some((c) => c && c.vigente);
      if (!hayVigente) {
        upd.contratoPendiente = true;
        upd.contratoPendienteGestion = event.params.gid; // para vincular el inquilino
      }
    }
    await ref.update(upd);
    logger.info(`[gestión cerrada] Propiedad ${pid} -> ${nuevoEstado}${upd.contratoPendiente ? " (contrato pendiente)" : ""}.`);
  } else if (estAntes === "cerrado") {
    // Se reabrió la gestión: revertir solo lo que este trigger marcó.
    const f = p.finalizadaPorGestion;
    if (f && f.gestionId === event.params.gid && (p.status === "sold" || p.status === "rented")) {
      await ref.update({
        status: "available",
        finalizadaPorGestion: admin.firestore.FieldValue.delete(),
        contratoPendiente: admin.firestore.FieldValue.delete(),
        contratoPendienteGestion: admin.firestore.FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
      logger.info(`[gestión reabierta] Propiedad ${pid} -> available.`);
    }
  } else if ((estAhora === "perdido" && estAntes !== "perdido") || (estAhora === "externo" && estAntes !== "externo")) {
    // Se perdió la gestión, o cerró por afuera. Según el ROL del cliente:
    //  - Interesado: no toca la propiedad (perder un candidato no la baja).
    //  - Propietario: se perdió la captación / cerró sin la agencia -> la propiedad
    //    no puede seguir publicada sin permiso: confirmación al admin.
    let cliente = null;
    try {
      if (ahora.clientId) { const cd = await db.doc(`clients/${ahora.clientId}`).get(); if (cd.exists) cliente = cd.data(); }
    } catch (e) { /* sin datos del cliente */ }
    if (rolGestionInferido(ahora, cliente) === "propietario") {
      const motivo = estAhora === "externo" ? "cerró la operación por afuera" : "se marcó como perdido";
      const tipoT = estAhora === "externo" ? "externo" : "perdido";
      await pedirConfirmacionDespublicar(pid, (cliente && cliente.name) || ahora.clientName || "El propietario", motivo, tipoT);
    }
  }
});

// =====================================================================
// El CLIENTE (no una gestión puntual) se marcó "cerró por afuera" o "perdido".
// Si es propietario de propiedades que siguen en el mercado, cada una necesita
// la confirmación del admin para despublicarse. Caso típico: "alquilada por su
// dueña" — la operación pasó por afuera y el aviso quedó colgado publicado.
// =====================================================================
exports.avisoDespublicarPorCliente = onDocumentUpdated("clients/{cid}", async (event) => {
  const before = (event.data.before && event.data.before.data()) || {};
  const after = (event.data.after && event.data.after.data()) || {};
  const sitAntes = before.situacion || "activo";
  const sitAhora = after.situacion || "activo";
  if (sitAhora === sitAntes) return;
  if (sitAhora !== "externo" && sitAhora !== "perdido") return;
  const motivo = sitAhora === "externo" ? "cerró por afuera" : "se marcó como perdido";
  const gs = await db.collection("gestiones").where("clientId", "==", event.params.cid).get();
  for (const gd of gs.docs) {
    const g = gd.data();
    if (!g.propertyId) continue;
    if (rolGestionInferido(g, after) !== "propietario") continue;
    await pedirConfirmacionDespublicar(g.propertyId, after.name || g.clientName || "El propietario", motivo, (sitAhora === "externo" ? "externo" : "perdido"));
  }
});

// =====================================================================
// LEADS DE INFOCASAS -> CRM
// Puerta de entrada que NO existía: por eso las consultas de InfoCasas no
// llegaban nunca al CRM. InfoCasas debe configurar el envío de leads a:
//   https://us-central1-mi-cartera-inmobiliaria.cloudfunctions.net/leadInfocasas
// (pedirlo al ejecutivo de cuenta; si se define la variable de entorno
// IC_LEAD_KEY, la URL debe incluir ?clave=ESA_CLAVE y se rechaza lo demás).
// Diseño a prueba de sorpresas: el payload crudo SIEMPRE se guarda en la
// colección leadsPortales antes de procesar, así ningún lead se pierde aunque
// el formato no coincida; los nombres de campo se leen con tolerancia.
// Qué hace con cada lead: resuelve la propiedad (por el id que va en el feed,
// o por la Ref./código de la ficha), deduplica el cliente por teléfono, lo
// crea a nombre del agente dueño de la propiedad, abre o actualiza la gestión
// con la consulta en el historial, y avisa con campanita + push.
// =====================================================================
exports.leadInfocasas = onRequest(async (req, res) => {
  if (req.method === "GET") { res.status(200).send("OK — receptor de leads de InfoCasas activo (usar POST)."); return; }
  if (req.method !== "POST") { res.status(405).send("Método no permitido"); return; }
  const body = (typeof req.body === "object" && req.body) || {};
  /* InfoCasas manda la clave en el CUERPO, en el campo "key". Antes solo se
     miraba ?clave= en la URL: con IC_LEAD_KEY configurada, TODOS sus leads
     habrían vuelto 401, y sin configurar el endpoint quedaba abierto.
     (Payload confirmado por el equipo de InfoCasas, 31/08/2026.) */
  const claveEsperada = process.env.IC_LEAD_KEY || "";
  if (claveEsperada) {
    const recibida = String((req.query && req.query.clave) || body.key || body.clave || "");
    if (recibida !== claveEsperada) { res.status(401).send("Clave inválida"); return; }
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = body[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };
  const nombre = pick("nombre", "name", "contactName", "nombreContacto", "cliente") || "Consulta InfoCasas";
  const telefono = pick("telefono", "tel", "phone", "celular", "movil", "telefonoContacto", "whatsapp");
  const email = pick("email", "mail", "correo");
  const mensaje = pick("mensaje", "message", "comentario", "consulta", "texto", "descripcion");
  /* "property_id" en snake_case es el nombre que usa InfoCasas y faltaba: solo
     estaba "propertyId". Sin él el lead entraba pero sin identificar la
     propiedad, así que no se asignaba al agente dueño ni se creaba la gestión.
     Se prueba primero porque es el que manda el portal.
     Ojo: en su ejemplo property_id se asigna dos veces y en PHP gana la última,
     así que llega el CÓDIGO de la propiedad, no el id del documento. Abajo se
     resuelve por las dos vías. */
  const refProp = pick("property_id", "idPropiedad", "propiedad", "id", "referencia", "ref", "codigo", "propertyId", "idAviso");
  // from_id identifica el portal de origen (2 = InfoCasas). Se guarda por si
  // algún día enrutan más de un portal al mismo endpoint.
  const origenId = pick("from_id", "fromId");

  // 1) Guardar el lead crudo ANTES de procesar: nada se pierde jamás.
  const rawRef = await db.collection("leadsPortales").add({
    fuente: "infocasas", origenId: origenId || null,
    recibido: new Date().toISOString(), body, query: req.query || {}, procesado: false,
  });

  try {
    // 2) Resolver la propiedad: por el id que publica el feed, o por la Ref. de la ficha.
    let propId = null, prop = null;
    if (refProp) {
      try { const d = await db.collection("properties").doc(refProp).get(); if (d.exists) { propId = d.id; prop = d.data(); } } catch (e) { /* id con formato raro */ }
      if (!prop) {
        const q = await db.collection("properties").where("ficha.PROPERTY_CODE", "==", refProp).limit(1).get();
        if (!q.empty) { propId = q.docs[0].id; prop = q.docs[0].data(); }
      }
    }
    const ownerId = (prop && prop.ownerId) || null;
    let ownerName = "", destino = null;
    if (ownerId) {
      try { const u = await db.doc(`users/${ownerId}`).get(); if (u.exists) { ownerName = u.data().name || ""; destino = { uid: u.id, fcmToken: u.data().fcmToken }; } } catch (e) { /* sin perfil */ }
    }
    if (!destino) destino = await getAdminUser();

    // 3) Cliente: deduplicar por teléfono normalizado (mismo criterio que el CRM).
    const telNorm = normalizarTel(telefono);
    let clientId = null, clienteExistia = false;
    if (telNorm) {
      const cs = await db.collection("clients").get();
      for (const d of cs.docs) {
        if (normalizarTel(d.data().phone) === telNorm) { clientId = d.id; clienteExistia = true; break; }
      }
    }
    const ahora = new Date().toISOString();
    if (!clientId) {
      const nuevoCliente = {
        name: nombre, phone: telefono, phoneNormalized: telNorm || "",
        status: "nuevo", source: "infocasas",
        notes: "Ingresó por una consulta en InfoCasas.",
        createdAt: ahora, updatedAt: ahora,
      };
      if (email) nuevoCliente.email = email;
      if (ownerId) { nuevoCliente.createdBy = ownerId; nuevoCliente.agentId = ownerId; nuevoCliente.ownerId = ownerId; }
      if (ownerName) { nuevoCliente.createdByName = ownerName; nuevoCliente.ownerName = ownerName; }
      const cRef = await db.collection("clients").add(nuevoCliente);
      clientId = cRef.id;
    }

    // 4) Gestión sobre la propiedad: una por cliente+propiedad; si ya existe,
    //    la consulta nueva se suma al historial (y cuenta como actividad).
    const notaLead = {
      tipo: "nota",
      valor: `Consulta desde InfoCasas${mensaje ? `: "${mensaje}"` : ""}${email ? ` (email: ${email})` : ""}`,
      autor: "InfoCasas", fecha: ahora,
    };
    if (propId && clientId) {
      const g = await db.collection("gestiones").where("clientId", "==", clientId).where("propertyId", "==", propId).limit(1).get();
      if (!g.empty) {
        await g.docs[0].ref.update({ updatedAt: ahora, historial: admin.firestore.FieldValue.arrayUnion(notaLead) });
      } else {
        const nuevaGestion = { clientId, propertyId: propId, estadoGestion: "nuevo", rol: "interesado", createdAt: ahora, updatedAt: ahora, historial: [notaLead] };
        if (ownerId) { nuevaGestion.agentId = ownerId; nuevaGestion.createdBy = ownerId; }
        await db.collection("gestiones").add(nuevaGestion);
      }
    }

    // 5) Aviso al agente (o al admin si la propiedad no se pudo identificar),
    //    con el mismo formato que las consultas de la web: campanita + push.
    if (destino) {
      await crearNotificacion(destino, {
        type: "consulta_infocasas",
        propertyId: propId || "",
        propertyTitle: (prop && prop.title) || "una propiedad",
        userName: nombre,
        userPhoto: null,
        userPhone: telefono || "",
        text: mensaje || "Consulta recibida desde InfoCasas",
      }, {
        title: "🔵 Lead de InfoCasas",
        body: `${nombre} consultó por ${(prop && prop.title) || "una propiedad"}${clienteExistia ? " (cliente ya existente)" : ""}`,
      });
    }

    await rawRef.update({ procesado: true, clientId: clientId || null, propertyId: propId || null });
    logger.info(`[leadInfocasas] Lead de ${nombre} (${telefono || "sin tel"}) -> cliente ${clientId || "?"} / propiedad ${propId || "no identificada"}.`);
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error("[leadInfocasas]", e);
    try { await rawRef.update({ error: String((e && e.message) || e) }); } catch (e2) { /* nada */ }
    // 200 igual: el crudo quedó guardado y no queremos reintentos infinitos de IC.
    res.status(200).json({ ok: true, guardadoCrudo: true });
  }
});

// ============================================================================
// AVISOS AL ADMIN DE LO QUE ESPERA EN EL PANEL
// Todo lo que cae en el Panel de Administración y necesita una decisión
// (alta de agente, testimonio, solicitud de venta, revisión) ahora avisa en
// la campanita y por push, en vez de descubrirse solo al entrar al panel.
// ============================================================================

// 1) Alta de agente esperando aprobación (users con status "pending")
exports.notificarAltaAgente = onDocumentCreated("users/{uid}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const u = snap.data();
  if (!u || u.status !== "pending") return;      // los aprobados de entrada no avisan
  const adm = await getAdminUser();
  const nombre = u.name || u.email || "Un usuario";
  // Diagnóstico: si el perfil del admin no aparece en 'users', nadie se entera de
  // los registros y no queda rastro de por qué. Venía de notificarNuevoUsuario.
  if (!adm) {
    await registrarLog("", "alta de agente SIN notificar", false, `No se encontró al admin (${ADMIN_EMAIL}) en users; revisá el email del perfil del admin.`);
    return;
  }
  if (adm.uid === snap.id) return;
  await notificarDireccion(
    {
      type: "admin_pendiente",
      subtipo: "alta",
      propertyId: "",
      propertyTitle: "una solicitud de alta — revisala en el Panel de Administración",
      userName: "👤 Alta de agente",
      userPhoto: u.profilePhoto || null,
      text: `${nombre} se registró y espera aprobación${u.email ? " (" + u.email + ")" : ""}.`,
    },
    { title: "👤 Nueva alta de agente", body: `${nombre} espera aprobación.` }
  );
  await registrarLog("", "alta de agente pendiente", true, `${nombre} (${u.email || ""})`);
});

// 2) Testimonio nuevo esperando aprobación
exports.notificarTestimonio = onDocumentCreated("testimonials/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const t = snap.data() || {};
  if (t.approved === true) return;               // si ya nace aprobado, no hay nada que decidir
  const adm = await getAdminUser();
  if (!adm) return;
  const autor = t.name || t.clientName || "Un cliente";
  const texto = String(t.text || t.comment || "").slice(0, 140);
  await notificarDireccion(
    {
      type: "admin_pendiente",
      subtipo: "testimonio",
      propertyId: "",
      propertyTitle: "un testimonio — aprobalo en el Panel de Administración",
      userName: "⭐ Testimonio nuevo",
      userPhoto: null,
      text: `${autor} dejó un testimonio${texto ? ': "' + texto + '…"' : ""}. Revisalo antes de publicarlo.`,
    },
    { title: "⭐ Testimonio para aprobar", body: `${autor} dejó un testimonio.` }
  );
});

// 3) Solicitud de venta/tasación desde el sitio (leadsVenta)
exports.notificarSolicitudVenta = onDocumentCreated("leadsVenta/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const l = snap.data() || {};
  const adm = await getAdminUser();
  if (!adm) return;
  const nombre = l.nombre || l.name || "Alguien";
  const contacto = [l.telefono || l.phone, l.email].filter(Boolean).join(" · ");
  const donde = l.direccion || l.zona || l.barrio || "";
  await notificarDireccion(
    {
      type: "admin_pendiente",
      subtipo: "solicitud",
      propertyId: "",
      propertyTitle: "una solicitud — contactala desde el Panel de Administración",
      userName: "📩 Solicitud nueva",
      userPhoto: null,
      text: `${nombre} pidió que la contacten${donde ? " por " + donde : ""}.${contacto ? " " + contacto : ""}`,
    },
    { title: "📩 Nueva solicitud de venta", body: `${nombre} quiere que la contacten.` }
  );
});

// 4) Revisiones: tasaciones y cálculos que los agentes guardan dentro de su
//    propio documento de usuario (arrays tasaciones / calcGastos / calcTerrenos).
//    Se compara el largo antes y después para avisar solo de las nuevas.
// Avisar al agente cuando el admin rechaza uno de sus informes. Sin esto el
// rechazo es mudo: el agente vuelve a entrar días después y no entiende por qué
// no puede descargar el PDF.
exports.notificarRechazo = onDocumentUpdated("users/{uid}", async (event) => {
  const before = event.data && event.data.before ? event.data.before.data() : null;
  const after = event.data && event.data.after ? event.data.after.data() : null;
  if (!before || !after) return;

  const TIPOS = [
    { campo: "tasaciones", etiqueta: "tasación" },
    { campo: "calcGastos", etiqueta: "cálculo de gastos" },
    { campo: "calcTerrenos", etiqueta: "cálculo de terreno" },
  ];
  const comoMapa = (v) => {
    if (Array.isArray(v)) { const o = {}; v.forEach((x) => { if (x && x.id) o[x.id] = x; }); return o; }
    return (v && typeof v === "object") ? v : {};
  };

  const rechazados = [];
  TIPOS.forEach((t) => {
    const a = comoMapa(after[t.campo]), b = comoMapa(before[t.campo]);
    Object.keys(a).forEach((k) => {
      // Solo el cambio a rechazada: si ya lo estaba, no se vuelve a avisar.
      if (a[k] && a[k].rechazada === true && !(b[k] && b[k].rechazada === true)) {
        rechazados.push({ etiqueta: t.etiqueta, motivo: a[k].motivoRechazo || "" });
      }
    });
  });
  if (!rechazados.length) return;

  const destino = { uid: event.params.uid, ...after };
  const r = rechazados[0];
  await crearNotificacion(destino, {
    type: "revision_rechazada",
    propertyId: "",
    propertyTitle: `tu ${r.etiqueta}`,
    userName: "Informe rechazado",
    userPhoto: null,
    text: `El administrador rechazó tu ${r.etiqueta}${r.motivo ? `: ${r.motivo}` : "."} Corregila y volvé a enviarla.`,
  }, {
    title: "Informe rechazado",
    body: r.motivo ? r.motivo.slice(0, 120) : `Revisá tu ${r.etiqueta}`,
  });
  logger.info(`[rechazo] ${event.params.uid}: ${rechazados.length} informe(s)`);
});

exports.notificarRevision = onDocumentUpdated("users/{uid}", async (event) => {
  const before = event.data && event.data.before ? event.data.before.data() : null;
  const after = event.data && event.data.after ? event.data.after.data() : null;
  if (!before || !after) return;

  const TIPOS = [
    { campo: "tasaciones", etiqueta: "Tasación" },
    { campo: "calcGastos", etiqueta: "Gastos y comisiones" },
    { campo: "calcTerrenos", etiqueta: "Cálculo de terreno" },
  ];
  // OJO: estos campos se guardan como MAPA, no como arreglo. El tasador escribe
  // `{ tasaciones: { [id]: rec } }`, así que `Array.isArray` daba false, contaba
  // cero antes y cero después, y la notificación no salía nunca. Se cuentan las
  // dos formas por si algún día alguno se guarda como lista.
  const cuantos = (v) => {
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === "object") return Object.keys(v).length;
    return 0;
  };
  const nuevas = TIPOS.filter((t) => cuantos(after[t.campo]) > cuantos(before[t.campo]));
  if (!nuevas.length) return;

  const adm = await getAdminUser();
  if (!adm || adm.uid === event.params.uid) return;   // si la hizo el propio admin, no se avisa
  const agente = after.name || after.email || "Un agente";
  const que = nuevas.map((n) => n.etiqueta).join(" y ");
  await notificarDireccion(
    {
      type: "admin_pendiente",
      subtipo: "revision",
      propertyId: "",
      propertyTitle: "una revisión — miralas en el Panel de Administración",
      userName: "🧮 Revisión nueva",
      userPhoto: after.profilePhoto || null,
      text: `${agente} guardó ${que.toLowerCase()}. Está esperando tu revisión.`,
    },
    { title: "🧮 Revisión para mirar", body: `${agente} guardó ${que.toLowerCase()}.` }
  );
});

/* ============================================================================
   DESTACADOS
   ----------------------------------------------------------------------------
   Poner una propiedad arriba de todo por 30 días. Cuántas puede tener ACTIVAS a
   la vez cada agente lo define su RANGO, no un cupo mensual: lo que satura la
   vitrina es cuántas hay al mismo tiempo, no cuántas se activaron en el mes.

   Todo pasa por acá y NO por el navegador. La regla de Firestore bloquea
   'featured' para el cliente justamente para que el cupo no se pueda saltear
   escribiendo el campo a mano por SDK.

   Espejo de rangos.js. Va duplicado porque las Functions no comparten bundle con
   el front; si cambia allá, hay que cambiarlo acá.
   ========================================================================== */
const DESTACADOS_POR_RANGO = {
  ceo: 3, coo: 3, gerente_comercial: 3,
  asesor_elite: 3, asesor_senior: 2, asesor_semi_senior: 1, asesor_junior: 1,
  finanzas: 1, administracion: 1, marketing: 1,
};
const DESTACADO_DIAS = 30;
const DESTACADO_MIN_FOTOS = 12;
const DESTACADO_EXTRA_PUNTOS = 2;

/* Puntos disponibles del agente, calculados EN EL SERVIDOR.
   El saldo que muestra la app se arma en el navegador; si el cobro confiara en
   eso, un agente podría comprarse destacados sin tener puntos. */
async function puntosDisponibles(uid) {
  let ganados = 0, gastados = 0;
  // Los puntos NO están guardados: se calculan desde los cierres confirmados,
  // 1 punto por cada US$100 de ganancia del agente. Es la misma cuenta que hace
  // la app; si acá se leyera un campo guardado, siempre daría cero.
  try {
    const cfgSnap = await db.doc("config/recompensas").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    const dolar = Number(cfg.dolarPesos) || 40;
    const porPunto = Number(cfg.usdPorPunto) || 100;
    const props = await db.collection("properties").where("ownerId", "==", uid).get();
    let usd = 0;
    props.docs.forEach((d) => {
      const p = d.data();
      if (!p.cierreConfirmado || !p.cierre) return;
      const c = p.cierre;
      const g = Number(c.gananciaAgente) || 0;
      if (!g) return;
      usd += (c.moneda === "UYU") ? g / dolar : g;
    });
    ganados = Math.floor(usd / porPunto);
  } catch (e) { logger.warn("puntosDisponibles ganados:", e.message); }
  try {
    const q = await db.collection("canjes").where("agenteUid", "==", uid).get();
    q.docs.forEach((d) => {
      const c = d.data();
      if (c.status !== "rechazado") gastados += Number(c.costoPuntos || 0);
    });
  } catch (e) { logger.warn("puntosDisponibles:", e.message); }
  return Math.max(0, ganados - gastados);
}

/** Cupo del agente. Sin rango cargado no puede destacar nada. */
function cupoDestacados(perfil) {
  if (!perfil) return 0;
  if (String(perfil.email || "").toLowerCase() === ADMIN_EMAIL) return 3;
  return DESTACADOS_POR_RANGO[String(perfil.rank || "")] || 0;
}

/* ¿La ficha está lo bastante completa como para ocupar la vitrina?
   No se recalcula el % de Mercado Libre / InfoCasas: ese puntaje se arma en el
   navegador y no queda guardado. Se exige lo que sí se puede verificar acá y es
   lo que realmente hace que un aviso rinda arriba. */
function fichaListaParaDestacar(p) {
  const faltan = [];
  const fotos = Array.isArray(p.images) ? p.images.length : 0;
  if (fotos < DESTACADO_MIN_FOTOS) faltan.push(`${DESTACADO_MIN_FOTOS} fotos (tenés ${fotos})`);
  if (!String(p.title || "").trim()) faltan.push("título");
  if (String(p.description || "").trim().length < 100) faltan.push("una descripción de al menos 100 caracteres");
  if (!(Number(p.price) > 0)) faltan.push("precio");
  const u = p.ubicacion || {};
  if (u.lat == null || u.lng == null) faltan.push("el pin en el mapa");
  return faltan;
}

/* ============================================================================
   ENTITLEMENTS DE DESTACADOS
   ----------------------------------------------------------------------------
   INVARIANTE PRINCIPAL: el tiempo pertenece al DESTACADO, no a la propiedad.
   Asignar o cambiar de propiedad NUNCA mueve 'validUntil'.

   Antes, activarDestacado escribía featuredHasta = ahora + 30 días sin mirar
   nada previo, y quitarDestacado limpiaba el campo gratis. Eso permitía:
   destaco A, mañana la saco y destaco B con 30 días nuevos, pasado vuelvo a A.
   El destacado quedaba encendido para siempre. Los 30 días no limitaban nada.

   MODELO
     - Destacados de RANGO: ciclo de mes calendario. Vencen el día 1 del mes
       siguiente sin importar cuándo se asignaron. Reasignables sin costo.
     - Destacado COMPRADO: 30 días exactos desde la compra, uno solo a la vez,
       sin regeneración. Solo se puede comprar con TODOS los slots de rango
       ocupados. Los puntos no se devuelven nunca.

   PROYECCIÓN: properties.featured / featuredHasta siguen existiendo porque
   propiedad.html es pública y no puede leer los entitlements del agente. Son
   una copia; la autoridad es el entitlement. Se escriben SIEMPRE en la misma
   transacción: si falla, no cambia ninguno de los dos.
   ========================================================================== */

/** Ciclo de mes calendario en hora de Montevideo. */
function cicloActual(ahora) {
  const d = ahora ? new Date(ahora) : new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const desde = new Date(Date.UTC(y, m, 1));
  const hasta = new Date(Date.UTC(y, m + 1, 1));
  return {
    cycleId: `${y}-${String(m + 1).padStart(2, "0")}`,
    validFrom: desde.toISOString(),
    validUntil: hasta.toISOString(),
  };
}

function entCol(uid) { return db.collection(`users/${uid}/featuredEntitlements`); }

/** Un entitlement está vivo si todavía no venció. */
function entVivo(e, ahora) {
  const hasta = e.validUntil ? Date.parse(e.validUntil) : 0;
  return hasta > (ahora || Date.now());
}

/** Deja rastro de cada movimiento. El agente no puede escribir acá. */
async function historial(uid, entId, accion, datos) {
  try {
    await entCol(uid).doc(entId).collection("history").add({
      accion, at: new Date().toISOString(), ...datos,
    });
  } catch (e) { logger.warn("historial destacados:", e.message); }
}

/* MIGRACIÓN LEGACY — corre una sola vez por agente.
   Los destacados que ya estaban vivos conservan su featuredHasta: no le
   cortamos la campaña a nadie ni le regalamos un reinicio hasta octubre.
   Cada uno consume un slot mientras siga vigente, si no la migración terminaría
   regalando capacidad (destacado viejo + slot del ciclo nuevo = dos).
   Fecha inválida o vacía = vencido: se limpia la proyección y no se crea nada.
   Inventarle 30 días a un dato roto sería peor. */
async function migrarLegacy(uid) {
  const marca = db.doc(`users/${uid}/featuredEntitlements/_migracion`);
  const ya = await marca.get();
  if (ya.exists) return;

  const props = await db.collection("properties")
    .where("ownerId", "==", uid).where("featured", "==", true).get();
  const ahora = Date.now();
  let creados = 0, limpiados = 0;

  for (const d of props.docs) {
    const p = d.data();
    const hasta = p.featuredHasta ? Date.parse(p.featuredHasta) : NaN;
    const valido = Number.isFinite(hasta) && hasta > ahora;
    if (!valido) {
      await d.ref.update({ featured: false, featuredHasta: "", featuredPor: "" });
      limpiados++;
      continue;
    }
    const id = `legacy_${d.id}`;
    await entCol(uid).doc(id).set({
      source: "legacy_migration",
      legacyType: p.extraPago ? "paid" : "rank",
      slotNumber: 0,
      cycleId: "legacy",
      validFrom: p.featuredDesde || new Date(ahora).toISOString(),
      validUntil: new Date(hasta).toISOString(),
      propertyId: d.id,
      status: "assigned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await historial(uid, id, "migrado", { propertyId: d.id, validUntil: new Date(hasta).toISOString() });
    creados++;
  }
  await marca.set({ at: new Date().toISOString(), creados, limpiados });
  if (creados || limpiados) {
    logger.info(`migrarLegacy ${uid}: ${creados} migrados, ${limpiados} limpiados`);
  }
}

/* Crea los entitlements de rango que falten para el ciclo en curso.
   Perezoso: se llama al leer o al activar. No depende del cron, así que un
   agente que entra el 20 recibe sus slots en el momento.
   Los legacy vigentes descuentan: nunca más slots que los del rango. */
async function ensureEntitlements(uid, perfil) {
  await migrarLegacy(uid);
  const ciclo = cicloActual();
  const ahora = Date.now();
  const cupo = cupoDestacados(perfil);

  const snap = await entCol(uid).get();
  const vivos = snap.docs
    .filter((d) => d.id !== "_migracion")
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((e) => entVivo(e, ahora));

  const deRango = vivos.filter((e) => e.source !== "points" && e.legacyType !== "paid").length;
  const faltan = Math.max(0, cupo - deRango);

  for (let i = 0; i < faltan; i++) {
    const n = deRango + i + 1;
    const id = `rank_${ciclo.cycleId}_${n}`;
    if (vivos.some((e) => e.id === id)) continue;
    await entCol(uid).doc(id).set({
      source: "rank",
      slotNumber: n,
      cycleId: ciclo.cycleId,
      validFrom: new Date().toISOString(),
      validUntil: ciclo.validUntil,
      propertyId: null,
      status: "available",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await historial(uid, id, "creado", { cycleId: ciclo.cycleId, validUntil: ciclo.validUntil });
    vivos.push({ id, source: "rank", propertyId: null, status: "available", validUntil: ciclo.validUntil, slotNumber: n });
  }
  return vivos;
}

/** Entitlements vivos del agente, ya asegurados para el ciclo. */
async function entitlementsVivos(uid) {
  const uSnap = await db.doc(`users/${uid}`).get();
  const perfil = uSnap.exists ? uSnap.data() : null;
  return ensureEntitlements(uid, perfil);
}

exports.activarDestacado = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const uid = request.auth.uid;
  const email = String(request.auth.token.email || "").toLowerCase();
  const propertyId = String((request.data && request.data.propertyId) || "");
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta la propiedad.");

  const [uSnap, pSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`properties/${propertyId}`).get(),
  ]);
  const perfil = uSnap.exists ? uSnap.data() : null;
  if (!perfil || perfil.status !== "approved") throw new HttpsError("permission-denied", "Tu cuenta no está aprobada.");
  if (!pSnap.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = pSnap.data();

  const esDir = await esDireccion(uid, email);
  if (p.ownerId !== uid && !esDir) throw new HttpsError("permission-denied", "Solo podés destacar tus propias propiedades.");

  const st = p.status || "available";
  if (st !== "available") throw new HttpsError("failed-precondition", "Solo se pueden destacar propiedades disponibles.");

  const faltan = fichaListaParaDestacar(p);
  if (faltan.length) {
    throw new HttpsError("failed-precondition", "Para destacarla, la ficha necesita: " + faltan.join(", ") + ".");
  }

  // El cupo se mide sobre el DUEÑO, no sobre quien aprieta el botón: si la
  // Dirección destaca el aviso de un agente, gasta el slot de ese agente.
  const duenoUid = p.ownerId || uid;
  const duenoPerfil = duenoUid === uid ? perfil : (await db.doc(`users/${duenoUid}`).get()).data();
  const cupo = cupoDestacados(duenoPerfil);
  if (cupo <= 0) throw new HttpsError("failed-precondition", "Tu rango todavía no tiene destacados disponibles.");

  const vivos = await ensureEntitlements(duenoUid, duenoPerfil);
  const ahora = Date.now();

  if (vivos.some((e) => e.propertyId === propertyId)) {
    throw new HttpsError("already-exists", "Esta propiedad ya está destacada.");
  }

  const libres = vivos.filter((e) => !e.propertyId);
  const quiereExtra = !!(request.data && request.data.conExtra);
  let entId = libres.length ? libres[0].id : null;
  let cobrarExtra = false;

  if (!entId) {
    if (!quiereExtra) {
      throw new HttpsError("resource-exhausted",
        `Ya tenés ${cupo} ${cupo === 1 ? "destacado activo" : "destacados activos"}. ` +
        `Podés sumar uno extra por ${DESTACADO_EXTRA_PUNTOS} puntos, cambiar la propiedad de uno, o esperar a que venza.`);
    }
    // Un solo extra a la vez. La fuente de verdad es el entitlement, no el
    // campo extraPago de la propiedad: ese se podía alterar desde el cliente.
    if (vivos.some((e) => e.source === "points" || e.legacyType === "paid")) {
      throw new HttpsError("resource-exhausted", "Ya tenés un destacado extra activo. Solo se permite uno a la vez.");
    }
    const saldo = await puntosDisponibles(duenoUid);
    if (saldo < DESTACADO_EXTRA_PUNTOS) {
      throw new HttpsError("failed-precondition",
        `Te faltan puntos: el extra cuesta ${DESTACADO_EXTRA_PUNTOS} y tenés ${saldo}.`);
    }
    cobrarExtra = true;
  }

  // El cobro va ANTES de destacar: si falla el canje, la propiedad no queda
  // destacada gratis.
  if (cobrarExtra) {
    await db.collection("canjes").add({
      agenteUid: duenoUid,
      concepto: `Destacado extra · ${p.title || "propiedad"}`,
      costoPuntos: DESTACADO_EXTRA_PUNTOS,
      status: "aprobado",
      tipo: "destacado",
      propertyId,
      createdAt: new Date().toISOString(),
    });
    const desde = new Date(ahora);
    const hasta = new Date(ahora + DESTACADO_DIAS * 86400000);
    entId = `paid_${ahora}`;
    await entCol(duenoUid).doc(entId).set({
      source: "points",
      slotNumber: 0,
      cycleId: "paid",
      validFrom: desde.toISOString(),
      validUntil: hasta.toISOString(),
      propertyId: null,
      status: "available",
      costoPuntos: DESTACADO_EXTRA_PUNTOS,
      createdAt: desde.toISOString(),
      updatedAt: desde.toISOString(),
    });
    await historial(duenoUid, entId, "comprado", { costoPuntos: DESTACADO_EXTRA_PUNTOS, validUntil: hasta.toISOString() });
  }

  // Asignación atómica: el entitlement y su proyección en la propiedad se
  // escriben juntos. Si dos toques rápidos compiten por el mismo slot, uno solo
  // pasa. Nunca se toca validUntil: acá está el invariante del sistema.
  const entRef = entCol(duenoUid).doc(entId);
  const hastaFinal = await db.runTransaction(async (tx) => {
    const eDoc = await tx.get(entRef);
    if (!eDoc.exists) throw new HttpsError("not-found", "El destacado ya no existe.");
    const e = eDoc.data();
    if (e.propertyId) throw new HttpsError("aborted", "Ese destacado se acaba de ocupar. Probá de nuevo.");
    if (!entVivo(e)) throw new HttpsError("failed-precondition", "Ese destacado ya venció.");
    tx.update(entRef, {
      propertyId, status: "assigned", updatedAt: new Date().toISOString(),
    });
    tx.update(pSnap.ref, {
      featured: true,
      featuredDesde: new Date().toISOString(),
      featuredHasta: e.validUntil,
      featuredPor: uid,
      featuredEntitlementId: entId,
      extraPago: e.source === "points",
    });
    return e.validUntil;
  });

  await historial(duenoUid, entId, "asignado", { propertyId, por: uid, validUntil: hastaFinal });
  await registrarLog(propertyId, "destacado activado", true, `hasta ${hastaFinal} · slot ${entId}`);
  const usados = vivos.filter((e) => e.propertyId).length + 1;
  return { ok: true, hasta: hastaFinal, usados, cupo, entitlementId: entId };
});

/* Libera el destacado de una propiedad. Ya NO hay exploit: el entitlement
   conserva su validUntil, así que reasignarlo no regala tiempo. */
exports.quitarDestacado = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const uid = request.auth.uid;
  const email = String(request.auth.token.email || "").toLowerCase();
  const propertyId = String((request.data && request.data.propertyId) || "");
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta la propiedad.");
  const pSnap = await db.doc(`properties/${propertyId}`).get();
  if (!pSnap.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = pSnap.data();
  const esDir = await esDireccion(uid, email);
  if (p.ownerId !== uid && !esDir) throw new HttpsError("permission-denied", "No es tu propiedad.");

  const duenoUid = p.ownerId || uid;
  const entId = p.featuredEntitlementId || null;
  const entRef = entId ? entCol(duenoUid).doc(entId) : null;

  await db.runTransaction(async (tx) => {
    if (entRef) {
      const eDoc = await tx.get(entRef);
      if (eDoc.exists) {
        tx.update(entRef, { propertyId: null, status: "available", updatedAt: new Date().toISOString() });
      }
    }
    tx.update(pSnap.ref, {
      featured: false, featuredHasta: "", featuredPor: "",
      featuredEntitlementId: null, extraPago: false,
    });
  });
  if (entId) await historial(duenoUid, entId, "liberado", { propertyId, por: uid });
  return { ok: true };
});

/** Estado de los destacados del agente. Lo consulta la tarjeta. */
exports.estadoDestacados = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const uid = request.auth.uid;
  const uSnap = await db.doc(`users/${uid}`).get();
  const perfil = uSnap.exists ? uSnap.data() : null;
  const cupo = cupoDestacados(perfil);
  const vivos = await ensureEntitlements(uid, perfil);
  const usados = vivos.filter((e) => e.propertyId);
  return {
    cupo,
    usados: usados.length,
    ids: usados.map((e) => e.propertyId),
    puedeComprarExtra: usados.length >= cupo
      && !vivos.some((e) => e.source === "points" || e.legacyType === "paid"),
    costoExtra: DESTACADO_EXTRA_PUNTOS,
    slots: vivos.map((e) => ({
      id: e.id,
      tipo: e.source === "points" || e.legacyType === "paid" ? "comprado" : "rango",
      propertyId: e.propertyId || null,
      validUntil: e.validUntil,
    })),
  };
});

/* LIMPIEZA, no exactitud. Quién está vencido lo decide la fecha, no este cron:
   el cliente usa isEffectivelyFeatured() y no espera a las 7:05. Acá solo se
   apagan proyecciones viejas y se liberan entitlements de propiedades que
   salieron del mercado, conservando su validUntil. */
exports.vencerDestacados = onSchedule(
  { schedule: "5 7 * * *", timeZone: "America/Montevideo" },
  async () => {
    const snap = await db.collection("properties").where("featured", "==", true).get();
    const ahora = Date.now();
    let vencidos = 0, liberados = 0;
    for (const d of snap.docs) {
      const p = d.data();
      const hasta = p.featuredHasta ? Date.parse(p.featuredHasta) : 0;
      const fueraDeJuego = (p.status && p.status !== "available");
      const venció = !hasta || hasta <= ahora;
      if (!venció && !fueraDeJuego) continue;

      const duenoUid = p.ownerId || null;
      const entId = p.featuredEntitlementId || null;
      await d.ref.update({
        featured: false, featuredHasta: "", featuredPor: "",
        featuredEntitlementId: null, extraPago: false,
      });
      // Si la propiedad salió del mercado el destacado NO se pierde: vuelve a
      // estar disponible con los días que le quedaban. Si venció, no hay nada
      // que devolver.
      if (duenoUid && entId && !venció && fueraDeJuego) {
        try {
          await entCol(duenoUid).doc(entId).update({
            propertyId: null, status: "available", updatedAt: new Date().toISOString(),
          });
          await historial(duenoUid, entId, "liberado_por_cierre", { propertyId: d.id, status: p.status });
          liberados++;
        } catch (e) { logger.warn("vencerDestacados: liberar", e.message); }
      }
      vencidos++;
      try {
        const dueno = duenoUid ? (await db.doc(`users/${duenoUid}`).get()) : null;
        if (dueno && dueno.exists) {
          await crearNotificacion(
            { uid: duenoUid, ...dueno.data() },
            {
              type: "destacado_vencido",
              propertyId: d.id,
              propertyTitle: p.title || "",
              userName: "⭐ Destacado terminado",
              text: fueraDeJuego
                ? "La propiedad ya no está disponible, así que se liberó el destacado con los días que le quedaban. Podés usarlo en otra."
                : "Se cumplió el período del destacado. Te quedó el lugar libre para destacar otra.",
            },
            { title: "⭐ Destacado terminado", body: p.title || "Tenés un lugar libre." },
            `destvenc_${d.id}_${Math.floor(ahora / 86400000)}`
          );
        }
      } catch (e) { logger.warn("vencerDestacados: aviso", e); }
    }
    // Marca vencidos los entitlements pasados de fecha, para que no queden
    // contando en ensureEntitlements ni en el panel del agente.
    try {
      const users = await db.collection("users").get();
      for (const u of users.docs) {
        const es = await entCol(u.id).get();
        for (const e of es.docs) {
          if (e.id === "_migracion") continue;
          const dat = e.data();
          if (dat.status !== "expired" && !entVivo(dat, ahora)) {
            await e.ref.update({ status: "expired", updatedAt: new Date().toISOString() });
          }
        }
      }
    } catch (e) { logger.warn("vencerDestacados: expirar entitlements", e.message); }
    logger.info(`vencerDestacados: ${vencidos} apagados, ${liberados} destacados liberados`);
  }
);

/* ============================================================================
   ELIMINAR AGENTE (de verdad)
   ----------------------------------------------------------------------------
   El panel borraba solo el documento de Firestore. La cuenta de Authentication
   quedaba viva, así que la persona podía volver a iniciar sesión — y la
   reparación automática de app.js ("cuenta sin perfil, la creamos") le rearmaba
   el perfil en 'pending'. Resultado: el eliminado reaparecía en la Bandeja como
   agente esperando aprobación.
   Acá se borra la cuenta de Authentication. El perfil de Firestore lo limpia
   solo el trigger limpiarPerfilAlBorrarse.
   ========================================================================== */
exports.eliminarAgente = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  const uid = request.auth.uid;
  const objetivo = String((request.data && request.data.uid) || "");
  if (!objetivo) throw new HttpsError("invalid-argument", "Falta el agente.");

  // Borrar una cuenta es irreversible: solo el CEO, igual que retiros y papelera.
  let esCEO = email === ADMIN_EMAIL;
  if (!esCEO) {
    const me = await db.doc(`users/${uid}`).get();
    esCEO = me.exists && me.data().rank === "ceo" && me.data().status === "approved";
  }
  if (!esCEO) throw new HttpsError("permission-denied", "Solo el CEO puede eliminar una cuenta.");
  if (objetivo === uid) throw new HttpsError("failed-precondition", "No podés eliminar tu propia cuenta.");

  const oSnap = await db.doc(`users/${objetivo}`).get();
  const o = oSnap.exists ? oSnap.data() : null;
  if (o && (o.rank === "ceo" || String(o.email || "").toLowerCase() === ADMIN_EMAIL)) {
    throw new HttpsError("failed-precondition", "La cuenta del CEO no se puede eliminar.");
  }

  const quien = (o && (o.name || o.email)) || objetivo;
  let authBorrada = false;
  try {
    await admin.auth().deleteUser(objetivo);
    authBorrada = true;   // el trigger limpiarPerfilAlBorrarse borra el perfil
  } catch (e) {
    // Si la cuenta ya no existía en Authentication, igual hay que sacar el perfil.
    if (e && e.code === "auth/user-not-found") {
      try { await db.doc(`users/${objetivo}`).delete(); } catch (e2) { /* ya no estaba */ }
    } else {
      logger.error("eliminarAgente:", e);
      throw new HttpsError("internal", "No se pudo eliminar la cuenta: " + (e.message || ""));
    }
  }
  await registrarLog("", "agente eliminado", true, `${quien}${authBorrada ? "" : " (solo perfil: no tenía cuenta)"}`);
  return { ok: true, authBorrada };
});

/* ============================================================================
   INFOCASAS — API DE INTEGRACIÓN (reemplaza al feed XML)
   ----------------------------------------------------------------------------
   Autenticación: API Key en el encabezado `apikey`.
   La publicación es ASINCRÓNICA: POST/PATCH /listing devuelve un task_id y hay
   que consultar GET /task para saber si terminó (COMPLETED o ERROR).

   RESPUESTAS DE INFOCASAS (Frank Payares, 31/08/2026):
     · El catálogo de ubicaciones es GET /location/download, no /location. Trae
       location_type "state" y "neighbourhood"; esos ids van en estate_id y
       neighbourhood_id.
     · GET /task exige el id en la ruta. Sin id da 404 SIEMPRE: no es una falla.
       El id es el task_id que devuelve el POST /listing.
     · /listing exige el header 'cookie' con el client_id, que sale de /client.
       Ese era el 401.
     · /client hoy devuelve una sola inmobiliaria: Malave Inmobiliaria,
       5f6430c5-a32f-11f1-bc84-06cab93c00b5.

   ⚠️  CUPO: la cuenta tiene initial_quota 50. Es un tope duro de avisos. Hoy la
   cartera anda cerca de ese número, así que antes de migrar hay que decidir qué
   entra. El feed XML no tenía este límite.

   ⚠️  POST /validate-listing NO valida: SINCRONIZA. Se le manda la lista de las
   propiedades que deben quedar activas y DA DE BAJA TODO LO QUE NO ESTÉ EN ELLA.
   Con la lista vacía elimina todos los avisos. No se usa hasta el final y con
   doble confirmación. (Confirmado por el equipo de InfoCasas, 28/08/2026.)

   No hay convivencia con el feed XML: cuando se cambia, se cambia entero.
   ========================================================================== */
const IC_API_BASE = (process.env.IC_API_BASE || "https://kong-qa.frcol.io/management/api/1.0").replace(/\/+$/, "");
const IC_API_KEY = process.env.IC_API_KEY || "";
// Opcional. Solo hace falta si algún día el apikey queda asociado a más de una
// inmobiliaria. Hoy /client devuelve una sola: Malave Inmobiliaria,
// 5f6430c5-a32f-11f1-bc84-06cab93c00b5 (verificado 31/08/2026).
const IC_CLIENT_ID = process.env.IC_CLIENT_ID || "";
// Código de agente de InfoCasas. Si el cliente no tiene ningún agente asociado,
// la API rechaza la creación por autenticación. Se da de alta en el panel de
// InfoCasas y el código se pone acá. Si un usuario del CRM tiene su propio
// icAgentId, ese gana sobre este valor.
const IC_CLIENT_AGENT = process.env.IC_CLIENT_AGENT || "";
// Webhook. El HUB.ID lo facilita InfoCasas (Frank, 01/09/2026). IC_WEBHOOK_URL
// es la URL de icWebhook una vez desplegada. IC_WEBHOOK_TOKEN es el valor que
// ellos mandan en el header VERIFY-TOKEN; si queda vacío el endpoint NO valida
// nada y cualquiera puede inyectar eventos falsos.
const IC_WEBHOOK_ID = process.env.IC_WEBHOOK_ID || "";
const IC_WEBHOOK_URL = process.env.IC_WEBHOOK_URL || "";
const IC_WEBHOOK_TOKEN = process.env.IC_WEBHOOK_TOKEN || "";

/* El client_id se pide una vez y se guarda en memoria. La instancia de la
   función vive un rato entre llamadas, así que esto ahorra un GET /client por
   cada publicación. */
let _icClient = null, _icClientAt = 0;

async function icClientId() {
  if (IC_CLIENT_ID) return IC_CLIENT_ID;
  if (_icClient && Date.now() - _icClientAt < 30 * 60 * 1000) return _icClient;
  const r = await icFetch("/client");
  if (!r.ok) throw new HttpsError("failed-precondition", `No se pudo leer /client (${r.status}). Sin client_id no se puede publicar.`);
  const lista = Array.isArray(r.data) ? r.data : (r.data && (r.data.data || r.data.results)) || [];
  if (!lista.length) throw new HttpsError("failed-precondition", "/client no devolvió ninguna inmobiliaria.");
  if (lista.length > 1) {
    // No adivinamos: publicar con el id equivocado significa cargar avisos en la
    // cuenta de otra inmobiliaria.
    const ids = lista.map((c) => `${c.name}=${c.id}`).join(" · ");
    throw new HttpsError("failed-precondition",
      `/client devolvió ${lista.length} inmobiliarias. Definí IC_CLIENT_ID en el .env. Opciones: ${ids}`);
  }
  _icClient = lista[0].id; _icClientAt = Date.now();
  return _icClient;
}

/** Llamada a la API de InfoCasas. Devuelve { ok, status, data }.
    conCookie: agrega el header 'cookie' con el client_id. Lo pide /listing;
    sin eso responde 401. (Confirmado por Frank Payares, 31/08/2026.) */
async function icFetch(path, { method = "GET", body = null, conCookie = false } = {}) {
  if (!IC_API_KEY) throw new HttpsError("failed-precondition", "Falta IC_API_KEY en el .env de functions.");
  // Los endpoints de consulta piden un valor dinámico en la URL para saltear
  // la caché de ellos (lo indica su documentación).
  // SIN barra final. Verificado con icExplorar el 29/08/2026: /client da 200 y
  // /client/ da 404. Es al revés de lo que sugería el 404 de Django que vimos en
  // el navegador, así que las rutas van tal cual las declara la documentación.
  const ruta = path;
  const sep = ruta.includes("?") ? "&" : "?";
  const url = IC_API_BASE + ruta + (method === "GET" ? `${sep}_=${Date.now()}` : "");
  // axios, igual que el resto del archivo (Mercado Libre). validateStatus en true
  // para manejar los errores acá y no con try/catch en cada llamada.
  const headers = { apikey: IC_API_KEY, "Content-Type": "application/json", Accept: "application/json" };
  if (conCookie) headers.cookie = await icClientId();
  const res = await axios({
    url, method,
    headers,
    data: body || undefined,
    timeout: 20000,
    validateStatus: () => true,
  });
  const ok = res.status >= 200 && res.status < 300;
  if (!ok) logger.warn(`InfoCasas ${method} ${path} -> ${res.status}`, res.data);
  // Se devuelve el content-type porque /location/download puede contestar un
  // archivo (CSV) en vez de JSON y hay que saberlo para parsearlo bien.
  return { ok, status: res.status, data: res.data, tipoContenido: String((res.headers && res.headers["content-type"]) || "") };
}

/* Trae el catálogo de ubicaciones de InfoCasas y lo guarda en Firestore.
   El endpoint correcto es /location/download, NO /location: ese daba 404 y nos
   tuvo trabados. Devuelve el catálogo completo con location_type ("state" o
   "neighbourhood"); esos ids son los que van en estate_id y neighbourhood_id al
   publicar. (Confirmado por Frank Payares, 31/08/2026.)

   Se guarda en lotes dentro de una subcolección porque un documento de Firestore
   tope en 1 MB y el catálogo de todo el país no entra. Antes se guardaba solo una
   muestra de 50, que no sirve para armar la equivalencia con nuestros barrios.
   No publica ni modifica nada: solo lee. */
exports.icUbicaciones = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const r = await icFetch("/location/download");
  if (!r.ok) {
    return { ok: false, status: r.status, detalle: r.data,
             pista: r.status === 401 || r.status === 403
               ? "La API Key fue rechazada. Revisá IC_API_KEY en el .env."
               : "Revisá IC_API_BASE o si cambió la ruta del catálogo." };
  }

  /* El nombre "download" ya avisa que puede no ser JSON. Se prueban las formas
     conocidas y, si ninguna sirve, se DEVUELVE LA FORMA REAL en vez de un cero
     sin explicación: un catálogo vacío y un parser equivocado se ven igual desde
     afuera, y eso nos costó una vuelta entera. */
  const d = r.data;
  let items = [];
  let comoSeLeyo = "";

  if (Array.isArray(d)) { items = d; comoSeLeyo = "array"; }
  else if (d && typeof d === "object") {
    for (const k of ["data", "results", "items", "locations", "content", "records", "rows"]) {
      if (Array.isArray(d[k])) { items = d[k]; comoSeLeyo = `objeto.${k}`; break; }
    }
  } else if (typeof d === "string") {
    const txt = d.trim();
    if (txt.startsWith("[") || txt.startsWith("{")) {
      try {
        const j = JSON.parse(txt);
        items = Array.isArray(j) ? j : (j.data || j.results || j.items || []);
        comoSeLeyo = "json-en-texto";
      } catch (e) { /* sigue abajo */ }
    }
    if (!items.length && txt.includes("\n")) {
      // CSV o TSV. Se detecta el separador por la primera línea.
      const lineas = txt.split(/\r?\n/).filter((l) => l.trim());
      const cab = lineas[0] || "";
      const sep = (cab.match(/;/g) || []).length > (cab.match(/,/g) || []).length ? ";"
        : (cab.includes("\t") ? "\t" : ",");
      const cols = cab.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
      items = lineas.slice(1).map((l) => {
        const v = l.split(sep);
        const o = {};
        cols.forEach((c, i) => { o[c] = (v[i] || "").trim().replace(/^"|"$/g, ""); });
        return o;
      });
      comoSeLeyo = `csv(sep="${sep === "\t" ? "tab" : sep}")`;
    }
  }

  // Diagnóstico crudo: sale SIEMPRE, aunque el parseo haya funcionado.
  const diagnostico = {
    tipoContenido: r.tipoContenido,
    tipoJs: Array.isArray(d) ? "array" : typeof d,
    claves: d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d).slice(0, 20) : null,
    largoTexto: typeof d === "string" ? d.length : null,
    inicio: typeof d === "string" ? d.slice(0, 500) : null,
    primerItem: items[0] || null,
    comoSeLeyo: comoSeLeyo || "no se pudo leer",
  };

  if (!items.length) {
    return { ok: false, cantidad: 0,
             pista: "La API respondió 200 pero no se reconoció el formato. Mirá 'diagnostico'.",
             diagnostico };
  }

  const tipo = (x) => String(x.location_type || x.locationType || x.type || "").toLowerCase();

  /* DEDUPLICACIÓN. El CSV devuelve cada ubicación TRES veces, variando solo
     state_name, que ademas viene mal: se resuelve contra la tabla de barrios en
     vez de la de departamentos. Ejemplo: Aguada llega con state_id 10
     (Montevideo, correcto) y state_name "Bañados de Carrasco", que es el barrio
     con id 10. Y todas las filas STATE traen state_id 1 sea cual sea el
     departamento.
     Por eso se descarta state_name y se deduplica por id + tipo.
     1.246 filas -> 415 ubicaciones reales: 20 departamentos y 395 barrios.
     (Reportado a Frank Payares el 31/08/2026.) */
  const vistos = new Set();
  const limpios = [];
  for (const x of items) {
    const t = tipo(x);
    if (!t) continue;                       // fila vacía del final del CSV
    const clave = `${t}:${x.id}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    limpios.push({
      id: String(x.id || "").trim(),
      name: String(x.name || "").trim(),    // vienen con espacios: "Aceguá "
      location_type: t,
      location_point: String(x.location_point || "").trim(),
      state_id: String(x.state_id || "").trim(),
      // state_name se omite a propósito: el dato es incorrecto en el origen.
    });
  }
  const filasCrudas = items.length;
  items = limpios;

  const states = items.filter((x) => tipo(x) === "state");
  const barrios = items.filter((x) => tipo(x) === "neighbourhood");
  const otros = items.filter((x) => tipo(x) !== "state" && tipo(x) !== "neighbourhood");

  try {
    const base = db.doc("adminData/infocasasUbicaciones");
    await base.set({
      actualizado: new Date().toISOString(),
      cantidad: items.length,
      states: states.length, neighbourhoods: barrios.length, otros: otros.length,
      comoSeLeyo,
      catalogoStates: states.slice(0, 500),
      ejemploBarrio: barrios[0] || items[0] || null,
      tiposVistos: [...new Set(items.map(tipo))],
    });
    const lotes = base.collection("lotes");
    const previos = await lotes.get();
    for (const doc of previos.docs) await doc.ref.delete();
    const paraLotes = barrios.length ? barrios : items;
    for (let i = 0; i < paraLotes.length; i += 400) {
      await lotes.doc(String(i / 400).padStart(3, "0")).set({ items: paraLotes.slice(i, i + 400) });
    }
  } catch (e) { logger.warn("icUbicaciones: no se pudo guardar", e.message); }

  return {
    ok: true, cantidad: items.length, filasCrudas,
    states: states.length, neighbourhoods: barrios.length, otros: otros.length,
    tiposVistos: [...new Set(items.map(tipo))],
    diagnostico,
    muestraStates: states.slice(0, 25),
    muestraBarrios: (barrios.length ? barrios : items).slice(0, 10),
  };
});

/* ============================================================================
   PUBLICACIÓN POR API (POST /listing)
   ----------------------------------------------------------------------------
   Convive con feedInfocasas (XML), que sigue vivo hasta el sunset. No se toca.

   El flujo es ASÍNCRONO y en tres pasos:
     1) POST /listing            -> devuelve task_id (NO publica todavía)
     2) GET  /task/{task_id}     -> COMPLETED o ERROR
     3) del resultado sale el listing_id, que hay que GUARDAR: es lo único que
        después permite editar o dar de baja el aviso.
   ========================================================================== */

/* PROPERTY_CONDITION de la ficha -> "condition" de la API.
   ATENCIÓN: los ids NO son los mismos que usa el feed XML. En el XML,
   "buen estado" es 4; en la API, 4 es "Remodelado" y "Bueno" es 3. Copiar la
   tabla del feed publicaría todas las propiedades usadas como remodeladas.
   "usado" va a 0 (sin especificar): no afirmamos un estado que el agente no
   declaró. */
const IC_API_CONDICION = {
  "nuevo": 1,            // Nueva marca
  "buen estado": 3,      // Bueno
  "renovado": 4,         // Remodelado
  "en construccion": 6,  // Desarrollo
  "usado": 0,            // Sin especificar
};

/* view_map: 0 punto geográfico, 1 oculto, 2 mostrar solo zona. */
function icApiViewMap(ficha) {
  const v = icNorm((ficha || {}).IC_UBICACION);
  if (v === "punto exacto") return 0;
  if (v === "punto aproximado") return 2;
  return 0;
}

/* Arma el cuerpo del POST/PATCH /listing a partir de una propiedad del CRM.
   Devuelve { ok, payload, faltan } — si faltan campos obligatorios no se
   inventa nada: se informa y no se publica. */
async function icApiPayload(p, propId, agente) {
  const F = p.ficha || {};
  const u = p.ubicacion || {};
  const faltan = [];

  const externalCode = String(F.PROPERTY_CODE || propId || "").trim();
  if (!externalCode) faltan.push("código de propiedad");

  const offer = IC_API_OFERTA[String(p.type || "").toLowerCase()];
  if (!offer) faltan.push(`tipo de operación no reconocido: "${p.type || ""}"`);

  const propertyType = IC_API_TIPO[icNorm(p.realEstateType)];
  if (!propertyType) faltan.push(`tipo de propiedad no reconocido: "${p.realEstateType || ""}"`);

  const price = Number(p.price) || 0;
  if (!(price > 0)) faltan.push("precio");

  // area es obligatorio y positivo. Se prefiere lo edificado; si no hay, total.
  const ta = Number(p.totalArea) || 0, ca = Number(p.builtArea) || 0;
  const area = ca > 0 ? ca : ta;
  if (!(area > 0)) faltan.push("superficie");

  const lat = Number(u.lat != null ? u.lat : p.lat);
  const lng = Number(u.lng != null ? u.lng : p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) faltan.push("pin de ubicación (lat/lng)");

  const depId = IC_DEPTOS[icNorm(p.departamento || u.departamento)];
  if (!depId) faltan.push(`departamento no reconocido: "${p.departamento || u.departamento || ""}"`);
  const zona = depId ? icZona(depId, p.ciudad || u.ciudad, u.barrio) : null;
  if (!zona) faltan.push("zona/barrio no mapeado");

  // address.address tiene maxLength 120 en el esquema: se recorta.
  const direccion = String(u.direccionVisible || u.direccion || "").trim().slice(0, 120);
  if (!direccion) faltan.push("dirección");

  const descripcion = String(p.description || "").trim();
  if (!descripcion) faltan.push("descripción");

  // listing_contact es obligatorio y necesita al menos un mail y un teléfono.
  const mail = String((agente && agente.email) || "").trim();
  const tel = String(p.ownerWhatsapp || (agente && agente.whatsapp) || "").trim();
  if (!mail) faltan.push("correo del agente");
  if (!tel) faltan.push("teléfono del agente");

  // Hasta 30 fotos según el esquema. El feed corta en 15; acá se aprovecha el
  // tope real, que es lo que mejora el aviso.
  const imgs = (p.images || []).filter(Boolean).slice(0, 30);
  if (!imgs.length) faltan.push("fotos");

  if (faltan.length) return { ok: false, faltan };

  const payload = {
    external_code: externalCode,
    client_id: await icClientId(),
    offer,
    property_type: propertyType,
    description: descripcion + (externalCode ? `\n\nRef.: ${externalCode}` : ""),
    price: Math.round(price),
    // SIEMPRE explícito: el default de la API es USD, así que omitirlo
    // publicaría un alquiler en pesos como si fueran dólares.
    currency: icApiCurrency(p.currency),
    area,
    stratum: IC_API_STRATUM_UY,
    address: { address: direccion },
    locations: {
      location_point: { longitude: lng, latitude: lat },
      view_map: icApiViewMap(F),
      estate_id: Number(depId),
      // OJO: en el POST el campo va SIN la "u" (neighborhood), mientras que el
      // catálogo CSV usa NEIGHBOURHOOD con "u". Escribirlo mal es rechazo.
      neighborhood_id: Number(zona),
    },
    listing_contact: {
      emails: [{ is_main: true, email: mail, sort_order: 0 }],
      phones: [{ phone: tel, is_whatsapp_number: true, is_click_to_call: true, sort_order: 0 }],
    },
    photos: imgs.map((url, i) => ({ sort_order: i + 1, is_main: i === 0, image: url })),
  };

  const agentId = Number(IC_CLIENT_AGENT || (agente && agente.icAgentId) || 0);
  if (agentId > 0) payload.client_agent = agentId;

  const cond = IC_API_CONDICION[icNorm(F.PROPERTY_CONDITION)];
  if (cond) payload.condition = cond;

  const rooms = icApiRooms(p.bedrooms);
  if (rooms) payload.rooms = rooms;
  const baths = icApiBaths(p.bathrooms);
  if (baths) payload.baths = baths;

  const cocheras = Number(F.PARKING_LOTS || 0) || (p.garage === "yes" ? 1 : 0);
  const garages = icApiGarages(cocheras);
  if (garages) payload.garages = garages;

  const plantas = icApiFloor(F.FLOORS);
  if (plantas) payload.floor = plantas;
  if (typeof F.UNIT_FLOOR === "number" && F.UNIT_FLOOR > 0) {
    payload.interior_floors = icApiFloor(F.UNIT_FLOOR);
  }

  if (typeof F.PROPERTY_AGE === "number") payload.age = icApiAge(F.PROPERTY_AGE);

  // living_area = área privada, solo para casa/lote según el esquema.
  const terreno = Number(F.LAND_AREA || 0);
  if (terreno > 0 && (propertyType === "house" || propertyType === "lot")) {
    payload.living_area = terreno;
  }

  const cats = icApiCategories(F);
  if (cats.length) payload.categories = cats;

  // administration solo aplica al alquiler. No tiene moneda propia: queda
  // pendiente de confirmar si hereda currency del listing.
  if (offer === "rent") {
    const gc = Number(p.commonExpenses) || 0;
    // Antes, sin gastos cargados se mandaba is_included: true, o sea que se le
    // AFIRMABA a InfoCasas que están incluidos en el alquiler. Es una suposición
    // y suele ser falsa: la ficha simplemente no tenía el dato. Publicar
    // "gastos incluidos" cuando no lo están es un reclamo del inquilino.
    if (gc > 0) {
      // administration tiene su PROPIO currency, con el mismo default de USD
      // (confirmado en la doc, 02/09/2026). Va explícito por la misma razón que
      // el precio: omitirlo publicaría $24.600 de gastos como US$ 24.600.
      // El feed XML ya asume pesos para gastos comunes (IDmonedagc: 2), así que
      // se respeta ese criterio salvo que la propiedad diga otra cosa.
      payload.administration = {
        is_included: false,
        price: Math.round(gc),
        currency: icApiCurrency(p.commonExpensesCurrency || "UYU"),
      };
    } else if (p.commonExpensesIncluded === true) {
      payload.administration = { is_included: true };
    } else {
      return { ok: false, faltan: ["gastos comunes (o marcar que están incluidos)"] };
    }
  }

  const video = String(p.videoUrl || "");
  if (/youtu\.?be/i.test(video)) payload.video = video;

  return { ok: true, payload };
}

/* Consulta el estado de una tarea hasta que termina. La publicación es
   asíncrona: el POST solo encola. Se consulta con espera creciente para no
   golpear la API, que tiene límite de peticiones (429). */
async function icEsperarTarea(taskId, intentos) {
  const max = intentos || 8;
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500 + i * 1500));
    const r = await icFetch(`/task/${encodeURIComponent(taskId)}`, { conCookie: true });
    if (!r.ok) {
      if (r.status === 429) continue;  // throttled: se reintenta
      return { ok: false, status: r.status, detalle: r.data };
    }
    const d = r.data || {};
    const t = d.task || d;
    const estado = String(t.status || t.state || "").toUpperCase();
    if (estado === "COMPLETED" || estado === "ERROR" || estado === "FAILED") {
      return { ok: estado === "COMPLETED", estado, detalle: d };
    }
  }
  return { ok: false, estado: "TIMEOUT", detalle: "La tarea no terminó a tiempo. Se puede consultar más tarde con el task_id." };
}

/* Publica UNA propiedad en InfoCasas por API.
   Guarda icListingId en la propiedad: sin ese id no se puede editar ni dar de
   baja después. */
exports.publicarEnInfocasas = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const propertyId = String((request.data && request.data.propertyId) || "");
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta la propiedad.");
  const soloVistaPrevia = !!(request.data && request.data.dryRun);

  const pSnap = await db.doc(`properties/${propertyId}`).get();
  if (!pSnap.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = pSnap.data();

  const uSnap = p.ownerId ? await db.doc(`users/${p.ownerId}`).get() : null;
  const agente = uSnap && uSnap.exists ? uSnap.data() : {};

  const armado = await icApiPayload(p, pSnap.id, agente);
  if (!armado.ok) {
    return { ok: false, faltan: armado.faltan,
             pista: "La ficha no tiene todo lo que exige InfoCasas. No se envió nada." };
  }

  // dryRun devuelve el cuerpo sin enviarlo: sirve para revisar el mapeo antes
  // de tocar el portal.
  if (soloVistaPrevia) return { ok: true, dryRun: true, payload: armado.payload };

  const r = await icFetch("/listing", { method: "POST", body: [armado.payload], conCookie: true });
  if (!r.ok) {
    logger.warn(`publicarEnInfocasas ${propertyId} -> ${r.status}`, r.data);
    return { ok: false, status: r.status, detalle: r.data };
  }

  const d = r.data || {};
  const taskId = d.task_id || d.taskId || (d.data && d.data.task_id) || null;
  if (!taskId) return { ok: false, detalle: d, pista: "La API respondió 200 pero no devolvió task_id." };

  await pSnap.ref.update({ icTaskId: taskId, icEnviadoAt: new Date().toISOString() });

  const fin = await icEsperarTarea(taskId);
  const info = (fin.detalle && (fin.detalle.task || fin.detalle)) || {};
  const listingId = info.listing_id || info.listingId ||
    (Array.isArray(info.results) && info.results[0] && info.results[0].listing_id) || null;

  if (fin.ok && listingId) {
    await pSnap.ref.update({
      icListingId: String(listingId),
      icEstado: "publicado",
      icPublicadoAt: new Date().toISOString(),
    });
    await registrarLog(propertyId, "InfoCasas: publicado", true, `listing ${listingId}`);
    return { ok: true, taskId, listingId };
  }

  await pSnap.ref.update({ icEstado: fin.estado === "TIMEOUT" ? "pendiente" : "error" });
  await registrarLog(propertyId, "InfoCasas: publicación", false, `${fin.estado || ""} ${JSON.stringify(fin.detalle || "").slice(0, 300)}`);
  return { ok: false, taskId, estado: fin.estado, detalle: fin.detalle };
});

/* Consulta una tarea ya encolada. Útil cuando la publicación dio TIMEOUT: el
   task_id queda guardado en la propiedad y se puede retomar sin republicar. */
exports.icEstadoTarea = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const taskId = String((request.data && request.data.taskId) || "");
  if (!taskId) throw new HttpsError("invalid-argument", "Falta taskId.");
  const r = await icFetch(`/task/${encodeURIComponent(taskId)}`, { conCookie: true });
  return { ok: r.ok, status: r.status, detalle: r.data };
});

/* Actualiza un aviso ya publicado. Reusa el mismo armado que la publicación:
   si el payload cambia, cambia para los dos y no se desincronizan.

   Necesita icListingId, que quedó guardado al publicar. Sin ese id InfoCasas no
   sabe qué aviso tocar: por eso publicar y guardar el id es un solo paso. */
exports.editarEnInfocasas = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const propertyId = String((request.data && request.data.propertyId) || "");
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta la propiedad.");
  const soloVistaPrevia = !!(request.data && request.data.dryRun);

  const pSnap = await db.doc(`properties/${propertyId}`).get();
  if (!pSnap.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = pSnap.data();

  const listingId = String(p.icListingId || "");
  if (!listingId) {
    return { ok: false, pista: "Esta propiedad no está publicada en InfoCasas por API (no tiene icListingId). Usá publicarEnInfocasas." };
  }

  const uSnap = p.ownerId ? await db.doc(`users/${p.ownerId}`).get() : null;
  const agente = uSnap && uSnap.exists ? uSnap.data() : {};

  const armado = await icApiPayload(p, pSnap.id, agente);
  if (!armado.ok) {
    return { ok: false, faltan: armado.faltan,
             pista: "La ficha ya no cumple con lo que exige InfoCasas. No se envió nada." };
  }
  const payload = { ...armado.payload, listing_id: listingId };
  if (soloVistaPrevia) return { ok: true, dryRun: true, payload };

  const r = await icFetch("/listing", { method: "PATCH", body: [payload], conCookie: true });
  if (!r.ok) {
    logger.warn(`editarEnInfocasas ${propertyId} -> ${r.status}`, r.data);
    return { ok: false, status: r.status, detalle: r.data };
  }
  const d = r.data || {};
  const taskId = d.task_id || d.taskId || (d.data && d.data.task_id) || null;
  if (!taskId) return { ok: false, detalle: d, pista: "La API respondió 200 pero no devolvió task_id." };

  await pSnap.ref.update({ icTaskId: taskId, icEnviadoAt: new Date().toISOString() });
  const fin = await icEsperarTarea(taskId);
  if (fin.ok) {
    await pSnap.ref.update({ icEstado: "publicado", icActualizadoAt: new Date().toISOString() });
    await registrarLog(propertyId, "InfoCasas: actualizado", true, `listing ${listingId}`);
    return { ok: true, taskId, listingId };
  }
  await registrarLog(propertyId, "InfoCasas: actualización", false, `${fin.estado || ""}`);
  return { ok: false, taskId, estado: fin.estado, detalle: fin.detalle };
});

/* Cambia el estado de un aviso: es la BAJA.

   Estados confirmados en la documentación (02/09/2026): son STRINGS, no números.
     ACTIVE  = activo
     DELETED = eliminado
   Solo esos dos. El "status": 0 que aparece en la respuesta del GET es otra
   cosa y NO se usa acá: haberlo copiado habría mandado un número donde va texto.

   El cuerpo lleva TRES campos obligatorios: listing_id, client_id y status.

   Sigue sin valor por defecto a propósito: DELETED borra el aviso del portal y
   no es algo que deba pasar por omisión. */
exports.estadoEnInfocasas = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const propertyId = String((request.data && request.data.propertyId) || "");
  const estado = String((request.data && request.data.status) || "").toUpperCase();
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta la propiedad.");
  if (estado !== "ACTIVE" && estado !== "DELETED") {
    throw new HttpsError("invalid-argument",
      "'status' debe ser ACTIVE o DELETED. No hay valor por defecto: DELETED borra el aviso del portal.");
  }

  const pSnap = await db.doc(`properties/${propertyId}`).get();
  if (!pSnap.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = pSnap.data();
  const listingId = String(p.icListingId || "");
  if (!listingId) return { ok: false, pista: "La propiedad no tiene icListingId: no está publicada por API." };

  const body = [{ listing_id: listingId, client_id: await icClientId(), status: estado }];
  if (request.data && request.data.dryRun) return { ok: true, dryRun: true, payload: body };

  const r = await icFetch("/listing/status", { method: "PATCH", body, conCookie: true });
  if (!r.ok) {
    logger.warn(`estadoEnInfocasas ${propertyId} -> ${r.status}`, r.data);
    return { ok: false, status: r.status, detalle: r.data };
  }
  const d = r.data || {};
  const taskId = d.task_id || d.taskId || (d.data && d.data.task_id) || null;
  const fin = taskId ? await icEsperarTarea(taskId) : { ok: true, estado: "SIN_TAREA" };

  await pSnap.ref.update({
    icStatusEnviado: estado,
    icStatusAt: new Date().toISOString(),
    // Si se eliminó del portal, el listing_id deja de servir: se marca para no
    // intentar editar un aviso que ya no existe.
    ...(estado === "DELETED" && fin.ok ? { icEstado: "eliminado" } : {}),
  });
  await registrarLog(propertyId, "InfoCasas: cambio de estado", !!fin.ok, `status ${estado} · listing ${listingId}`);
  return { ok: !!fin.ok, taskId, estado: fin.estado, detalle: fin.detalle };
});

/* Suscribe el webhook: InfoCasas avisa cuando una tarea termina, en vez de
   tener que consultar /task con espera creciente. La documentación lo recomienda
   como la forma ideal.

   El HUB.ID lo facilita InfoCasas (nos lo pasó Frank el 01/09/2026) y va en
   IC_WEBHOOK_ID del .env. La URL destino es la Cloud Function de abajo. */
exports.icSuscribirWebhook = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const hubId = String(IC_WEBHOOK_ID || (request.data && request.data.hubId) || "");
  if (!hubId) throw new HttpsError("failed-precondition", "Falta IC_WEBHOOK_ID en el .env.");
  const url = String((request.data && request.data.url) || IC_WEBHOOK_URL || "");
  if (!url) throw new HttpsError("invalid-argument", "Falta la URL destino del webhook.");

  /* El campo se llama "target", no "url" (confirmado en el esquema
     WebhookSubscribePOST, 02/09/2026). Mandarlo como "url" no registraba nada.
     client_id es opcional pero se manda a propósito: sin él llegarían las tareas
     de TODOS los clientes del integrador, no solo las de Malave. */
  const r = await icFetch(`/webhook/${encodeURIComponent(hubId)}/subscribe`, {
    method: "POST",
    body: { target: url, client_id: await icClientId() },
    conCookie: true,
  });
  return { ok: r.ok, status: r.status, detalle: r.data, target: url };
});

/* Desuscribe el webhook. Existe para poder revertir sin depender de ellos: si
   la URL queda mal o hay que rotarla, primero se desuscribe y después se vuelve
   a suscribir. */
exports.icDesuscribirWebhook = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const hubId = String(IC_WEBHOOK_ID || (request.data && request.data.hubId) || "");
  if (!hubId) throw new HttpsError("failed-precondition", "Falta IC_WEBHOOK_ID en el .env.");
  const r = await icFetch(`/webhook/${encodeURIComponent(hubId)}/unsubscribe`, {
    method: "POST", body: { client_id: await icClientId() }, conCookie: true,
  });
  return { ok: r.ok, status: r.status, detalle: r.data };
});

/* Recibe los avisos de tareas terminadas. Es público (InfoCasas no se
   autentica con nuestro Firebase), así que valida el token que ellos mandan en
   el header VERIFY-TOKEN antes de tocar nada.

   Guarda SIEMPRE el cuerpo crudo en icWebhookEventos, aunque el procesamiento
   falle: si algo no encaja, el dato real queda para mirarlo. Mismo criterio que
   leadsPortales. */
exports.icWebhook = onRequest(async (req, res) => {
  if (req.method === "GET") { res.status(200).send("OK — webhook de InfoCasas activo (usar POST)"); return; }
  if (req.method !== "POST") { res.status(405).send("Método no permitido"); return; }

  const body = (typeof req.body === "object" && req.body) || {};
  const esperado = String(IC_WEBHOOK_TOKEN || "");
  if (esperado) {
    const recibido = String(req.get("VERIFY-TOKEN") || req.get("verify-token") || body.verify_token || "");
    if (recibido !== esperado) { res.status(401).send("Token inválido"); return; }
  }

  let ref = null;
  try {
    ref = await db.collection("icWebhookEventos").add({
      recibido: new Date().toISOString(), body,
      hubId: String(req.get("HUB-ID") || req.get("hub-id") || ""),
      procesado: false,
    });
  } catch (e) { logger.warn("icWebhook: no se pudo guardar el crudo", e.message); }

  // Se responde 200 enseguida: si tardamos, reintentan y duplicamos trabajo.
  res.status(200).json({ ok: true });

  try {
    const t = body.task || body;
    const externalCode = String(t.external_code || t.externalCode || "");
    const listingId = t.listing_id || t.listingId || null;
    const estado = String(t.status || t.state || "").toUpperCase();
    if (!externalCode) return;

    const q = await db.collection("properties")
      .where("ficha.PROPERTY_CODE", "==", externalCode).limit(1).get();
    if (q.empty) { logger.warn(`icWebhook: no encontré propiedad con código ${externalCode}`); return; }

    const doc = q.docs[0];
    const cambios = { icEstado: estado === "COMPLETED" ? "publicado" : "error",
                      icWebhookAt: new Date().toISOString() };
    if (listingId) cambios.icListingId = String(listingId);
    await doc.ref.update(cambios);
    await registrarLog(doc.id, "InfoCasas: webhook", estado === "COMPLETED", `${estado}${listingId ? " · listing " + listingId : ""}`);
    if (ref) await ref.update({ procesado: true, propertyId: doc.id });
  } catch (e) {
    logger.error("icWebhook: error al procesar", e);
    if (ref) { try { await ref.update({ procesado: false, error: String(e.message || e) }); } catch (e2) { /* nada */ } }
  }
});

/* EXPLORADOR GENÉRICO (solo lectura). Hace GET a una ruta de la API y devuelve
   el cuerpo tal cual. Sirve para inspeccionar la forma real de los datos sin
   desplegar una función nueva por cada endpoint que queramos mirar.

   DOS CANDADOS, y son a propósito:
     1) SOLO GET. No acepta method: ningún POST puede salir por acá.
     2) Rechaza cualquier ruta que contenga "validate". POST /validate-listing
        NO valida: SINCRONIZA y BORRA del portal todo aviso que no venga en la
        lista enviada. Aunque hoy solo hagamos GET, el candado queda escrito
        para que nadie la habilite por descuido más adelante.

   Solo Dirección. */
exports.icGet = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  let path = String((request.data && request.data.path) || "").trim();
  if (!path) throw new HttpsError("invalid-argument", "Falta 'path' (por ejemplo: /listing).");
  if (!path.startsWith("/")) path = "/" + path;
  if (/validate/i.test(path)) {
    throw new HttpsError("permission-denied",
      "Ruta bloqueada: /validate-listing sincroniza y BORRA avisos del portal. No se toca desde acá.");
  }
  const params = (request.data && request.data.params) || null;
  if (params && typeof params === "object") {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && String(v) !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    if (qs) path += (path.includes("?") ? "&" : "?") + qs;
  }
  const r = await icFetch(path, { conCookie: true });
  const d = r.data;
  // Los cuerpos pueden ser enormes (el catálogo pesa 95 KB). Se recorta para no
  // reventar la consola ni el límite de respuesta de la función.
  let cuerpo = d, recortado = false;
  if (typeof d === "string" && d.length > 4000) { cuerpo = d.slice(0, 4000); recortado = true; }
  else if (Array.isArray(d) && d.length > 5) { cuerpo = d.slice(0, 5); recortado = true; }
  else if (d && typeof d === "object" && Array.isArray(d.results) && d.results.length > 3) {
    cuerpo = { ...d, results: d.results.slice(0, 3) }; recortado = true;
  }
  return {
    ruta: path, status: r.status, ok: r.ok,
    tipoContenido: r.tipoContenido,
    claves: d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d) : null,
    recortado, cuerpo,
  };
});

/* BUSCADOR DEL CATÁLOGO. Busca ubicaciones de InfoCasas por nombre.

   Existe porque los barrios se guardan en la subcolección "lotes" y las
   subcolecciones NO heredan la regla de adminData/{doc}: desde el navegador no
   se pueden leer. Sin esto habría que abrir Firestore a mano lote por lote.

   Parámetros: q (texto, opcional), depId (número, opcional), todos (bool: trae
   el listado completo del departamento, sin filtrar por texto).
   Solo lee. */
exports.icBuscarUbicacion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const q = icNorm((request.data && request.data.q) || "");
  const depId = request.data && request.data.depId != null ? String(request.data.depId) : null;
  const todos = !!(request.data && request.data.todos);
  if (!q && !todos) throw new HttpsError("invalid-argument", "Pasá q (texto) o todos:true con depId.");

  const base = db.doc("adminData/infocasasUbicaciones");
  const cab = await base.get();
  if (!cab.exists) throw new HttpsError("failed-precondition", "Corré icUbicaciones primero.");
  const lotes = await base.collection("lotes").get();
  let items = [];
  for (const d of lotes.docs) for (const it of (d.data().items || [])) items.push(it);
  for (const st of (cab.data().catalogoStates || [])) items.push(st);

  if (depId) items = items.filter((x) => String(x.state_id) === depId);
  if (q) {
    // Coincidencia por inclusión en ambos sentidos: "atlantida" encuentra
    // "Atlántida Norte", y "ciudad del plata" encuentra "Ciudad del Plata".
    items = items.filter((x) => {
      const n = icNorm(x.name);
      return n.includes(q) || q.includes(n);
    });
  }
  items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return {
    cantidad: items.length,
    resultados: items.slice(0, 200).map((x) => ({
      id: x.id, nombre: x.name, tipo: x.location_type, depId: Number(x.state_id),
    })),
  };
});

/* COBERTURA DEL MAPEO. Compara IC_DEPTOS e IC_ZONAS -las tablas que el feed XML
   viene usando desde siempre- contra el catálogo real de la API.

   Por qué importa: al publicar, el estate_id y el neighbourhood_id salen de esas
   tablas. Si un id no existe en el catálogo, o existe pero corresponde a otro
   barrio, la propiedad sale publicada en la zona equivocada y nos enteramos por
   un cliente, no por un error.

   Solo lee y compara. No publica ni modifica nada. */
exports.icCobertura = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }

  // Se lee el catálogo ya deduplicado que dejó icUbicaciones. Si nunca se corrió,
  // se avisa en vez de comparar contra nada.
  const base = db.doc("adminData/infocasasUbicaciones");
  const cab = await base.get();
  if (!cab.exists) {
    throw new HttpsError("failed-precondition", "Corré icUbicaciones primero: no hay catálogo guardado.");
  }
  const lotes = await base.collection("lotes").get();
  const barrios = [];
  for (const d of lotes.docs) for (const it of (d.data().items || [])) barrios.push(it);
  const states = cab.data().catalogoStates || [];

  // Índices del catálogo por id.
  const catBarrio = new Map();   // id -> {name, state_id}
  for (const b of barrios) catBarrio.set(String(b.id), b);
  const catState = new Map();
  for (const st of states) catState.set(String(st.id), st);

  // --- Departamentos ---
  const depsMal = [];
  for (const [nombre, id] of Object.entries(IC_DEPTOS)) {
    const c = catState.get(String(id));
    if (!c) { depsMal.push({ nuestro: nombre, id, problema: "el id no existe en el catálogo" }); continue; }
    if (icNorm(c.name) !== icNorm(nombre)) {
      depsMal.push({ nuestro: nombre, id, enCatalogo: c.name, problema: "el id apunta a otro departamento" });
    }
  }

  // --- Zonas por defecto ---
  // Acá cae TODA propiedad cuyo barrio no se reconoce, así que un id malo pesa
  // más que cualquier zona suelta. Faltaba verificarlo.
  const defectosMal = [];
  for (const [depId, zonaId] of Object.entries(IC_ZONA_DEFAULT || {})) {
    const c = catBarrio.get(String(zonaId));
    if (!c) { defectosMal.push({ depId: Number(depId), zonaId, problema: "el id no existe en el catálogo" }); continue; }
    if (String(c.state_id) !== String(depId)) {
      defectosMal.push({ depId: Number(depId), zonaId, enCatalogo: c.name,
                         depEnCatalogo: Number(c.state_id), problema: "la zona por defecto está en otro departamento" });
    }
  }

  // --- Zonas / barrios ---
  // Varias entradas de IC_ZONAS comparten id a propósito: son alias para que el
  // matching de texto agarre las variantes que escriben los agentes
  // ("cerrito" y "cerrito de la victoria" -> 36). No son un error.
  const inexistentes = [], distintos = [], coinciden = [];
  const idsUsados = new Set();
  for (const [depId, zonas] of Object.entries(IC_ZONAS)) {
    for (const [nombre, id] of Object.entries(zonas)) {
      idsUsados.add(String(id));
      const c = catBarrio.get(String(id));
      if (!c) { inexistentes.push({ depId: Number(depId), nuestro: nombre, id }); continue; }
      const mismoDep = String(c.state_id) === String(depId);
      if (icNorm(c.name) === icNorm(nombre) && mismoDep) { coinciden.push(id); continue; }
      distintos.push({
        depId: Number(depId), nuestro: nombre, id,
        enCatalogo: c.name, depEnCatalogo: Number(c.state_id),
        problema: !mismoDep ? "está en otro departamento" : "el nombre no coincide",
      });
    }
  }

  // Barrios del catálogo que no tenemos mapeados. Menos grave: el feed cae en la
  // zona por defecto del departamento (IC_ZONA_DEFAULT).
  const sinMapear = barrios
    .filter((b) => !idsUsados.has(String(b.id)))
    .map((b) => ({ id: b.id, nombre: b.name, depId: Number(b.state_id) }));

  const porDep = {};
  for (const b of sinMapear) porDep[b.depId] = (porDep[b.depId] || 0) + 1;

  return {
    catalogo: { departamentos: states.length, barrios: barrios.length },
    nuestro: { departamentos: Object.keys(IC_DEPTOS).length, zonas: idsUsados.size },
    // Lo que hay que mirar primero:
    departamentosConProblema: depsMal,
    zonasPorDefectoConProblema: defectosMal,
    zonasQueNoExisten: inexistentes,
    zonasConNombreDistinto: distintos.slice(0, 80),
    zonasConNombreDistintoTotal: distintos.length,
    zonasOk: coinciden.length,
    // Informativo:
    barriosSinMapear: sinMapear.length,
    barriosSinMapearPorDepartamento: porDep,
    muestraSinMapear: sinMapear.slice(0, 40),
    veredicto: (depsMal.length || defectosMal.length || inexistentes.length || distintos.length)
      ? "Hay diferencias: revisá las listas antes de publicar."
      : "El mapeo del feed XML coincide 100% con el catálogo de la API.",
  };
});

/** Prueba de conexión: confirma que la clave y la URL están bien, sin tocar nada. */
exports.icProbarConexion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  const r = await icFetch("/client");
  const lista = r.ok ? (Array.isArray(r.data) ? r.data : (r.data && (r.data.data || r.data.results)) || []) : [];
  const c = lista[0] || null;
  return {
    ok: r.ok, status: r.status, base: IC_API_BASE,
    claveCargada: !!IC_API_KEY,
    inmobiliarias: lista.length,
    clientId: IC_CLIENT_ID || (lista.length === 1 && c ? c.id : null),
    // El cupo es un tope duro de avisos publicables. Conviene mirarlo antes de
    // migrar: si el feed manda más propiedades que el cupo, sobran.
    cupo: c ? { total: c.initial_quota, usado: c.used_quota, libre: c.remained_quota } : null,
    data: r.ok ? r.data : null,
    detalle: r.ok ? null : r.data,
  };
});

/* Diagnóstico: prueba todas las rutas de la documentación, con y sin barra final,
   y devuelve qué contestó cada una. Sirve para dejar de adivinar de a una cuando
   la documentación y el servidor no coinciden. Solo hace GET: no toca nada. */
exports.icExplorar = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión.");
  const email = String(request.auth.token.email || "").toLowerCase();
  if (!(await esDireccion(request.auth.uid, email))) {
    throw new HttpsError("permission-denied", "Solo la Dirección.");
  }
  // /task NO se prueba a secas: exige el id en la ruta (/task/{id}) y siempre
  // devuelve 404 sin él. El id sale del task_id que responde el POST /listing.
  // No es una falla: es cómo funciona. (Frank Payares, 31/08/2026.)
  const rutas = ["/client", "/location/download", "/listing"];
  const out = [];
  for (const base of rutas) {
    for (const p of [base, base + "/"]) {
      try {
        // Se arma la URL a mano para poder probar SIN la barra que agrega icFetch.
        const url = IC_API_BASE + p + `?_=${Date.now()}`;
        // /listing exige el header cookie con el client_id. Se manda en todas:
        // las que no lo piden lo ignoran.
        let cookie = null;
        try { cookie = await icClientId(); } catch (e) { /* sin client_id igual se prueba */ }
        const res = await axios({
          url, method: "GET",
          headers: { apikey: IC_API_KEY, Accept: "application/json", ...(cookie ? { cookie } : {}) },
          timeout: 15000, validateStatus: () => true,
        });
        const d = res.data;
        const tipo = Array.isArray(d) ? `array(${d.length})`
          : (typeof d === "string" && d.startsWith("<")) ? "html(404 Django)"
          : d && typeof d === "object" ? `objeto(${Object.keys(d).slice(0, 5).join(",")})`
          : typeof d;
        out.push({ ruta: p, status: res.status, tipo });
      } catch (e) {
        out.push({ ruta: p, status: "error", tipo: String(e.message).slice(0, 80) });
      }
    }
  }
  return { base: IC_API_BASE, resultados: out };
});
