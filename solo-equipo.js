/* ============================================================================
   SOLO EQUIPO — páginas que no son para el Agente Asociado.
   ----------------------------------------------------------------------------
   El agente asociado paga para publicar en la web, pero no es del equipo: no
   usa clientes, finanzas, puntos, tasaciones, cuentas de portales,
   rentabilidad ni documentos. El menú ya no le muestra esas páginas, y las
   reglas de Firestore no le dan los datos. Esto es para que, si entra por un
   enlace, vea un aviso claro en lugar de una pantalla vacía con errores.

   Se carga al final de cada una de esas páginas, después de Firebase.
   ========================================================================== */
(function () {
  'use strict';
  var intentos = 0;
  function bloquear() {
    var css = 'position:fixed;inset:0;z-index:99999;background:#f5f6f8;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;font-family:inherit,system-ui,sans-serif;text-align:center';
    var d = document.createElement('div');
    d.setAttribute('style', css);
    d.innerHTML = '<div style="max-width:420px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 10px 30px rgba(16,29,48,.12)">' +
      '<div style="font-size:2rem;color:#C9A227;margin-bottom:8px">&#128274;</div>' +
      '<h2 style="margin:0 0 8px;color:#16273f;font-size:1.2rem">Esta herramienta es del equipo de MALAVE</h2>' +
      '<p style="margin:0 0 18px;color:#555;font-size:.95rem;line-height:1.5">Tu plan de agente asociado incluye publicar tus propiedades en la web y los portales, tus consultas, tu perfil, tu agenda y la Academy.</p>' +
      '<a href="index.html" style="display:inline-block;background:#16273f;color:#fff;text-decoration:none;border-radius:10px;padding:10px 20px;font-weight:600">Volver al inicio</a>' +
      '</div>';
    document.body.appendChild(d);
    document.documentElement.style.overflow = 'hidden';
  }
  function empezar() {
    if (!window.firebase || !firebase.apps || !firebase.apps.length) {
      if (++intentos < 100) setTimeout(empezar, 100);
      return;
    }
    firebase.auth().onAuthStateChanged(function (u) {
      if (!u) return;
      firebase.firestore().collection('users').doc(u.uid).get().then(function (s) {
        if (s.exists && s.data().rank === 'agente_asociado') bloquear();
      }).catch(function () { /* sin perfil legible: la página sigue con sus propios controles */ });
    });
  }
  empezar();
})();
