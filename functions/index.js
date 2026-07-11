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

// Crea una notificación en la campanita (colección notifications) y, si hay
// token FCM, manda también un push. Nunca tira error hacia afuera.
async function crearNotificacion(destino, campos, push) {
  if (!destino || !destino.uid) return;
  try {
    await db.collection("notifications").add({
      ownerId: destino.uid,
      read: false,
      createdAt: new Date().toISOString(),
      ...campos,
    });
  } catch (e) { logger.warn("No se pudo crear la notificación:", e.message); }
  if (push && destino.fcmToken) {
    try {
      await admin.messaging().send({
        token: destino.fcmToken,
        notification: { title: push.title, body: push.body },
        data: { type: campos.type || "info" },
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
    const adm = await getAdminUser();
    if (adm && !destinos.some((d) => d.uid === adm.uid)) destinos.push(adm);
    for (const d of destinos) await crearNotificacion(d, aviso, push);
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
const TIPOS_AVISO_VALIDOS = ["free", "bronze", "silver", "gold", "gold_premium"];
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
  } catch (_e) {}
  // ===============================================================================

  // Los ids IC_* son extras de InfoCasas cargados desde el form: no existen en ML,
  // los consume únicamente el feed (feedInfocasas). Se saltean acá a propósito.

  for (const [id, val] of Object.entries(ficha)) {
    const attr = byId[id];
    if (!attr || have.has(id) || val === "" || val == null) continue;
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
      // MAINTENANCE_FEE (gastos comunes): la unidad es una MONEDA. Hay que usar la
      // moneda de la propiedad (USD/UYU) si la categoría la permite, no la primera unidad.
      if (id === "MAINTENANCE_FEE" && attr.allowed_units && attr.allowed_units.length) {
        const wanted = (p && p.currency === "UYU") ? "UYU" : "USD";
        const match = attr.allowed_units.find((u) => u.id === wanted || norm(u.name) === norm(wanted));
        if (match) unit = match.id;
      }
      const num = Number(val);
      // value_name "5 m²" en vez de value_struct: con la unidad vacía ML descartaba el
      // atributo (el caso BALCONY_AREA: "value_id and value_name are null... not sent").
      if (!isNaN(num)) { out.push({ id, value_name: unit ? `${num} ${unit}` : String(num) }); have.add(id); }
    } else {
      out.push({ id, value_name: String(val) }); // number o string
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
  const pictures = (p.images || []).slice(0, maxPics).map((url) => ({ source: url }));

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
    video_id: extractYouTubeId(p.videoUrl),
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
  if (cambioEstado) {
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
    const { category_id, listing_type_id, buying_mode, condition, channels, available_quantity, description, currency_id, ...updatable } = item;
    const cambioMoneda = before && before.currency && before.currency !== after.currency;
    if (cambioMoneda) delete updatable.price;

    await axios.put(`${API}/items/${after.mlItemId}`, updatable, { headers });
    await setItemDescription(after.mlItemId, after.description, token);

    const cambios = { mlSyncedAt: new Date().toISOString() };
    if (cambioMoneda) {
      cambios.mlError = "La moneda no se puede cambiar en un aviso ya publicado. Para cambiarla: dalo de baja y volvé a publicarlo.";
      cambios.mlErrorAt = new Date().toISOString();
      if (before.mlError !== cambios.mlError) {
        await notificarErrorML(after, id, "Cambio de moneda no aplicado en Mercado Libre", "Dalo de baja y volvé a publicarlo para cambiar la moneda.");
      }
    } else {
      cambios.mlError = admin.firestore.FieldValue.delete();
      cambios.mlErrorAt = admin.firestore.FieldValue.delete();
    }
    await ref.update(cambios);
    logger.info(`Propiedad ${id} sincronizada con ML (${after.mlItemId}).`);
    await registrarLog(id, "sincronizar", true, after.mlItemId);
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
  if (!adm || adm.uid === r.agenteUid) return;
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

exports.notificarNuevoUsuario = onDocumentCreated("users/{uid}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const d = snap.data();
  if (!d || d.status !== "pending") return; // el admin se crea aprobado; no auto-notificarse
  const adm = await getAdminUser();
  if (!adm) {
    await registrarLog("", "nuevo usuario pendiente SIN notificar", false, `No se encontró al admin (${ADMIN_EMAIL}) en users; revisá el email del perfil del admin.`);
    return;
  }
  if (adm.uid === event.params.uid) return;
  const nombre = d.name || d.email || "Alguien";
  await crearNotificacion(
    adm,
    {
      type: "new_user",
      propertyId: "",
      propertyTitle: "su registro — aprobalo en el Panel de Administración",
      userName: `🆕 ${nombre}`,
      userPhone: d.whatsapp || "",
      userPhoto: null,
      text: `${nombre} (${d.email || "sin email"}) se registró y está pendiente de aprobación.`,
    },
    { title: "👤 Nuevo usuario pendiente", body: `${nombre} se registró y espera tu aprobación.` }
  );
  await registrarLog("", "nuevo usuario pendiente", true, `${nombre} (${d.email || ""})`);
});

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
  const esAdmin = email === ADMIN_EMAIL;
  if (!esAdmin) {
    const u = await db.doc(`users/${uid}`).get();
    const d = u.exists ? u.data() : null;
    if (!d || d.status !== "approved") throw new HttpsError("permission-denied", "Tu cuenta no está aprobada.");
    if (p && p.ownerId && p.ownerId !== uid) throw new HttpsError("permission-denied", "Solo el agente dueño o el administrador pueden gestionar este aviso.");
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

exports.bajaML = onCall(async (request) => {
  const propertyId = request.data && request.data.propertyId;
  if (!propertyId) throw new HttpsError("invalid-argument", "Falta el id de la propiedad.");
  const ref = admin.firestore().collection("properties").doc(propertyId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "La propiedad no existe.");
  const p = doc.data();
  await exigirAgente(request, p);
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
  2: { "atlantida": 136, "estacion atlantida": 136, "costa de oro": 136, "balneario argentino": 137, "barra de carrasco": 138, "paso carrasco": 138, "bello horizonte": 139, "canelones": 140, "ciudad de la costa": 141, "colinas de solymar": 142, "costa azul": 143, "cuchilla alta": 144, "el bosque": 145, "el pinar": 146, "empalme olmos": 147, "fortin de santa rosa": 148, "guazu vira": 149, "guazuvira": 149, "jaureguiberry": 150, "la floresta": 151, "la paz": 152, "la tuna": 153, "lagomar": 154, "las piedras": 155, "las toscas": 156, "lomas de solymar": 157, "los cerrillos": 158, "los titanes": 159, "marindia": 160, "medanos de solymar": 161, "migues": 162, "montes de solymar": 163, "neptunia": 164, "pando": 165, "parque de solymar": 166, "parque del plata": 167, "las vegas": 167, "pinamar": 168, "pinares de solymar": 169, "progreso": 170, "salinas": 171, "san antonio": 172, "san cristobal": 173, "san jacinto": 174, "san luis": 175, "san ramon": 176, "santa ana": 177, "santa lucia": 178, "santa lucia del este": 179, "santa rosa": 180, "sauce": 181, "shangrila": 182, "solymar": 183, "tala": 184, "toledo": 185, "villa argentina": 186, "barrios privados": 187, "la tahona": 4736, "lomas de la tahona": 4737, "altos de la tahona": 4738, "vinedos de la tahona": 4739, "mirador de la tahona": 4740, "huertas de los horneros": 4741, "pilar de los horneros": 4742, "camino de los horneros": 4743, "la juana": 4744, "carlotta": 4745, "cumbres de carrasco": 4746, "colinas de carrasco": 4747, "las higueritas": 4748, "lomas de carrasco": 4749, "carmel": 4750, "haras del lago": 4751, "la asuncion": 4752, "san jose de carrasco": 345, "colonia nicolich": 355 },
  9: { "aigua": 82, "gregorio aznares": 83, "gregorio aznarez": 83, "maldonado": 84, "pan de azucar": 85, "piriapolis": 86, "beaulieu": 87, "bella vista": 88, "cerro del toro": 90, "cerro san antonio": 91, "fuente venus": 92, "las flores": 93, "los angeles": 94, "playa grande": 95, "playa hermosa": 96, "playa verde": 97, "proa al mar": 99, "proa del mar": 99, "punta colorada": 101, "punta fria": 102, "punta negra": 103, "rinconada": 104, "san francisco": 105, "solis": 106, "portezuelo": 107, "punta ballena": 129, "lagunas del diario": 119, "laguna del diario": 2242, "laguna del sauce": 2243, "solanas": 344, "chihuahua": 2238, "ocean park": 2245, "sauce de portezuelo": 2251, "las cumbres": 2244, "el pejerrey": 2240, "la barra": 117, "la pastora": 118, "lugano": 121, "manantiales": 122, "montoya": 123, "punta piedras": 130, "balneario buenos aires": 2168, "punta del este": 124, "peninsula": 124, "pinares": 125, "playa brava": 126, "playa mansa": 127, "puerto": 128, "punta shopping": 131, "rincon del indio": 132, "roosevelt": 133, "san rafael": 134, "cantegril": 113, "golf": 115, "las delicias": 120, "beverly hills": 112, "arcobaleno": 110, "barrio cordoba": 111, "san carlos": 135, "jose ignacio": 2186, "arenas de jose ignacio": 2186, "la juanita": 2191, "laguna garzon": 2193, "pueblo garzon": 2195, "garzon": 2195, "san vicente": 2197, "santa monica": 2199 },
  14: { "aguas dulces": 290, "barra de valizas": 291, "valizas": 650, "cabo polonio": 2181, "castillos": 294, "chuy": 295, "barra del chuy": 2176, "dieciocho de julio": 296, "18 de julio": 296, "rocha": 303, "lascano": 656, "la coronilla": 655, "la esmeralda": 653, "el palmar": 297, "vuelta del palmar": 297, "punta del diablo": 302, "la paloma": 2206, "costa azul": 646, "la aguada": 647, "arachania": 645, "antoniopolis": 644, "santa maria de rocha": 651, "la pedrera": 2219, "punta rubia": 649, "san antonio": 2224, "oceania del polonio": 648 },
  1: { "artigas": 188, "baltasar brum": 189, "bella union": 190, "bernabe rivera": 191, "cuaro": 192, "javier de viana": 193, "pintadito": 194, "tomas gomensoro": 195, "topador": 196 },
  3: { "acegua": 197, "cerro de las cuentas": 198, "fraile muerto": 199, "isidoro noblia": 200, "melo": 201, "rio branco": 202, "tres islas": 203 },
  4: { "arrivillaga": 204, "artilleros": 205, "barker": 206, "blanca arena": 207, "boca del rosario": 208, "brisas del plata": 209, "carmelo": 210, "cerros de san juan": 211, "colonia cosmopolita": 212, "colonia del sacramento": 213, "colonia miguelete": 214, "colonia valdense": 215, "conchillas": 216, "cufre": 217, "el semillero": 218, "el solado": 219, "estanzuela": 220, "juan lacaze": 221, "la paz": 222, "los pinos": 223, "nueva helvecia": 224, "nueva palmira": 225, "ombues de lavalle": 226, "paraje minuano": 227, "paso minuano": 228, "paso antolin": 229, "pastoreo": 230, "playa azul": 231, "playa britopolis": 232, "playa parant": 233, "puerto ingles": 234, "rosario": 235, "santa regina": 236, "tarariras": 237 },
  5: { "durazno": 238, "san jorge": 239, "santa bernardita": 240 },
  6: { "san gregorio carrio": 241, "trinidad": 242 },
  7: { "25 de agosto": 243, "veinticinco de agosto": 243, "cardal": 244, "cerro colorado": 245, "florida": 246, "fray marcos": 247, "independencia": 248, "la cruz": 249, "pintado": 250, "sarandi grande": 251 },
  8: { "colon": 252, "illescas": 253, "jose pedro varela": 254, "la mariscala": 255, "maria albina": 256, "minas": 257, "piraraja": 258, "solis de mataojo": 259, "zapican": 260, "villa del cerro": 346, "villa serrana": 257 },
  11: { "chapicuy": 261, "guaviyu": 262, "paysandu": 263, "piedra sola": 264, "quebracho": 265 },
  12: { "algorta": 266, "andresito": 267, "barrio anglo": 268, "cardozo": 269, "carlos reyles": 270, "fray bentos": 271, "general borges": 272, "grecco": 273, "las canas": 274, "nuevo berlin": 275, "pueblo orgoroso": 276, "rincon del bonete": 277, "san javier": 278, "villa maria": 279, "young": 280 },
  13: { "la pedrera": 281, "lagunon": 282, "mandubi": 283, "masoller": 284, "minas de corrales": 285, "paso campamento": 286, "rivera": 287, "santa teresa": 288, "tranqueras": 289 },
  15: { "arenitas blancas": 304, "belen": 306, "colonia 18 de julio": 307, "constitucion": 308, "salto": 309, "termas del arapey": 310, "termas del dayman": 311 },
  16: { "boca del cufre": 312, "delta del tigre": 313, "ecilda paullier": 314, "ituzaingo": 315, "libertad": 316, "playa pascual": 317, "san jose": 318, "san jose de mayo": 319, "scavino": 320, "villa rodriguez": 321, "ciudad del plata": 313 },
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
const RECORDATORIO_DIAS = 14;

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
      // "Cartera" es etapa avanzada (la propiedad ya está captada): el silencio
      // ahí es normal, no abandono. Mantener igual a estadosSinAviso de clientes.html.
      if (estado === "cartera") return;
      const ts = [(a && a.ts) || "", c.updatedAt || "", c.createdAt || ""].sort().pop();
      const t = new Date(ts).getTime();
      const dias = isNaN(t) ? 9999 : Math.floor((ahora - t) / 86400000);
      if (dias < RECORDATORIO_DIAS) return;
      const uid = c.createdBy || c.agentId || c.ownerId || "__sin_agente__";
      (porAgente[uid] = porAgente[uid] || []).push({ name: c.name || "Sin nombre", dias });
    });

    const adm = await getAdminUser();
    for (const uid of Object.keys(porAgente)) {
      const lista = porAgente[uid].sort((a, b) => b.dias - a.dias);
      let destino = null;
      if (uid === "__sin_agente__") {
        destino = adm;
      } else {
        try {
          const uDoc = await db.doc(`users/${uid}`).get();
          if (uDoc.exists) destino = { uid: uDoc.id, fcmToken: uDoc.data().fcmToken };
        } catch (e) { /* sin perfil */ }
        if (!destino) destino = adm; // agente sin perfil: que al menos lo vea el admin
      }
      if (!destino) continue;

      const nombres = lista.slice(0, 3).map((x) => x.name).join(", ");
      const extra = lista.length > 3 ? ` y ${lista.length - 3} más` : "";
      const texto = lista.length === 1
        ? `${nombres} lleva ${lista[0].dias} días sin contacto. Entrá a Clientes para retomarlo.`
        : `${lista.length} clientes llevan más de ${RECORDATORIO_DIAS} días sin contacto: ${nombres}${extra}. Entrá a Clientes para retomarlos.`;
      await crearNotificacion(
        destino,
        { type: "crm_seguimiento", userName: "Seguimiento", userPhoto: null, text: texto },
        { title: "📋 Clientes para recontactar", body: texto }
      );
      logger.info(`[recordatorioSeguimiento] aviso a ${uid}: ${lista.length} cliente(s) sin contacto.`);
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
    const nuevoEstado = p.type === "rent" ? "rented" : "sold";
    await ref.update({
      status: nuevoEstado,
      finalizadaPorGestion: { gestionId: event.params.gid, fecha: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    logger.info(`[gestión cerrada] Propiedad ${pid} -> ${nuevoEstado} (gestión ${event.params.gid}).`);
  } else if (estAntes === "cerrado") {
    // Se reabrió la gestión: revertir solo lo que este trigger marcó.
    const f = p.finalizadaPorGestion;
    if (f && f.gestionId === event.params.gid && (p.status === "sold" || p.status === "rented")) {
      await ref.update({
        status: "available",
        finalizadaPorGestion: admin.firestore.FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
      logger.info(`[gestión reabierta] Propiedad ${pid} -> available.`);
    }
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
  const claveEsperada = process.env.IC_LEAD_KEY || "";
  if (claveEsperada && String((req.query && req.query.clave) || "") !== claveEsperada) {
    res.status(401).send("Clave inválida"); return;
  }
  const body = (typeof req.body === "object" && req.body) || {};
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
  const refProp = pick("idPropiedad", "propiedad", "id", "referencia", "ref", "codigo", "propertyId", "idAviso");

  // 1) Guardar el lead crudo ANTES de procesar: nada se pierde jamás.
  const rawRef = await db.collection("leadsPortales").add({
    fuente: "infocasas", recibido: new Date().toISOString(), body, query: req.query || {}, procesado: false,
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
        const nuevaGestion = { clientId, propertyId: propId, estadoGestion: "nuevo", createdAt: ahora, updatedAt: ahora, historial: [notaLead] };
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
