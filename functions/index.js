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

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
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
// Helper: arma el aviso de Mercado Libre a partir de la propiedad
// =====================================================================
async function buildItem(p, token) {
  // Intentar predecir la categoría a partir del título
  let categoryId = null;
  try {
    const q = encodeURIComponent(p.title || "inmueble");
    const dd = await axios.get(`${API}/sites/${SITE}/domain_discovery/search?limit=1&q=${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (Array.isArray(dd.data) && dd.data[0]?.category_id) categoryId = dd.data[0].category_id;
  } catch (e) {
    logger.warn("No se pudo predecir categoría:", e.response?.data || e.message);
  }
  // Fallback a las categorías configuradas
  if (!categoryId) categoryId = p.type === "rent" ? CAT_RENT : CAT_SALE;
  if (!categoryId) throw new Error("No se pudo determinar la categoría de Mercado Libre. Definí ML_CAT_SALE / ML_CAT_RENT en .env.");

  const operation = p.type === "rent" ? "Alquiler" : "Venta";
  const propTypeMap = { common: "Apartamento", ph: "PH", house: "Casa" };
  const propType = propTypeMap[p.propertyType] || "Apartamento";

  const attributes = [
    { id: "OPERATION", value_name: operation },
    { id: "PROPERTY_TYPE", value_name: propType },
  ];
  if (p.bedrooms) attributes.push({ id: "BEDROOMS", value_name: String(p.bedrooms) });
  if (p.bathrooms) attributes.push({ id: "FULL_BATHROOMS", value_name: String(p.bathrooms) });
  if (p.totalArea) attributes.push({ id: "TOTAL_AREA", value_name: `${p.totalArea} m²` });
  if (p.builtArea) attributes.push({ id: "COVERED_AREA", value_name: `${p.builtArea} m²` });

  const pictures = (p.images || []).slice(0, 12).map((url) => ({ source: url }));

  return {
    title: (p.title || "Propiedad").slice(0, 60),
    category_id: categoryId,
    price: p.price,
    currency_id: p.currency || "USD",
    available_quantity: 1,
    buying_mode: "classified",
    listing_type_id: "silver",
    condition: "not_specified",
    description: { plain_text: p.description || p.title || "" },
    pictures,
    location: {
      address_line: p.direccion || "",
      neighborhood: { name: p.ciudad || "" },
      state: { name: p.departamento || "" },
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
