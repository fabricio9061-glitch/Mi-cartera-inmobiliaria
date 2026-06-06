/**
 * MALAVE — Integración con Mercado Libre
 * Cloud Functions (Firebase, 2da generación)
 *
 * Piezas:
 *  1) iniciarAuthML  -> abrís esta URL UNA vez para conectar tu cuenta de ML.
 *  2) callbackML     -> Mercado Libre vuelve acá con el código; guardamos los tokens.
 *  3) publicarEnML   -> se dispara solo cuando creás una propiedad y la publica en ML.
 *
 * Los tokens se guardan en Firestore: ml_config/tokens
 */

const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
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

const API = "https://api.mercadolibre.com";
const TOKENS_DOC = db.collection("ml_config").doc("tokens");

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
// Helper: devuelve un access_token válido (renueva si está por vencer)
// =====================================================================
async function getValidToken() {
  const snap = await TOKENS_DOC.get();
  if (!snap.exists) throw new Error("No hay cuenta de Mercado Libre conectada. Abrí la función iniciarAuthML primero.");
  let t = snap.data();
  if (Date.now() < t.expires_at) return t.access_token; // todavía válido

  // Renovar con refresh_token
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
  await TOKENS_DOC.set({
    access_token: d.access_token,
    refresh_token: d.refresh_token || t.refresh_token,
    user_id: d.user_id || t.user_id,
    expires_at: Date.now() + (d.expires_in - 120) * 1000,
    updated_at: new Date().toISOString(),
  });
  logger.info("Token de Mercado Libre renovado.");
  return d.access_token;
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

// =====================================================================
// Helper: arma el aviso de Mercado Libre a partir de la propiedad
// =====================================================================
// Busca la categoría correcta dentro de Inmuebles (MLU1459), navegando el árbol
// hasta una categoría hoja, según el tipo de propiedad y la operación.
async function getRealEstateCategory(p, token) {
  // El tipo de inmueble real (casa, apartamento, terreno...). Para propiedades viejas
  // sin este dato, lo aproximamos desde el padrón (PH suele ser apartamento).
  const ret = p.realEstateType || (p.propertyType === "ph" ? "apartamento" : "casa");
  const typeMap = { casa: "casas", apartamento: "apartamento", terreno: "terreno", local: "local", oficina: "oficina", galpon: "galp", campo: "campo" };
  const want = typeMap[ret] || "casas";
  const opWord = p.type === "rent" ? "alquiler" : "venta";
  // Evitamos categorías de emprendimientos/proyectos: exigen atributos de desarrollo
  // (DEVELOPMENT_NAME, UNIT_NAME, MODEL_NAME) que no aplican a una propiedad individual.
  const avoid = ["emprendimiento", "proyecto", "pozo", "desarrollo", "loteo"];
  const isAvoided = (name) => avoid.some((w) => (name || "").toLowerCase().includes(w));
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const root = await axios.get(`${API}/categories/MLU1459`, { headers });
    const children = (root.data.children_categories || []).filter((c) => !isAvoided(c.name));
    let cat =
      children.find((c) => c.name.toLowerCase().includes(want)) ||
      children.find((c) => c.name.toLowerCase().includes("casas")) ||
      children[0];
    if (!cat) return null;
    let catId = cat.id;
    let catName = cat.name;
    // Bajar hasta una categoría hoja (sin subcategorías). Si hay subcategorías de
    // venta/alquiler, elegir la de la operación; siempre esquivando emprendimientos.
    for (let i = 0; i < 5; i++) {
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
    return { id, value_name: String(numMap[id]) };
  }
  // Atributo de lista: tomar el primer valor permitido.
  if (Array.isArray(a.values) && a.values.length) {
    return { id, value_id: a.values[0].id };
  }
  const vt = a.value_type;
  if (vt === "number" || vt === "number_unit") return { id, value_name: "0" };
  if (vt === "boolean") return null;
  // Texto libre (p. ej. nombres de emprendimiento/unidad cuando la categoría los pide).
  return { id, value_name: (p.title || "Consultar").slice(0, 40) };
}

// Completa los atributos OBLIGATORIOS de la categoría que falten, leyéndolos en vivo
// desde ML. Así la publicación no falla aunque la categoría pida atributos nuevos.
async function fillRequiredAttributes(categoryId, p, baseAttributes, token) {
  const out = baseAttributes.slice();
  const have = new Set(out.map((a) => a.id));
  try {
    const r = await axios.get(`${API}/categories/${categoryId}/attributes`, { headers: { Authorization: `Bearer ${token}` } });
    for (const a of r.data || []) {
      const tags = a.tags || {};
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

  // Completar cualquier atributo obligatorio que la categoría exija y no tengamos.
  attributes = await fillRequiredAttributes(categoryId, p, attributes, token);

  const condition = await pickCondition(categoryId, token);
  const pictures = (p.images || []).slice(0, 12).map((url) => ({ source: url }));

  return {
    title: (p.title || "Propiedad").slice(0, 60),
    category_id: categoryId,
    price: p.price,
    currency_id: p.currency || "USD",
    available_quantity: 1,
    buying_mode: "classified",
    listing_type_id: "silver",
    condition,
    channels: ["marketplace"],
    description: { plain_text: p.description || p.title || "" },
    pictures,
    location: {
      address_line: p.direccion || "",
      country: { id: "UY", name: "Uruguay" },
      state: { name: p.departamento || "" },
      city: { name: p.ciudad || "" },
    },
    attributes,
  };
}

// =====================================================================
// 3) PUBLICAR  — se dispara solo al crear una propiedad
// =====================================================================
exports.publicarEnML = onDocumentCreated("properties/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const p = snap.data();
  const id = event.params.id;

  // Publicar solo si está disponible y no se publicó antes
  if (p.status && p.status !== "available") {
    logger.info(`Propiedad ${id} no está disponible (${p.status}); no se publica.`);
    return;
  }
  if (p.mlItemId) {
    logger.info(`Propiedad ${id} ya tiene aviso en ML (${p.mlItemId}).`);
    return;
  }

  try {
    const token = await getValidToken();
    const item = await buildItem(p, token);
    const r = await axios.post(`${API}/items`, item, {
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    await snap.ref.update({
      mlItemId: r.data.id,
      mlPermalink: r.data.permalink || "",
      mlStatus: r.data.status || "active",
      mlError: admin.firestore.FieldValue.delete(),
      mlPublishedAt: new Date().toISOString(),
    });
    logger.info(`Propiedad ${id} publicada en ML: ${r.data.id} (${r.data.permalink})`);
  } catch (e) {
    const detail = e.response?.data || e.message;
    logger.error(`Error publicando ${id} en ML:`, JSON.stringify(detail));
    // Guardamos el error en la propiedad para poder revisarlo y ajustar
    await snap.ref.update({
      mlError: typeof detail === "string" ? detail : JSON.stringify(detail),
      mlErrorAt: new Date().toISOString(),
    });
  }
});
