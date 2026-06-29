  const firebaseConfig = {
    apiKey: "AIzaSyDnCQLlJuBtZqXNwYILio9a8ltb972bXzQ",
    authDomain: "mi-cartera-inmobiliaria.firebaseapp.com",
    projectId: "mi-cartera-inmobiliaria",
    storageBucket: "mi-cartera-inmobiliaria.firebasestorage.app",
    messagingSenderId: "923595024127",
    appId: "1:923595024127:web:b7104adcba6387a5a84eca"
  };
  firebase.initializeApp(firebaseConfig);
  function mvEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  const auth = firebase.auth(),
    db = firebase.firestore(),
    storage = firebase.storage(),
    ADMIN_EMAIL = "fabricio9061@gmail.com";

  // FCM - Push Notifications
  // Se inicializa en una app de Firebase APARTE a propósito: el SDK de Cloud
  // Functions intenta sacar el token de push de la misma app para adjuntarlo a
  // cada llamada, y en navegadores como Brave u Opera eso falla con
  // "Registration failed - push service error" y rompe la llamada. Aislando
  // Messaging en otra app, las llamadas a las funciones (estado/republicar/baja
  // de ML) dejan de verse afectadas.
  let messaging = null;
  try {
    const msgApp = firebase.apps.find((a) => a.name === 'messaging') || firebase.initializeApp(firebaseConfig, 'messaging');
    messaging = msgApp.messaging()
  } catch (e) {
    console.log('FCM no soportado en este navegador')
  }

  // IMPORTANTE: Reemplazar con tu VAPID Key de Firebase Console
  const VAPID_KEY = 'BK8DjPgkooF91Ou9js1FOaX9VtJwVDqFaXpGePoYosqWcmpy5MBrtW0YauhWjWpYP1yUVvM9IzT4toFYLdEI8Ko';

  async function setupFCM() {
    if (!messaging || !currentUser) return;
    try {
      // 1. Verificar soporte de Service Worker
      if (!('serviceWorker' in navigator)) {
        console.log('Service Workers no soportados');
        return;
      }

      // 2. Solicitar permiso de notificaciones
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.log('Permiso de notificaciones denegado');
        showToast('Notificaciones', 'Habilita las notificaciones para recibir recordatorios', 'fa-bell');
        return;
      }

      // 3. Registrar Service Worker
      const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      console.log('Service Worker registrado:', reg.scope);

      // 4. Esperar a que el SW esté activo
      await navigator.serviceWorker.ready;

      // 5. Obtener token FCM
      const token = await messaging.getToken({
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: reg
      });

      if (token) {
        console.log('FCM Token obtenido:', token.substring(0, 20) + '...');

        // 6. Guardar token en Firestore
        const userRef = db.collection('users').doc(currentUser.uid);
        const doc = await userRef.get();
        const currentToken = doc.data()?.fcmToken;

        if (currentToken !== token) {
          await userRef.update({
            fcmToken: token,
            fcmTokenUpdatedAt: new Date().toISOString(),
            notificationsEnabled: true,
            deviceInfo: {
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              language: navigator.language
            }
          });
          console.log('FCM Token guardado en Firestore');
          showToast('Notificaciones activadas', 'Recibirás alertas de tus eventos', 'fa-bell');
        }
      } else {
        console.log('No se pudo obtener token FCM');
      }
    } catch (err) {
      console.error('Error configurando FCM:', err);
      // No mostrar error al usuario, las notificaciones locales seguirán funcionando
    }
  }

  // Escuchar notificaciones en primer plano
  if (messaging) {
    messaging.onMessage(payload => {
      console.log('Notificación recibida en primer plano:', payload);
      const n = payload.notification || {};
      const d = payload.data || {};
      showToast(n.title || d.title || 'Recordatorio', n.body || d.body || 'Tienes un evento próximo', 'fa-bell');
      // También mostrar notificación nativa si está en primer plano
      if (Notification.permission === 'granted') {
        new Notification(n.title || 'Recordatorio', {
          body: n.body || 'Tienes un evento próximo',
          icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
          badge: 'https://cdn-icons-png.flaticon.com/128/1946/1946488.png',
          vibrate: [200, 100, 200]
        });
      }
    });
  }

  // Escuchar mensajes del Service Worker (cuando hace clic en notificación)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      console.log('Mensaje del SW:', event.data);
      if (event.data?.action === 'openCalendar') {
        openCalendarModal();
      }
    });
  }

  // Función para enviar notificación de prueba (para debug)
  async function testNotification() {
    if (Notification.permission === 'granted') {
      new Notification('🔔 Notificación de prueba', {
        body: '¡Las notificaciones están funcionando correctamente!',
        icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
        vibrate: [200, 100, 200, 100, 200]
      });
      showToast('Test exitoso', 'Las notificaciones locales funcionan', 'fa-check');
    } else {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') testNotification();
      else showToast('Permiso denegado', 'Habilita las notificaciones en tu navegador', 'fa-exclamation-triangle');
    }
  }

  const uruguayData = {
    "Montevideo": ["Aguada", "Aires Puros", "Atahualpa", "Bañados de Carrasco", "Barrio Sur", "Bella Italia", "Bella Vista", "Belvedere", "Brazo Oriental", "Buceo", "Capurro", "Carrasco", "Carrasco Norte", "Casabó", "Casavalle", "Centro", "Cerrito de la Victoria", "Cerro", "Ciudad Vieja", "Colón", "Conciliación", "Cordón", "Flor de Maroñas", "Goes", "Ituzaingó", "Jacinto Vera", "Jardines del Hipódromo", "La Blanqueada", "La Comercial", "La Figurita", "La Paloma", "La Teja", "Larrañaga", "Las Acacias", "Las Canteras", "Lezica", "Malvín", "Malvín Norte", "Manga", "Maroñas", "Melilla", "Mercado Modelo", "Nuevo París", "Palermo", "Parque Batlle", "Parque Rodó", "Paso de la Arena", "Paso de las Duranas", "Paso Molino", "Peñarol", "Piedras Blancas", "Pocitos", "Pocitos Nuevo", "Prado", "Punta Carretas", "Punta Gorda", "Punta Rieles", "Reducto", "Sayago", "Toledo Chico", "Tres Cruces", "Tres Ombúes", "Unión", "Villa Dolores", "Villa Española", "Villa García", "Villa Muñoz", "Vista Linda"].sort(),
    "Canelones": ["Ciudad de la Costa", "Las Piedras", "Pando", "Canelones", "Santa Lucía", "Progreso", "Atlántida", "Salinas", "Parque del Plata", "Solymar", "Shangrilá", "El Pinar", "Lagomar", "La Floresta"],
    "Maldonado": ["Maldonado", "Punta del Este", "San Carlos", "Piriápolis", "Pan de Azúcar", "La Barra", "José Ignacio", "Manantiales", "Punta Ballena"],
    "Colonia": ["Colonia del Sacramento", "Carmelo", "Juan Lacaze", "Nueva Helvecia", "Rosario", "Nueva Palmira"],
    "Salto": ["Salto", "Daymán", "Termas del Daymán", "Termas del Arapey"],
    "Paysandú": ["Paysandú", "Guichón", "Termas de Guaviyú"],
    "Río Negro": ["Fray Bentos", "Young"],
    "Soriano": ["Mercedes", "Dolores"],
    "San José": ["San José de Mayo", "Ciudad del Plata", "Libertad"],
    "Florida": ["Florida", "Sarandí Grande"],
    "Flores": ["Trinidad"],
    "Durazno": ["Durazno", "Sarandí del Yí"],
    "Tacuarembó": ["Tacuarembó", "Paso de los Toros"],
    "Rivera": ["Rivera", "Tranqueras"],
    "Artigas": ["Artigas", "Bella Unión"],
    "Cerro Largo": ["Melo", "Río Branco"],
    "Lavalleja": ["Minas"],
    "Rocha": ["Rocha", "Chuy", "Castillos", "La Paloma", "La Pedrera", "Cabo Polonio", "Punta del Diablo"],
    "Treinta y Tres": ["Treinta y Tres", "Vergara"]
  };

  let currentUser = null,
    userProfile = null,
    properties = [],
    allUsers = {},
    currentDetailProperty = null,
    currentDetailImageIndex = 0,
    currentProfileUserId = null,
    selectedImages = [],
    draggedImageIndex = null,
    notifications = [],
    notificationCheckInterval = null,
    visits = [],
    currentCalendarDate = null,
    selectedCalendarDate = null,
    visitReminderInterval = null,
    selectedEventType = 'visit';

  const eventTypeLabels = {
    visit: 'Visita',
    meeting: 'Reunión',
    delivery: 'Entrega',
    review: 'Revisión',
    other: 'Otro'
  };

  // Zona horaria Uruguay - enfoque robusto con Intl API
  function getUruguayNow() {
    try {
      const s = new Date().toLocaleString('en-US', {
        timeZone: 'America/Montevideo'
      });
      const d = new Date(s);
      // Safari/iOS a veces no puede parsear ese formato -> Invalid Date.
      if (isNaN(d.getTime())) return new Date();
      return d;
    } catch (e) {
      return new Date();
    }
  }

  function getUruguayToday() {
    const d = getUruguayNow();
    d.setHours(0, 0, 0, 0);
    return d
  }

  function formatDateToISO(d) {
    if (!d || isNaN(d.getTime && d.getTime())) d = getUruguayToday() || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`
  }

  function parseEventDateTime(dateStr, timeStr) {
    const p = dateStr.split('-'),
      t = timeStr.split(':');
    return new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]), parseInt(t[0]), parseInt(t[1]), 0)
  }

  function hoursUntilEvent(dateStr, timeStr) {
    const now = getUruguayNow(),
      evt = parseEventDateTime(dateStr, timeStr);
    return (evt.getTime() - now.getTime()) / (1e3 * 60 * 60)
  }

  function initDepartamentos() {
    const s = document.getElementById('propDepartamento');
    s.innerHTML = '<option value="">Seleccionar...</option>';
    Object.keys(uruguayData).sort().forEach(d => {
      s.innerHTML += `<option value="${d}">${d}</option>`
    })
  }

  function updateCiudades() {
    const d = document.getElementById('propDepartamento').value,
      c = document.getElementById('propCiudad');
    c.innerHTML = '<option value="">Seleccionar...</option>';
    if (d && uruguayData[d]) uruguayData[d].forEach(ciudad => {
      c.innerHTML += `<option value="${ciudad}">${ciudad}</option>`
    })
  }

  function loadRememberedUser() {
    const r = localStorage.getItem('rememberedEmail');
    if (r) {
      document.getElementById('loginEmail').value = r;
      document.getElementById('rememberMe').checked = true
    }
  }
  async function loadUsers() {
    const s = await db.collection('users').where('status', '==', 'approved').get();
    s.docs.forEach(d => {
      allUsers[d.id] = d.data()
    })
  }
  const _usersReady = loadUsers();

  function showToast(t, m, i = 'fa-bell') {
    const c = document.getElementById('toastContainer'),
      toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<div class="toast-icon"><i class="fas ${i}"></i></div><div class="toast-content"><strong>${t}</strong><p>${m}</p></div>`;
    c.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300)
    }, 5000)
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  }

  function sendBrowserNotification(t, b, tag = 'notification') {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notif = new Notification(t, {
        body: b,
        icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
        badge: 'https://cdn-icons-png.flaticon.com/128/1946/1946488.png',
        tag: tag,
        renotify: true,
        vibrate: [200, 100, 200]
      });
      notif.onclick = () => window.focus();
    }
  }

  async function uploadImageToStorage(f, p, i) {
    const n = `${Date.now()}_${i}_${f.name.replace(/[^a-zA-Z0-9.]/g,'_')}`,
      r = storage.ref(`properties/${p}/${n}`),
      b = await compressImageToBlob(f, 1200, .8),
      u = await r.put(b);
    return await u.ref.getDownloadURL()
  }
  async function uploadProfilePhoto(f, u) {
    const n = `profile_${Date.now()}.jpg`,
      r = storage.ref(`users/${u}/${n}`),
      b = await compressImageToBlob(f, 400, .8),
      up = await r.put(b);
    return await up.ref.getDownloadURL()
  }

  function compressImageToBlob(f, m = 1200, q = .8) {
    return new Promise(r => {
      const rd = new FileReader();
      rd.onload = e => {
        const i = new Image();
        i.onload = () => {
          const c = document.createElement('canvas');
          let w = i.width,
            h = i.height;
          if (w > m) {
            h = (h * m) / w;
            w = m
          }
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(i, 0, 0, w, h);
          c.toBlob(r, 'image/jpeg', q)
        };
        i.src = e.target.result
      };
      rd.readAsDataURL(f)
    })
  }

  function compressImageForPreview(f, m = 200) {
    return new Promise(r => {
      const rd = new FileReader();
      rd.onload = e => {
        const i = new Image();
        i.onload = () => {
          const c = document.createElement('canvas');
          let w = i.width,
            h = i.height;
          if (w > m) {
            h = (h * m) / w;
            w = m
          }
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(i, 0, 0, w, h);
          r(c.toDataURL('image/jpeg', .6))
        };
        i.src = e.target.result
      };
      rd.readAsDataURL(f)
    })
  }

  function selectStatus(s) {
    document.querySelectorAll('.status-option').forEach(o => o.classList.remove('active'));
    document.querySelector(`.status-option.${s}`).classList.add('active');
    document.getElementById('propStatus').value = s
  }

  // User Dropdown
  function openSideMenu() {
    if (!currentUser) { openModal('loginModal'); return; }
    // Volcar datos del usuario en la cabecera del panel
    const av = document.getElementById('mvSideAv');
    if (av) av.innerHTML = (userProfile && userProfile.profilePhoto) ? `<img src="${userProfile.profilePhoto}" alt="">` : '<i class="fas fa-user"></i>';
    const nm = document.getElementById('mvSideName'); if (nm) nm.textContent = (userProfile && userProfile.name) || 'Usuario';
    const rl = document.getElementById('mvSideRole'); if (rl) rl.textContent = isAdminUser() ? 'Administrador' : 'Agente';
    document.getElementById('mvSideAdminGroup')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSideAdmin')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSideRevisiones')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSideSolicitudes')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSide')?.classList.add('open');
    document.getElementById('mvSideOverlay')?.classList.add('open');
    document.getElementById('mvSide')?.setAttribute('aria-hidden', 'false');
  }
  function closeSideMenu() {
    document.getElementById('mvSide')?.classList.remove('open');
    document.getElementById('mvSideOverlay')?.classList.remove('open');
    document.getElementById('mvSide')?.setAttribute('aria-hidden', 'true');
  }

  // ===== Tour guiado para nuevos agentes =====
  var TOUR_STEPS = null, tourIdx = 0;
  function buildTourSteps(){
    var steps = [
      { sel:null, t:'¡Bienvenido a MALAVÉ! 👋', d:'Te muestro en un minuto las herramientas del menú. Podés saltarlo cuando quieras.' },
      { sel:'a[href="agenda.html"]', t:'Mi Agenda', d:'Agendá visitas, reuniones y entregas. Podés vincular un cliente y una propiedad a cada evento.' },
      { sel:'a[href="clientes.html"]', t:'Clientes', d:'Tu cartera de clientes. Cargá prospectos, seguí gestiones y mirá su actividad.' },
      { sel:'a[href="recompensas.html"]', t:'Recompensas', d:'Sumás puntos por cada operación cerrada y los canjeás por premios.' },
      { sel:'a[href="tasador.html"]', t:'Tasador', d:'Calculá el valor estimado de una propiedad con comparables.' },
      { sel:'a[href="mapa-cierres.html"]', t:'Mapa de cierres', d:'Mirá en el mapa las ventas y alquileres cerrados del equipo.' },
      { sel:'a[href="gastos.html"]', t:'Gastos y comisiones', d:'Calculá comisiones, gastos e impuestos de una operación.' },
      { sel:'a[href="ganancias.html"]', t:'Mis ganancias', d:'Cuánto ganás según tu comisión en cada operación.' },
      { sel:'a[href="documentos.html"]', t:'Recursos', d:'Documentos, cuentas de portales y la Academy con capacitaciones.' },
      { sel:null, t:'¡Listo! 🎉', d:'Abrí el menú ☰ cuando quieras. Podés volver a ver este recorrido tocando "Tutorial" en el menú.' }
    ];
    return steps.filter(function(s){ return !s.sel || document.querySelector(s.sel); });
  }
  function ensureTourEls(){
    if (document.getElementById('tourBlock')) return;
    var css = document.createElement('style');
    css.textContent = '#tourBlock{position:fixed;inset:0;z-index:4999;display:none}'
      + '#tourHole{position:fixed;z-index:5000;border-radius:10px;pointer-events:none;display:none;box-shadow:0 0 0 9999px rgba(16,29,48,.72);transition:all .25s ease}'
      + '#tourTip{position:fixed;z-index:5001;display:none;width:280px;max-width:86vw;background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 18px 50px rgba(16,29,48,.4)}'
      + '#tourTip h4{margin:0 0 6px;font-size:1.05rem;color:#16273f}'
      + '#tourTip p{margin:0;font-size:.88rem;color:#555;line-height:1.5}'
      + '#tourTip .tour-step{font-size:.72rem;color:#9aa3ad;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}'
      + '#tourTip .tour-actions{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:10px}'
      + '#tourTip .tour-skip{background:none;border:none;color:#9aa3ad;font-size:.85rem;cursor:pointer;padding:6px}'
      + '#tourTip .tour-next{background:var(--primary,#16273f);color:#fff;border:none;border-radius:9px;padding:9px 18px;font-size:.88rem;font-weight:600;cursor:pointer}';
    document.head.appendChild(css);
    ['tourBlock','tourHole','tourTip'].forEach(function(id){ var e=document.createElement('div'); e.id=id; document.body.appendChild(e); });
  }
  function startTour(){
    if (!currentUser) return;
    ensureTourEls();
    TOUR_STEPS = buildTourSteps();
    if (!TOUR_STEPS.length) return;
    tourIdx = 0;
    document.getElementById('tourBlock').style.display='block';
    document.getElementById('tourHole').style.display='block';
    document.getElementById('tourTip').style.display='block';
    openSideMenu();
    setTimeout(showTourStep, 380);
  }
  function endTour(){
    ['tourBlock','tourHole','tourTip'].forEach(function(id){ var e=document.getElementById(id); if(e) e.style.display='none'; });
    try { if (currentUser) localStorage.setItem('mvTourSeen_'+currentUser.uid, '1'); } catch(e){}
  }
  function nextTourStep(){ if (tourIdx >= TOUR_STEPS.length-1){ endTour(); return; } tourIdx++; showTourStep(); }
  function showTourStep(){
    var step = TOUR_STEPS[tourIdx];
    var hole = document.getElementById('tourHole'), tip = document.getElementById('tourTip');
    var last = tourIdx === TOUR_STEPS.length-1;
    tip.innerHTML = '<div class="tour-step">Paso '+(tourIdx+1)+' de '+TOUR_STEPS.length+'</div>'
      + '<h4>'+step.t+'</h4><p>'+step.d+'</p>'
      + '<div class="tour-actions"><button class="tour-skip" onclick="endTour()">Saltar</button>'
      + '<button class="tour-next" onclick="nextTourStep()">'+(last?'Terminar':'Siguiente')+'</button></div>';
    var target = step.sel ? document.querySelector(step.sel) : null;
    if (target){
      try { target.scrollIntoView({ block:'center' }); } catch(e){}
      setTimeout(function(){ positionTour(target, hole, tip); }, 60);
    } else {
      hole.style.transform='none'; hole.style.width='0'; hole.style.height='0';
      hole.style.left='50%'; hole.style.top='50%';
      tip.style.transform='translate(-50%,-50%)'; tip.style.left='50%'; tip.style.top='50%';
    }
  }
  function positionTour(target, hole, tip){
    var r = target.getBoundingClientRect(), pad = 6;
    hole.style.transform='none';
    hole.style.left=(r.left-pad)+'px'; hole.style.top=(r.top-pad)+'px';
    hole.style.width=(r.width+pad*2)+'px'; hole.style.height=(r.height+pad*2)+'px';
    var tipH = tip.offsetHeight || 150, tipW = tip.offsetWidth || 280;
    var vh = window.innerHeight, vw = window.innerWidth, top, left;
    if (r.bottom + tipH + 16 < vh){ top = r.bottom + 12; }
    else if (r.top - tipH - 16 > 0){ top = r.top - tipH - 12; }
    else { top = Math.max(12, (vh - tipH)/2); }
    left = Math.max(12, Math.min(r.left + r.width/2 - tipW/2, vw - tipW - 12));
    tip.style.transform='none'; tip.style.left=left+'px'; tip.style.top=top+'px';
  }
  function maybeStartTour(){
    if (!currentUser) return;
    var seen = false;
    try { seen = localStorage.getItem('mvTourSeen_'+currentUser.uid) === '1'; } catch(e){}
    if (!seen) setTimeout(startTour, 1200);
  }
  function mvTasador() {
    showToast('Tasador', 'La herramienta de tasación estará disponible muy pronto.', 'fa-calculator');
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSideMenu(); });

  // Event Type Selection
  function selectEventType(type) {
    selectedEventType = type;
    document.querySelectorAll('.event-type-option').forEach(o => o.classList.remove('active'));
    document.querySelector(`.event-type-option[data-type="${type}"]`).classList.add('active');
    document.getElementById('eventType').value = type
  }

  // Calendar Functions
  function openCalendarModal() {
    currentCalendarDate = getUruguayToday();
    selectedCalendarDate = getUruguayToday();
    loadVisits();
    renderCalendar();
    openModal('calendarModal')
  }
  async function loadVisits() {
    if (!currentUser) return;
    try {
      const s = await db.collection('visits').where('userId', '==', currentUser.uid).get();
      visits = s.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      renderCalendar();
      renderVisitsList();
      checkVisitReminders()
    } catch (e) {
      console.error('Error loading visits:', e)
    }
  }

  function renderCalendar() {
    if (!currentCalendarDate || isNaN(currentCalendarDate.getTime && currentCalendarDate.getTime())) {
      currentCalendarDate = getUruguayToday() || new Date();
    }
    const g = document.getElementById('calendarGrid'),
      l = document.getElementById('calendarMonth'),
      y = currentCalendarDate.getFullYear(),
      m = currentCalendarDate.getMonth(),
      mn = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    l.textContent = `${mn[m]} ${y}`;
    const f = new Date(y, m, 1),
      sd = new Date(f);
    sd.setDate(sd.getDate() - f.getDay());
    const t = getUruguayToday(),
      todayISO = formatDateToISO(t),
      selISO = formatDateToISO(selectedCalendarDate);
    let h = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map(d => `<div class="calendar-day-header">${d}</div>`).join('');
    const cd = new Date(sd);
    for (let i = 0; i < 42; i++) {
      const ds = formatDateToISO(cd),
        om = cd.getMonth() !== m,
        it = ds === todayISO,
        is = ds === selISO,
        he = visits.some(v => v.date === ds);
      let c = 'calendar-day';
      if (om) c += ' other-month';
      if (it) c += ' today';
      if (is) c += ' selected';
      if (he) c += ' has-events';
      h += `<div class="${c}" onclick="selectDate('${ds}')">${cd.getDate()}</div>`;
      cd.setDate(cd.getDate() + 1)
    }
    g.innerHTML = h
  }

  function changeMonth(d) {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + d);
    renderCalendar()
  }

  function selectDate(ds) {
    const parts = ds.split('-');
    selectedCalendarDate = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    renderCalendar();
    renderVisitsList();
    const o = {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    };
    document.getElementById('selectedDateTitle').textContent = selectedCalendarDate.toLocaleDateString('es-UY', o)
  }

  function renderVisitsList() {
    const c = document.getElementById('visitsList'),
      ds = formatDateToISO(selectedCalendarDate),
      dv = visits.filter(v => v.date === ds).sort((a, b) => a.time.localeCompare(b.time));
    if (dv.length === 0) {
      c.innerHTML = '<div class="no-visits"><i class="fas fa-calendar-check"></i><p>No hay eventos programados</p></div>';
      return
    }
    c.innerHTML = dv.map(v => {
      const p = v.propertyId ? properties.find(pr => pr.id === v.propertyId) : null;
      const h = hoursUntilEvent(v.date, v.time),
        iu = h > 0;
      const evType = v.eventType || 'visit';
      const evLabel = eventTypeLabels[evType] || 'Evento';
      const title = v.title || (p ? p.title : 'Evento');
      const reminderInfo = v.reminder24h || v.reminder2h ? `<p style="font-size:11px;color:var(--gold);margin-top:4px"><i class="fas fa-bell"></i> Recordatorio${v.reminded24h?' · 24h ✓':''}${v.reminded2h?' · 2h ✓':''}</p>` : '';
      return `<div class="visit-item ${iu?'upcoming':''} event-type-${evType}"><span class="event-type-badge ${evType}">${evLabel}</span><h4>${mvEsc(title)}</h4>${p?`<p><i class="fas fa-home"></i> ${p.title}</p>`:''}${v.clientName?`<p><i class="fas fa-user"></i> ${mvEsc(v.clientName)}</p>`:''}${v.clientPhone?`<p><i class="fas fa-phone"></i> ${v.clientPhone}</p>`:''}<div class="visit-time"><i class="fas fa-clock"></i> ${v.time}</div>${reminderInfo}${v.notes?`<p style="font-style:italic;margin-top:8px">"${mvEsc(v.notes)}"</p>`:''}<div class="visit-actions"><button class="btn-edit" onclick="editVisit('${v.id}')"><i class="fas fa-edit"></i></button><button class="btn-reject" onclick="deleteVisit('${v.id}')"><i class="fas fa-trash"></i></button>${v.clientPhone?`<button class="btn-approve" onclick="window.open('https://wa.me/${v.clientPhone.replace(/\\D/g,'')}','_blank')"><i class="fab fa-whatsapp"></i></button>`:''}</div></div>`
    }).join('')
  }

  function openVisitModal(pi = null) {
    document.getElementById('visitForm').reset();
    document.getElementById('editingVisitId').value = '';
    document.getElementById('visitModalTitle').textContent = 'Nuevo Evento';
    selectEventType('visit');
    const s = document.getElementById('visitProperty');
    const up = properties.filter(p => p.ownerId === currentUser?.uid);
    s.innerHTML = '<option value="">-- Sin propiedad asociada --</option>' + up.map(p => `<option value="${p.id}"${p.id===pi?' selected':''}>${mvEsc(p.title)}</option>`).join('');
    const today = selectedCalendarDate || getUruguayToday();
    document.getElementById('visitDate').value = formatDateToISO(today);
    document.getElementById('visitTitle').value = '';
    document.getElementById('visitClient').value = '';
    document.getElementById('visitPhone').value = '';
    document.getElementById('reminder24h').checked = true;
    document.getElementById('reminder2h').checked = true;
    openModal('visitModal')
  }

  async function handleSaveVisit(e) {
    e.preventDefault();
    if (!currentUser) {
      alert('Debes iniciar sesión');
      return
    }
    const ei = document.getElementById('editingVisitId').value;
    const pi = document.getElementById('visitProperty').value || null;
    const title = document.getElementById('visitTitle').value.trim();
    const vdate = document.getElementById('visitDate').value;
    const vtime = document.getElementById('visitTime').value;
    if (!title) {
      alert('Ingresa un título o descripción para el evento');
      return
    }
    if (!vdate || !vtime) {
      alert('Ingresa fecha y hora');
      return
    }
    const vd = {
      userId: currentUser.uid,
      propertyId: pi,
      eventType: document.getElementById('eventType').value || 'visit',
      title: title,
      clientName: document.getElementById('visitClient').value || '',
      clientPhone: document.getElementById('visitPhone').value || '',
      date: vdate,
      time: vtime,
      reminder24h: document.getElementById('reminder24h').checked,
      reminder2h: document.getElementById('reminder2h').checked,
      notes: document.getElementById('visitNotes').value || '',
      updatedAt: new Date().toISOString()
    };
    try {
      if (ei) {
        await db.collection('visits').doc(ei).update(vd);
        showToast('Evento actualizado', 'Los cambios han sido guardados', 'fa-calendar-check')
      } else {
        vd.createdAt = new Date().toISOString();
        vd.reminded24h = false;
        vd.reminded2h = false;
        await db.collection('visits').add(vd);
        showToast('Evento agendado', 'Se te recordará antes del evento', 'fa-calendar-check')
      }
      closeModal('visitModal');
      loadVisits()
    } catch (err) {
      console.error('Error saving visit:', err);
      alert('Error al guardar: ' + err.message)
    }
  }

  async function editVisit(vi) {
    const v = visits.find(vt => vt.id === vi);
    if (!v) return;
    document.getElementById('editingVisitId').value = vi;
    document.getElementById('visitModalTitle').textContent = 'Editar Evento';
    selectEventType(v.eventType || 'visit');
    document.getElementById('visitProperty').value = v.propertyId || '';
    document.getElementById('visitTitle').value = v.title || '';
    document.getElementById('visitClient').value = v.clientName || '';
    document.getElementById('visitPhone').value = v.clientPhone || '';
    document.getElementById('visitDate').value = v.date;
    document.getElementById('visitTime').value = v.time;
    document.getElementById('reminder24h').checked = v.reminder24h;
    document.getElementById('reminder2h').checked = v.reminder2h;
    document.getElementById('visitNotes').value = v.notes || '';
    openModal('visitModal')
  }
  async function deleteVisit(vi) {
    if (!confirm('¿Eliminar este evento?')) return;
    try {
      await db.collection('visits').doc(vi).delete();
      showToast('Evento eliminado', '', 'fa-trash');
      loadVisits()
    } catch (e) {
      console.error('Error deleting visit:', e)
    }
  }

  function checkVisitReminders() {
    const now = getUruguayNow();
    visits.forEach(async v => {
      const h = hoursUntilEvent(v.date, v.time);
      if (h < 0 || h > 25) return; // Ignorar eventos pasados o muy lejanos

      const evLabel = eventTypeLabels[v.eventType || 'visit'] || 'Evento';
      const title = v.title || evLabel;
      const detail = v.clientName ? ` - ${v.clientName}` : '';

      try {
        // RECORDATORIO 24H
        if (v.reminder24h && !v.reminded24h && h <= 24 && h > 2) {
          const notifTitle = '📅 Recordatorio - Mañana';
          const notifBody = `${title}${detail} · ${v.date} a las ${v.time}`;

          // Toast en la app
          showToast(notifTitle, notifBody, 'fa-calendar-alt');

          // Notificación del sistema (funciona aunque la pestaña esté en segundo plano)
          if (Notification.permission === 'granted') {
            const notif = new Notification(notifTitle, {
              body: notifBody,
              icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
              badge: 'https://cdn-icons-png.flaticon.com/128/1946/1946488.png',
              tag: 'reminder-24h-' + v.id,
              renotify: true,
              requireInteraction: true,
              vibrate: [200, 100, 200]
            });
            notif.onclick = () => {
              window.focus();
              openCalendarModal()
            };
          }

          await db.collection('visits').doc(v.id).update({
            reminded24h: true
          });
          v.reminded24h = true;
          console.log('Recordatorio 24h enviado:', title);
        }

        // RECORDATORIO 2H
        if (v.reminder2h && !v.reminded2h && h <= 2 && h > 0) {
          const mins = Math.round(h * 60);
          const notifTitle = `⏰ ¡Evento en ${mins} minutos!`;
          const notifBody = `${title}${detail} a las ${v.time}`;

          // Toast en la app
          showToast(notifTitle, notifBody, 'fa-clock');

          // Notificación del sistema
          if (Notification.permission === 'granted') {
            const notif = new Notification(notifTitle, {
              body: notifBody,
              icon: 'https://cdn-icons-png.flaticon.com/512/1946/1946488.png',
              badge: 'https://cdn-icons-png.flaticon.com/128/1946/1946488.png',
              tag: 'reminder-2h-' + v.id,
              renotify: true,
              requireInteraction: true,
              vibrate: [200, 100, 200, 100, 200],
              actions: [{
                action: 'open',
                title: 'Ver agenda'
              }]
            });
            notif.onclick = () => {
              window.focus();
              openCalendarModal()
            };
          }

          await db.collection('visits').doc(v.id).update({
            reminded2h: true
          });
          v.reminded2h = true;
          console.log('Recordatorio 2h enviado:', title);
        }
      } catch (err) {
        console.error('Error en recordatorio para', v.id, ':', err);
      }
    });
  }

  function startVisitReminderCheck() {
    if (visitReminderInterval) clearInterval(visitReminderInterval);
    checkVisitReminders();
    visitReminderInterval = setInterval(checkVisitReminders, 60000)
  }

  // Notifications
  async function loadNotifications() {
    if (!currentUser) return;
    try {
      const s = await db.collection('notifications').where('ownerId', '==', currentUser.uid).get();
      const nn = s.docs.map(d => ({
        id: d.id,
        ...d.data()
      })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 50);
      const oi = new Set(notifications.map(n => n.id)),
        bn = nn.filter(n => !oi.has(n.id) && !n.read);
      if (bn.length > 0 && notifications.length > 0) bn.forEach(n => {
        showToast('Nueva consulta', `${n.userName} consultó sobre "${n.propertyTitle}"`, 'fa-comment');
        sendBrowserNotification('Nueva consulta', `${n.userName} consultó sobre "${n.propertyTitle}"`)
      });
      notifications = nn;
      renderNotifications()
    } catch (e) {
      console.error('Error loading notifications:', e)
    }
  }

  function startNotificationPolling() {
    if (!currentUser) return;
    loadNotifications();
    if (notificationCheckInterval) clearInterval(notificationCheckInterval);
    notificationCheckInterval = setInterval(loadNotifications, 10000)
  }

  function stopNotificationPolling() {
    if (notificationCheckInterval) {
      clearInterval(notificationCheckInterval);
      notificationCheckInterval = null
    }
  }

  function renderNotifications() {
    const b = document.getElementById('notificationBadge'),
      be = document.getElementById('notificationBell'),
      l = document.getElementById('notificationList'),
      uc = notifications.filter(n => !n.read).length;
    if (uc > 0) {
      b.textContent = uc > 99 ? '99+' : uc;
      b.classList.remove('hidden');
      be.classList.add('has-unread')
    } else {
      b.classList.add('hidden');
      be.classList.remove('has-unread')
    }
    if (notifications.length === 0) {
      l.innerHTML = '<div class="notification-empty"><i class="fas fa-bell-slash"></i><p>No tienes consultas</p></div>';
      return
    }
    l.innerHTML = notifications.map(n => {
      const i = (n.userName || 'A').charAt(0).toUpperCase(),
        ts = n.createdAt ? formatTimeAgo(n.createdAt) : '';
      return `<div class="notification-item ${n.read?'':'unread'}" onclick="handleNotificationClick('${n.id}','${n.propertyId}')"><div class="notification-avatar">${n.userPhoto?`<img src="${n.userPhoto}" alt="">`:i}</div><div class="notification-body"><p><strong>${n.userName}</strong> consultó sobre <strong>${n.propertyTitle}</strong></p><div class="notification-message">"${(n.text||'').substring(0,100)}${(n.text||'').length>100?'...':''}"</div><div class="notification-meta"><span><i class="far fa-clock"></i> ${ts}</span>${n.userPhone?`<a href="https://wa.me/${n.userPhone.replace(/\D/g,'')}" target="_blank" class="notification-phone" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i> ${n.userPhone}</a>`:''}</div></div></div>`
    }).join('')
  }

  function formatTimeAgo(t) {
    const d = new Date(t),
      s = Math.floor((new Date() - d) / 1000);
    if (s < 60) return 'Ahora';
    const m = Math.floor(s / 60);
    if (m < 60) return `Hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Hace ${h}h`;
    const dy = Math.floor(h / 24);
    if (dy < 7) return `Hace ${dy} días`;
    return d.toLocaleDateString('es')
  }

  function toggleNotifications(e) {
    e.stopPropagation();
    const d = document.getElementById('notificationDropdown');
    const o = document.getElementById('notificationOverlay');
    const isOpen = d.classList.toggle('active');
    o.classList.toggle('active', isOpen);
    if (isOpen) loadNotifications()
  }

  function closeNotifications() {
    document.getElementById('notificationDropdown').classList.remove('active');
    document.getElementById('notificationOverlay').classList.remove('active')
  }
  document.addEventListener('click', e => {
    const d = document.getElementById('notificationDropdown'),
      b = document.getElementById('notificationBell');
    if (d && b && !d.contains(e.target) && !b.contains(e.target)) d.classList.remove('active')
  });
  async function handleNotificationClick(ni, pi) {
    closeNotifications();
    try {
      await db.collection('notifications').doc(ni).update({
        read: true
      });
      const n = notifications.find(nt => nt.id === ni);
      if (n) n.read = true;
      renderNotifications()
    } catch (e) {
      console.error('Error marking notification as read:', e)
    }
    openDetail(pi, true)
  }
  async function markAllAsRead(e) {
    e.stopPropagation();
    const u = notifications.filter(n => !n.read);
    if (u.length === 0) return;
    try {
      const p = u.map(n => db.collection('notifications').doc(n.id).update({
        read: true
      }));
      await Promise.all(p);
      notifications.forEach(n => n.read = true);
      renderNotifications();
      showToast('Listo', 'Todas las consultas marcadas como leídas', 'fa-check')
    } catch (e) {
      console.error('Error marking all as read:', e)
    }
  }

  // Auth
  auth.onAuthStateChanged(async u => {
    if (u) {
      const d = await db.collection('users').doc(u.uid).get();
      if (d.exists) {
        userProfile = d.data();
        if (userProfile.status === 'approved' || userProfile.email.toLowerCase() === ADMIN_EMAIL) {
          currentUser = u;
          allUsers[u.uid] = userProfile;
          updateUI();
          requestNotificationPermission();
          setupFCM();
          startNotificationPolling();
          loadVisits();
          startVisitReminderCheck();
          maybeStartTour()
        } else {
          auth.signOut();
          alert('Tu cuenta está pendiente de aprobación')
        }
      }
    } else {
      currentUser = null;
      userProfile = null;
      notifications = [];
      visits = [];
      stopNotificationPolling();
      if (visitReminderInterval) clearInterval(visitReminderInterval);
      updateUI()
    }
  });

  function updateUI() {
    const ng = document.getElementById('nav-guest'),
      nu = document.getElementById('nav-user'),
      un = document.getElementById('userName'),
      ab = document.getElementById('adminBadge'),
      abt = document.getElementById('adminBtn'),
      ua = document.getElementById('userAvatar'),
      hb = document.getElementById('heroButtons'),
      bnp = document.getElementById('btnNewProperty');
    if (currentUser && userProfile) {
      ng?.classList.add('hidden');
      nu?.classList.remove('hidden');
      hb?.classList.add('hidden');
      bnp?.classList.remove('hidden');
      if (un) un.textContent = userProfile.name || 'Usuario';
      const i = (userProfile.name || 'U').charAt(0).toUpperCase();
      if (ua) ua.innerHTML = userProfile.profilePhoto ? `<img src="${userProfile.profilePhoto}" alt="">` : i;
      if ((userProfile.email || '').toLowerCase() === ADMIN_EMAIL) {
        ab?.classList.remove('hidden');
        abt?.classList.remove('hidden')
      } else {
        ab?.classList.add('hidden');
        abt?.classList.add('hidden')
      }
      loadClients()
    } else {
      ng?.classList.remove('hidden');
      nu?.classList.add('hidden');
      hb?.classList.remove('hidden');
      bnp?.classList.add('hidden');
      clients = []
    }
  }

  let mlModalPropId = null;
  async function openMLModal(propertyId) {
    mlModalPropId = propertyId;
    openModal('mlModal');
    const body = document.getElementById('mlModalBody');
    ensureMLStyles();
    body.innerHTML = '<div class="ml-ui"><div class="ml-loading"><div class="sp"></div><p>Consultando Mercado Libre...</p></div></div>';
    try {
      const res = await firebase.functions().httpsCallable('estadoML')({ propertyId });
      if (mlModalPropId === propertyId) renderMLStatus(res.data)
    } catch (e) {
      body.innerHTML = `<div class="ml-ui"><div class="ml-err">No se pudo consultar el estado: ${e.message || e}</div></div>`
    }
  }
  // Estilos del modal de Mercado Libre (se inyectan una sola vez).
  function ensureMLStyles() {
    if (document.getElementById('mlUiStyles')) return;
    const s = document.createElement('style');
    s.id = 'mlUiStyles';
    s.textContent = `
      .ml-ui{ font-family:inherit; color:#16273f; }
      .ml-hero{ display:flex; align-items:center; gap:18px; background:linear-gradient(135deg,#16273f,#22395b); border-radius:16px; padding:18px 20px; }
      .ml-hero-info{ flex:1; min-width:0; }
      .ml-pill{ display:inline-flex; align-items:center; gap:7px; font-weight:700; font-size:.8rem; padding:5px 12px; border-radius:999px; background:rgba(255,255,255,.1); }
      .ml-pill .dot{ width:8px; height:8px; border-radius:50%; background:currentColor; box-shadow:0 0 0 3px rgba(255,255,255,.15); }
      .ml-hero h4{ margin:10px 0 2px; font-size:1.16rem; color:#fff; font-weight:700; }
      .ml-hero .sub{ font-size:.8rem; color:#aeb8c6; }
      .ml-ring{ flex:0 0 auto; position:relative; width:64px; height:64px; }
      .ml-ring .pct{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:.85rem; font-weight:800; color:#fff; }
      .ml-section{ margin-top:14px; }
      .ml-note{ display:flex; align-items:flex-start; gap:10px; border-radius:12px; padding:12px 14px; font-size:.89rem; line-height:1.5; }
      .ml-note.ok{ background:#eaf7f0; color:#157a52; }
      .ml-note.ok i{ color:#1e9e6a; margin-top:2px; }
      .ml-note.warn{ background:#fff6e8; color:#8a5a00; border:1px solid #ffe2b0; }
      .ml-note.warn i{ color:#e0892a; margin-top:2px; }
      .ml-improve-title{ font-weight:700; font-size:.92rem; margin:4px 2px 8px; color:#16273f; }
      .ml-improve{ list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:8px; }
      .ml-improve li{ display:flex; align-items:flex-start; gap:10px; background:#f6f8fa; border-radius:10px; padding:10px 12px; font-size:.86rem; color:#3a4658; }
      .ml-improve li i{ color:#C9A227; margin-top:3px; }
      .ml-stats{ display:flex; gap:10px; flex-wrap:wrap; }
      .ml-stat{ flex:1 1 130px; min-width:130px; display:flex; align-items:center; gap:11px; background:#f6f8fa; border-radius:12px; padding:13px 14px; }
      .ml-stat i{ font-size:1.2rem; flex:0 0 auto; }
      .ml-stat .n{ font-weight:800; font-size:1.25rem; color:#16273f; line-height:1; }
      .ml-stat .t{ font-size:.76rem; color:#6a7280; margin-top:3px; }
      .ml-label{ font-size:.74rem; letter-spacing:.04em; color:#8a93a0; font-weight:600; text-transform:uppercase; margin-bottom:7px; }
      .ml-select{ width:100%; padding:12px 13px; border:1.5px solid #e2e6ea; border-radius:11px; font-family:inherit; font-size:.95rem; color:#16273f; background:#fff; }
      .ml-select:focus{ outline:none; border-color:#C9A227; }
      .ml-btns{ display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }
      .ml-btn{ flex:1; min-width:130px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:13px 16px; border-radius:12px; font-family:inherit; font-size:.92rem; font-weight:700; cursor:pointer; border:1.5px solid transparent; text-decoration:none; transition:transform .06s, background .2s, border-color .2s; }
      .ml-btn:active{ transform:translateY(1px); }
      .ml-btn-primary{ background:#C9A227; color:#16273f; }
      .ml-btn-primary:hover{ background:#b8941f; }
      .ml-btn-ghost{ background:#fff; border-color:#dce0e5; color:#16273f; }
      .ml-btn-ghost:hover{ border-color:#16273f; }
      .ml-btn-danger{ background:#fff; border-color:#f0c7c7; color:#c0392b; }
      .ml-btn-danger:hover{ background:#fdeced; }
      .ml-empty{ text-align:center; padding:8px 4px 4px; }
      .ml-empty-ic{ width:72px; height:72px; border-radius:50%; margin:0 auto 14px; display:flex; align-items:center; justify-content:center; font-size:1.7rem; background:linear-gradient(135deg,#16273f,#22395b); color:#ffd400; }
      .ml-empty h4{ font-size:1.12rem; margin:0 0 6px; color:#16273f; }
      .ml-empty p{ font-size:.9rem; color:#6a7280; margin:0; line-height:1.5; }
      .ml-err{ background:#fdeced; color:#c0392b; border-radius:10px; padding:11px 14px; font-size:.86rem; line-height:1.45; margin:12px 0; }
      .ml-loading{ text-align:center; padding:40px 20px; }
      .ml-loading .sp{ width:46px; height:46px; border-radius:50%; border:3px solid #eef0f3; border-top-color:#C9A227; margin:0 auto 14px; animation:mlspin .8s linear infinite; }
      .ml-loading p{ color:#8a93a0; font-size:.9rem; margin:0; }
      @keyframes mlspin{ to{ transform:rotate(360deg); } }
    `;
    document.head.appendChild(s);
  }
  // Anillo circular de calidad del aviso.
  function mlRing(pct, color) {
    const r = 26, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    return `<div class="ml-ring"><svg width="64" height="64" viewBox="0 0 64 64">` +
      `<circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="6"/>` +
      `<circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 32 32)"/>` +
      `</svg><div class="pct">${pct}%</div></div>`;
  }
  function mlListingTypeName(lt) {
    const m = { free: 'Gratuita', bronze: 'Bronce', silver: 'Plata', gold: 'Oro', gold_special: 'Clásica', gold_pro: 'Premium', gold_premium: 'Premium' };
    return m[lt] || lt || '—'
  }
  function mlStatusName(st) {
    const m = { active: 'Activa', paused: 'Pausada', closed: 'Finalizada', under_review: 'En revisión', inactive: 'Inactiva', payment_required: 'Pendiente de pago' };
    return m[st] || st || '—'
  }
  function mlActionText(a) {
    const m = {
      technical_specification: 'Completá más características del inmueble (ficha técnica).',
      pictures: 'Agregá más fotos o mejorá su calidad.',
      picture_quality: 'Mejorá la calidad de las fotos.',
      description: 'Ampliá la descripción del aviso.',
      title: 'Mejorá el título del aviso.',
      video: 'Agregá un video al aviso.',
      product_identifiers: 'Completá los identificadores del producto.',
      variations: 'Agregá variaciones al aviso.',
      buybox: 'Sumá el aviso al catálogo.',
      premium: 'Subí el aviso a un nivel superior para más exposición.',
      installments_free: 'Subí el aviso a un nivel superior para más exposición.'
    };
    return m[a] || a.replace(/_/g, ' ')
  }
  // Selector del tipo de aviso: gratuita por defecto cuando existe; los tipos
  // pagos los elige el agente a mano y se abonan en Mercado Libre.
  function mlTypeSelector(tipos) {
    const lista = (tipos && tipos.length ? tipos : ['free', 'bronze', 'silver', 'gold']);
    const opts = lista.map(t => `<option value="${t}">${mlListingTypeName(t)}${t === 'free' ? ' — sin costo' : ' — paga (se abona en Mercado Libre)'}</option>`).join('');
    const aviso = lista.includes('free') ? '' : `<div class="ml-note warn" style="margin-top:8px"><i class="fas fa-circle-info"></i><div>Esta categoría no tiene aviso gratis, o ya usaste tu cupo de avisos gratis. Es normal en inmuebles: elegí un tipo de aviso pago.</div></div>`;
    return `<div class="ml-label">Tipo de aviso</div><select id="mlTipoAviso" class="ml-select">${opts}</select>${aviso}`;
  }
  function renderMLStatus(d) {
    ensureMLStyles();
    const body = document.getElementById('mlModalBody');
    if (!d.publicado) {
      const _esCupo = d.error && /avisos? gratis|gratuita|cupo/i.test(d.error);
      const _errHtml = d.error
        ? (_esCupo
            ? `<div class="ml-note warn" style="margin-top:8px"><i class="fas fa-circle-info"></i><div>${d.error}</div></div>`
            : `<div class="ml-err">${d.error}</div>`)
        : '';
      body.innerHTML = `<div class="ml-ui"><div class="ml-empty"><div class="ml-empty-ic"><i class="fas fa-tag"></i></div><h4>Todavía no está publicada</h4><p>Esta propiedad aún no está en Mercado Libre.</p></div>${_errHtml}<div class="ml-section">${mlTypeSelector(d.tiposDisponibles)}</div><div class="ml-btns"><button class="ml-btn ml-btn-primary" onclick="republicarPropiedad()"><i class="fas fa-upload"></i> Publicar en Mercado Libre</button></div></div>`;
      return
    }
    if (d.error) {
      body.innerHTML = `<div class="ml-ui"><div class="ml-err">${d.error}</div><div class="ml-btns"><button class="ml-btn ml-btn-primary" onclick="republicarPropiedad()"><i class="fas fa-rotate-right"></i> Volver a publicar</button></div></div>`;
      return
    }
    const hp = d.health != null ? Math.round(d.health * 100) : null;
    const ringColor = hp == null ? '#aeb8c6' : (hp >= 70 ? '#3ddc97' : hp >= 40 ? '#f5b54a' : '#ff7a7a');
    const stColors = { active: '#3ddc97', paused: '#f5b54a', closed: '#ff7a7a', under_review: '#f5b54a', inactive: '#aeb8c6', payment_required: '#f5b54a' };
    const pillColor = stColors[d.status] || '#aeb8c6';
    const hero = `<div class="ml-hero">${hp != null ? mlRing(hp, ringColor) : ''}<div class="ml-hero-info"><span class="ml-pill" style="color:${pillColor}"><span class="dot"></span>${mlStatusName(d.status)}</span><h4>${mlListingTypeName(d.listingType)}</h4><div class="sub">${hp != null ? 'Calidad del aviso ' + hp + '%' : 'Aviso publicado en Mercado Libre'}</div></div></div>`;
    const _dash = (v) => (v != null ? v : '—');
    const _pregN = (d.preguntas && d.preguntas.total != null) ? d.preguntas.total : null;
    const _pregSR = (d.preguntas && d.preguntas.sinResponder) ? ` · ${d.preguntas.sinResponder} sin responder` : '';
    const interaccion = `<div class="ml-section"><div class="ml-stats"><div class="ml-stat"><i class="fas fa-eye" style="color:#1e9e6a"></i><div><div class="n">${_dash(d.visitas)}</div><div class="t">visitas · 30 días</div></div></div><div class="ml-stat"><i class="fas fa-circle-question" style="color:#2e86de"></i><div><div class="n">${_dash(_pregN)}</div><div class="t">preguntas${_pregSR}</div></div></div><div class="ml-stat"><i class="fab fa-whatsapp" style="color:#25d366"></i><div><div class="n">${_dash(d.contactosWhatsapp)}</div><div class="t">contactos WhatsApp · 30 días</div></div></div></div></div>`;
    const pagoHint = d.status === 'payment_required' ? `<div class="ml-section"><div class="ml-note warn"><i class="fas fa-circle-info"></i><div>El aviso está creado pero Mercado Libre exige pagar el tipo <strong>${mlListingTypeName(d.listingType)}</strong> para activarlo (se abona desde tu cuenta de ML, sección Publicaciones). Si no querés pagarlo, dale <strong>Dar de baja</strong> y volvé a publicarlo eligiendo otro tipo. Mientras no lo pagues, no se cobra nada.</div></div></div>` : '';
    // Qué falta para el 100%: lo MÁS confiable es comparar los atributos de la
    // categoría contra los que el aviso tiene cargados (d.faltan, lo calcula el
    // backend y NO depende de la calidad de ML). Si por algo no viene, caemos al
    // detalle de /performance, después a /health, y por último a fotos/descripción.
    let improve;
    const _faltan = Array.isArray(d.faltan) ? d.faltan : [];
    if (_faltan.length) {
      const reqs = _faltan.filter(x => x && x.req).map(x => x.nombre);
      const opts = _faltan.filter(x => x && !x.req).map(x => x.nombre);
      const CAP = 14;
      let h = '<div class="ml-section">';
      if (reqs.length) {
        h += '<div class="ml-improve-title">Datos obligatorios sin completar</div><ul class="ml-improve">'
          + reqs.map(n => `<li><i class="fas fa-triangle-exclamation" style="color:#e8a33d"></i><span>${mvEsc(n)}</span></li>`).join('')
          + '</ul>';
      }
      if (opts.length) {
        const shown = opts.slice(0, CAP), rest = opts.length - shown.length;
        h += `<div class="ml-improve-title"${reqs.length ? ' style="margin-top:10px"' : ''}>Completá estos datos para subir la calidad</div><ul class="ml-improve">`
          + shown.map(n => `<li><i class="fas fa-arrow-up"></i><span>${mvEsc(n)}</span></li>`).join('')
          + (rest > 0 ? `<li style="opacity:.65"><i class="fas fa-ellipsis-h"></i><span>y ${rest} dato${rest === 1 ? '' : 's'} m\u00e1s</span></li>` : '')
          + '</ul>';
      }
      h += '<div style="font-size:.8rem;color:#8a7a45;margin-top:8px;line-height:1.4">Completalos en <strong>Editar propiedad</strong> y guard\u00e1: se actualizan solos en Mercado Libre.</div></div>';
      improve = h;
    } else {
      let _mej = [];
      const _vis = new Set();
      if (d.mejoras && d.mejoras.length) {
        d.mejoras.forEach(m => { const t = ((m && m.titulo) || '').trim(); if (t && !_vis.has(t)) { _vis.add(t); _mej.push(t); } });
      } else if (d.actions && d.actions.length) {
        d.actions.forEach(a => { const t = mlActionText(a); if (t && !_vis.has(t)) { _vis.add(t); _mej.push(t); } });
      }
      const acc = _mej.map(t => `<li><i class="fas fa-arrow-up"></i><span>${mvEsc(t)}</span></li>`).join('');
      if (acc) {
        improve = `<div class="ml-section"><div class="ml-improve-title">Para llegar al 100%, completá:</div><ul class="ml-improve">${acc}</ul></div>`;
      } else if (hp != null && hp < 99) {
        improve = `<div class="ml-section"><div class="ml-note warn"><i class="fas fa-circle-info"></i><div>Sum\u00e1 <strong>m\u00e1s fotos</strong> (al menos 12) y una <strong>descripci\u00f3n</strong> m\u00e1s completa para subir la calidad.</div></div></div>`;
      } else {
        improve = `<div class="ml-section"><div class="ml-note ok"><i class="fas fa-circle-check"></i><div>El aviso est\u00e1 completo, sin mejoras pendientes.</div></div></div>`;
      }
    }
    const selTipo = d.status === 'closed' ? `<div class="ml-section">${mlTypeSelector(d.tiposDisponibles)}</div>` : '';
    const botones = [];
    if (d.permalink) botones.push(`<a href="${d.permalink}" target="_blank" rel="noopener" class="ml-btn ml-btn-ghost"><i class="fas fa-external-link-alt"></i> Ver aviso</a>`);
    if (d.status === 'paused' || d.status === 'closed') botones.push(`<button class="ml-btn ml-btn-primary" onclick="republicarPropiedad()"><i class="fas fa-rotate-right"></i> Republicar</button>`);
    if (d.status !== 'closed') botones.push(`<button class="ml-btn ml-btn-danger" onclick="bajaPropiedad()"><i class="fas fa-circle-stop"></i> Dar de baja</button>`);
    const _dbg = Array.isArray(d.debugMetricas) ? d.debugMetricas : [];
    const debugHtml = _dbg.length ? `<div class="ml-section" style="font-size:.68rem;color:#5a6573;font-family:monospace;word-break:break-all;background:#f3f4f6;border:1px dashed #c4ccd6;border-radius:8px;padding:8px"><div style="font-weight:bold;margin-bottom:4px;color:#16273f">debug métricas (temporal):</div>${_dbg.map(x => '<div>'+mvEsc(x)+'</div>').join('')}</div>` : '';
    body.innerHTML = `<div class="ml-ui">${hero}${interaccion}${pagoHint}${improve}${debugHtml}${selTipo}<div class="ml-btns">${botones.join('')}</div></div>`
  }
  async function republicarPropiedad() {
    if (!mlModalPropId) return;
    const sel = document.getElementById('mlTipoAviso');
    const listingType = sel ? sel.value : null;
    const id = mlModalPropId, body = document.getElementById('mlModalBody');
    ensureMLStyles();
    body.innerHTML = '<div class="ml-ui"><div class="ml-loading"><div class="sp"></div><p>Publicando en Mercado Libre...</p></div></div>';
    try {
      await firebase.functions().httpsCallable('republicarML')({ propertyId: id, listingType });
      showToast('Mercado Libre', 'El aviso se envió a Mercado Libre', 'fa-tag');
      openMLModal(id)
    } catch (e) {
      body.innerHTML = `<div class="ml-ui"><div class="ml-err">No se pudo publicar: ${e.message || e}</div><div class="ml-btns"><button class="ml-btn ml-btn-ghost" onclick="openMLModal('${id}')"><i class="fas fa-rotate-right"></i> Reintentar</button></div></div>`
    }
  }
  async function bajaPropiedad() {
    if (!mlModalPropId) return;
    if (!confirm('¿Dar de baja este aviso en Mercado Libre? Vas a poder volver a publicarlo después.')) return;
    const id = mlModalPropId, body = document.getElementById('mlModalBody');
    ensureMLStyles();
    body.innerHTML = '<div class="ml-ui"><div class="ml-loading"><div class="sp"></div><p>Dando de baja...</p></div></div>';
    try {
      await firebase.functions().httpsCallable('bajaML')({ propertyId: id });
      showToast('Mercado Libre', 'El aviso se dio de baja', 'fa-tag');
      openMLModal(id)
    } catch (e) {
      body.innerHTML = `<div class="ml-ui"><div class="ml-err">No se pudo dar de baja: ${e.message || e}</div></div>`
    }
  }

  // ===== Cuentas de portales: credenciales compartidas de la inmobiliaria =====
  let portalAccounts = [];
  async function openPortalAccounts() {
    document.getElementById('userDropdown')?.classList.remove('active');
    if (!currentUser) { openModal('loginModal'); return }
    openModal('portalAccountsModal');
    document.getElementById('btnAddPortal').classList.toggle('hidden', !isAdminUser());
    const list = document.getElementById('portalAccountsList');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-500,#888)"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      const q = await db.collection('portalAccounts').get();
      portalAccounts = q.docs.map(d => ({ id: d.id, ...d.data() }));
      renderPortalAccounts()
    } catch (e) {
      list.innerHTML = '<p style="color:#c0392b">No se pudieron cargar las cuentas.</p>'
    }
  }
  function renderPortalAccounts() {
    const list = document.getElementById('portalAccountsList'), admin = isAdminUser();
    const escA = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escH = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!portalAccounts.length) {
      list.innerHTML = `<p style="color:var(--gray-500,#888);text-align:center;padding:16px">Todavía no hay cuentas cargadas.${admin ? ' Agregá la primera con el botón de abajo.' : ''}</p>`;
      return;
    }
    // Ícono por defecto según categoría (SVG mask para el encabezado de cada grupo)
    const CATS = [
      { key: 'portal', label: 'Portales inmobiliarios', ic: 'M3 9l9-7 9 7v11a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z' },
      { key: 'herramienta', label: 'Herramientas', ic: 'M14 6l-1-1a3 3 0 00-4 4l1 1-6 6v3h3l6-6 1 1a3 3 0 004-4z' },
      { key: 'otro', label: 'Otros', ic: 'M4 6h16M4 12h16M4 18h16' }
    ];
    const iconFor = a => {
      const c = a.category || 'portal';
      if (c === 'herramienta') return 'fa-toolbox';
      if (c === 'otro') return 'fa-circle-nodes';
      return 'fa-building';
    };
    const card = a => `<div class="mv-pa-card">
      <div class="mv-pa-top"><div class="mv-pa-ic"><i class="fas ${iconFor(a)}"></i></div>
        <div class="mv-pa-name"><strong>${escH(a.name) || 'Cuenta'}</strong><span>${escH(a.subtitle || (a.category === 'herramienta' ? 'Herramienta' : a.category === 'otro' ? 'Cuenta' : 'Portal inmobiliario'))}</span></div>
        ${a.url ? `<a href="${escA(a.url)}" target="_blank" rel="noopener" class="mv-pa-open"><i class="fas fa-external-link-alt"></i> Abrir</a>` : ''}</div>
      <div class="mv-pa-row"><label>Usuario</label><code id="user-${a.id}" data-val="${escA(a.user)}">${escH(a.user) || '—'}</code><button class="mv-pa-mini" onclick="copyText(document.getElementById('user-${a.id}').dataset.val,event)" title="Copiar"><i class="fas fa-copy"></i></button></div>
      <div class="mv-pa-row"><label>Contraseña</label><code id="pass-${a.id}" data-val="${escA(a.password)}">••••••••••</code><button class="mv-pa-mini" onclick="togglePortalPass('${a.id}')" title="Mostrar/ocultar"><i class="fas fa-eye"></i></button><button class="mv-pa-mini" onclick="copyText(document.getElementById('pass-${a.id}').dataset.val,event)" title="Copiar"><i class="fas fa-copy"></i></button></div>
      ${a.notes ? `<p style="font-size:.82rem;color:var(--gray-600,#666);margin-top:8px">${escH(a.notes)}</p>` : ''}
      ${admin ? `<div class="mv-pa-actions"><button class="ed" onclick="openEditPortal('${a.id}')"><i class="fas fa-edit"></i> Editar</button><button class="de" onclick="deletePortalAccount('${a.id}')"><i class="fas fa-trash"></i> Eliminar</button></div>` : ''}
    </div>`;
    let html = '';
    CATS.forEach(cat => {
      const items = portalAccounts.filter(a => (a.category || 'portal') === cat.key);
      if (!items.length) return;
      html += `<div class="mv-pa-cat" style="--mv-cat-ic:url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='${cat.ic}'/%3E%3C/svg%3E&quot;)">${cat.label}</div>`;
      html += items.map(card).join('');
    });
    list.innerHTML = html;
  }
  function togglePortalPass(id) {
    const el = document.getElementById('pass-' + id);
    if (!el) return;
    const masked = '•'.repeat(10); el.textContent = (el.textContent === masked) ? (el.dataset.val || '') : masked
  }
  function copyText(t, ev) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => {
      if (ev && ev.currentTarget) { const i = ev.currentTarget.querySelector('i'); if (i) { const o = i.className; i.className = 'fas fa-check'; setTimeout(() => { i.className = o }, 1200) } }
    }).catch(() => {})
  }
  function openEditPortal(id) {
    if (!isAdminUser()) return;
    const a = id ? portalAccounts.find(x => x.id === id) : null;
    document.getElementById('portalEditId').value = id || '';
    document.getElementById('editPortalTitle').textContent = a ? 'Editar cuenta' : 'Nueva cuenta';
    document.getElementById('portalCategory').value = a ? (a.category || 'portal') : 'portal';
    document.getElementById('portalName').value = a ? (a.name || '') : '';
    document.getElementById('portalUrl').value = a ? (a.url || '') : '';
    document.getElementById('portalUser').value = a ? (a.user || '') : '';
    document.getElementById('portalPass').value = a ? (a.password || '') : '';
    document.getElementById('portalNotes').value = a ? (a.notes || '') : '';
    openModal('editPortalModal')
  }
  async function savePortalAccount() {
    if (!isAdminUser()) return;
    const id = document.getElementById('portalEditId').value;
    const data = {
      category: document.getElementById('portalCategory').value,
      name: document.getElementById('portalName').value.trim(),
      url: document.getElementById('portalUrl').value.trim(),
      user: document.getElementById('portalUser').value.trim(),
      password: document.getElementById('portalPass').value,
      notes: document.getElementById('portalNotes').value.trim(),
      updatedAt: new Date().toISOString()
    };
    if (!data.name) { alert('Poné un nombre para el portal.'); return }
    try {
      if (id) await db.collection('portalAccounts').doc(id).update(data);
      else await db.collection('portalAccounts').add(data);
      closeModal('editPortalModal');
      const q = await db.collection('portalAccounts').get();
      portalAccounts = q.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!document.getElementById('portalAccountsPage')?.classList.contains('hidden')) renderPortalAccountsPage();
      else openPortalAccounts();
    } catch (e) {
      alert('No se pudo guardar: ' + (e.message || e))
    }
  }
  async function deletePortalAccount(id) {
    if (!isAdminUser()) return;
    if (!confirm('¿Eliminar esta cuenta de portal?')) return;
    try {
      await db.collection('portalAccounts').doc(id).delete();
      portalAccounts = portalAccounts.filter(x => x.id !== id);
      if (!document.getElementById('portalAccountsPage')?.classList.contains('hidden')) renderPortalAccountsPage();
      else openPortalAccounts();
    } catch (e) {
      alert('No se pudo eliminar: ' + (e.message || e))
    }
  }

  function openModal(i) {
    document.getElementById(i).classList.add('active');
    if (i === 'loginModal') loadRememberedUser()
  }

  function closeModal(i) {
    document.getElementById(i).classList.remove('active')
  }

  function switchModal(f, t) {
    closeModal(f);
    setTimeout(() => openModal(t), 200)
  }

  function openPropertyModal(pi = null) {
    resetPropertyForm();
    if (pi) {
      const p = properties.find(pr => pr.id === pi);
      if (p) loadPropertyForEdit(p)
    } else {
      if (userProfile && userProfile.whatsapp) document.getElementById('propWhatsapp').value = userProfile.whatsapp
    }
    openModal('propertyModal')
  }

  function loadPropertyForEdit(p) {
    document.getElementById('propertyModalTitle').textContent = 'Editar Propiedad';
    document.getElementById('propertyBtn').innerHTML = '<i class="fas fa-save"></i> Guardar Cambios';
    document.getElementById('editingPropertyId').value = p.id;
    document.getElementById('previousPrice').value = p.price || '';
    document.getElementById('propTitle').value = p.title || '';
    document.getElementById('propDepartamento').value = p.departamento || '';
    updateCiudades();
    setTimeout(() => {
      document.getElementById('propCiudad').value = p.ciudad || ''
    }, 100);
    document.getElementById('propDireccion').value = p.direccion || '';
    document.getElementById('propPrice').value = p.price || '';
    document.getElementById('propCurrency').value = p.currency || 'USD';
    document.getElementById('propType').value = p.type || 'sale';
    togglePropertyType();
    document.getElementById('propPropertyType').value = p.propertyType || 'common';
    document.getElementById('propBedrooms').value = p.bedrooms || '';
    document.getElementById('propBathrooms').value = p.bathrooms || '';
    document.getElementById('propTotalArea').value = p.totalArea || '';
    document.getElementById('propBuiltArea').value = p.builtArea || '';
    document.getElementById('propExpenses').value = p.commonExpenses || '';
    document.getElementById('propGarage').value = p.garage || 'no';
    document.getElementById('propDescription').value = p.description || '';
    document.getElementById('propWhatsapp').value = p.ownerWhatsapp || '';
    selectStatus(p.status || 'available');
    if (p.images && p.images.length > 0) {
      selectedImages = p.images.map(url => ({
        preview: url,
        url: url,
        existing: true
      }));
      renderImagePreviews()
    }
  }

  function editCurrentProperty() {
    if (currentDetailProperty) {
      closeModal('detailModal');
      openPropertyFormTab(currentDetailProperty.id)
    }
  }

  function togglePropertyType() {
    document.getElementById('propertyTypeGroup').style.display = document.getElementById('propType').value === 'rent' ? 'none' : 'block'
  }
  async function handleLogin(e) {
    e.preventDefault();
    const b = document.getElementById('loginBtn'),
      er = document.getElementById('loginError'),
      em = document.getElementById('loginEmail').value,
      r = document.getElementById('rememberMe').checked;
    b.disabled = true;
    b.textContent = 'Iniciando...';
    er.classList.add('hidden');
    try {
      await auth.signInWithEmailAndPassword(em, document.getElementById('loginPassword').value);
      if (r) localStorage.setItem('rememberedEmail', em);
      else localStorage.removeItem('rememberedEmail');
      closeModal('loginModal');
      document.getElementById('loginEmail').value = '';
      document.getElementById('loginPassword').value = ''
    } catch (err) {
      er.textContent = 'Correo o contraseña incorrectos';
      er.classList.remove('hidden')
    } finally {
      b.disabled = false;
      b.textContent = 'Iniciar Sesión'
    }
  }
  // Traduce los códigos de error de Firebase Auth a mensajes claros.
  function mensajeErrorAuth(err) {
    switch (err && err.code) {
      case 'auth/email-already-in-use': return 'Este correo ya está registrado.';
      case 'auth/invalid-email': return 'El correo no es válido.';
      case 'auth/weak-password': return 'La contraseña es muy débil (mínimo 6 caracteres).';
      case 'auth/network-request-failed': return 'Falló la conexión. Revisá tu internet y reintentá.';
      default: return (err && err.message) || 'No se pudo crear la cuenta.';
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    const b = document.getElementById('registerBtn'),
      er = document.getElementById('registerError'),
      su = document.getElementById('registerSuccess'),
      nm = document.getElementById('registerName').value.trim(),
      em = document.getElementById('registerEmail').value.trim(),
      wh = document.getElementById('registerWhatsapp').value.trim(),
      ig = document.getElementById('registerInstagram').value.trim(),
      pw = document.getElementById('registerPassword').value,
      cf = document.getElementById('registerConfirm').value;
    er.classList.add('hidden');
    su.classList.add('hidden');
    if (!nm || !em) {
      er.textContent = 'Completá tu nombre y correo.';
      er.classList.remove('hidden');
      return
    }
    if (pw !== cf) {
      er.textContent = 'Las contraseñas no coinciden';
      er.classList.remove('hidden');
      return
    }
    b.disabled = true;
    b.textContent = 'Creando...';

    // PASO 1 — crear la cuenta de Firebase Auth.
    let uc;
    try {
      uc = await auth.createUserWithEmailAndPassword(em, pw);
    } catch (err) {
      er.textContent = mensajeErrorAuth(err);
      er.classList.remove('hidden');
      b.disabled = false;
      b.textContent = 'Crear Cuenta';
      return
    }

    // PASO 2 — escribir el perfil en Firestore. Si falla, NO dejamos la cuenta
    // de Auth huérfana: la borramos para que el correo quede libre y se pueda
    // volver a registrar sin el error "este correo ya está registrado".
    try {
      const ia = em.toLowerCase() === ADMIN_EMAIL;
      const ud = {
        uid: uc.user.uid,
        email: em,
        name: nm,
        whatsapp: wh,
        status: ia ? 'approved' : 'pending',
        createdAt: new Date().toISOString()
      };
      if (ig && ig.includes('instagram.com')) ud.instagram = ig;
      await db.collection('users').doc(uc.user.uid).set(ud);
      await auth.signOut();
      document.getElementById('registerForm').reset();
      su.textContent = ia ? '¡Cuenta admin creada!' : '¡Cuenta creada! Espera aprobación.';
      su.classList.remove('hidden')
    } catch (err) {
      // Revertimos: borramos la cuenta recién creada (o al menos cerramos sesión).
      try { await uc.user.delete(); }
      catch (delErr) { try { await auth.signOut(); } catch (e2) {} }
      console.error('Registro: falló la escritura del perfil en Firestore:', err);
      er.textContent = 'No se pudo guardar tu perfil: ' + ((err && err.message) || err) +
        '. Si el problema persiste, avisale al administrador. Probá de nuevo.';
      er.classList.remove('hidden')
    } finally {
      b.disabled = false;
      b.textContent = 'Crear Cuenta'
    }
  }

  function logout() {
    auth.signOut();
    showHome();
    document.getElementById('userDropdown')?.classList.remove('active')
  }
  async function handleProfilePhotoChange(e) {
    const f = e.target.files[0];
    if (!f || !currentUser) return;
    try {
      showToast('Subiendo foto...', 'Por favor espera', 'fa-spinner');
      const pu = await uploadProfilePhoto(f, currentUser.uid);
      await db.collection('users').doc(currentUser.uid).update({
        profilePhoto: pu
      });
      userProfile.profilePhoto = pu;
      allUsers[currentUser.uid].profilePhoto = pu;
      updateUI();
      document.getElementById('profileAvatar').innerHTML = `<img src="${pu}" alt="">`;
      showToast('Perfil actualizado', 'Tu foto ha sido actualizada', 'fa-check')
    } catch (err) {
      console.error('Error uploading profile photo:', err);
      alert('Error al actualizar foto: ' + err.message)
    }
  }

  // Properties
  function loadProperties() {
    db.collection('properties').orderBy('createdAt', 'desc').onSnapshot(s => {
      properties = s.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      renderProperties(properties);
      updateStats()
    })
  }

  function getUserInfo(ui) {
    return allUsers[ui] || {
      name: 'Usuario',
      profilePhoto: null
    }
  }

  // Datos del agente dueño de una propiedad. Usa el perfil cargado (allUsers) y,
  // si no está disponible, cae en los datos guardados en la propiedad.
  function getOwnerInfo(p) {
    const u = allUsers[p.ownerId] || {};
    return {
      ...u,
      name: u.name || p.ownerName || 'Usuario',
      profilePhoto: u.profilePhoto || p.ownerPhoto || null,
      whatsapp: u.whatsapp || p.ownerWhatsapp || null
    }
  }

  function formatPrice(p, c) {
    return `${c==='UYU'?'$U':'US$'} ${(p||0).toLocaleString()}`
  }

  function getLocationString(p) {
    return p.ciudad && p.departamento ? `${p.ciudad}, ${p.departamento}` : p.location || 'Uruguay'
  }

  function canEditProperty(p) {
    return currentUser && (currentUser.uid === p.ownerId || userProfile?.email?.toLowerCase() === ADMIN_EMAIL)
  }

  function renderProperties(ps, tg = 'propertiesGrid') {
    if (tg === 'propertiesGrid') { try { mvSetHeroPhoto(ps); } catch (e) { /* hero sin foto */ } }
    const g = document.getElementById(tg),
      ld = document.getElementById('propertiesLoading'),
      ct = document.getElementById('propertiesCount');
    if (ld) ld.classList.add('hidden');
    if (ct) ct.textContent = `${ps.length} propiedades encontradas`;
    if (ps.length === 0) {
      g.innerHTML = '<p style="text-align:center;color:var(--gray-500);grid-column:1/-1;padding:60px">No hay propiedades disponibles</p>';
      return
    }
    // Ordenar: 1) Destacadas disponibles, 2) Disponibles, 3) Reservadas/Vendidas/Alquiladas, 4) Archivadas
    const statusPriority = {
      available: 1,
      reserved: 2,
      sold: 3,
      rented: 4,
      archived: 5
    };
    const sorted = [...ps].sort((a, b) => {
      const stA = a.status || 'available',
        stB = b.status || 'available';
      const prioA = statusPriority[stA] || 1,
        prioB = statusPriority[stB] || 1;
      const aFeat = a.featured && stA === 'available' ? 0 : 1;
      const bFeat = b.featured && stB === 'available' ? 0 : 1;
      if (aFeat !== bFeat) return aFeat - bFeat;
      if (prioA !== prioB) return prioA - prioB;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    g.innerHTML = sorted.map(p => {
      const o = getOwnerInfo(p),
        oi = (o.name || 'U').charAt(0).toUpperCase(),
        c = p.currency || 'USD',
        l = getLocationString(p),
        ce = canEditProperty(p),
        hi = o.instagram && o.instagram.includes('instagram.com'),
        st = p.status || 'available',
        hop = p.previousPrice && p.previousPrice > p.price,
        pdp = hop ? Math.round((1 - p.price / p.previousPrice) * 100) : 0,
        isFeatured = p.featured && st === 'available';
      const stLabels = {
        reserved: 'RESERVADA',
        sold: 'VENDIDA',
        rented: 'ALQUILADA',
        archived: 'ARCHIVADA'
      };
      const stLabel = stLabels[st] || '';
      return `<div class="property-card ${st!=='available'?`status-${st}`:''} ${isFeatured?'featured':''}" onclick="openPropertyTab('${p.id}')"><div class="card-image"><img src="${p.images?.[0]||'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800'}" alt="${mvEsc(p.title)}" loading="lazy">${st!=='available'?`<div class="property-status-overlay ${st}"><div class="status-ribbon ${st}">${stLabel}</div></div>`:''}<div class="card-badges">${isFeatured?'<span class="badge badge-featured"><i class="fas fa-star"></i> DESTACADA</span>':''}<span class="badge ${p.type==='sale'?'badge-sale':'badge-rent'}">${p.type==='sale'?'VENTA':'ALQUILER'}</span>${p.type==='sale'&&p.propertyType==='ph'?'<span class="badge badge-ph">PH</span>':''}${c==='UYU'?'<span class="badge badge-currency">UYU</span>':''}${p.garage==='yes'?'<span class="badge badge-garage"><i class="fas fa-car"></i></span>':''}${hop?`<span class="badge badge-reduced">-${pdp}%</span>`:''}</div>${!ce?`<button class="mv-fav ${mvEsFav(p.id)?'on':''}" title="Guardar" onclick="mvToggleFav(event,'${p.id}')"><i class="${mvEsFav(p.id)?'fas':'far'} fa-heart"></i></button>`:''}${ce?`<div class="card-actions"><button class="card-action-btn calendar" onclick="event.stopPropagation();openVisitModal('${p.id}')" title="Agendar visita"><i class="fas fa-calendar-plus"></i></button><button class="card-action-btn edit" onclick="event.stopPropagation();openPropertyFormTab('${p.id}')" title="Editar"><i class="fas fa-edit"></i></button><button class="card-action-btn" onclick="event.stopPropagation();openMLModal('${p.id}')" title="Mercado Libre" style="background:#fff159;color:#2d3277"><i class="fas fa-tag"></i></button><button class="btn-feature ${p.featured?'active':''}" onclick="event.stopPropagation();toggleFeatured('${p.id}')" title="${p.featured?'Quitar destacado':'Destacar'}"><i class="fas fa-star"></i></button><button class="card-action-btn delete" onclick="event.stopPropagation();deleteProperty('${p.id}')" title="Eliminar"><i class="fas fa-trash"></i></button></div>`:''}<div class="card-owner" onclick="event.stopPropagation();showProfile('${p.ownerId}')">${o.profilePhoto?`<img src="${o.profilePhoto}" alt="">`:`<div class="card-owner-initial">${oi}</div>`}<span>${mvEsc(o.name||'Usuario')}</span></div></div><div class="card-content"><div class="card-price ${hop?'card-price-reduced':''}">${hop?`<span class="card-price-old">${formatPrice(p.previousPrice,c)}</span>`:''}${formatPrice(p.price,c)}${p.type==='rent'?'<span>/mes</span>':''}${hop?`<span class="price-drop-badge" style="color:#FFFFFF!important">-${pdp}%</span>`:''}</div><h3 class="card-title">${mvEsc(p.title)}</h3><div class="card-location"><i class="fas fa-map-marker-alt"></i>${mvEsc(l)}</div><div class="card-features">${p.bedrooms?`<div class="card-feature"><i class="fas fa-bed"></i>${p.bedrooms}</div>`:''}${p.bathrooms?`<div class="card-feature"><i class="fas fa-bath"></i>${p.bathrooms}</div>`:''}${p.totalArea?`<div class="card-feature"><i class="fas fa-expand"></i>${p.totalArea}m²</div>`:''}${p.builtArea?`<div class="card-feature"><i class="fas fa-home"></i>${p.builtArea}m² edif.</div>`:''}${p.garage==='yes'?`<div class="card-feature"><i class="fas fa-car"></i>Garaje</div>`:''}</div></div><div class="card-footer"><div style="display:flex;gap:12px;align-items:center"><span class="card-views"><i class="fas fa-eye"></i> ${p.views||0}</span>${ce?`<span class="card-views" title="Tocaron Contactar"><i class="fab fa-whatsapp" style="color:#25d366"></i> ${p.contactClicks||0}</span>`:''}</div><div style="display:flex;gap:8px"><button class="btn-share" onclick="event.stopPropagation();openShareModal('${p.id}')" title="Compartir"><i class="fas fa-share-alt"></i></button>${hi?`<button class="btn-instagram" onclick="event.stopPropagation();window.open('${o.instagram}','_blank')"><i class="fab fa-instagram"></i></button>`:''}<button class="btn-whatsapp" onclick="event.stopPropagation();contactWhatsapp('${p.id}')"><i class="fab fa-whatsapp"></i> Contactar</button></div></div></div>`
    }).join('')
  }

  function updateStats() {
    const av = properties.filter(p => !p.status || p.status === 'available' || p.status === 'reserved');
    document.getElementById('statTotal').textContent = av.length;
    document.getElementById('statSale').textContent = av.filter(p => p.type === 'sale').length;
    document.getElementById('statRent').textContent = av.filter(p => p.type === 'rent').length
  }

  function filterProperties() {
    const s = document.getElementById('filterSearch').value.toLowerCase(),
      t = document.getElementById('filterType').value,
      b = parseInt(document.getElementById('filterBedrooms').value) || 0,
      mp = parseInt(document.getElementById('filterPrice').value) || Infinity;
    const f = properties.filter(p => {
      const l = getLocationString(p).toLowerCase();
      if (s && !p.title.toLowerCase().includes(s) && !l.includes(s)) return false;
      if (t && p.type !== t) return false;
      if (b && (p.bedrooms || 0) < b) return false;
      if (p.price > mp) return false;
      return true
    });
    renderProperties(f)
  }

  // Profile Functions
  function renderSocialLinks(ud) {
    let html = '';
    if (ud.instagram && ud.instagram.includes('instagram.com')) {
      html += `<a href="${ud.instagram}" target="_blank" class="profile-social-link instagram" title="Instagram"><i class="fab fa-instagram"></i></a>`
    }
    if (ud.facebook && ud.facebook.includes('facebook.com')) {
      html += `<a href="${ud.facebook}" target="_blank" class="profile-social-link facebook" title="Facebook"><i class="fab fa-facebook-f"></i></a>`
    }
    if (ud.linkedin && ud.linkedin.includes('linkedin.com')) {
      html += `<a href="${ud.linkedin}" target="_blank" class="profile-social-link linkedin" title="LinkedIn"><i class="fab fa-linkedin-in"></i></a>`
    }
    if (ud.twitter && (ud.twitter.includes('twitter.com') || ud.twitter.includes('x.com'))) {
      html += `<a href="${ud.twitter}" target="_blank" class="profile-social-link twitter" title="Twitter/X"><i class="fab fa-twitter"></i></a>`
    }
    if (ud.tiktok && ud.tiktok.includes('tiktok.com')) {
      html += `<a href="${ud.tiktok}" target="_blank" class="profile-social-link tiktok" title="TikTok"><i class="fab fa-tiktok"></i></a>`
    }
    if (ud.youtube && ud.youtube.includes('youtube.com')) {
      html += `<a href="${ud.youtube}" target="_blank" class="profile-social-link youtube" title="YouTube"><i class="fab fa-youtube"></i></a>`
    }
    if (ud.website) {
      html += `<a href="${ud.website}" target="_blank" class="profile-social-link" title="Sitio Web"><i class="fas fa-globe"></i></a>`
    }
    return html
  }

  async function showProfile(ui) {
    currentProfileUserId = ui;
    window.location.hash = `perfil/${ui}`;
    let ud = allUsers[ui];
    if (!ud) {
      const d = await db.collection('users').doc(ui).get();
      ud = d.exists ? d.data() : {
        name: 'Usuario',
        email: ''
      };
      allUsers[ui] = ud
    }
    document.getElementById('profileName').textContent = ud.name || 'Usuario';
    document.getElementById('profileNameTitle').textContent = ud.name || 'Usuario';
    document.getElementById('profileEmail').textContent = ud.email || '';
    document.getElementById('profileBio').textContent = ud.bio || '';
    document.getElementById('profileBio').style.display = ud.bio ? 'block' : 'none';
    // Campos nuevos del perfil v2 (con valores por defecto elegantes si están vacíos)
    const rol = ud.role || 'Asesor Inmobiliario';
    document.getElementById('profileRole').textContent = rol.toUpperCase();
    document.getElementById('profileLocation').textContent = ud.location || 'Montevideo, Uruguay';
    const ael = document.getElementById('profileAboutText');
    if (ael) {
      const about = ud.about || ud.bio || '';
      ael.innerHTML = about ? about.split(/\n+/).filter(Boolean).map(p => `<p>${p.replace(/</g, '&lt;')}</p>`).join('') : '<p style="color:var(--gray-400,#aaa)">Este asesor todavía no agregó una descripción.</p>';
    }
    const i = (ud.name || 'U').charAt(0).toUpperCase();
    document.getElementById('profileAvatar').innerHTML = ud.profilePhoto ? `<img src="${ud.profilePhoto}" alt="">` : i;
    const ip = currentUser && currentUser.uid === ui;
    document.getElementById('profileAvatarEdit').classList.toggle('hidden', !ip);
    document.getElementById('btnEditProfile').classList.toggle('hidden', !ip);
    const wab = document.getElementById('btnContactWhatsapp');
    if (wab) wab.classList.toggle('hidden', ip || !ud.whatsapp);
    const emw = document.getElementById('profileEmailWrap');
    if (emw) emw.style.display = ud.email ? 'inline-flex' : 'none';
    document.getElementById('profileSocialLinks').innerHTML = renderSocialLinks(ud);
    const up = properties.filter(p => p.ownerId === ui),
      tv = up.reduce((s, p) => s + (p.views || 0), 0);
    document.getElementById('profilePropertiesCount').textContent = up.length;
    document.getElementById('profileViewsCount').textContent = tv;
    const salesEl = document.getElementById('profileSalesCount');
    if (salesEl) salesEl.textContent = (ud.salesCount != null ? ud.salesCount : up.filter(p => ['sold', 'rented'].includes(p.status)).length);
    document.getElementById('profilePropertiesSubtitle').textContent = `${up.length} propiedades`;
    document.getElementById('btnNewPropertyProfile')?.classList.toggle('hidden', !ip);
    renderProfileTestimonials(ud, ui);
    renderProperties(up, 'profilePropertiesGrid');
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('adminPanel').classList.add('hidden');
    document.getElementById('crmPage').classList.add('hidden');
    document.getElementById('clientProfilePage')?.classList.add('hidden');
    document.getElementById('profilePage').classList.remove('hidden')
  }

  // Testimonios del perfil: reales aprobados (Firestore) + ejemplo (etiquetado).
  let pf2TestiIdx = 0, pf2TestiTimer = null;
  const PF2_TESTI_EJEMPLO = [
    { t: 'Nos acompañó en todo el proceso con profesionalismo y cercanía. Encontramos justo lo que buscábamos. 100% recomendable.', n: 'Valeria G.', r: 'Compradora en Punta Carretas', ejemplo: true }
  ];
  function renderProfileTestimonials(ud, agentId) {
    const cont = document.getElementById('pf2TestiText');
    if (!cont) return;
    // Base: ejemplo (siempre disponible para no dejar vacio)
    let list = PF2_TESTI_EJEMPLO.slice();
    const pintar = () => {
      clearInterval(pf2TestiTimer); pf2TestiIdx = 0;
      const show = j => {
        const x = list[j]; if (!x) return; pf2TestiIdx = j;
        document.getElementById('pf2TestiText').textContent = '"' + (x.t || x.text || '') + '"';
        document.getElementById('pf2TestiName').textContent = x.n || x.name || '';
        document.getElementById('pf2TestiRole').textContent = x.r || x.role || '';
        document.getElementById('pf2TestiAv').textContent = (x.n || x.name || 'C').trim().charAt(0).toUpperCase();
        const tag = document.getElementById('pf2TestiTag');
        if (tag) tag.style.display = x.ejemplo ? 'inline-block' : 'none';
        document.getElementById('pf2TestiDots').innerHTML = list.map((_, k) => `<span class="${k === j ? 'on' : ''}" onclick="pf2GoTesti(${k})"></span>`).join('');
      };
      window.pf2GoTesti = show;
      show(0);
      if (list.length > 1) pf2TestiTimer = setInterval(() => show((pf2TestiIdx + 1) % list.length), 7000);
    };
    pintar();
    // Cargar reales aprobados de este agente y combinarlos adelante
    if (agentId && typeof db !== 'undefined') {
      db.collection('testimonials')
        .where('target', '==', 'agent')
        .where('agentId', '==', agentId)
        .where('approved', '==', true)
        .get()
        .then(snap => {
          const reales = [];
          snap.forEach(d => { const x = d.data(); reales.push({ t: x.text, n: x.name, r: x.role || 'Cliente', ejemplo: false }); });
          if (reales.length) { list = reales.concat(PF2_TESTI_EJEMPLO); pintar(); }
        })
        .catch(() => {});
    }
    // Boton "dejar testimonio" para este agente
    const addBtn = document.getElementById('pf2TestiAdd');
    if (addBtn) {
      const nombreAg = (ud && (ud.name || ud.displayName)) || 'este agente';
      addBtn.onclick = () => { if (typeof window.abrirTestimonioModal === 'function') window.abrirTestimonioModal('agent', agentId || '', nombreAg); };
      addBtn.style.display = agentId ? 'inline-flex' : 'none';
    }
  }

  function showMyProfile() {
    if (currentUser) {
      showProfile(currentUser.uid);
      document.getElementById('userDropdown')?.classList.remove('active')
    }
  }

  function getProfileLink() {
    return `${window.location.origin}${window.location.pathname}#perfil/${currentProfileUserId}`
  }

  function copyProfileLink() {
    navigator.clipboard.writeText(getProfileLink()).then(() => {
      showToast('Enlace copiado', 'El enlace ha sido copiado', 'fa-link')
    })
  }

  function shareProfileWhatsapp() {
    const u = allUsers[currentProfileUserId] || {
      name: 'este usuario'
    };
    window.open(`https://wa.me/?text=${encodeURIComponent(`Mira las propiedades de ${u.name}: ${getProfileLink()}`)}`, '_blank')
  }

  function contactAgentWhatsapp() {
    const u = allUsers[currentProfileUserId];
    if (!u || !u.whatsapp) return;
    const ph = u.whatsapp.replace(/\D/g, '');
    window.open(`https://wa.me/${ph}?text=${encodeURIComponent(`Hola ${u.name||''}, vi tu perfil en MALAVE y me gustaría consultarte.`)}`, '_blank')
  }

  function handleHash() {
    const h = window.location.hash;
    if (h.startsWith('#perfil/')) {
      showProfile(h.replace('#perfil/', ''))
    } else if (h.startsWith('#propiedad/')) {
      const pid = h.replace('#propiedad/', '');
      if (properties.length > 0) {
        openDetail(pid)
      } else {
        const checkProps = setInterval(() => {
          if (properties.length > 0) {
            clearInterval(checkProps);
            openDetail(pid)
          }
        }, 200);
        setTimeout(() => clearInterval(checkProps), 5000)
      }
    }
  }
  window.addEventListener('hashchange', handleHash);

  // Edit Profile
  function openEditProfileModal() {
    if (!currentUser || !userProfile) return;
    document.getElementById('editProfileError').classList.add('hidden');
    document.getElementById('editProfileSuccess').classList.add('hidden');
    document.getElementById('editName').value = userProfile.name || '';
    document.getElementById('editLocation').value = userProfile.location || '';
    document.getElementById('editBio').value = userProfile.bio || '';
    document.getElementById('editAbout').value = userProfile.about || '';
    document.getElementById('editWhatsapp').value = userProfile.whatsapp || '';
    document.getElementById('editInstagram').value = userProfile.instagram || '';
    document.getElementById('editFacebook').value = userProfile.facebook || '';
    document.getElementById('editLinkedin').value = userProfile.linkedin || '';
    document.getElementById('editTwitter').value = userProfile.twitter || '';
    document.getElementById('editTiktok').value = userProfile.tiktok || '';
    document.getElementById('editYoutube').value = userProfile.youtube || '';
    document.getElementById('editWebsite').value = userProfile.website || '';
    document.getElementById('userDropdown')?.classList.remove('active');
    openModal('editProfileModal')
  }

  async function handleSaveProfile(e) {
    e.preventDefault();
    if (!currentUser) return;
    const b = document.getElementById('editProfileBtn'),
      er = document.getElementById('editProfileError'),
      su = document.getElementById('editProfileSuccess');
    b.disabled = true;
    b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    er.classList.add('hidden');
    su.classList.add('hidden');
    try {
      const updateData = {
        name: document.getElementById('editName').value.trim(),
        location: document.getElementById('editLocation').value.trim(),
        bio: document.getElementById('editBio').value.trim(),
        about: document.getElementById('editAbout').value.trim(),
        whatsapp: document.getElementById('editWhatsapp').value.trim(),
        instagram: document.getElementById('editInstagram').value.trim(),
        facebook: document.getElementById('editFacebook').value.trim(),
        linkedin: document.getElementById('editLinkedin').value.trim(),
        twitter: document.getElementById('editTwitter').value.trim(),
        tiktok: document.getElementById('editTiktok').value.trim(),
        youtube: document.getElementById('editYoutube').value.trim(),
        website: document.getElementById('editWebsite').value.trim(),
        updatedAt: new Date().toISOString()
      };
      await db.collection('users').doc(currentUser.uid).update(updateData);
      Object.assign(userProfile, updateData);
      allUsers[currentUser.uid] = userProfile;
      updateUI();
      if (currentProfileUserId === currentUser.uid) {
        showProfile(currentUser.uid)
      }
      su.textContent = '¡Perfil actualizado correctamente!';
      su.classList.remove('hidden');
      showToast('Perfil actualizado', 'Tus datos han sido guardados', 'fa-check');
      setTimeout(() => closeModal('editProfileModal'), 1500)
    } catch (err) {
      console.error('Error updating profile:', err);
      er.textContent = 'Error al guardar: ' + err.message;
      er.classList.remove('hidden')
    } finally {
      b.disabled = false;
      b.innerHTML = '<i class="fas fa-save"></i> Guardar Cambios'
    }
  }

  // Abre la propiedad en una pestaña nueva, en su página dedicada
  function openPropertyTab(id) {
    window.open('propiedad.html?id=' + id, '_blank');
  }

  // Abre el formulario de crear/editar propiedad en una pestaña nueva
  function openPropertyFormTab(id, clientId) {
    let url = 'propiedad-form.html';
    if (id) url += '?id=' + encodeURIComponent(id);
    else if (clientId) url += '?clientId=' + encodeURIComponent(clientId);
    window.open(url, '_blank');
  }

  // Detail View
  let visitsCache = null;
  const EVP_LAB = { visit:['visita','visitas'], meeting:['reunión','reuniones'], delivery:['entrega','entregas'], review:['revisión','revisiones'], other:['evento','eventos'] };
  const EVP_ICO = { visit:'home', meeting:'handshake', delivery:'box', review:'clipboard-check', other:'star' };
  async function getVisitsForProperty(id) {
    if (visitsCache === null) {
      try {
        const q = isAdminUser() ? db.collection('visits') : db.collection('visits').where('userId', '==', currentUser.uid);
        const s = await q.get();
        visitsCache = s.docs.map(d => d.data());
      } catch (e) { console.warn('No se pudieron cargar eventos:', e); visitsCache = []; }
    }
    return visitsCache.filter(v => v.propertyId === id);
  }
  async function renderPropEventCount(id) {
    let host = document.getElementById('detailEventStats');
    if (!host) {
      const feat = document.getElementById('detailFeatures');
      if (!feat || !feat.parentNode) return;
      host = document.createElement('div');
      host.id = 'detailEventStats';
      host.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:14px 0';
      feat.parentNode.insertBefore(host, feat.nextSibling);
    }
    host.style.display = 'none';
    host.innerHTML = '';
    let evs = [];
    try { evs = await getVisitsForProperty(id); } catch (e) { return; }
    if (!evs.length) return;
    const counts = {};
    evs.forEach(v => { const t = v.eventType || 'other'; counts[t] = (counts[t] || 0) + 1; });
    const chips = ['visit','meeting','delivery','review','other'].filter(t => counts[t]).map(t => {
      const n = counts[t], lab = EVP_LAB[t] || ['evento','eventos'];
      return `<span style="background:#f3f4f6;color:#374151;font-size:.78rem;font-weight:600;padding:5px 11px;border-radius:20px;white-space:nowrap"><i class="fas fa-${EVP_ICO[t]||'star'}" style="color:var(--accent,#C9A227);margin-right:5px"></i>${n} ${n===1?lab[0]:lab[1]}</span>`;
    });
    host.innerHTML = `<span style="width:100%;font-size:.74rem;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:.3px"><i class="fas fa-calendar-check"></i> Agenda de esta propiedad</span>` + chips.join('');
    host.style.display = 'flex';
  }
  async function openDetail(id, sc = false) {
    const p = properties.find(pr => pr.id === id);
    if (!p) return;
    currentDetailProperty = p;
    currentDetailImageIndex = 0;
    const io = currentUser && currentUser.uid === p.ownerId;
    if (!sc && !io) db.collection('properties').doc(id).update({
      views: firebase.firestore.FieldValue.increment(1)
    }).catch(e => console.log('Error counting view:', e));
    const im = p.images?.length ? p.images : ['https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800'];
    document.getElementById('detailImage').src = im[0];
    document.getElementById('detailTitle').textContent = p.title;
    document.getElementById('detailLocation').textContent = getLocationString(p) + (p.direccion ? ` - ${p.direccion}` : '');
    const c = p.currency || 'USD',
      hop = p.previousPrice && p.previousPrice > p.price,
      pdp = hop ? Math.round((1 - p.price / p.previousPrice) * 100) : 0;
    document.getElementById('detailPrice').textContent = `${formatPrice(p.price,c)}${p.type==='rent'?'/mes':''}`;
    const ope = document.getElementById('detailPriceOld'),
      pde = document.getElementById('detailPriceDrop');
    if (hop) {
      ope.textContent = formatPrice(p.previousPrice, c);
      ope.classList.remove('hidden');
      pde.textContent = `¡${pdp}% de descuento!`;
      pde.classList.remove('hidden')
    } else {
      ope.classList.add('hidden');
      pde.classList.add('hidden')
    }
    document.getElementById('detailDescription').textContent = p.description || 'Sin descripción.';
    const so = document.getElementById('detailStatusOverlay'),
      sr = document.getElementById('detailStatusRibbon'),
      st = p.status || 'available';
    const stLabels = {
      reserved: 'RESERVADA',
      sold: 'VENDIDA',
      rented: 'ALQUILADA',
      archived: 'ARCHIVADA'
    };
    if (st !== 'available' && stLabels[st]) {
      so.className = `detail-status-overlay ${st}`;
      sr.className = `status-ribbon ${st}`;
      sr.textContent = stLabels[st];
      so.classList.remove('hidden')
    } else {
      so.classList.add('hidden')
    }
    const tc = document.getElementById('detailThumbnails');
    if (im.length > 1) {
      tc.innerHTML = im.map((img, i) => `<div class="detail-thumb ${i===0?'active':''}" onclick="setDetailImage(${i})"><img src="${img}" alt=""></div>`).join('');
      tc.style.display = 'flex'
    } else tc.style.display = 'none';
    const o = getOwnerInfo(p),
      oi = (o.name || 'U').charAt(0).toUpperCase();
    document.getElementById('detailOwnerName').textContent = o.name || 'Usuario';
    document.getElementById('detailOwnerAvatar').innerHTML = o.profilePhoto ? `<img src="${o.profilePhoto}" alt="">` : oi;
    document.getElementById('detailBadges').innerHTML = `${p.featured&&st==='available'?'<span class="badge badge-featured"><i class="fas fa-star"></i> DESTACADA</span>':''}<span class="badge ${p.type==='sale'?'badge-sale':'badge-rent'}">${p.type==='sale'?'VENTA':'ALQUILER'}</span>${p.type==='sale'&&p.propertyType==='ph'?'<span class="badge badge-ph">PH</span>':''}${c==='UYU'?'<span class="badge badge-currency">UYU</span>':''}${p.garage==='yes'?'<span class="badge badge-garage"><i class="fas fa-car"></i></span>':''}${hop?`<span class="badge badge-reduced">-${pdp}%</span>`:''}${st==='reserved'?'<span class="badge badge-reserved">RESERVADA</span>':''}${st==='sold'?'<span class="badge badge-sold">VENDIDA</span>':''}${st==='rented'?'<span class="badge badge-rented">ALQUILADA</span>':''}${st==='archived'?'<span class="badge badge-archived">ARCHIVADA</span>':''}`;
    document.getElementById('detailFeatures').innerHTML = `${p.bedrooms?`<div class="detail-feature"><i class="fas fa-bed"></i><strong>${p.bedrooms}</strong><span>Dormitorios</span></div>`:''}${p.bathrooms?`<div class="detail-feature"><i class="fas fa-bath"></i><strong>${p.bathrooms}</strong><span>Baños</span></div>`:''}${p.totalArea?`<div class="detail-feature"><i class="fas fa-expand"></i><strong>${p.totalArea}</strong><span>m² Total</span></div>`:''}${p.builtArea?`<div class="detail-feature"><i class="fas fa-home"></i><strong>${p.builtArea}</strong><span>m² Edificado</span></div>`:''}${p.garage==='yes'?`<div class="detail-feature"><i class="fas fa-car"></i><strong>Sí</strong><span>Garaje</span></div>`:''}${p.commonExpenses?`<div class="detail-feature"><i class="fas fa-dollar-sign"></i><strong>${p.commonExpenses}</strong><span>Gastos</span></div>`:''}`;
    document.getElementById('detailWhatsapp').onclick = () => contactWhatsapp(id);
    const ib = document.getElementById('detailInstagram');
    if (o.instagram && o.instagram.includes('instagram.com')) {
      ib.classList.remove('hidden');
      ib.onclick = () => window.open(o.instagram, '_blank')
    } else {
      ib.classList.add('hidden')
    }
    document.getElementById('detailEditBtn').classList.toggle('hidden', !canEditProperty(p));
    document.getElementById('commentFormGuest').classList.toggle('hidden', !!currentUser);
    document.getElementById('commentFormUser').classList.toggle('hidden', !currentUser);
    loadComments(id);
    renderPropEventCount(id);
    openModal('detailModal')
  }

  function setDetailImage(i) {
    if (!currentDetailProperty?.images?.length) return;
    currentDetailImageIndex = i;
    document.getElementById('detailImage').src = currentDetailProperty.images[i];
    document.querySelectorAll('.detail-thumb').forEach((t, idx) => t.classList.toggle('active', idx === i))
  }

  function prevDetailImage() {
    if (!currentDetailProperty?.images?.length) return;
    currentDetailImageIndex = (currentDetailImageIndex - 1 + currentDetailProperty.images.length) % currentDetailProperty.images.length;
    setDetailImage(currentDetailImageIndex)
  }

  function nextDetailImage() {
    if (!currentDetailProperty?.images?.length) return;
    currentDetailImageIndex = (currentDetailImageIndex + 1) % currentDetailProperty.images.length;
    setDetailImage(currentDetailImageIndex)
  }

  function openLightbox(i) {
    if (!currentDetailProperty?.images?.length) return;
    currentDetailImageIndex = i;
    document.getElementById('lightboxImg').src = currentDetailProperty.images[i];
    updateLightboxCounter();
    document.getElementById('lightbox').classList.add('active');
    document.body.style.overflow = 'hidden'
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
    document.body.style.overflow = ''
  }

  function lightboxNext() {
    if (!currentDetailProperty?.images?.length) return;
    currentDetailImageIndex = (currentDetailImageIndex + 1) % currentDetailProperty.images.length;
    document.getElementById('lightboxImg').src = currentDetailProperty.images[currentDetailImageIndex];
    setDetailImage(currentDetailImageIndex);
    updateLightboxCounter()
  }

  function lightboxPrev() {
    if (!currentDetailProperty?.images?.length) return;
    currentDetailImageIndex = (currentDetailImageIndex - 1 + currentDetailProperty.images.length) % currentDetailProperty.images.length;
    document.getElementById('lightboxImg').src = currentDetailProperty.images[currentDetailImageIndex];
    setDetailImage(currentDetailImageIndex);
    updateLightboxCounter()
  }

  function updateLightboxCounter() {
    const c = document.getElementById('lightboxCounter');
    if (c && currentDetailProperty?.images?.length) {
      c.textContent = `${currentDetailImageIndex + 1} / ${currentDetailProperty.images.length}`;
      c.style.display = currentDetailProperty.images.length > 1 ? 'block' : 'none'
    }
  }

  document.addEventListener('keydown', e => {
    const lb = document.getElementById('lightbox');
    if (!lb || !lb.classList.contains('active')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') lightboxNext();
    else if (e.key === 'ArrowLeft') lightboxPrev()
  });

  function viewOwnerProfile() {
    if (currentDetailProperty) {
      closeModal('detailModal');
      showProfile(currentDetailProperty.ownerId)
    }
  }

  // Comments
  async function loadComments(pi) {
    const c = document.getElementById('commentsList');
    c.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const io = currentUser && currentDetailProperty && currentUser.uid === currentDetailProperty.ownerId;
    try {
      const s = await db.collection('properties').doc(pi).collection('comments').orderBy('createdAt', 'desc').get();
      const cm = s.docs.map(d => d.data());
      if (cm.length === 0) {
        c.innerHTML = '<div class="no-comments"><i class="fas fa-comment-slash"></i><p>Sé el primero en consultar</p></div>';
        return
      }
      c.innerHTML = cm.map(co => {
        const i = (co.userName || 'A').charAt(0).toUpperCase(),
          t = co.createdAt ? new Date(co.createdAt).toLocaleDateString('es') : '',
          sp = io && co.userPhone;
        return `<div class="comment-item"><div class="comment-avatar">${co.userPhoto?`<img src="${co.userPhoto}" alt="">`:i}</div><div class="comment-content"><div class="comment-header"><span class="comment-author">${co.userName||'Anónimo'}</span>${co.isGuest?'<span class="comment-guest-badge">Invitado</span>':''}<span class="comment-time">${t}</span></div><p class="comment-text">${co.text}</p>${sp?`<div class="comment-contact"><i class="fab fa-whatsapp"></i> Contacto: <a href="https://wa.me/${co.userPhone.replace(/\D/g,'')}" target="_blank">${co.userPhone}</a></div>`:''}</div></div>`
      }).join('')
    } catch (e) {
      console.error('Error loading comments:', e);
      c.innerHTML = '<p style="color:var(--danger)">Error al cargar consultas</p>'
    }
  }
  async function addComment() {
    let tx, un, up, uph, ig;
    if (currentUser && userProfile) {
      tx = document.getElementById('commentInputUser').value.trim();
      un = userProfile.name;
      up = userProfile.whatsapp || '';
      uph = userProfile.profilePhoto || null;
      ig = false
    } else {
      tx = document.getElementById('commentInput').value.trim();
      un = document.getElementById('guestName').value.trim();
      up = document.getElementById('guestPhone').value.trim();
      uph = null;
      ig = true;
      if (!un) {
        alert('Por favor ingresa tu nombre');
        return
      }
      if (!up) {
        alert('Por favor ingresa tu WhatsApp');
        return
      }
    }
    if (!tx || !currentDetailProperty) {
      alert('Por favor escribe tu consulta');
      return
    }
    try {
      const cd = {
        userId: currentUser?.uid || null,
        userName: un,
        userPhone: up,
        userPhoto: uph,
        text: tx,
        isGuest: ig,
        createdAt: new Date().toISOString()
      };
      await db.collection('properties').doc(currentDetailProperty.id).collection('comments').add(cd);
      const io = currentUser && currentUser.uid === currentDetailProperty.ownerId;
      if (!io) {
        const nd = {
          ownerId: currentDetailProperty.ownerId,
          propertyId: currentDetailProperty.id,
          propertyTitle: currentDetailProperty.title,
          userName: un,
          userPhone: up,
          userPhoto: uph,
          text: tx,
          read: false,
          createdAt: new Date().toISOString()
        };
        await db.collection('notifications').add(nd)
      }
      if (currentUser) {
        document.getElementById('commentInputUser').value = ''
      } else {
        document.getElementById('commentInput').value = ''
      }
      loadComments(currentDetailProperty.id);
      showToast('Consulta enviada', 'Tu mensaje ha sido enviado al propietario', 'fa-check')
    } catch (e) {
      console.error('Error adding comment:', e);
      alert('Error al enviar consulta: ' + e.message)
    }
  }

  function contactWhatsapp(id) {
    const p = properties.find(pr => pr.id === id);
    if (!p) return;
    try { db.collection('properties').doc(id).update({ contactClicks: firebase.firestore.FieldValue.increment(1) }); } catch (e) {}
    p.contactClicks = (p.contactClicks || 0) + 1;
    const o = getOwnerInfo(p),
      ph = (p.ownerWhatsapp || o.whatsapp || '59899000000').replace(/\D/g, ''),
      m = `Hola, me interesa: ${p.title} - ${formatPrice(p.price,p.currency||'USD')} en ${getLocationString(p)}`;
    window.open(`https://wa.me/${ph}?text=${encodeURIComponent(m)}`, '_blank')
  }

  function showHome() {
    document.getElementById('mainContent').classList.remove('hidden');
    document.getElementById('adminPanel').classList.add('hidden');
    document.getElementById('profilePage').classList.add('hidden');
    document.getElementById('crmPage').classList.add('hidden');
    document.getElementById('clientProfilePage')?.classList.add('hidden');
    currentProfileUserId = null;
    window.location.hash = ''
  }
  // ===== (Cuentas y herramientas se movió a cuentas.html) =====

  // Admin
  function showAdmin() {
    if (!currentUser || userProfile?.email?.toLowerCase() !== ADMIN_EMAIL) return;
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('profilePage').classList.add('hidden');
    document.getElementById('crmPage').classList.add('hidden');
    document.getElementById('clientProfilePage')?.classList.add('hidden');
    document.getElementById('adminPanel').classList.remove('hidden');
    showAdminTab('pending')
  }
  async function showAdminTab(tb) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab${tb.charAt(0).toUpperCase()+tb.slice(1)}`).classList.add('active');
    const c = document.getElementById('adminContent');
    c.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      if (tb === 'pending') {
        console.log('Buscando usuarios pendientes...');
        const s = await db.collection('users').where('status', '==', 'pending').get();
        console.log('Encontrados:', s.docs.length);
        const us = s.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));
        document.getElementById('pendingCount').textContent = us.length > 0 ? `(${us.length})` : '';
        c.innerHTML = us.length === 0 ? `<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success)"></i><h3>Sin pendientes</h3><p style="color:var(--gray-500);margin-top:8px">No hay usuarios esperando aprobación</p></div>` : us.map(u => `<div class="user-card"><div class="user-card-avatar"><i class="fas fa-user"></i></div><div class="user-card-info"><h4>${mvEsc(u.name||'Sin nombre')}</h4><p>${mvEsc(u.email||'')}</p><small>WhatsApp: ${mvEsc(u.whatsapp||'-')}</small><br><small style="color:var(--gray-400)">Registrado: ${u.createdAt?new Date(u.createdAt).toLocaleDateString('es-UY'):'N/A'}</small></div><div class="user-card-actions"><button class="btn-approve" onclick="approveUser('${u.id}')"><i class="fas fa-check"></i> Aprobar</button><button class="btn-reject" onclick="rejectUser('${u.id}')"><i class="fas fa-times"></i> Rechazar</button></div></div>`).join('')
      } else if (tb === 'users') {
        const s = await db.collection('users').get();
        const us = s.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));
        c.innerHTML = us.length === 0 ? '<div class="empty-state"><i class="fas fa-users"></i><h3>Sin usuarios</h3></div>' : us.map(u => `<div class="user-card"><div class="user-card-avatar">${u.profilePhoto?`<img src="${u.profilePhoto}" alt="">`:'<i class="fas fa-user"></i>'}</div><div class="user-card-info"><h4>${mvEsc(u.name||'Sin nombre')} ${(u.email||'').toLowerCase()===ADMIN_EMAIL?'<span class="admin-badge">Admin</span>':''}</h4><p>${mvEsc(u.email||'')}</p><small style="color:var(--gray-500)"><i class="fas fa-id-badge" style="color:var(--accent,#C9A227)"></i> ${mvEsc(u.role||'Asesor Inmobiliario')}</small>${u.commissionSale!=null||u.commissionRent!=null||u.commissionPct!=null?`<br><small style="color:#8a6d12"><i class="fas fa-percent"></i> Venta: ${u.commissionSale!=null?u.commissionSale:(u.commissionPct!=null?u.commissionPct:'—')}% · Alq: ${u.commissionRent!=null?u.commissionRent:(u.commissionPct!=null?u.commissionPct:'—')}%</small>`:''}<br><small style="color:${u.status==='approved'?'var(--success)':u.status==='pending'?'var(--gold)':'var(--danger)'}">${u.status==='approved'?'✓ Aprobado':u.status==='pending'?'⏳ Pendiente':'✗ Rechazado'}</small></div><div class="user-card-actions"><button class="btn-edit" onclick="setUserRole('${u.id}')" title="Asignar cargo"><i class="fas fa-id-badge"></i></button><button class="btn-edit" onclick="setUserComision('${u.id}')" title="Comisión del agente"><i class="fas fa-percent"></i></button><button class="btn-edit" onclick="showProfile('${u.id}')" title="Ver perfil"><i class="fas fa-eye"></i></button>${u.status==='pending'?`<button class="btn-approve" onclick="approveUser('${u.id}')"><i class="fas fa-check"></i></button>`:''}${(u.email||'').toLowerCase()!==ADMIN_EMAIL?`<button class="btn-reject" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button>`:''}</div></div>`).join('')
      } else if (tb === 'properties') {
        c.innerHTML = properties.length === 0 ? '<div class="empty-state"><i class="fas fa-building"></i><h3>Sin propiedades</h3></div>' : properties.map(p => {
          const o = getOwnerInfo(p),
            st = p.status || 'available',
            stLabels = {
              tasacion: '⏳ Pendiente de tasación',
              tasado: '📋 Tasado',
              available: '✓ Disponible',
              reserved: '⏳ Reservada',
              sold: '✗ Vendida',
              rented: '🔑 Alquilada',
              archived: '📦 Archivada'
            },
            stt = stLabels[st] || '✓ Disponible',
            isFeat = p.featured;
          return `<div class="user-card ${isFeat?'featured-admin':''}"><div class="user-card-avatar" style="border-radius:8px"><img src="${p.images?.[0]||'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=100'}" style="width:100%;height:100%;object-fit:cover;border-radius:8px"></div><div class="user-card-info"><h4>${isFeat?'<i class="fas fa-star" style="color:#f1c40f"></i> ':''} ${mvEsc(p.title)}</h4><p>${formatPrice(p.price,p.currency||'USD')} - ${getLocationString(p)}</p><small>${mvEsc(o.name)} | <i class="fas fa-eye"></i> ${p.views||0} | ${stt}</small></div><div class="user-card-actions"><button class="btn-feature-admin ${isFeat?'active':''}" onclick="toggleFeatured('${p.id}')" title="${isFeat?'Quitar destacado':'Destacar'}"><i class="fas fa-star"></i></button><button class="btn-edit" onclick="openPropertyFormTab('${p.id}')"><i class="fas fa-edit"></i></button><button class="btn-reject" onclick="deleteProperty('${p.id}')"><i class="fas fa-trash"></i></button></div></div>`
        }).join('')
      } else if (tb === 'testimonials') {
        const s = await db.collection('testimonials').get();
        const ts = s.docs.map(d => ({ id: d.id, ...d.data() }));
        ts.sort((a,b) => (a.approved===b.approved) ? 0 : (a.approved ? 1 : -1));
        const pend = ts.filter(t => !t.approved);
        const pc = document.getElementById('testiPendCount'); if (pc) pc.textContent = pend.length ? `(${pend.length})` : '';
        if (ts.length === 0) {
          c.innerHTML = '<div class="empty-state"><i class="fas fa-comment-dots"></i><h3>Sin testimonios</h3><p style="color:var(--gray-500);margin-top:8px">Cuando un cliente deje un testimonio, aparecerá acá para que lo apruebes.</p></div>';
        } else {
          c.innerHTML = ts.map(t => {
            const donde = t.target === 'agent' ? `Perfil de ${t.agentName || 'agente'}` : 'Inicio';
            const estado = t.approved
              ? '<span style="color:var(--success)">✓ Publicado</span>'
              : '<span style="color:var(--gold,#C9A227)">⏳ Pendiente</span>';
            return `<div class="user-card"><div class="user-card-avatar"><i class="fas fa-quote-left"></i></div><div class="user-card-info"><h4>${t.name||'Anónimo'} ${t.role?`<small style="color:var(--gray-500);font-weight:normal">· ${t.role}</small>`:''}</h4><p style="font-style:italic">"${(t.text||'').slice(0,160)}${(t.text||'').length>160?'…':''}"</p><small style="color:var(--gray-400)"><i class="fas fa-map-pin"></i> ${donde} · ${estado}</small></div><div class="user-card-actions">${!t.approved?`<button class="btn-approve" onclick="approveTestimonial('${t.id}')" title="Aprobar y publicar"><i class="fas fa-check"></i></button>`:`<button class="btn-edit" onclick="unpublishTestimonial('${t.id}')" title="Despublicar"><i class="fas fa-eye-slash"></i></button>`}<button class="btn-reject" onclick="deleteTestimonial('${t.id}')" title="Eliminar"><i class="fas fa-trash"></i></button></div></div>`;
          }).join('');
        }
      }
    } catch (err) {
      console.error('Error panel admin:', err);
      c.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i><h3>Error al cargar</h3><p style="color:var(--gray-500);margin-top:8px">${err.message}</p></div>`
    }
  }

  // ===== Moderación de testimonios (solo admin) =====
  async function approveTestimonial(id) {
    if (!isAdminUser()) return;
    try { await db.collection('testimonials').doc(id).update({ approved: true }); showToast('Publicado', 'El testimonio ya se muestra en el sitio.', 'fa-check'); showAdminTab('testimonials'); }
    catch (e) { showToast('Error', 'No se pudo aprobar.', 'fa-triangle-exclamation'); }
  }
  async function unpublishTestimonial(id) {
    if (!isAdminUser()) return;
    try { await db.collection('testimonials').doc(id).update({ approved: false }); showToast('Despublicado', 'El testimonio dejó de mostrarse.', 'fa-eye-slash'); showAdminTab('testimonials'); }
    catch (e) { showToast('Error', 'No se pudo despublicar.', 'fa-triangle-exclamation'); }
  }
  async function deleteTestimonial(id) {
    if (!isAdminUser()) return;
    if (!confirm('¿Eliminar este testimonio definitivamente?')) return;
    try { await db.collection('testimonials').doc(id).delete(); showToast('Eliminado', 'El testimonio fue borrado.', 'fa-trash'); showAdminTab('testimonials'); }
    catch (e) { showToast('Error', 'No se pudo eliminar.', 'fa-triangle-exclamation'); }
  }
  window.approveTestimonial = approveTestimonial;
  window.unpublishTestimonial = unpublishTestimonial;
  window.deleteTestimonial = deleteTestimonial;

  // El cargo/título es oficial de la inmobiliaria: SOLO el admin lo asigna.
  async function setUserRole(id) {
    if (!isAdminUser()) { showToast('Solo administradores', 'Solo el administrador puede asignar cargos.', 'fa-lock'); return; }
    const actual = (allUsers[id] && allUsers[id].role) || '';
    const nuevo = prompt('Cargo / título para este agente (aparece en su perfil):\nEj: CEO, Asesor Inmobiliario, Asesora Senior, Corredor Público', actual || 'Asesor Inmobiliario');
    if (nuevo === null) return; // canceló
    const role = nuevo.trim();
    try {
      await db.collection('users').doc(id).update({ role: role });
      if (allUsers[id]) allUsers[id].role = role;
      if (currentProfileUserId === id) showProfile(id); // refrescar si está abierto su perfil
      showAdminTab('users');
      showToast('Cargo actualizado', role ? `Ahora figura como "${role}".` : 'Se quitó el cargo.', 'fa-id-badge');
    } catch (e) {
      showToast('Error', 'No se pudo guardar el cargo: ' + (e.message || e), 'fa-triangle-exclamation');
    }
  }
  // La comision del agente (% de la comision que cobra la inmobiliaria): SOLO el admin la fija.
  async function setUserComision(id) {
    if (!isAdminUser()) { showToast('Solo administradores', 'Solo el administrador puede fijar la comisión.', 'fa-lock'); return; }
    const u = allUsers[id] || {};
    const curV = (u.commissionSale != null && u.commissionSale !== '') ? u.commissionSale : ((u.commissionPct != null && u.commissionPct !== '') ? u.commissionPct : '');
    const curA = (u.commissionRent != null && u.commissionRent !== '') ? u.commissionRent : ((u.commissionPct != null && u.commissionPct !== '') ? u.commissionPct : '');
    const sv = prompt('Comisión en VENTA para este agente (% de la comisión que cobra MALAVE).\nEj: 40 = se lleva el 40% de la comisión.', curV);
    if (sv === null) return;
    const av = prompt('Comisión en ALQUILER para este agente (% de la comisión que cobra MALAVE).', curA);
    if (av === null) return;
    const pctV = parseFloat(String(sv).trim().replace(',', '.'));
    const pctA = parseFloat(String(av).trim().replace(',', '.'));
    if (isNaN(pctV) || pctV < 0 || pctV > 100 || isNaN(pctA) || pctA < 0 || pctA > 100) { showToast('Valor inválido', 'Ingresá números entre 0 y 100 en las dos.', 'fa-triangle-exclamation'); return; }
    try {
      await db.collection('users').doc(id).update({ commissionSale: pctV, commissionRent: pctA });
      if (allUsers[id]) { allUsers[id].commissionSale = pctV; allUsers[id].commissionRent = pctA; }
      showAdminTab('users');
      showToast('Comisión actualizada', `${u.name || 'El agente'}: venta ${pctV}% · alquiler ${pctA}%.`, 'fa-percent');
    } catch (e) {
      showToast('Error', 'No se pudo guardar la comisión: ' + (e.message || e), 'fa-triangle-exclamation');
    }
  }
  async function approveUser(id) {
    await db.collection('users').doc(id).update({
      status: 'approved'
    });
    allUsers[id] = {
      ...allUsers[id],
      status: 'approved'
    };
    showAdminTab('pending');
    showToast('Usuario aprobado', 'El usuario ya puede acceder', 'fa-user-check')
  }
  async function rejectUser(id) {
    await db.collection('users').doc(id).update({
      status: 'rejected'
    });
    showAdminTab('pending')
  }
  async function deleteUser(id) {
    if (!confirm('¿Eliminar?')) return;
    await db.collection('users').doc(id).delete();
    delete allUsers[id];
    showAdminTab('users')
  }
  async function deleteProperty(id) {
    if (!isAdminUser()) { showToast('Solo administradores', 'Solo el administrador puede eliminar propiedades. Como agente, podés archivarla.', 'fa-lock'); return; }
    if (!confirm('¿Eliminar esta propiedad DEFINITIVAMENTE? Esta acción no se puede deshacer. Si solo querés ocultarla, archivala en su lugar.')) return;
    await db.collection('properties').doc(id).delete()
  }
  async function toggleFeatured(id) {
    try {
      const p = properties.find(pr => pr.id === id);
      if (!p) return;
      const newVal = !p.featured;
      await db.collection('properties').doc(id).update({
        featured: newVal
      });
      showToast(newVal ? 'Propiedad destacada' : 'Destacado removido', newVal ? 'La propiedad aparecerá primero' : 'La propiedad volvió al orden normal', 'fa-star')
    } catch (err) {
      console.error('Error toggling featured:', err);
      alert('Error al cambiar destacado')
    }
  }
  // Funciones de compartir
  let currentShareProperty = null;

  function openShareModal(id) {
    const p = properties.find(pr => pr.id === id);
    if (!p) return;
    currentShareProperty = p;
    const url = `${window.location.origin}${window.location.pathname}#propiedad/${id}`;
    document.getElementById('shareTitle').textContent = p.title;
    document.getElementById('sharePrice').textContent = formatPrice(p.price, p.currency || 'USD') + (p.type === 'rent' ? '/mes' : '');
    document.getElementById('shareLocation').textContent = getLocationString(p);
    document.getElementById('shareUrlInput').value = url;
    openModal('shareModal')
  }

  function getShareText() {
    if (!currentShareProperty) return '';
    const p = currentShareProperty;
    return `${p.type==='sale'?'🏠 EN VENTA':'🔑 EN ALQUILER'}: ${p.title}\n💰 ${formatPrice(p.price,p.currency||'USD')}${p.type==='rent'?'/mes':''}\n📍 ${getLocationString(p)}\n${p.bedrooms?`🛏 ${p.bedrooms} dormitorios `:''} ${p.bathrooms?`🚿 ${p.bathrooms} baños`:''}\n`
  }

  function shareToWhatsApp() {
    const url = document.getElementById('shareUrlInput').value;
    const text = encodeURIComponent(getShareText() + '\n' + url);
    window.open(`https://wa.me/?text=${text}`, '_blank')
  }

  function shareToFacebook() {
    const url = encodeURIComponent(document.getElementById('shareUrlInput').value);
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, '_blank')
  }

  function shareToTwitter() {
    const url = document.getElementById('shareUrlInput').value;
    const text = encodeURIComponent(getShareText());
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(url)}`, '_blank')
  }

  function copyShareLink() {
    const input = document.getElementById('shareUrlInput');
    input.select();
    input.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(input.value).then(() => {
      showToast('Enlace copiado', 'El link está listo para compartir', 'fa-link')
    }).catch(() => {
      document.execCommand('copy');
      showToast('Enlace copiado', 'El link está listo para compartir', 'fa-link')
    })
  }
  // Limpiar notificaciones
  async function clearAllNotifications(e) {
    e.stopPropagation();
    if (!currentUser) return;
    if (!confirm('¿Eliminar todas las consultas?')) return;
    try {
      const snap = await db.collection('notifications').where('ownerId', '==', currentUser.uid).get();
      if (snap.empty) {
        showToast('Sin consultas', 'No hay consultas para eliminar', 'fa-info-circle');
        return
      }
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      notifications = [];
      renderNotifications();
      showToast('Bandeja limpia', 'Todas las consultas fueron eliminadas', 'fa-trash')
    } catch (err) {
      console.error('Error clearing notifications:', err);
      showToast('Error', 'No se pudieron eliminar: ' + err.message, 'fa-exclamation-circle')
    }
  }

  // Image Handling
  const uploadArea = document.getElementById('imageUploadArea');
  uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('dragover')
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover')
  });
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    addImagesToPreview(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')))
  });

  function handleImageSelect(e) {
    addImagesToPreview(Array.from(e.target.files));
    e.target.value = ''
  }
  async function addImagesToPreview(fs) {
    for (const f of fs) {
      if (f.size > 5 * 1024 * 1024) {
        alert(`La imagen ${f.name} excede 5MB`);
        continue
      }
      const pr = await compressImageForPreview(f);
      selectedImages.push({
        preview: pr,
        file: f,
        existing: false
      });
      renderImagePreviews()
    }
  }

  function renderImagePreviews() {
    document.getElementById('imagePreviewGrid').innerHTML = selectedImages.map((im, i) => `<div class="image-preview-item ${i===0?'main':''}" draggable="true" ondragstart="handleDragStart(event,${i})" ondragover="handleDragOver(event)" ondragenter="handleDragEnter(event)" ondragleave="handleDragLeave(event)" ondrop="handleDropImage(event,${i})" ondragend="handleDragEnd(event)"><img src="${im.preview}" alt=""><div class="drag-handle"><i class="fas fa-grip-vertical"></i></div><div class="remove-image" onclick="event.stopPropagation();removeImage(${i})"><i class="fas fa-times"></i></div></div>`).join('')
  }

  function handleDragStart(e, i) {
    draggedImageIndex = i;
    e.target.classList.add('dragging')
  }

  function handleDragOver(e) {
    e.preventDefault()
  }

  function handleDragEnter(e) {
    e.preventDefault();
    if (e.target.closest('.image-preview-item')) e.target.closest('.image-preview-item').classList.add('drag-over')
  }

  function handleDragLeave(e) {
    if (e.target.closest('.image-preview-item')) e.target.closest('.image-preview-item').classList.remove('drag-over')
  }

  function handleDropImage(e, ti) {
    e.preventDefault();
    const it = e.target.closest('.image-preview-item');
    if (it) it.classList.remove('drag-over');
    if (draggedImageIndex !== null && draggedImageIndex !== ti) {
      const di = selectedImages[draggedImageIndex];
      selectedImages.splice(draggedImageIndex, 1);
      selectedImages.splice(ti, 0, di);
      renderImagePreviews()
    }
  }

  function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    draggedImageIndex = null;
    document.querySelectorAll('.image-preview-item').forEach(it => it.classList.remove('drag-over'))
  }

  function removeImage(i) {
    selectedImages.splice(i, 1);
    renderImagePreviews()
  }

  function resetPropertyForm() {
    document.getElementById('propertyForm').reset();
    document.getElementById('editingPropertyId').value = '';
    document.getElementById('previousPrice').value = '';
    document.getElementById('propertyModalTitle').textContent = 'Nueva Propiedad';
    document.getElementById('propertyBtn').innerHTML = '<i class="fas fa-check"></i> Publicar Propiedad';
    selectedImages = [];
    renderImagePreviews();
    togglePropertyType();
    selectStatus('available');
    document.getElementById('propCiudad').innerHTML = '<option value="">Primero selecciona departamento</option>';
    document.getElementById('uploadProgress').classList.add('hidden')
  }

  function updateUploadProgress(c, t) {
    const p = document.getElementById('uploadProgress'),
      f = document.getElementById('uploadProgressFill'),
      tx = document.getElementById('uploadProgressText');
    p.classList.remove('hidden');
    const pc = Math.round((c / t) * 100);
    f.style.width = `${pc}%`;
    tx.textContent = `Subiendo imagen ${c} de ${t}...`
  }

  async function handleSaveProperty(e) {
    e.preventDefault();
    if (!currentUser) {
      alert('Debes iniciar sesión');
      return
    }
    if (selectedImages.length === 0) {
      alert('Sube al menos una imagen');
      return
    }
    const b = document.getElementById('propertyBtn'),
      er = document.getElementById('propertyError'),
      ei = document.getElementById('editingPropertyId').value,
      pp = document.getElementById('previousPrice').value;
    b.disabled = true;
    b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    er.classList.add('hidden');
    try {
      const pi = ei || db.collection('properties').doc().id,
        iu = [];
      const itu = selectedImages.filter(im => !im.existing);
      let uc = 0;
      const tt = itu.length;
      for (let i = 0; i < selectedImages.length; i++) {
        const im = selectedImages[i];
        if (im.existing) {
          iu.push(im.url)
        } else {
          uc++;
          updateUploadProgress(uc, tt);
          const url = await uploadImageToStorage(im.file, pi, i);
          iu.push(url)
        }
      }
      const ty = document.getElementById('propType').value,
        dp = document.getElementById('propDepartamento').value,
        cd = document.getElementById('propCiudad').value,
        np = parseInt(document.getElementById('propPrice').value);
      const pd = {
        title: document.getElementById('propTitle').value,
        departamento: dp,
        ciudad: cd,
        direccion: document.getElementById('propDireccion').value,
        location: `${cd}, ${dp}`,
        price: np,
        currency: document.getElementById('propCurrency').value,
        type: ty,
        propertyType: ty === 'sale' ? document.getElementById('propPropertyType').value : 'common',
        bedrooms: parseInt(document.getElementById('propBedrooms').value) || 0,
        bathrooms: parseInt(document.getElementById('propBathrooms').value) || 0,
        totalArea: parseInt(document.getElementById('propTotalArea').value) || 0,
        builtArea: parseInt(document.getElementById('propBuiltArea').value) || 0,
        commonExpenses: parseInt(document.getElementById('propExpenses').value) || 0,
        garage: document.getElementById('propGarage').value,
        status: document.getElementById('propStatus').value,
        images: iu,
        description: document.getElementById('propDescription').value,
        ownerWhatsapp: document.getElementById('propWhatsapp').value || userProfile.whatsapp,
        updatedAt: new Date().toISOString()
      };
      if (ei && pp && parseInt(pp) !== np) {
        pd.previousPrice = parseInt(pp);
        pd.priceChangedAt = new Date().toISOString()
      }
      if (ei) {
        await db.collection('properties').doc(ei).update(pd);
        showToast('Propiedad actualizada', 'Los cambios han sido guardados', 'fa-check')
      } else {
        pd.ownerId = currentUser.uid;
        pd.ownerName = userProfile.name;
        pd.views = 0;
        pd.createdAt = new Date().toISOString();
        await db.collection('properties').doc(pi).set(pd);
        showToast('Propiedad publicada', 'Tu propiedad ya está visible', 'fa-home')
      }
      closeModal('propertyModal');
      resetPropertyForm()
    } catch (err) {
      console.error('Error saving property:', err);
      er.textContent = 'Error: ' + err.message;
      er.classList.remove('hidden')
    } finally {
      b.disabled = false;
      b.innerHTML = "<i class=\"fas fa-check\"></i> Publicar Propiedad"
    }
  }
  let clients = [];

  function isAdminUser() {
    return !!(userProfile && userProfile.email && userProfile.email.toLowerCase() === ADMIN_EMAIL)
  }
  async function loadClients() {
    if (!currentUser) {
      clients = [];
      return
    }
    try {
      // CRM compartido: todos los agentes ven todos los clientes de la inmobiliaria
      const q = await db.collection('clients').get();
      clients = q.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      try {
        const ps = await db.collection('properties').get();
        const counts = {};
        ps.docs.forEach(d => { const cid = d.data().clientId; if (cid) counts[cid] = (counts[cid] || 0) + 1 });
        clients.forEach(c => { c._propCount = counts[c.id] || 0 })
      } catch (e) { console.warn('No se pudo contar propiedades por cliente', e) }
      renderClients()
    } catch (e) {
      console.error('Error cargando clientes:', e)
    }
  }

  function showCRM() {
    if (!currentUser) {
      openModal('loginModal');
      return
    }
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('adminPanel').classList.add('hidden');
    document.getElementById('profilePage').classList.add('hidden');
    document.getElementById('clientProfilePage')?.classList.add('hidden');
    document.getElementById('crmPage').classList.remove('hidden');
    window.location.hash = 'clientes';
    const sub = document.getElementById('crmSubtitle');
    if (sub) sub.textContent = isAdminUser() ? 'Todos los clientes de la inmobiliaria' : 'Gestiona tus clientes y prospectos';
    loadClients()
  }

  function normalizePhone(raw) {
    let d = String(raw || '').replace(/[^\d+]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    if (d.startsWith('598')) d = d.slice(3);
    d = d.replace(/^0+/, '');
    return d ? '+598' + d : '';
  }
  const CLIENT_STATUS = { nuevo: 'Nuevo', contactado: 'Contactado', seguimiento: 'En seguimiento', visita: 'Visita agendada', negociacion: 'En negociación', cerrado: 'Cerrado', perdido: 'Perdido' };
  function renderClients() {
    const g = document.getElementById('crmGrid');
    if (!g) return;
    const term = (document.getElementById('clientSearch').value || '').toLowerCase(),
      sf = document.getElementById('clientStatusFilter').value,
      inf = document.getElementById('clientInterestFilter').value;
    const st = {
      total: clients.length,
      nuevo: clients.filter(c => c.status === 'nuevo').length,
      proceso: clients.filter(c => ['contactado', 'seguimiento', 'visita', 'negociacion'].includes(c.status)).length,
      cerrado: clients.filter(c => c.status === 'cerrado').length
    };
    const se = document.getElementById('crmStats');
    if (se) se.innerHTML = `<div class="crm-stat"><div class="crm-stat-num">${st.total}</div><div class="crm-stat-label">Total clientes</div></div><div class="crm-stat"><div class="crm-stat-num">${st.nuevo}</div><div class="crm-stat-label">Nuevos</div></div><div class="crm-stat"><div class="crm-stat-num">${st.proceso}</div><div class="crm-stat-label">En proceso</div></div><div class="crm-stat"><div class="crm-stat-num">${st.cerrado}</div><div class="crm-stat-label">Cerrados</div></div>`;
    let list = clients.filter(c => {
      const m = !term || (c.name || '').toLowerCase().includes(term) || (c.phone || '').includes(term) || (c.phoneNormalized || '').includes(term) || (c.email || '').toLowerCase().includes(term);
      return m && (!sf || c.status === sf) && (!inf || c.interest === inf)
    });
    list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (list.length === 0) {
      g.innerHTML = `<div class="crm-empty" style="grid-column:1/-1"><i class="fas fa-user-friends"></i><h3>${clients.length===0?'Aún no tienes clientes':'Sin resultados'}</h3><p>${clients.length===0?'Agrega tu primer cliente con el botón Nuevo Cliente':'Probá con otros filtros de búsqueda'}</p></div>`;
      return
    }
    const il = {
      comprar: '<i class="fas fa-key"></i> Quiere comprar',
      alquilar: '<i class="fas fa-home"></i> Busca alquilar',
      vender: '<i class="fas fa-tag"></i> Quiere vender'
    };
    g.innerHTML = list.map(c => {
      const ini = (c.name || '?').charAt(0).toUpperCase(),
        ph = (c.phoneNormalized || c.phone || '').replace(/\D/g, ''),
        so = c.createdByName || c.ownerName;
      return `<div class="client-card" onclick="showClientProfile('${c.id}')" style="cursor:pointer"><div class="client-card-top"><div class="client-avatar">${ini}</div><div class="client-card-name"><h3>${mvEsc(c.name||'Sin nombre')}</h3>${so?`<div class="client-owner"><i class="fas fa-user-tie"></i> ${mvEsc(c.createdByName||c.ownerName)}</div>`:''}<div style="font-size:.74rem;color:var(--gray-500,#999);margin-top:3px"><i class="fas fa-home"></i> ${(c._propCount||0)>0?`${c._propCount} propiedad${c._propCount===1?'':'es'}`:'Sin propiedades'}</div></div><span class="client-status ${c.status||'nuevo'}">${CLIENT_STATUS[c.status]||c.status||'Nuevo'}</span></div>${c.interest&&il[c.interest]?`<div class="client-interest-tag">${il[c.interest]}</div>`:''}<div class="client-meta"><div class="client-meta-row"><i class="fas fa-phone"></i> ${c.phoneNormalized||((c.areaCode||'')+(c.phone||''))||'—'}</div>${c.email?`<div class="client-meta-row"><i class="fas fa-envelope"></i> ${mvEsc(c.email)}</div>`:''}${c.budget?`<div class="client-meta-row"><i class="fas fa-coins"></i> ${mvEsc(c.budget)}</div>`:''}${c.link?`<div class="client-meta-row"><i class="fas fa-link"></i> <a href="${c.link}" target="_blank" rel="noopener" style="color:var(--primary)" onclick="event.stopPropagation()">Ver link</a></div>`:''}</div>${c.notes?`<div class="client-notes-preview">${mvEsc(c.notes)}</div>`:''}<div class="client-actions">${ph?`<a class="ca-wa" href="https://wa.me/${ph}" target="_blank" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i> WhatsApp</a>`:''}<button class="ca-edit" onclick="event.stopPropagation();openClientModal('${c.id}')"><i class="fas fa-edit"></i> Editar</button><button class="ca-del" onclick="event.stopPropagation();deleteClient('${c.id}')"><i class="fas fa-trash"></i></button></div></div>`
    }).join('')
  }

  let currentClientProfileId = null;
  async function showClientProfile(id) {
    const c = clients.find(x => x.id === id);
    if (!c) { showCRM(); return }
    currentClientProfileId = id;
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('adminPanel').classList.add('hidden');
    document.getElementById('profilePage').classList.add('hidden');
    document.getElementById('crmPage').classList.add('hidden');
    document.getElementById('clientProfilePage').classList.remove('hidden');
    window.scrollTo(0, 0);
    document.getElementById('cpAvatar').textContent = (c.name || '?').charAt(0).toUpperCase();
    document.getElementById('cpName').textContent = c.name || 'Cliente';
    const stEl = document.getElementById('cpStatus');
    stEl.textContent = CLIENT_STATUS[c.status] || 'Nuevo';
    stEl.className = 'client-status ' + (c.status || 'nuevo');
    const phoneFull = c.phoneNormalized || ((c.areaCode || '') + (c.phone || ''));
    const meta = [];
    if (phoneFull) meta.push(`<i class="fas fa-phone"></i> ${phoneFull}`);
    if (c.email) meta.push(`<i class="fas fa-envelope"></i> ${c.email}`);
    if (c.createdByName || c.ownerName) meta.push(`<i class="fas fa-user-tie"></i> Creado por ${c.createdByName || c.ownerName}`);
    if (c.createdAt) meta.push(`<i class="fas fa-calendar"></i> ${new Date(c.createdAt).toLocaleDateString('es-UY')}`);
    document.getElementById('cpMeta').innerHTML = meta.join(' &nbsp;·&nbsp; ');
    const wa = document.getElementById('cpWhatsapp'), ph = (phoneFull || '').replace(/\D/g, '');
    if (ph) { wa.href = 'https://wa.me/' + ph; wa.style.display = '' } else { wa.style.display = 'none' }
    document.getElementById('cpNotes').innerHTML = c.notes ? `<div class="client-notes-preview">${mvEsc(c.notes)}</div>` : '';
    renderClientProfileProperties(id)
  }
  async function renderClientProfileProperties(clientId) {
    const grid = document.getElementById('cpPropsGrid'), cnt = document.getElementById('cpPropsCount');
    grid.innerHTML = '<div class="crm-empty" style="grid-column:1/-1"><i class="fas fa-spinner fa-spin"></i><p>Cargando propiedades...</p></div>';
    try {
      const q = await db.collection('properties').where('clientId', '==', clientId).get();
      const props = q.docs.map(d => ({ id: d.id, ...d.data() }));
      props.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      cnt.textContent = props.length === 0 ? 'Sin propiedades aún' : `${props.length} propiedad${props.length === 1 ? '' : 'es'}`;
      if (props.length === 0) {
        grid.innerHTML = `<p style="grid-column:1/-1;color:var(--gray-500,#999);padding:6px 2px;font-size:.92rem">Este cliente todavía no tiene propiedades. Agregá una con el botón de arriba.</p>`;
        return
      }
      grid.innerHTML = props.map(p => {
        const img = p.images && p.images[0] ? p.images[0] : 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=400';
        const agent = p.ownerName || 'Agente';
        return `<div class="property-card" onclick="openPropertyTab('${p.id}')" style="cursor:pointer"><div class="card-image"><img src="${img}" alt="${p.title||''}" loading="lazy"></div><div class="card-content"><div class="card-price">${formatPrice(p.price, p.currency||'USD')}${p.type==='rent'?'<span>/mes</span>':''}</div><h3 class="card-title">${mvEsc(p.title||'Propiedad')}</h3><div class="card-location"><i class="fas fa-map-marker-alt"></i> ${getLocationString(p)}</div><div class="client-meta-row" style="margin-top:8px;color:var(--gray-500,#777)"><i class="fas fa-user-tie"></i> Cargada por ${mvEsc(agent)}</div></div><div class="card-footer"><span class="card-views"><i class="fas fa-eye"></i> ${p.views||0}</span><button class="ca-edit" onclick="event.stopPropagation();openPropertyFormTab('${p.id}')"><i class="fas fa-edit"></i> Editar</button></div></div>`
      }).join('')
    } catch (e) {
      console.error('Error cargando propiedades del cliente:', e);
      cnt.textContent = '';
      grid.innerHTML = `<div class="crm-empty" style="grid-column:1/-1"><i class="fas fa-exclamation-triangle"></i><p>No se pudieron cargar las propiedades.</p></div>`
    }
  }
  function openClientModal(id) {
    const f = document.getElementById('clientForm');
    f.reset();
    document.getElementById('editingClientId').value = id || '';
    document.getElementById('clientError').classList.add('hidden');
    document.getElementById('clientModalTitle').textContent = id ? 'Editar Cliente' : 'Nuevo Cliente';
    if (id) {
      const c = clients.find(x => x.id === id);
      if (c) {
        document.getElementById('clientName').value = c.name || '';
        let _ac = c.areaCode || '+598', _loc = c.phone || '';
        if (!c.areaCode && _loc) { const m = _loc.replace(/\D/g, ''); _loc = m.startsWith('598') ? m.slice(3) : m.replace(/^0+/, ''); }
        document.getElementById('clientAreaCode').value = _ac;
        document.getElementById('clientPhone').value = _loc;
        document.getElementById('clientEmail').value = c.email || '';
        document.getElementById('clientInterest').value = c.interest || '';
        document.getElementById('clientStatus').value = c.status || 'nuevo';
        document.getElementById('clientBudget').value = c.budget || '';
        document.getElementById('clientLink').value = c.link || '';
        document.getElementById('clientNotes').value = c.notes || ''
      }
    }
    openModal('clientModal')
  }
  async function handleSaveClient(e) {
    e.preventDefault();
    if (!currentUser) return;
    const b = document.getElementById('clientBtn'),
      er = document.getElementById('clientError'),
      id = document.getElementById('editingClientId').value;
    const areaCode = document.getElementById('clientAreaCode').value || '+598';
    const local = String(document.getElementById('clientPhone').value || '').replace(/\D/g, '').replace(/^0+/, '');
    const phoneFull = local ? areaCode + local : '';
    er.classList.add('hidden');

    // CRM compartido: un número = un solo cliente. Si ya existe, te llevo a su ficha.
    if (phoneFull && !id) {
      const dup = clients.find(c => (c.phoneNormalized || normalizePhone(c.phone)) === phoneFull);
      if (dup) {
        er.innerHTML = `Este número ya está cargado como <b>${dup.name || 'un cliente'}</b>${dup.createdByName ? ` (lo creó ${dup.createdByName})` : ''}. Te abro su ficha para que trabajes sobre ese.`;
        er.classList.remove('hidden');
        setTimeout(() => openClientModal(dup.id), 1400);
        return;
      }
    }

    b.disabled = true;
    b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    try {
      const data = {
        name: document.getElementById('clientName').value.trim(),
        areaCode: areaCode,
        phone: local,
        phoneNormalized: phoneFull,
        email: document.getElementById('clientEmail').value.trim(),
        interest: document.getElementById('clientInterest').value,
        status: document.getElementById('clientStatus').value,
        budget: document.getElementById('clientBudget').value.trim(),
        link: document.getElementById('clientLink').value.trim(),
        notes: document.getElementById('clientNotes').value.trim(),
        updatedAt: new Date().toISOString()
      };
      if (id) {
        await db.collection('clients').doc(id).update(data);
        showToast('Cliente actualizado', 'Los cambios se guardaron', 'fa-user-check')
      } else {
        data.createdBy = currentUser.uid;
        data.createdByName = userProfile.name || '';
        data.createdAt = new Date().toISOString();
        await db.collection('clients').add(data);
        showToast('Cliente agregado', 'Nuevo cliente registrado', 'fa-user-plus')
      }
      closeModal('clientModal');
      await loadClients()
    } catch (err) {
      console.error('Error guardando cliente:', err);
      er.textContent = 'Error: ' + err.message;
      er.classList.remove('hidden')
    } finally {
      b.disabled = false;
      b.innerHTML = '<i class="fas fa-save"></i> Guardar Cliente'
    }
  }
  async function deleteClient(id) {
    if (!confirm('¿Eliminar este cliente? Esta acción no se puede deshacer.')) return;
    try {
      await db.collection('clients').doc(id).delete();
      showToast('Cliente eliminado', '', 'fa-trash');
      await loadClients()
    } catch (err) {
      alert('Error al eliminar: ' + err.message)
    }
  }
  initDepartamentos();
  _usersReady.catch(() => {}).then(() => loadProperties());
  handleHash();


// ===== Inicio v2: favoritos del visitante (localStorage) y foto del hero =====
function mvFavsGet() { try { return JSON.parse(localStorage.getItem('mvFavs') || '[]'); } catch (e) { return []; } }
function mvEsFav(id) { return mvFavsGet().includes(id); }
function mvToggleFav(ev, id) {
  ev.stopPropagation();
  let f = mvFavsGet();
  f = f.includes(id) ? f.filter(x => x !== id) : f.concat([id]);
  try { localStorage.setItem('mvFavs', JSON.stringify(f)); } catch (e) { /* sin storage */ }
  const b = ev.currentTarget, on = f.includes(id);
  b.classList.toggle('on', on);
  b.innerHTML = '<i class="' + (on ? 'fas' : 'far') + ' fa-heart"></i>';
}
function mvSetHeroPhoto(ps) {
  // La imagen del hero ahora es una foto fija profesional definida en index.html
  // (antes tomaba la primera propiedad y no se integraba bien). No se toca.
}
