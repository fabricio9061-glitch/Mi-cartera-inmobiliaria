// =============================================================================
// FINANZAS DEL EQUIPO (panel de la Dirección, admin.html)
// -----------------------------------------------------------------------------
// El saldo a cobrar y los puntos de un agente NO están guardados en su perfil:
// se calculan. Es la misma cuenta que calcularFinanzasAgente() de app.js (menú
// personal y Mis Finanzas), Recompensas y el servidor al cobrar un canje:
//
//   cierres confirmados propios + su parte en cierres de equipo + referidos
//   ± ajustes de la Dirección − canjes (solo puntos) − retiros (solo dinero)
//
// Acá se hace para TODO el equipo de una vez: cada colección se lee una sola
// vez y se reparte por agente, en lugar de 5 consultas por agente.
// Si se cambia la cuenta en app.js hay que cambiarla también acá.
// =============================================================================
(function () {
  function cierresConfirmadosDe(p) {
    var l = [], vistos = {};
    function sumar(c) {
      if (!c || typeof c !== 'object') return;
      var k = String(c.registradoEl || '');
      if (k && vistos[k]) return;          // la misma operación archivada dos veces cuenta una
      if (k) vistos[k] = true;
      l.push(c);
    }
    if (p && p.cierreConfirmado === true) sumar(p.cierre);
    if (p && Array.isArray(p.cierresAnteriores)) p.cierresAnteriores.forEach(sumar);
    return l;
  }
  function agenteDelCierre(c, p) { return (c && c.agenteUid) || (p && p.ownerId) || ''; }
  function numOk(v) { return v != null && v !== '' && isFinite(Number(v)); }
  // Lo que le quedó al agente: la ganancia cargada en el cierre o, en los cierres
  // viejos que no la tienen, su % de la comisión de la inmobiliaria.
  function gananciaDelCierre(c, perfil) {
    if (numOk(c.gananciaAgente)) return Number(c.gananciaAgente);
    var precio = Number(c.precio) || 0;
    var comAg = (c.tipo === 'venta') ? precio * ((c.agencyPct != null ? Number(c.agencyPct) : 3) / 100)
                                     : precio * (c.agencyMonths != null ? Number(c.agencyMonths) : 1);
    var pct = (c.tipo === 'venta') ? Number((perfil || {}).commissionSale) : Number((perfil || {}).commissionRent);
    return pct ? comAg * pct / 100 : 0;
  }

  // Lee lo que hace falta además de propiedades y usuarios (que el panel ya
  // tiene). Retiros y ajustes solo los puede leer el CEO: por eso este cálculo
  // se usa únicamente cuando mira el CEO. Si una lectura falla, devuelve error
  // en vez de mostrar un saldo incompleto como si fuera el real.
  async function cargar(db) {
    var lista = function (q) { return q.get().then(function (s) { return s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); }); };
    var r = await Promise.all([
      db.collection('config').doc('recompensas').get().catch(function () { return null; }),
      lista(db.collection('referidos')),
      lista(db.collection('ajustesFinancieros')),
      lista(db.collection('canjes')),
      lista(db.collection('retiros'))
    ]);
    var cfg = { puntosPor100: 1, dolarPesos: 40 };
    if (r[0] && r[0].exists) cfg = Object.assign(cfg, r[0].data());
    return { cfg: cfg, referidos: r[1], ajustes: r[2], canjes: r[3], retiros: r[4] };
  }

  // props: array de propiedades ({...data}); perfiles: { uid: perfil }.
  // Devuelve { uid: { usd, uyu, pts, ganadoUSD, ganadoUYU, ganadoPts, ajUSD, ajUYU,
  // ajPts, canjPts, retUSD, retUYU, ajustes: [...] } } para cada uid de perfiles.
  function calcular(props, perfiles, datos) {
    var cfg = datos.cfg;
    var porCien = Number(cfg.puntosPor100) || 1;
    var aUSD = function (monto, moneda) { return moneda === 'UYU' ? (cfg.dolarPesos > 0 ? monto / cfg.dolarPesos : 0) : monto; };
    var out = {};
    var de = function (uid) {
      return out[uid] || (out[uid] = { usd: 0, uyu: 0, pts: 0, ganadoUSD: 0, ganadoUYU: 0, ganadoPts: 0,
        ajUSD: 0, ajUYU: 0, ajPts: 0, canjPts: 0, retUSD: 0, retUYU: 0, ajustes: [] });
    };
    Object.keys(perfiles).forEach(de);

    // 1) Cierres propios y 2) participaciones en cierres de equipo.
    // Se arma también la ganancia de cada agente del cierre, para los referidos.
    var cierresPorAgente = {};
    props.forEach(function (p) {
      cierresConfirmadosDe(p).forEach(function (c) {
        var moneda = c.moneda === 'UYU' ? 'UYU' : 'USD';
        var duenio = agenteDelCierre(c, p);
        (cierresPorAgente[duenio] = cierresPorAgente[duenio] || []).push(c);
        var suma = function (uid, monto) {
          if (!monto || !perfiles[uid]) return;
          var f = de(uid);
          if (moneda === 'UYU') f.ganadoUYU += monto; else f.ganadoUSD += monto;
          f.ganadoPts += Math.floor(aUSD(monto, moneda) / 100) * porCien;
        };
        if (duenio) suma(duenio, gananciaDelCierre(c, perfiles[duenio]));
        (Array.isArray(c.participantes) ? c.participantes : []).forEach(function (x) {
          if (x && x.uid && x.uid !== duenio) suma(x.uid, Number(x.monto) || 0);
        });
      });
    });

    // 3) Referidos: el referente cobra su % de la ganancia cargada en cada
    //    cierre confirmado del referido. No da puntos.
    datos.referidos.forEach(function (rf) {
      var f = perfiles[rf.referrerUid] ? de(rf.referrerUid) : null;
      if (!f) return;
      var pctS = Number(rf.pctSale) || 0, pctR = Number(rf.pctRent) || 0;
      if (!pctS && !pctR) return;
      (cierresPorAgente[rf.id] || []).forEach(function (c) {
        var gan = numOk(c.gananciaAgente) ? Number(c.gananciaAgente) : 0;
        var pct = (c.tipo === 'venta') ? pctS : pctR;
        if (!gan || !pct) return;
        if (c.moneda === 'UYU') f.ganadoUYU += gan * pct / 100; else f.ganadoUSD += gan * pct / 100;
      });
    });

    // 4) Ajustes de la Dirección, 5) canjes y 6) retiros.
    datos.ajustes.forEach(function (a) {
      if (!perfiles[a.agenteUid]) return;
      var f = de(a.agenteUid);
      f.ajUSD += Number(a.montoUSD) || 0; f.ajUYU += Number(a.montoUYU) || 0; f.ajPts += Number(a.puntos) || 0;
      f.ajustes.push(a);
    });
    datos.canjes.forEach(function (c) {
      if (!perfiles[c.agenteUid] || c.status === 'rechazado') return;
      de(c.agenteUid).canjPts += Number(c.costoPuntos) || 0;
    });
    datos.retiros.forEach(function (r) {
      if (!perfiles[r.agenteUid]) return;
      if (r.status !== 'pagado' && r.status !== 'pendiente' && r.status !== 'aprobado') return;
      var f = de(r.agenteUid), m = Number(r.monto) || 0;
      if (r.moneda === 'UYU') f.retUYU += m; else f.retUSD += m;
    });

    Object.keys(out).forEach(function (uid) {
      var f = out[uid];
      f.usd = Math.max(0, f.ganadoUSD + f.ajUSD - f.retUSD);
      f.uyu = Math.max(0, f.ganadoUYU + f.ajUYU - f.retUYU);
      f.pts = Math.max(0, f.ganadoPts + f.ajPts - f.canjPts);
      f.ajustes.sort(function (a, b) { return String(b.fecha || '').localeCompare(String(a.fecha || '')); });
    });
    return out;
  }

  window.FinanzasEquipo = { cargar: cargar, calcular: calcular };
})();
