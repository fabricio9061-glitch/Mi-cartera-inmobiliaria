#!/usr/bin/env node
/*
 * Sube las Cloud Functions de a tandas.
 *
 * Por qué: con "firebase deploy --only functions" se mandan las ~110 funciones
 * juntas y Google corta con el error 429 (demasiados pedidos por minuto). Acá se
 * mandan de a 20, con una pausa entre tanda y tanda, y si una tanda falla se
 * vuelve a intentar sola.
 *
 * Además, como cada tanda nombra sus funciones, Firebase NUNCA pregunta si
 * borrar las que están en el proyecto y no en el código (fichaCompartir y
 * fotosParaDocumento se usan todavía: no hay que borrarlas).
 *
 * Uso (desde la carpeta del proyecto, en PowerShell):
 *   node scripts/deploy-funciones.js                 -> todas, de a 20
 *   node scripts/deploy-funciones.js sincronizarVitrina estadoML   -> solo esas
 *   node scripts/deploy-funciones.js --desde 41      -> retoma desde la función 41
 *   node scripts/deploy-funciones.js --tanda 10      -> tandas más chicas
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const RAIZ = path.join(__dirname, "..");
const args = process.argv.slice(2);
function opcion(nombre, porDefecto) {
  const i = args.indexOf(nombre);
  if (i < 0) return porDefecto;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return Number.isFinite(v) && v > 0 ? v : porDefecto;
}
const TANDA = opcion("--tanda", 20);
const DESDE = opcion("--desde", 1);
const PAUSA_S = opcion("--pausa", 60);
const REINTENTOS = 2;

const codigo = fs.readFileSync(path.join(RAIZ, "functions", "index.js"), "utf8");
const todas = [...codigo.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]);
let lista = todas;
if (args.length) {
  const noExisten = args.filter((n) => !todas.includes(n));
  if (noExisten.length) {
    console.error("Estas funciones no están en functions/index.js: " + noExisten.join(", "));
    process.exit(1);
  }
  lista = args;
}
lista = lista.slice(DESDE - 1);

function esperar(segundos) {
  // Pausa sin depender de nada instalado (funciona igual en Windows).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, segundos * 1000);
}

const tandas = [];
for (let i = 0; i < lista.length; i += TANDA) tandas.push(lista.slice(i, i + TANDA));
console.log(`Se van a subir ${lista.length} funciones en ${tandas.length} tanda(s) de hasta ${TANDA}.`);

for (let t = 0; t < tandas.length; t++) {
  const nombres = tandas[t];
  const primera = DESDE + t * TANDA;
  const only = nombres.map((n) => "functions:" + n).join(",");
  let ok = false;
  for (let intento = 0; intento <= REINTENTOS && !ok; intento++) {
    if (intento) {
      console.log(`\nLa tanda ${t + 1} falló. Se espera ${PAUSA_S * 2} s y se reintenta (${intento}/${REINTENTOS})...`);
      esperar(PAUSA_S * 2);
    }
    console.log(`\n=== Tanda ${t + 1} de ${tandas.length} (funciones ${primera} a ${primera + nombres.length - 1}) ===`);
    const r = spawnSync("firebase", ["deploy", "--only", only], { cwd: RAIZ, stdio: "inherit", shell: true });
    ok = r.status === 0;
  }
  if (!ok) {
    console.error(`\nNo se pudo subir la tanda ${t + 1}. Cuando quieras, retomá con:`);
    console.error(`  node scripts/deploy-funciones.js --desde ${primera}` + (args.length ? " " + args.join(" ") : ""));
    process.exit(1);
  }
  if (t < tandas.length - 1) {
    console.log(`\nTanda ${t + 1} lista. Pausa de ${PAUSA_S} s para no pasar el límite de Google...`);
    esperar(PAUSA_S);
  }
}
console.log("\nListo: todas las funciones quedaron subidas.");
