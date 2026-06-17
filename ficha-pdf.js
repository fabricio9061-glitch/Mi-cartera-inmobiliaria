/* =========================================================================
   Generador de FICHA TÉCNICA de propiedades (estilo Canva, marca MALAVE)
   Reutiliza jsPDF + html2canvas. Sirve para propiedades propias y compartidas.

   Uso:
     await generarFichaPropiedad({
       title, price, zona, direccion,
       dormitorios, banos, m2Terreno, m2Edificado, garaje, extras:[..],
       destacados:[..], comentario,
       photos:['url1','url2',...],     // primera = principal
       clienteNombre, clienteFecha, rangoInversion,
       mapLat, mapLng                   // opcional, para el mini-mapa
     });

   Requiere que en la página estén cargados (antes que este archivo):
     - jsPDF (window.jspdf)
     - html2canvas
     - malave-logos.js (MALAVE_LOGO_ISO, MALAVE_LOGO_TXT)
   ========================================================================= */

(function(){
  'use strict';

  var GOLD = '#c9a227';
  var NAVY = '#16273f';

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ---- Skyline decorativo (igual al del tasador) ----
  function skylineSVG(color, op, w, h){
    w = w||794; h = h||120;
    return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" preserveAspectRatio="xMidYMax meet" style="display:block;">' +
      '<g fill="'+color+'" opacity="'+op+'">' +
      '<rect x="20" y="60" width="40" height="60"/><rect x="72" y="40" width="34" height="80"/>' +
      '<polygon points="118,120 118,30 140,14 162,30 162,120"/>' +
      '<rect x="175" y="55" width="44" height="65"/><rect x="232" y="72" width="30" height="48"/>' +
      '<rect x="275" y="48" width="38" height="72"/><polygon points="325,120 325,38 348,22 371,38 371,120"/>' +
      '<rect x="384" y="62" width="40" height="58"/><rect x="438" y="50" width="34" height="70"/>' +
      '<rect x="485" y="68" width="40" height="52"/><polygon points="540,120 540,34 562,18 584,34 584,120"/>' +
      '<rect x="598" y="58" width="42" height="62"/><rect x="654" y="44" width="36" height="76"/>' +
      '<rect x="704" y="64" width="40" height="56"/><rect x="756" y="56" width="20" height="64"/>' +
      '</g></svg>';
  }

  // ---- Iconos de características (SVG dorado/navy) ----
  function caracIcon(type){
    var c = NAVY;
    var p = {
      bed:    '<path d="M2 14 V8 h14 a3 3 0 0 1 3 3 v3 M2 11 h17 M5 8 V6 h5 v2 M11 8 V6 h4 v2" fill="none" stroke="'+c+'" stroke-width="1.4" stroke-linejoin="round"/>',
      bath:   '<path d="M3 11 h16 v2 a3 3 0 0 1-3 3 H6 a3 3 0 0 1-3-3 z M5 11 V5 a2 2 0 0 1 4 0" fill="none" stroke="'+c+'" stroke-width="1.4" stroke-linecap="round"/>',
      area:   '<path d="M3 3 h16 v16 H3 z M3 9 h16 M9 3 v16" fill="none" stroke="'+c+'" stroke-width="1.4" stroke-linejoin="round"/>',
      land:   '<path d="M2 18 h18 M4 18 V8 l7-5 7 5 v10 M9 18 v-5 h4 v5" fill="none" stroke="'+c+'" stroke-width="1.4" stroke-linejoin="round"/>',
      car:    '<path d="M3 14 v-3 l2-4 h10 l2 4 v3 M3 14 h14 M3 14 v2 h2 v-2 M15 14 v2 h2 v-2 M6 11 h8" fill="none" stroke="'+c+'" stroke-width="1.4" stroke-linejoin="round"/>',
      extra:  '<circle cx="10" cy="10" r="7" fill="none" stroke="'+c+'" stroke-width="1.4"/><path d="M7 10 l2 2 l4-4" fill="none" stroke="'+c+'" stroke-width="1.4" stroke-linecap="round"/>'
    };
    return '<svg viewBox="0 0 22 22" width="20" height="20" style="vertical-align:middle;">'+(p[type]||p.extra)+'</svg>';
  }
  function checkIcon(){
    return '<svg viewBox="0 0 16 16" width="13" height="13" style="vertical-align:-1px;margin-right:6px;"><circle cx="8" cy="8" r="7" fill="'+GOLD+'"/><path d="M5 8 l2 2 l4-4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }
  function pinIcon(){
    return '<svg viewBox="0 0 16 16" width="13" height="13" style="vertical-align:-2px;margin-right:5px;"><path d="M8 1 C5 1 3 3 3 6 C3 9.5 8 15 8 15 C8 15 13 9.5 13 6 C13 3 11 1 8 1 Z" fill="'+GOLD+'"/><circle cx="8" cy="6" r="2" fill="#fff"/></svg>';
  }

  // ---- Cargar una imagen como dataURL (para que html2canvas la capture sin CORS) ----
  function imgToDataURL(url){
    return new Promise(function(resolve){
      if (!url){ resolve(''); return; }
      // Si ya es dataURL, devolver tal cual
      if (/^data:/.test(url)){ resolve(url); return; }
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function(){
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch(e){ resolve(url); } // si falla el canvas (CORS), usar la url directa
      };
      img.onerror = function(){ resolve(''); };
      img.src = url;
    });
  }

  // ---- Mini-mapa estático (OpenStreetMap, sin API key) ----
  function staticMapURL(lat, lng){
    if (lat == null || lng == null) return '';
    // staticmap de osm (sin key). Si falla, simplemente no se muestra.
    return 'https://staticmap.openstreetmap.de/staticmap.php?center='+lat+','+lng+'&zoom=15&size=420x240&markers='+lat+','+lng+',red-pushpin';
  }

  // ===================== GENERADOR PRINCIPAL =====================
  window.generarFichaPropiedad = async function(p){
    if (!window.jspdf || !window.html2canvas){ alert('Faltan librerías para generar el PDF.'); return; }
    p = p || {};

    // Preparar imágenes (a dataURL para evitar problemas de captura)
    var fotos = (p.photos||[]).filter(Boolean);
    var fotosData = [];
    for (var i=0;i<Math.min(fotos.length,4);i++){ fotosData.push(await imgToDataURL(fotos[i])); }
    fotosData = fotosData.filter(Boolean);
    var principal = fotosData[0] || '';
    var chicas = fotosData.slice(1, 4);

    // Mini-mapa
    var mapData = '';
    var mapUrl = staticMapURL(p.mapLat, p.mapLng);
    if (mapUrl){ mapData = await imgToDataURL(mapUrl); }

    var fecha = p.clienteFecha || new Date().toLocaleDateString('es-UY', { month:'long', year:'numeric' });
    fecha = fecha.charAt(0).toUpperCase() + fecha.slice(1);

    // ---- Características (solo las que tengan valor) ----
    var caracs = [];
    if (p.dormitorios) caracs.push([caracIcon('bed'), p.dormitorios + ' dormitorio' + (p.dormitorios==1?'':'s')]);
    if (p.banos) caracs.push([caracIcon('bath'), p.banos + ' baño' + (p.banos==1?'':'s')]);
    if (p.m2Edificado) caracs.push([caracIcon('area'), p.m2Edificado + ' m² edificados']);
    if (p.m2Terreno) caracs.push([caracIcon('land'), p.m2Terreno + ' m² de terreno']);
    if (p.garaje) caracs.push([caracIcon('car'), (typeof p.garaje==='number' ? ('Garaje para '+p.garaje) : 'Garaje')]);
    (p.extras||[]).forEach(function(e){ if(e) caracs.push([caracIcon('extra'), esc(e)]); });

    var caracsHTML = caracs.map(function(c){
      return '<div style="display:flex;align-items:center;gap:9px;width:48%;margin-bottom:11px;font-size:11.5px;color:#3a4150;">'+c[0]+'<span>'+c[1]+'</span></div>';
    }).join('');

    // ---- Destacados ----
    var destHTML = (p.destacados||[]).filter(Boolean).map(function(d){
      return '<div style="font-size:11px;color:#3a4150;margin-bottom:8px;">'+checkIcon()+esc(d)+'</div>';
    }).join('');

    // ---- Galería de fotos chicas ----
    var chicasHTML = chicas.map(function(src){
      return '<div style="flex:1;height:95px;border-radius:8px;overflow:hidden;background:#eef0f3;"><img src="'+src+'" style="width:100%;height:100%;object-fit:cover;display:block;"></div>';
    }).join('');

    // ---- Construcción de la página (A4 794x1123) ----
    var html =
      '<div id="__fichaPage" style="width:794px;min-height:1123px;background:#fff;font-family:Helvetica,Arial,sans-serif;color:#2c3340;box-sizing:border-box;display:flex;flex-direction:column;position:fixed;left:-99999px;top:0;">' +

        // ====== Encabezado superior: logo + título + foto principal ======
        '<div style="display:flex;">' +
          // Columna izquierda (marca + datos cliente)
          '<div style="width:34%;background:'+NAVY+';color:#fff;padding:26px 22px;display:flex;flex-direction:column;">' +
            '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:22px;">' +
              '<img src="'+MALAVE_LOGO_ISO+'" style="height:46px;"><img src="'+MALAVE_LOGO_TXT+'" style="height:13px;">' +
              '<div style="color:#aeb6c0;font-size:8px;letter-spacing:2px;margin-top:3px;">ASESORÍA INMOBILIARIA</div>' +
            '</div>' +
            '<div style="color:#fff;font-size:15px;letter-spacing:1px;line-height:1.3;margin-bottom:4px;">SELECCIÓN DE</div>' +
            '<div style="color:'+GOLD+';font-size:23px;font-weight:bold;letter-spacing:.5px;line-height:1;margin-bottom:22px;">PROPIEDADES</div>' +
            (p.clienteNombre ? '<div style="display:flex;align-items:center;gap:8px;margin-bottom:13px;"><div style="width:26px;height:26px;border-radius:50%;background:rgba(201,162,39,.2);display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="5.5" r="3" fill="none" stroke="'+GOLD+'" stroke-width="1.4"/><path d="M2.5 14 C2.5 10.5 5 9 8 9 C11 9 13.5 10.5 13.5 14" fill="none" stroke="'+GOLD+'" stroke-width="1.4"/></svg></div><div><div style="color:#aeb6c0;font-size:8px;letter-spacing:1px;">PARA</div><div style="color:#fff;font-size:11px;">'+esc(p.clienteNombre)+'</div></div></div>' : '') +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:13px;"><div style="width:26px;height:26px;border-radius:50%;background:rgba(201,162,39,.2);display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 16 16" width="13" height="13"><rect x="2" y="3" width="12" height="11" rx="1" fill="none" stroke="'+GOLD+'" stroke-width="1.3"/><path d="M2 6 h12 M5 2 v3 M11 2 v3" stroke="'+GOLD+'" stroke-width="1.3"/></svg></div><div><div style="color:#aeb6c0;font-size:8px;letter-spacing:1px;">FECHA</div><div style="color:#fff;font-size:11px;">'+esc(fecha)+'</div></div></div>' +
            (p.rangoInversion ? '<div style="display:flex;align-items:center;gap:8px;"><div style="width:26px;height:26px;border-radius:50%;background:rgba(201,162,39,.2);display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6" fill="none" stroke="'+GOLD+'" stroke-width="1.3"/><path d="M8 5 v6 M6.5 6.5 h3 a1.3 1.3 0 0 1 0 2.6 h-3 M6.5 9 h3 a1.3 1.3 0 0 1 0 2.6 h-3" stroke="'+GOLD+'" stroke-width="1.1" fill="none"/></svg></div><div><div style="color:#aeb6c0;font-size:8px;letter-spacing:1px;">RANGO DE INVERSIÓN</div><div style="color:#fff;font-size:11px;">'+esc(p.rangoInversion)+'</div></div></div>' : '') +
            '<div style="flex:1;"></div>' +
          '</div>' +
          // Columna derecha (foto principal)
          '<div style="width:66%;height:300px;background:#eef0f3;position:relative;">' +
            (principal ? '<img src="'+principal+'" style="width:100%;height:100%;object-fit:cover;display:block;">' : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#ccd1d8;font-size:40px;">🏠</div>') +
            '<div style="position:absolute;top:14px;right:14px;background:'+NAVY+';color:#fff;font-size:9px;font-weight:bold;letter-spacing:1px;padding:5px 12px;">PROPIEDAD 01</div>' +
          '</div>' +
        '</div>' +

        // ====== Fotos chicas ======
        (chicasHTML ? '<div style="display:flex;gap:8px;padding:8px 22px 0;">'+chicasHTML+'</div>' : '') +

        // ====== Cuerpo: título, precio, características + destacados + mapa ======
        '<div style="padding:18px 24px 8px;display:flex;gap:24px;">' +
          // Izquierda
          '<div style="flex:1.15;">' +
            '<div style="font-size:21px;font-weight:bold;color:'+NAVY+';line-height:1.1;">'+esc(p.title||'Propiedad')+'</div>' +
            (p.direccion||p.zona ? '<div style="font-size:11px;color:#6a7280;margin-top:5px;">'+pinIcon()+esc(p.direccion||p.zona)+'</div>' : '') +
            '<div style="font-size:23px;font-weight:bold;color:'+NAVY+';margin:11px 0 4px;">'+esc(p.price||'Consultar')+'</div>' +
            '<div style="height:1px;background:#e3e6ea;margin:12px 0 14px;"></div>' +
            '<div style="font-size:9px;letter-spacing:1.5px;color:'+GOLD+';font-weight:bold;margin-bottom:12px;">CARACTERÍSTICAS</div>' +
            '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;">'+(caracsHTML||'<div style="font-size:11px;color:#9aa0a8;">Sin datos cargados</div>')+'</div>' +
          '</div>' +
          // Derecha (destacados + mapa)
          '<div style="flex:1;border-left:1px solid #e3e6ea;padding-left:22px;">' +
            (destHTML ? '<div style="font-size:9px;letter-spacing:1.5px;color:'+GOLD+';font-weight:bold;margin-bottom:12px;">DESTACADOS</div>'+destHTML : '') +
            (mapData ? '<div style="font-size:9px;letter-spacing:1.5px;color:'+GOLD+';font-weight:bold;margin:16px 0 8px;">'+pinIcon()+'UBICACIÓN</div><div style="height:120px;border-radius:9px;overflow:hidden;border:1px solid #e3e6ea;"><img src="'+mapData+'" style="width:100%;height:100%;object-fit:cover;display:block;"></div>' : '') +
          '</div>' +
        '</div>' +

        // ====== Comentario profesional ======
        (p.comentario ? '<div style="margin:6px 24px 0;background:#f5f6f8;border-radius:10px;padding:14px 18px;display:flex;gap:11px;align-items:flex-start;">' +
          '<svg viewBox="0 0 20 20" width="20" height="20" style="flex:0 0 auto;margin-top:1px;"><circle cx="10" cy="10" r="9" fill="'+GOLD+'"/><path d="M10 5 v6 M10 14 v.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>' +
          '<div><div style="font-size:9px;letter-spacing:1px;color:'+NAVY+';font-weight:bold;margin-bottom:4px;">COMENTARIO PROFESIONAL</div>' +
          '<div style="font-size:10.5px;line-height:1.6;color:#4a5260;">'+esc(p.comentario)+'</div></div>' +
        '</div>' : '') +

        '<div style="flex:1;min-height:14px;"></div>' +

        // ====== Footer ======
        '<div style="background:'+NAVY+';padding:13px 24px;display:flex;justify-content:space-between;align-items:center;margin-top:14px;">' +
          '<div style="color:#cdd2d8;font-size:9px;letter-spacing:1px;">MALAVE &nbsp;·&nbsp; ASESORÍA INMOBILIARIA</div>' +
          '<div style="color:#cdd2d8;font-size:9px;">094 029 297 &nbsp;·&nbsp; inmobiliariamalave@gmail.com</div>' +
          '<div style="color:'+GOLD+';font-size:13px;font-weight:bold;">01</div>' +
        '</div>' +

      '</div>';

    // Insertar, capturar, generar PDF
    var holder = document.createElement('div');
    holder.innerHTML = html;
    document.body.appendChild(holder);
    var node = holder.querySelector('#__fichaPage');

    try {
      var canvas = await html2canvas(node, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
      var imgData = canvas.toDataURL('image/jpeg', 0.92);
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF('p', 'mm', 'a4');
      var pw = pdf.internal.pageSize.getWidth();
      var ph = pdf.internal.pageSize.getHeight();
      // Ajustar manteniendo proporción A4
      pdf.addImage(imgData, 'JPEG', 0, 0, pw, ph);
      var nombre = ('ficha-' + (p.title||'propiedad')).toLowerCase().replace(/[^\w]+/g,'-').replace(/^-|-$/g,'') + '.pdf';
      pdf.save(nombre);
    } catch(e){
      console.error('Error generando ficha:', e);
      alert('Hubo un problema generando la ficha. Revisá que las fotos estén disponibles.');
    } finally {
      document.body.removeChild(holder);
    }
  };
})();
