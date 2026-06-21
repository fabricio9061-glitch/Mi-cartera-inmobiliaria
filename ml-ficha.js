// ml-ficha.js  (v3 — usa la MISMA logica que tu backend: esquiva emprendimientos
//                y baja por la rama de venta de propiedad individual)
// Endpoint publico, no necesita login.
//   node ml-ficha.js   ->  genera ml-ficha-salida.json  (subilo)

const https = require('https');
const fs = require('fs');
const API = 'https://api.mercadolibre.com';

const CATS = {
  casa:        'MLU1466',
  apartamento: 'MLU1472',
  terreno:     'MLU1493',
  local:       'MLU1478',
  oficina:     'MLU50633',
  galpon:      'MLU455466',
  campo:       'MLU1496',
};

// Igual que en functions/index.js
const AVOID = ['emprendimiento', 'proyecto', 'pozo', 'desarrollo', 'loteo'];
const isAvoided = (n) => AVOID.some((w) => (n || '').toLowerCase().includes(w));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'malave-ficha' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function leafOf(id) {
  let catId = id, name = '';
  for (let i = 0; i < 8; i++) {
    const cr = await getJSON(`${API}/categories/${catId}`);
    const sub = (cr.children_categories || []).filter((c) => !isAvoided(c.name));
    if (sub.length === 0) { return { id: catId, name: cr.name }; }
    const next = sub.find((c) => /venta/i.test(c.name)) || sub[0];
    catId = next.id; name = next.name;
    await sleep(120);
  }
  return { id: catId, name };
}

(async () => {
  const out = {};
  for (const [tipo, id] of Object.entries(CATS)) {
    try {
      const leaf = await leafOf(id);
      const attrs = await getJSON(`${API}/categories/${leaf.id}/attributes`);
      const lista = Array.isArray(attrs) ? attrs : [];
      out[tipo] = {
        categoria_hoja: leaf.id,
        nombre_hoja: leaf.name,
        atributos: lista.map((a) => ({
          id: a.id,
          name: a.name,
          value_type: a.value_type,
          required: !!(a.tags && (a.tags.required || a.tags.catalog_required)),
          values: (a.values || []).map((v) => v.name),
        })),
      };
      const sub = out[tipo].atributos.find((a) => /_PROPERTY_SUBTYPE$/.test(a.id));
      console.log(
        tipo.padEnd(12) + 'hoja ' + leaf.id + ' (' + leaf.name + '): ' + out[tipo].atributos.length + ' attrs' +
        (sub ? '  | ' + sub.id + ': ' + sub.values.join(', ') : '  | (sin subtipo)')
      );
    } catch (e) {
      console.log(tipo.padEnd(12) + 'ERROR ' + e.message);
      out[tipo] = { error: e.message };
    }
    await sleep(200);
  }
  fs.writeFileSync('ml-ficha-salida.json', JSON.stringify(out, null, 2));
  console.log('\nListo. Se creo: ml-ficha-salida.json  (subime ese archivo)');
})();
