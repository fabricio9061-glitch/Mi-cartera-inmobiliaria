/* ============================================================================
   ORGANIGRAMA DE LA INMOBILIARIA — fuente única de verdad de los rangos.
   ----------------------------------------------------------------------------
   Este archivo lo cargan admin.html y app.js (y más adelante el resto). Antes el
   organigrama vivía suelto dentro de app.js, que admin.html NI SIQUIERA CARGA:
   por eso el panel editaba un "Cargo" de texto libre por un lado y el campo
   'rank' quedaba sin escribir por el otro. Dos fuentes de verdad que se
   contradecían. Acá hay una sola.

   TRES COSAS SEPARADAS, a propósito:

     grupo  — qué hacés (Dirección / Comercial / Operaciones / Finanzas).
     nivel  — a quién podés administrar. Sirve para UNA sola regla: no podés
              tocar a alguien de nivel igual o mayor al tuyo. Nada más.
     caps   — qué podés hacer. LOS PERMISOS SALEN DE ACÁ, no de comparar niveles.

   El motivo de separarlas: un número lineal no sabe decir "otra área, no más
   poder". Con el modelo viejo, Coordinador Administrativo (55) quedaba por
   encima de Asesor Senior (50) y por lo tanto heredaba permisos comerciales que
   no le corresponden. Finanzas tiene nivel 40 —no manda sobre nadie— pero sus
   caps tocan el dinero. Eso con un número solo no se puede expresar.

   OJO: esto es la capa de interfaz. El permiso de verdad se hace cumplir en las
   reglas de Firestore y en las Cloud Functions. Si algo se agrega acá, hay que
   bajarlo también allá o es sólo decoración.
   ========================================================================== */
(function (global) {
  'use strict';

  // Con quién arranca todo el que se registra. No se puede elegir al registrarse:
  // lo clava la regla de Firestore en el create.
  var RANGO_INICIAL = 'asesor_junior';

  // Estos dos mandan sobre todo el sistema.
  var RANGOS_DIRECCION = ['ceo', 'coo'];

  var RANKS = [
    // ---- Dirección: '*' es todas las capacidades ----
    { key: 'ceo', grupo: 'Dirección', label: 'CEO', nivel: 100, caps: ['*'] },
    { key: 'coo', grupo: 'Dirección', label: 'COO — Director de Operaciones', nivel: 90, caps: ['*'] },

    // ---- Comercial: la escalera del asesor. Define la comisión. ----
    {
      key: 'gerente_comercial', grupo: 'Comercial', label: 'Gerente Comercial', nivel: 70,
      caps: ['equipo.ver', 'equipo.aprobar', 'agenda.todas', 'propiedades.todas', 'clientes.todos']
    },
    { key: 'asesor_elite', grupo: 'Comercial', label: 'Asesor Elite', nivel: 50, caps: ['compartidas.crear'] },
    { key: 'asesor_senior', grupo: 'Comercial', label: 'Asesor Senior', nivel: 40, caps: [] },
    { key: 'asesor_semi_senior', grupo: 'Comercial', label: 'Asesor Semi Senior', nivel: 30, caps: [] },
    { key: 'asesor_junior', grupo: 'Comercial', label: 'Asesor Junior', nivel: 20, caps: [] },

    // ---- Finanzas: nivel bajo (no manda sobre nadie) pero toca la plata. ----
    {
      key: 'finanzas', grupo: 'Finanzas', label: 'Finanzas', nivel: 40,
      caps: ['dinero.retiros', 'dinero.comisiones', 'dinero.saldos', 'ganancias.ver']
    },

    // ---- Operaciones: al costado de lo comercial, no por encima. ----
    {
      key: 'administracion', grupo: 'Operaciones', label: 'Administración', nivel: 35,
      caps: ['documentos.editar', 'portales.gestionar']
    },
    {
      key: 'marketing', grupo: 'Operaciones', label: 'Marketing', nivel: 35,
      caps: ['sitio.editar', 'academy.editar', 'recompensas.gestionar']
    }
  ];

  // Catálogo de capacidades, para tener la lista completa en un solo lugar.
  var CAPS = [
    'equipo.ver', 'equipo.editar', 'equipo.rango', 'equipo.aprobar', 'equipo.eliminar',
    'dinero.retiros', 'dinero.comisiones', 'dinero.saldos', 'ganancias.ver',
    'cartera.traspasar', 'propiedades.todas', 'propiedades.borrar',
    'clientes.todos', 'agenda.todas', 'compartidas.crear',
    'sitio.editar', 'academy.editar', 'documentos.editar',
    'portales.gestionar', 'recompensas.gestionar'
  ];

  function rango(key) {
    for (var i = 0; i < RANKS.length; i++) if (RANKS[i].key === key) return RANKS[i];
    return null;
  }
  function rangoDe(u) { return rango(u && u.rank); }
  function nivelDe(u) { var r = rangoDe(u); return r ? r.nivel : 0; }

  // Etiqueta a mostrar. Cae en 'role' sólo por los usuarios viejos que todavía
  // tienen el texto libre y ningún rango asignado.
  function etiqueta(u) {
    var r = rangoDe(u);
    if (r) return r.label;
    return (u && u.role) ? u.role : '';
  }
  function esDireccion(u) { return RANGOS_DIRECCION.indexOf(u && u.rank) !== -1; }

  /* ¿El usuario puede hacer 'cap'?
     adminPorEmail es la red de seguridad: el CEO se identifica por correo aunque
     su documento no tenga rango cargado. Sin esto, un rango mal puesto te deja
     afuera de tu propio panel y no hay desde dónde arreglarlo. */
  function puede(u, cap, adminPorEmail) {
    if (adminPorEmail) return true;
    var r = rangoDe(u);
    if (!r) return false;
    if (r.caps.indexOf('*') !== -1) return true;
    return r.caps.indexOf(cap) !== -1;
  }

  /* ¿'actor' puede administrar a 'objetivo'? Regla única del nivel.
     Se exige nivel ESTRICTAMENTE mayor: dos personas del mismo rango no se
     administran entre sí, y nadie se administra a sí mismo. */
  function puedeAdministrar(actor, objetivo, adminPorEmail) {
    if (!actor || !objetivo) return false;
    if (actor.uid && actor.uid === objetivo.uid) return false;   // ni a uno mismo
    if (objetivo.rank === 'ceo') return false;                   // al CEO no lo toca nadie
    if (adminPorEmail) return true;
    return nivelDe(actor) > nivelDe(objetivo);
  }

  /* ¿'actor' puede ponerle el rango 'nuevoKey' a 'objetivo'?
     Tres candados, y el orden importa:
       1. Hay que poder administrar al objetivo (incluye: al CEO nadie lo toca).
       2. No se puede asignar un rango de nivel igual o mayor al propio: así el
          COO no se hace CEO ni fabrica otro COO.
       3. Nadie se cambia el rango a sí mismo, ni siquiera hacia abajo.
     El CEO por correo se saltea 2 y 3 porque es el dueño del organigrama. */
  function puedeAsignarRango(actor, objetivo, nuevoKey, adminPorEmail) {
    if (!puede(actor, 'equipo.rango', adminPorEmail)) return false;
    if (!puedeAdministrar(actor, objetivo, adminPorEmail)) return false;
    if (adminPorEmail) return true;
    var nuevo = rango(nuevoKey);
    if (nuevo && nuevo.nivel >= nivelDe(actor)) return false;
    return true;
  }

  // Rangos agrupados para armar los <optgroup> del selector, en el orden del array.
  function porGrupo() {
    var g = [], idx = {};
    RANKS.forEach(function (r) {
      if (idx[r.grupo] == null) { idx[r.grupo] = g.length; g.push({ grupo: r.grupo, rangos: [] }); }
      g[idx[r.grupo]].rangos.push(r);
    });
    return g;
  }

  global.Rangos = {
    RANKS: RANKS,
    CAPS: CAPS,
    RANGO_INICIAL: RANGO_INICIAL,
    RANGOS_DIRECCION: RANGOS_DIRECCION,
    rango: rango,
    rangoDe: rangoDe,
    nivelDe: nivelDe,
    etiqueta: etiqueta,
    esDireccion: esDireccion,
    puede: puede,
    puedeAdministrar: puedeAdministrar,
    puedeAsignarRango: puedeAsignarRango,
    porGrupo: porGrupo
  };
})(typeof window !== 'undefined' ? window : this);
