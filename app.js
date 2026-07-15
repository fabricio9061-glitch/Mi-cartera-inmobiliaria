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
  // Devuelve la URL solo si es http(s) y NO trae caracteres que permitan romper
  // un atributo o una cadena JS (comillas, < > \ o espacios). Si no, '' .
  // Sirve para meter URLs de usuario en href Y en onclick sin riesgo de XSS.
  function safeUrl(u){ const s = String(u == null ? '' : u).trim(); return /^https?:\/\/[^\s'"<>\\]+$/i.test(s) ? s : ''; }
  const auth = firebase.auth(),
    db = firebase.firestore(),
    storage = firebase.storage(),
    ADMIN_EMAIL = "fabricio9061@gmail.com";

  // ===== Rangos de la inmobiliaria (organigrama) =====
  // 'grupo' arma los optgroups del selector; 'nivel' queda para permisos futuros.
  // El COO (y el CEO) pueden ver la agenda de todo el equipo (ver agenda.html + reglas).
  const RANKS = [
    { key:'ceo',                grupo:'Dirección',   label:'CEO',                            nivel:100 },
    { key:'coo',                grupo:'Dirección',   label:'COO — Director de Operaciones',  nivel:90 },
    { key:'gerente_comercial',  grupo:'Comercial',   label:'Gerente Comercial',              nivel:80 },
    { key:'lider_equipo',       grupo:'Comercial',   label:'Líder de Equipo',                nivel:70 },
    { key:'asesor_elite',       grupo:'Comercial',   label:'Asesor Elite',                   nivel:60 },
    { key:'asesor_senior',      grupo:'Comercial',   label:'Asesor Senior',                  nivel:50 },
    { key:'asesor_semi_senior', grupo:'Comercial',   label:'Asesor Semi Senior',             nivel:40 },
    { key:'asesor_junior',      grupo:'Comercial',   label:'Asesor Junior',                  nivel:30 },
    { key:'coord_admin',        grupo:'Operaciones', label:'Coordinador Administrativo',     nivel:55 },
    { key:'administracion',     grupo:'Operaciones', label:'Administración',                 nivel:45 },
    { key:'marketing',          grupo:'Operaciones', label:'Marketing',                      nivel:45 },
    { key:'procesos_calidad',   grupo:'Operaciones', label:'Procesos y Calidad',             nivel:45 },
    { key:'finanzas',           grupo:'Finanzas',    label:'Finanzas',                       nivel:50 },
  ];
  function rankLabel(key){ const r = RANKS.find(x => x.key === key); return r ? r.label : ''; }

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
    if (!currentUser) return;
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
        return;
      }

      // messaging puede no estar listo todavía; lo inicializamos si hace falta.
      if (!messaging && firebase.messaging) {
        try { messaging = firebase.messaging(); } catch (e) { console.warn('messaging no disponible', e); return; }
      }
      if (!messaging) return;

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
    "Montevideo": ["Aguada", "Aires Puros", "Atahualpa", "Bañados de Carrasco", "Barrio Sur", "Bella Italia", "Bella Vista", "Belvedere", "Brazo Oriental", "Buceo", "Capurro", "Carrasco", "Carrasco Norte", "Casabó", "Casavalle", "Centro", "Cerrito de la Victoria", "Cerro", "Ciudad Vieja", "Colón", "Conciliación", "Cordón", "Flor de Maroñas", "Goes", "Ituzaingó", "Jacinto Vera", "Jardines del Hipódromo", "La Blanqueada", "La Comercial", "La Figurita", "La Paloma", "La Teja", "Larrañaga", "Las Acacias", "Las Canteras", "Lezica", "Malvín", "Malvín Norte", "Manga", "Maroñas", "Melilla", "Mercado Modelo", "Nuevo París", "Palermo", "Parque Batlle", "Parque Rodó", "Paso de la Arena", "Paso de las Duranas", "Paso Molino", "Peñarol", "Piedras Blancas", "Pocitos", "Pocitos Nuevo", "Prado", "Punta Carretas", "Punta Gorda", "Punta Rieles", "Reducto", "Sayago", "Toledo Chico", "Tres Cruces", "Tres Ombúes", "Unión", "Villa Dolores", "Villa Española", "Villa García", "Villa Muñoz", "Vista Linda"].sort((a,b)=>a.localeCompare(b,'es')),
    "Canelones": ["Las Piedras", "Pando", "Canelones", "Santa Lucía", "Progreso", "Atlántida", "Salinas", "Parque del Plata", "Solymar", "Shangrilá", "El Pinar", "Lagomar", "La Floresta", "Paso Carrasco", "Ciudad de la Costa", "San José de Carrasco", "Médanos de Solymar", "Colinas de Solymar", "Colonia Nicolich", "Barros Blancos", "Toledo", "Sauce", "Joaquín Suárez", "Suárez", "La Paz", "Las Toscas", "Pinamar", "Neptunia", "Marindia", "Villa Argentina", "Estación Atlántida", "Balneario Argentino", "Fortín de Santa Rosa", "Costa Azul", "Costa de Oro", "Las Vegas", "Bello Horizonte", "Guazuvirá", "Los Titanes", "Santa Lucía del Este", "Santa Ana", "San Luis", "La Tuna", "Cuchilla Alta", "Jaureguiberry", "Empalme Olmos", "Tala", "San Ramón", "Santa Rosa", "San Jacinto", "San Bautista", "Migues", "Montes", "Soca", "Aguas Corrientes", "Los Cerrillos", "Juanicó", "San Antonio", "El Bosque", "Villa Felicidad"].sort((a,b)=>a.localeCompare(b,'es')),
    "Maldonado": ["Maldonado", "Punta del Este", "San Carlos", "Piriápolis", "Pan de Azúcar", "Aiguá", "Solís", "Bella Vista", "Las Flores", "Playa Verde", "Playa Hermosa", "Playa Grande", "San Francisco", "Punta Colorada", "Punta Negra", "Gregorio Aznárez", "Cerros Azules", "Nueva Carrara", "Punta Ballena", "Solanas", "Sauce de Portezuelo", "Portezuelo", "Chihuahua", "Laguna del Sauce", "Pinares", "La Barra", "El Tesoro", "Manantiales", "El Chorro", "Montoya", "Balneario Buenos Aires", "La Juanita", "José Ignacio", "Santa Mónica", "Pueblo Edén", "Garzón", "Estación Las Flores", "Maldonado Nuevo", "Cerro Pelado", "La Capuera", "Ocean Park", "Las Grutas", "El Placer"].sort((a,b)=>a.localeCompare(b,'es')),
    "Colonia": ["Colonia del Sacramento", "Carmelo", "Juan Lacaze", "Nueva Helvecia", "Rosario", "Nueva Palmira", "Tarariras", "Colonia Valdense", "Ombúes de Lavalle", "Florencio Sánchez", "Conchillas", "Miguelete", "Colonia Cosmopolita"].sort((a,b)=>a.localeCompare(b,'es')),
    "Salto": ["Salto", "Daymán", "Termas del Daymán", "Termas del Arapey", "Belén", "Constitución"].sort((a,b)=>a.localeCompare(b,'es')),
    "Paysandú": ["Paysandú", "Guichón", "Termas de Guaviyú", "Quebracho", "Piedras Coloradas", "Chapicuy", "Porvenir"].sort((a,b)=>a.localeCompare(b,'es')),
    "Río Negro": ["Fray Bentos", "Young", "Nuevo Berlín", "San Javier"].sort((a,b)=>a.localeCompare(b,'es')),
    "Soriano": ["Mercedes", "Dolores", "Cardona", "José Enrique Rodó", "Palmitas", "Villa Soriano"].sort((a,b)=>a.localeCompare(b,'es')),
    "San José": ["San José de Mayo", "Ciudad del Plata", "Libertad", "Rodríguez", "Ecilda Paullier", "Rafael Perazza", "Puntas de Valdez", "Delta del Tigre"].sort((a,b)=>a.localeCompare(b,'es')),
    "Florida": ["Florida", "Sarandí Grande", "Casupá", "Fray Marcos", "25 de Mayo", "25 de Agosto", "Cardal", "Capilla del Sauce"].sort((a,b)=>a.localeCompare(b,'es')),
    "Flores": ["Trinidad", "Ismael Cortinas"].sort((a,b)=>a.localeCompare(b,'es')),
    "Durazno": ["Durazno", "Sarandí del Yí", "Villa del Carmen", "Carmen", "La Paloma", "Blanquillo"].sort((a,b)=>a.localeCompare(b,'es')),
    "Tacuarembó": ["Tacuarembó", "Paso de los Toros", "San Gregorio de Polanco", "Ansina"].sort((a,b)=>a.localeCompare(b,'es')),
    "Rivera": ["Rivera", "Tranqueras", "Vichadero", "Minas de Corrales"].sort((a,b)=>a.localeCompare(b,'es')),
    "Artigas": ["Artigas", "Bella Unión", "Tomás Gomensoro", "Baltasar Brum"].sort((a,b)=>a.localeCompare(b,'es')),
    "Cerro Largo": ["Melo", "Río Branco", "Fraile Muerto", "Aceguá", "Tupambaé"].sort((a,b)=>a.localeCompare(b,'es')),
    "Lavalleja": ["Minas", "José Pedro Varela", "Solís de Mataojo", "Mariscala", "Batlle y Ordóñez", "Pirarajá"].sort((a,b)=>a.localeCompare(b,'es')),
    "Rocha": ["Rocha", "Chuy", "Castillos", "La Paloma", "La Pedrera", "Cabo Polonio", "Punta del Diablo", "Lascano", "Velázquez", "Aguas Dulces", "Barra de Valizas", "La Coronilla", "Punta Rubia"].sort((a,b)=>a.localeCompare(b,'es')),
    "Treinta y Tres": ["Treinta y Tres", "Vergara", "Santa Clara de Olimar", "Cerro Chato"].sort((a,b)=>a.localeCompare(b,'es'))
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

  // Activación de notificaciones DISPARADA POR EL USUARIO (botón). iOS exige que el
  // pedido de permiso venga de un gesto del usuario y que la web esté instalada en la
  // pantalla de inicio; si no, no muestra el diálogo. Esta función da feedback claro.
  async function activarNotificaciones() {
    const ua = navigator.userAgent || '';
    const esIOS = /iphone|ipad|ipod/i.test(ua);
    const esAndroid = /android/i.test(ua);
    const instalada = window.navigator.standalone === true ||
                      window.matchMedia('(display-mode: standalone)').matches;
    // iPhone/iPad: iOS solo permite push web si la app está agregada a la pantalla
    // de inicio y se abre desde ahí. En Safari normal nunca deja activarlas.
    if (esIOS && !instalada) {
      alert('En iPhone, primero agregá la app a tu pantalla de inicio:\n\n1) Tocá el botón Compartir de Safari\n2) "Agregar a inicio"\n3) Abrí MALAVE desde ese ícono\n4) Volvé a tocar "Activar notificaciones"');
      return;
    }
    if (!('Notification' in window)) {
      alert('Tu navegador no soporta notificaciones. Probá con Chrome (Android) o Safari (iPhone).');
      return;
    }
    if (Notification.permission === 'denied') {
      // Instrucción según la plataforma, porque se reactiva distinto en cada una.
      if (esAndroid) {
        alert('Las notificaciones están bloqueadas.\n\nEn Android: tocá el candado 🔒 junto a la dirección → Permisos → Notificaciones → Permitir. Después reintentá.');
      } else if (esIOS) {
        alert('Las notificaciones están bloqueadas.\n\nEn iPhone: Ajustes → Notificaciones → MALAVE, o borrá el ícono de inicio y volvé a agregar la app. Después reintentá.');
      } else {
        alert('Las notificaciones están bloqueadas. Activálas desde el candado 🔒 junto a la dirección del navegador y reintentá.');
      }
      return;
    }
    try {
      await setupFCM(); // pide permiso (gesto del usuario) + registra token
      if (Notification.permission === 'granted') {
        showToast('¡Listo!', 'Notificaciones activadas correctamente', 'fa-bell');
        ocultarBannerNotif();
      } else {
        showToast('No se activaron', 'No diste permiso de notificaciones', 'fa-bell-slash');
      }
    } catch (e) {
      console.warn('activarNotificaciones', e);
      alert('No se pudieron activar las notificaciones. Reintentá en un momento.');
    }
  }
  // Muestra el banner SOLO si: hay sesión iniciada, el navegador soporta
  // notificaciones, el permiso todavía no está concedido, y el usuario no lo
  // cerró antes. El cierre queda guardado en localStorage, así no reaparece en
  // cada apertura. El HTML lo trae oculto de verdad (display:none), por lo que
  // si la sesión se restaura sola y el permiso ya está dado, nunca llega a verse.
  function bannerNotifCerrado() {
    try { return localStorage.getItem('mvNotifBannerCerrado') === '1'; } catch (e) { return false; }
  }
  function refrescarBannerNotif() {
    const b = document.getElementById('notifBanner');
    if (!b) return;
    const debeMostrar = !!currentUser
      && ('Notification' in window)
      && Notification.permission !== 'granted'
      && !bannerNotifCerrado();
    b.style.display = debeMostrar ? 'flex' : 'none';
  }
  function ocultarBannerNotif() {
    try { localStorage.setItem('mvNotifBannerCerrado', '1'); } catch (e) { /* sin storage */ }
    const b = document.getElementById('notifBanner'); if (b) b.style.display = 'none';
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
    if (av) av.innerHTML = (userProfile && userProfile.profilePhoto) ? `<img src="${safeUrl(userProfile.profilePhoto)}" alt="">` : '<i class="fas fa-user"></i>';
    const nm = document.getElementById('mvSideName'); if (nm) nm.textContent = (userProfile && userProfile.name) || 'Usuario';
    const rl = document.getElementById('mvSideRole'); if (rl) rl.textContent = isAdminUser() ? 'Administrador' : 'Agente';
    cargarFinanzasMenu();
    document.getElementById('mvSideAdminGroup')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSideAdmin')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSideRetiros')?.classList.toggle('hidden', !isAdminUser());
    document.getElementById('mvSidePapelera')?.classList.toggle('hidden', !isAdminUser());
    if (isAdminUser()) actualizarBadgePendientes();
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
    notificationCheckInterval = setInterval(() => { loadNotifications(); if (isAdminUser()) actualizarBadgePendientes(); }, 10000)
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
    // Familia de cada notificación, para el filtro Clientes / Propiedades.
    // Clientes: recordatorios del CRM (seguimiento, pausa). Propiedades: consultas
    // de portales/web y (más adelante) vencimientos de alquiler.
    const familiaDe = (n) => (n.type === 'crm_seguimiento' || n.type === 'crm_pausa') ? 'clientes' : 'propiedades';
    const filtro = window._notifFiltro || 'all';
    const visibles = notifications.filter(n => filtro === 'all' || familiaDe(n) === filtro);
    const nCli = notifications.filter(n => familiaDe(n) === 'clientes').length;
    const nProp = notifications.length - nCli;
    const chip = (val, txt) => `<button class="notif-chip ${filtro===val?'active':''}" onclick="setNotifFiltro('${val}')">${txt}</button>`;
    const barra = `<div class="notif-filtros">${chip('all','Todas')}${chip('clientes','Clientes'+(nCli?' ('+nCli+')':''))}${chip('propiedades','Propiedades'+(nProp?' ('+nProp+')':''))}</div>`;
    if (!visibles.length){
      l.innerHTML = barra + '<div class="notification-empty" style="padding:24px 12px"><i class="fas fa-bell-slash"></i><p>Sin avisos en esta categoría</p></div>';
      return;
    }
    l.innerHTML = barra + visibles.map(n => {
      const i = (n.userName || 'A').charAt(0).toUpperCase(),
        ts = n.createdAt ? formatTimeAgo(n.createdAt) : '';
      // Confirmación de despublicación (la ve el admin): botones de acción adentro.
      // Un propietario se perdió o cerró por afuera y su propiedad sigue publicada.
      if (n.type === 'despublicar_confirmar') {
        const acciones = n.handled
          ? `<div class="notification-meta"><span style="color:${n.resultado === 'despublicada' ? '#b91c1c' : '#15803d'};font-weight:700"><i class="fas fa-${n.resultado === 'despublicada' ? 'box-archive' : 'check'}"></i> ${n.resultado === 'despublicada' ? 'Despublicada' : 'Se mantuvo publicada'}</span><span><i class="far fa-clock"></i> ${ts}</span></div>`
          : `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button onclick="confirmarDespublicacion(event,'${n.id}','${n.propertyId}')" style="border:none;background:#b91c1c;color:#fff;border-radius:8px;padding:6px 12px;font-family:inherit;font-size:.78rem;font-weight:700;cursor:pointer"><i class="fas fa-box-archive"></i> Despublicar</button><button onclick="mantenerPublicada(event,'${n.id}','${n.propertyId}')" style="border:1px solid var(--gray-200,#e5e7eb);background:#fff;color:var(--gray-600,#555);border-radius:8px;padding:6px 12px;font-family:inherit;font-size:.78rem;font-weight:700;cursor:pointer">Mantener publicada</button></div><div class="notification-meta" style="margin-top:6px"><span><i class="far fa-clock"></i> ${ts}</span></div>`;
        return `<div class="notification-item ${n.read ? '' : 'unread'}"><div class="notification-avatar" style="background:#fee2e2;color:#b91c1c"><i class="fas fa-house-circle-xmark"></i></div><div class="notification-body"><p><strong>¿Despublicar propiedad?</strong></p><div class="notification-message">${mvEsc((n.text || '').substring(0, 170))}${(n.text || '').length > 170 ? '...' : ''}</div>${acciones}</div></div>`
      }
      // Aviso de ficha incompleta en ML: dorado, clic hacia la propiedad para editarla.
      if (n.type === 'ficha_incompleta') {
        return `<div class="notification-item ${n.read?'':'unread'}" onclick="handleNotificationClick('${n.id}','${n.propertyId}')"><div class="notification-avatar" style="background:#fef9c3;color:#a16207"><i class="fas fa-clipboard-list"></i></div><div class="notification-body"><p><strong>Ficha incompleta</strong></p><div class="notification-message">${mvEsc((n.text||'').substring(0,150))}${(n.text||'').length>150?'...':''}</div><div class="notification-meta"><span><i class="far fa-clock"></i> ${ts}</span></div></div></div>`
      }
      // Aviso de vencimiento de alquiler: naranja, clic hacia la propiedad.
      if (n.type === 'vencimiento_alquiler') {
        return `<div class="notification-item ${n.read?'':'unread'}" onclick="handleNotificationClick('${n.id}','${n.propertyId}')"><div class="notification-avatar" style="background:#ffedd5;color:#c2410c"><i class="fas fa-house-circle-exclamation"></i></div><div class="notification-body"><p><strong>Alquiler por vencer</strong></p><div class="notification-message">${mvEsc((n.text||'').substring(0,150))}${(n.text||'').length>150?'...':''}</div><div class="notification-meta"><span><i class="far fa-clock"></i> ${ts}</span></div></div></div>`
      }
      // Recordatorio de clientes EN PAUSA: azul, clic hacia Clientes.
      if (n.type === 'crm_pausa') {
        return `<div class="notification-item ${n.read?'':'unread'}" onclick="handleCrmNotifClick('${n.id}')"><div class="notification-avatar" style="background:#dbeafe;color:#2563eb"><i class="fas fa-circle-pause"></i></div><div class="notification-body"><p><strong>Clientes en pausa</strong></p><div class="notification-message">${mvEsc((n.text||'').substring(0,140))}${(n.text||'').length>140?'...':''}</div><div class="notification-meta"><span><i class="far fa-clock"></i> ${ts}</span></div></div></div>`
      }
      // Recordatorio del CRM (clientes sin contacto): formato propio y clic hacia Clientes,
      // porque el formato estándar de abajo asume una consulta sobre una propiedad.
      if (n.type === 'crm_seguimiento') {
        return `<div class="notification-item ${n.read?'':'unread'}" onclick="handleCrmNotifClick('${n.id}')"><div class="notification-avatar" style="background:#fef3c7;color:#b45309"><i class="fas fa-user-clock"></i></div><div class="notification-body"><p><strong>Seguimiento de clientes</strong></p><div class="notification-message">${mvEsc((n.text||'').substring(0,140))}${(n.text||'').length>140?'...':''}</div><div class="notification-meta"><span><i class="far fa-clock"></i> ${ts}</span></div></div></div>`
      }
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
  // Clic en el recordatorio de seguimiento: marca leído y va a la página de Clientes.
  function setNotifFiltro(f){ window._notifFiltro = f; renderNotifications(); }
  // El admin confirmó: la propiedad se archiva (sale del sitio; el espejo de estado
  // la baja de Mercado Libre y el feed de InfoCasas la excluye en la próxima lectura).
  async function confirmarDespublicacion(ev, nid, pid) {
    ev.stopPropagation();
    try {
      await db.collection('properties').doc(pid).update({
        status: 'archived',
        despubPendiente: firebase.firestore.FieldValue.delete(),
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await db.collection('notifications').doc(nid).update({ handled: true, resultado: 'despublicada', read: true });
      const n = notifications.find(x => x.id === nid); if (n) { n.handled = true; n.resultado = 'despublicada'; n.read = true; }
      const p = properties.find(x => x.id === pid); if (p) p.status = 'archived';
      renderNotifications();
      showToast('Propiedad despublicada', 'Salió del sitio; los portales se sincronizan solos', 'fa-check');
    } catch (e) { console.error('despublicar:', e); showToast('No se pudo despublicar', (e && e.message) || '', 'fa-exclamation-triangle'); }
  }
  // El admin decidió mantenerla: se limpia el pedido (puede volver a avisarse si
  // más adelante otro evento del propietario lo justifica).
  async function mantenerPublicada(ev, nid, pid) {
    ev.stopPropagation();
    try {
      await db.collection('properties').doc(pid).update({ despubPendiente: firebase.firestore.FieldValue.delete(), updatedAt: new Date().toISOString() });
      await db.collection('notifications').doc(nid).update({ handled: true, resultado: 'mantenida', read: true });
      const n = notifications.find(x => x.id === nid); if (n) { n.handled = true; n.resultado = 'mantenida'; n.read = true; }
      renderNotifications();
      showToast('Se mantiene publicada', '', 'fa-check');
    } catch (e) { console.error(e); showToast('No se pudo guardar', '', 'fa-exclamation-triangle'); }
  }
  async function handleCrmNotifClick(ni) {
    closeNotifications();
    try {
      await db.collection('notifications').doc(ni).update({ read: true });
      const n = notifications.find(nt => nt.id === ni);
      if (n) n.read = true;
      renderNotifications()
    } catch (e) { /* si no se pudo marcar, igual navegamos */ }
    window.location.href = 'clientes.html'
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
      if (!d.exists) {
        // Cuenta en Authentication pero SIN perfil en Firestore (quedó a medias en un
        // registro anterior). La reparamos creando el doc pendiente ahora, así aparece
        // en el panel del admin sin tener que borrarla y volver a registrarse.
        try {
          const esAdmin = (u.email || '').toLowerCase() === ADMIN_EMAIL;
          await db.collection('users').doc(u.uid).set({
            uid: u.uid,
            email: u.email || '',
            name: u.displayName || (u.email ? u.email.split('@')[0] : 'Usuario'),
            whatsapp: '',
            status: esAdmin ? 'approved' : 'pending',
            createdAt: new Date().toISOString(),
            autorreparado: true
          });
          console.log('Perfil reparado para', u.email);
        } catch (e) {
          console.error('No se pudo reparar el perfil:', e);
          auth.signOut();
          alert('Hubo un problema con tu cuenta. Volvé a registrarte o avisale al administrador.');
          return;
        }
        auth.signOut();
        alert('Tu cuenta quedó registrada y está pendiente de aprobación. El administrador ya la puede ver.');
        return;
      }
      if (d.exists) {
        userProfile = d.data();
        if (userProfile.status === 'approved' || userProfile.email.toLowerCase() === ADMIN_EMAIL) {
          currentUser = u;
          allUsers[u.uid] = userProfile;
          updateUI();
          // No pedimos permiso automáticamente (iOS lo bloquea si no es por gesto del
          // usuario). Mostramos el banner con botón "Activar"; si ya está concedido,
          // setupFCM refresca el token en silencio.
          refrescarBannerNotif();
          if ('Notification' in window && Notification.permission === 'granted') setupFCM();
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
      const _nb = document.getElementById('notifBanner'); if (_nb) _nb.style.display = 'none';
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
      if (ua) ua.innerHTML = userProfile.profilePhoto ? `<img src="${safeUrl(userProfile.profilePhoto)}" alt="">` : i;
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
      .ml-chart{ margin-top:10px; background:#f6f8fa; border-radius:12px; padding:12px 14px; }
      .ml-chart-head{ display:flex; justify-content:space-between; align-items:baseline; font-size:.82rem; font-weight:700; color:#16273f; margin-bottom:9px; }
      .ml-chart-head small{ font-weight:600; color:#8a93a0; font-size:.72rem; }
      .ml-chart-bars{ display:flex; align-items:flex-end; gap:2px; height:74px; padding-top:16px; }
      .ml-bar{ flex:1; height:100%; display:flex; align-items:flex-end; min-width:0; position:relative; }
      .ml-bar-fill{ width:100%; background:#1e9e6a; border-radius:3px 3px 0 0; opacity:.8; min-height:3px; transition:opacity .12s; }
      .ml-bar:hover .ml-bar-fill{ opacity:1; }
      .ml-bar-num{ position:absolute; left:50%; transform:translateX(-50%); font-size:.68rem; font-weight:800; color:#157a52; white-space:nowrap; }
      .ml-chart-axis{ display:flex; justify-content:space-between; font-size:.68rem; color:#8a93a0; font-weight:600; margin-top:6px; }
      .ml-chart-total{ font-weight:800; color:#16273f; font-size:.95rem; }
      .ml-note.gold{ background:linear-gradient(135deg,#fdf6e3,#fbf0d0); color:#7a611a; border:1px solid #ecd9a0; }
      .ml-note.gold i{ color:#C9A227; margin-top:2px; }
      .ml-more{ margin-top:10px; }
      .ml-more summary{ cursor:pointer; font-size:.84rem; font-weight:700; color:#6a7280; padding:6px 2px; list-style:none; display:flex; align-items:center; gap:7px; }
      .ml-more summary::-webkit-details-marker{ display:none; }
      .ml-more summary i{ transition:transform .15s; font-size:.7rem; }
      .ml-more[open] summary i{ transform:rotate(90deg); }
      .ml-more ul{ margin-top:8px; }
      .ml-divider{ display:flex; align-items:center; gap:10px; margin:18px 0 10px; }
      .ml-divider .tagchip{ flex:none; padding:3px 9px; border-radius:6px; font-weight:800; font-size:.72rem; letter-spacing:.03em; }
      .ml-divider .line{ flex:1; height:1px; background:#e7eaee; }
      .ml-webline{ margin-top:10px; font-size:.8rem; color:#6a7280; display:flex; gap:14px; flex-wrap:wrap; align-items:center; }
      .ml-webline b{ color:#16273f; }
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
    const m = { free: 'Gratuita', bronze: 'Bronce', silver: 'Plata', gold: 'Oro', gold_special: 'Clásica', gold_pro: 'Oro Premium', gold_premium: 'Oro Premium' };
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
    // Los tipos vienen de ML (lo que ofrece la cuenta en esa categoría). Si no
    // llegaron, el fallback son los planes reales de esta cuenta: Plata/Oro/Oro Premium.
    const lista = (tipos && tipos.length ? tipos : ['silver', 'gold', 'gold_premium']);
    const opts = lista.map(t => `<option value="${t}">${mlListingTypeName(t)}${t === 'free' ? ' — sin costo' : ' — se abona en Mercado Libre'}</option>`).join('');
    const aviso = '';
    return `<div class="ml-label">Tipo de aviso</div><select id="mlTipoAviso" class="ml-select">${opts}</select>${aviso}`;
  }
  // Estado de la propiedad frente al feed de InfoCasas, calculado con las MISMAS
  // reglas que usa el backend. InfoCasas no ofrece estadísticas por API (su
  // integración es el feed, de una sola vía): acá se ve si está sincronizando,
  // por qué no, y el link al aviso si ya se pegó desde Compartir.
  function mlSeccionInfocasas() {
    const p = properties.find(pr => pr.id === mlModalPropId);
    if (!p) return '';
    const EST = { tasacion: 'Pendiente de tasación', tasado: 'Tasada', reserved: 'Reservada', sold: 'Vendida', rented: 'Alquilada', archived: 'Archivada' };
    let motivo = '';
    if (p.cierreConfirmado === true) motivo = 'tiene un cierre confirmado';
    else if (p.status && p.status !== 'available') motivo = 'está en estado "' + (EST[p.status] || p.status) + '" y solo las disponibles van al feed';
    else if (!p.ubicacion || p.ubicacion.lat == null || p.ubicacion.lng == null) motivo = 'no tiene el pin de ubicación en el mapa';
    else if (!(Number(p.price) > 0)) motivo = 'no tiene precio cargado';
    else if (!((p.images || []).filter(Boolean).length)) motivo = 'no tiene fotos';
    else if (!(p.departamento || (p.ubicacion && p.ubicacion.departamento))) motivo = 'no tiene departamento asignado';
    const enFeed = !motivo;
    const corregible = !enFeed && !(p.status && p.status !== 'available') && p.cierreConfirmado !== true;
    const estadoHtml = enFeed
      ? '<div class="ml-note ok"><i class="fas fa-circle-check"></i><div><strong>En el feed:</strong> InfoCasas la sincroniza periódicamente. Los cambios de precio, fotos y descripción viajan solos en la próxima lectura.</div></div>'
      : `<div class="ml-note warn"><i class="fas fa-circle-info"></i><div><strong>Fuera del feed:</strong> ${motivo}.${corregible ? ' Corregilo en <strong>Editar propiedad</strong> y entra sola.' : ''}</div></div>`;
    const linkHtml = (p.infocasasUrl && safeUrl(p.infocasasUrl))
      ? `<a href="${safeUrl(p.infocasasUrl)}" target="_blank" rel="noopener" class="ml-btn ml-btn-ghost" style="margin-top:10px;flex:none"><i class="fas fa-external-link-alt"></i> Ver aviso en InfoCasas</a>`
      : (enFeed ? '<div style="font-size:.8rem;color:#8a93a0;margin-top:8px;line-height:1.45">Cuando el aviso esté en línea, pegá su link desde el botón <strong>Compartir</strong> de la tarjeta y va a aparecer acá.</div>' : '');
    return `<div class="ml-divider"><span class="tagchip" style="background:#dbeafe;color:#1d4ed8">InfoCasas</span><span class="line"></span></div>${estadoHtml}${linkHtml}<div style="font-size:.74rem;color:#a8b0ba;margin-top:8px">InfoCasas no ofrece estadísticas por API: acá solo se ve el estado de sincronización.</div>`;
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
      body.innerHTML = `<div class="ml-ui"><div class="ml-empty"><div class="ml-empty-ic"><i class="fas fa-tag"></i></div><h4>Todavía no está publicada</h4><p>Esta propiedad aún no está en Mercado Libre.</p></div>${_errHtml}<div class="ml-section">${mlTypeSelector(d.tiposDisponibles)}</div><div class="ml-btns"><button class="ml-btn ml-btn-primary" onclick="republicarPropiedad()"><i class="fas fa-upload"></i> Publicar en Mercado Libre</button></div>${mlSeccionInfocasas()}</div>`;
      return
    }
    if (d.error) {
      body.innerHTML = `<div class="ml-ui"><div class="ml-err">${d.error}</div><div class="ml-btns"><button class="ml-btn ml-btn-primary" onclick="republicarPropiedad()"><i class="fas fa-rotate-right"></i> Volver a publicar</button></div></div>`;
      return
    }
    const hp = d.health != null ? Math.round(d.health * 100) : null;
    const _prop = properties.find(pr => pr.id === mlModalPropId) || {};
    const ringColor = hp == null ? '#aeb8c6' : (hp >= 70 ? '#3ddc97' : hp >= 40 ? '#f5b54a' : '#ff7a7a');
    const stColors = { active: '#3ddc97', paused: '#f5b54a', closed: '#ff7a7a', under_review: '#f5b54a', inactive: '#aeb8c6', payment_required: '#f5b54a' };
    const pillColor = stColors[d.status] || '#aeb8c6';
    const hero = `<div class="ml-divider" style="margin-top:0"><span class="tagchip" style="background:#fff159;color:#2d3277">Mercado Libre</span><span class="line"></span></div><div class="ml-hero">${hp != null ? mlRing(hp, ringColor) : ''}<div class="ml-hero-info"><span class="ml-pill" style="color:${pillColor}"><span class="dot"></span>${mlStatusName(d.status)}</span><h4>${mlListingTypeName(d.listingType)}</h4><div class="sub">${hp != null ? 'Calidad del aviso ' + hp + '%' : 'Aviso publicado en Mercado Libre'}</div></div></div>`;
    const _dash = (v) => (v != null ? v : '—');
    const _pregN = (d.preguntas && d.preguntas.total != null) ? d.preguntas.total : null;
    const _pregSR = (d.preguntas && d.preguntas.sinResponder) ? ` · ${d.preguntas.sinResponder} sin responder` : '';
    const _serie = Array.isArray(d.visitasSerie) ? d.visitasSerie : [];
    let _chart = '';
    if (_serie.length > 1) {
      const _tot = _serie.reduce((s, x) => s + (x.total || 0), 0);
      const _fmt = (x) => { const dt = String((x && x.date) || '').slice(0, 10); return dt.length === 10 ? dt.slice(8, 10) + '/' + dt.slice(5, 7) : ''; };
      if (_tot > 0) {
        const _max = Math.max.apply(null, _serie.map(x => x.total || 0));
        let _peak = -1; _serie.forEach((x, i) => { if ((x.total || 0) === _max && _peak === -1) _peak = i; });
        const _bars = _serie.map((x, i) => {
          const nv = x.total || 0;
          const h = Math.max(5, Math.round(nv / _max * 100));
          const num = (i === _peak && nv > 0) ? `<span class="ml-bar-num" style="bottom:calc(${h}% + 3px)">${nv}</span>` : '';
          return `<div class="ml-bar" title="${_fmt(x)}: ${nv} visita${nv === 1 ? '' : 's'}">${num}<div class="ml-bar-fill" style="height:${h}%${nv === 0 ? ';opacity:.25' : ''}"></div></div>`;
        }).join('');
        const _mid = _serie[Math.floor(_serie.length / 2)];
        _chart = `<div class="ml-chart"><div class="ml-chart-head"><span><i class="fas fa-chart-column" style="color:#1e9e6a"></i> Visitas por día</span><span class="ml-chart-total">${_tot} <small style="font-weight:600;color:#8a93a0">en ${_serie.length} días</small></span></div><div class="ml-chart-bars">${_bars}</div><div class="ml-chart-axis"><span>${_fmt(_serie[0])}</span><span>${_fmt(_mid)}</span><span>${_fmt(_serie[_serie.length - 1])}</span></div></div>`;
      } else {
        _chart = `<div class="ml-chart"><div class="ml-chart-head"><span><i class="fas fa-chart-column" style="color:#1e9e6a"></i> Visitas por día</span><small>últimos ${_serie.length} días</small></div><div style="font-size:.82rem;color:#8a93a0;padding:6px 0 2px">Todavía sin visitas registradas en este período.</div></div>`;
      }
    }
    const interaccion = `<div class="ml-section"><div class="ml-stats"><div class="ml-stat"><i class="fas fa-eye" style="color:#1e9e6a"></i><div><div class="n">${_dash(d.visitas)}</div><div class="t">visitas · 30 días</div></div></div><div class="ml-stat"><i class="fas fa-circle-question" style="color:#2e86de"></i><div><div class="n">${_dash(_pregN)}</div><div class="t">preguntas${_pregSR}</div></div></div><div class="ml-stat"><i class="fab fa-whatsapp" style="color:#25d366"></i><div><div class="n">${_dash(d.contactosWhatsapp)}</div><div class="t">contactos WhatsApp · 30 días</div></div></div></div>${_chart}<div class="ml-webline"><span>En tu web:</span><span><i class="fas fa-eye"></i> <b>${_prop.views || 0}</b> visitas</span><span><i class="fab fa-whatsapp" style="color:#25d366"></i> <b>${_prop.contactClicks || 0}</b> contactos</span><span style="color:#a8b0ba">· histórico del sitio</span></div></div>`;
    const pagoHint = d.status === 'payment_required' ? `<div class="ml-section"><div class="ml-note warn"><i class="fas fa-circle-info"></i><div>El aviso está creado pero Mercado Libre exige pagar el tipo <strong>${mlListingTypeName(d.listingType)}</strong> para activarlo (se abona desde tu cuenta de ML, sección Publicaciones). Si no querés pagarlo, dale <strong>Dar de baja</strong> y volvé a publicarlo eligiendo otro tipo. Mientras no lo pagues, no se cobra nada.</div></div></div>` : '';
    // Qué falta para el 100%: lo MÁS confiable es comparar los atributos de la
    // categoría contra los que el aviso tiene cargados (d.faltan, lo calcula el
    // backend y NO depende de la calidad de ML). Si por algo no viene, caemos al
    // detalle de /performance, después a /health, y por último a fotos/descripción.
    // Qué falta: obligatorios SIEMPRE visibles. Al 100% se festeja (nada de listas
    // contradictorias bajo el anillo lleno): los opcionales quedan plegados. El id
    // de ML se muestra chiquito solo al admin, para alinear el formulario sin adivinar.
    let improve = '';
    const _faltan = Array.isArray(d.faltan) ? d.faltan : [];
    const _adm = typeof isAdminUser === 'function' && isAdminUser();
    // Atributos que NO se completan en la ficha sino en otra parte del formulario.
    const _pistas = { HOUSE_NUMBER: 'se completa en Ubicación → Número' };
    const _item = (x, icon, iconStyle) => {
      const extra = _pistas[x.id]
        ? ` <small style="color:#a8b0ba">· ${_pistas[x.id]}</small>`
        : (_adm && x.id ? ` <small style="color:#a8b0ba">· ${mvEsc(x.id)}</small>` : '');
      return `<li><i class="${icon}"${iconStyle ? ` style="${iconStyle}"` : ''}></i><span>${mvEsc(x.nombre)}${extra}</span></li>`;
    };
    const _guia = '<div style="font-size:.8rem;color:#8a7a45;margin-top:8px;line-height:1.4">Completalos en <strong>Editar propiedad → Ficha técnica</strong> y guardá: se actualizan solos en Mercado Libre.</div>';
    const _oro = '<div class="ml-note gold"><i class="fas fa-trophy"></i><div><strong>¡Publicación al 100%!</strong> El aviso tiene la máxima calidad que mide Mercado Libre: mejor posición en los resultados y más visitas.</div></div>';
    const reqs = _faltan.filter(x => x && x.req);
    const opts = _faltan.filter(x => x && !x.req);
    let hImp = '';
    if (reqs.length) {
      hImp += '<div class="ml-improve-title">Datos obligatorios sin completar</div><ul class="ml-improve">' + reqs.map(x => _item(x, 'fas fa-triangle-exclamation', 'color:#e8a33d')).join('') + '</ul>';
    }
    if (hp != null && hp >= 99 && !reqs.length) {
      hImp += _oro;
      if (opts.length) {
        hImp += `<details class="ml-more"><summary><i class="fas fa-chevron-right"></i>Datos opcionales que todavía podés sumar (${opts.length})</summary><ul class="ml-improve">` + opts.slice(0, 20).map(x => _item(x, 'fas fa-arrow-up')).join('') + `</ul>${_guia}</details>`;
      }
      improve = `<div class="ml-section">${hImp}</div>`;
    } else if (reqs.length || opts.length) {
      if (opts.length) {
        const CAP = 14, shown = opts.slice(0, CAP), rest = opts.length - shown.length;
        hImp += `<div class="ml-improve-title"${reqs.length ? ' style="margin-top:10px"' : ''}>Completá estos datos para subir la calidad</div><ul class="ml-improve">`
          + shown.map(x => _item(x, 'fas fa-arrow-up')).join('')
          + (rest > 0 ? `<li style="opacity:.65"><i class="fas fa-ellipsis-h"></i><span>y ${rest} dato${rest === 1 ? '' : 's'} más</span></li>` : '')
          + '</ul>';
      }
      improve = `<div class="ml-section">${hImp}${_guia}</div>`;
    } else {
      let _mej = [];
      const _vis = new Set();
      if (d.mejoras && d.mejoras.length) {
        d.mejoras.forEach(m => { const t = ((m && m.titulo) || '').trim(); if (t && !_vis.has(t)) { _vis.add(t); _mej.push(t); } });
      } else if (d.actions && d.actions.length) {
        d.actions.forEach(a => { const t = mlActionText(a); if (t && !_vis.has(t)) { _vis.add(t); _mej.push(t); } });
      }
      const acc = _mej.map(tx => `<li><i class="fas fa-arrow-up"></i><span>${mvEsc(tx)}</span></li>`).join('');
      if (hp != null && hp >= 99) {
        improve = `<div class="ml-section">${_oro}</div>`;
      } else if (acc) {
        improve = `<div class="ml-section"><div class="ml-improve-title">Para llegar al 100%, completá:</div><ul class="ml-improve">${acc}</ul>${_guia}</div>`;
      } else if (hp != null && hp < 99) {
        improve = `<div class="ml-section"><div class="ml-note warn"><i class="fas fa-circle-info"></i><div>Sumá <strong>más fotos</strong> (al menos 12) y una <strong>descripción</strong> más completa para subir la calidad.</div></div></div>`;
      } else {
        improve = `<div class="ml-section"><div class="ml-note ok"><i class="fas fa-circle-check"></i><div>El aviso está completo, sin mejoras pendientes.</div></div></div>`;
      }
    }
    const selTipo = d.status === 'closed' ? `<div class="ml-section">${mlTypeSelector(d.tiposDisponibles)}</div>` : '';
    const botones = [];
    if (d.permalink) botones.push(`<a href="${d.permalink}" target="_blank" rel="noopener" class="ml-btn ml-btn-ghost"><i class="fas fa-external-link-alt"></i> Ver aviso</a>`);
    if (d.status === 'paused' || d.status === 'closed') botones.push(`<button class="ml-btn ml-btn-primary" onclick="republicarPropiedad()"><i class="fas fa-rotate-right"></i> Republicar</button>`);
    if (d.status !== 'closed') botones.push(`<button class="ml-btn ml-btn-danger" onclick="bajaPropiedad()"><i class="fas fa-circle-stop"></i> Dar de baja</button>`);
    body.innerHTML = `<div class="ml-ui">${hero}${interaccion}${pagoHint}${improve}${mlSeccionInfocasas()}${selTipo}<div class="ml-btns">${botones.join('')}</div></div>`
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

  // ---- Bloqueo del scroll de fondo mientras hay algo abierto encima ----
  // En iPhone, con un modal abierto el dedo movía la página de atrás: en iOS
  // overflow:hidden no alcanza. El método robusto es FIJAR el body
  // (position:fixed) guardando dónde estaba el scroll, y devolverlo al cerrar.
  // El estado se deriva del DOM (¿queda algún .active?) para que el bloqueo
  // jamás quede colgado aunque un modal se cierre por otro camino.
  let _scrollFondo = 0;
  function sincronizarBloqueoFondo() {
    const abierto = document.querySelector('.modal.active, .lightbox.active') !== null;
    const bloqueado = document.body.style.position === 'fixed';
    if (abierto && !bloqueado) {
      _scrollFondo = window.scrollY || document.documentElement.scrollTop || 0;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${_scrollFondo}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
    } else if (!abierto && bloqueado) {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.width = '';
      window.scrollTo(0, _scrollFondo);
    }
  }

  function openModal(i) {
    document.getElementById(i).classList.add('active');
    sincronizarBloqueoFondo();
    if (i === 'loginModal') loadRememberedUser()
  }

  function closeModal(i) {
    document.getElementById(i).classList.remove('active');
    sincronizarBloqueoFondo()
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

  // ===================================================================
  // CONTRATOS DE ALQUILER (panel en el detalle de la propiedad)
  // Modelo: property.contratos[] es el historial completo; el vigente es el que
  // tiene vigente:true. Cada contrato guarda fechaInicio, fechaFin, el inquilino
  // (nombre/clientId) y los hitos de aviso ya notificados. Renovar NO reemplaza:
  // cierra el vigente y agrega uno nuevo, así queda el historial de renovaciones.
  // Solo el dueño de la propiedad (o admin) ve y edita este panel.
  // ===================================================================
  function fmtFecha(iso){ if(!iso) return '—'; const d=new Date(iso+'T00:00:00'); return isNaN(d)?iso:d.toLocaleDateString('es-UY',{day:'2-digit',month:'2-digit',year:'numeric'}); }
  function diasHastaFin(iso){ if(!iso) return null; const f=new Date(iso+'T00:00:00'); const h=new Date(); h.setHours(0,0,0,0); return Math.round((f-h)/86400000); }
  function contratoVigente(p){ return (p.contratos||[]).find(c=>c&&c.vigente) || null; }

  function renderDetailContrato(p){
    const box = document.getElementById('detailContrato');
    if (!box){ return; }
    // Solo para el dueño/admin y solo si es un alquiler (o ya tiene contratos).
    const puede = canEditProperty(p);
    const esAlquiler = p.type === 'rent' || (p.contratos && p.contratos.length);
    if (!puede || !esAlquiler){ box.innerHTML = ''; return; }

    const cv = contratoVigente(p);
    // Caso 1: alquilada SIN contrato vigente → falta cargarlo. Esto cubre los tres
    // caminos de cierre (perfil, mapa de cierres, cierre de gestión): la fuente de
    // verdad es el estado de la propiedad, no un flag que solo pone un camino.
    if (!cv && (p.status === 'rented' || p.contratoPendiente)){
      box.innerHTML = `<div class="ctr-panel ctr-pending"><div class="ctr-head"><i class="fas fa-file-signature"></i> Falta cargar el contrato</div><p class="ctr-p">Esta propiedad está marcada como alquilada. Cargá la fecha de fin del contrato y el inquilino para activar los avisos de vencimiento a 90, 60 y 30 días.</p><button class="ctr-btn primary" onclick="abrirModalContrato('${p.id}',false)"><i class="fas fa-plus"></i> Cargar contrato</button></div>`;
      return;
    }

    // Caso 2: alquilada con contrato vigente.
    if (cv){
      const d = diasHastaFin(cv.fechaFin);
      let alerta = '';
      if (d != null){
        if (d < 0) alerta = `<span class="ctr-chip venc">Venció hace ${-d} día${d===-1?'':'s'}</span>`;
        else if (d <= 30) alerta = `<span class="ctr-chip r30">Vence en ${d} días</span>`;
        else if (d <= 90) alerta = `<span class="ctr-chip r90">Vence en ${d} días</span>`;
        else alerta = `<span class="ctr-chip ok">Vence en ${d} días</span>`;
      }
      const inq = cv.inquilinoNombre ? `<div class="ctr-row"><i class="fas fa-user"></i> Inquilino: <b>${mvEsc(cv.inquilinoNombre)}</b>${cv.inquilinoClientId?` <a href="clientes.html" class="ctr-link">ver ficha</a>`:''}</div>` : '';
      const nRenov = (p.contratos||[]).length;
      const histBtn = nRenov > 1 ? `<button class="ctr-btn ghost" onclick="verHistorialContratos('${p.id}')"><i class="fas fa-clock-rotate-left"></i> Historial (${nRenov})</button>` : '';
      box.innerHTML = `<div class="ctr-panel"><div class="ctr-head"><i class="fas fa-key"></i> Contrato de alquiler ${alerta}</div>
        <div class="ctr-row"><i class="fas fa-calendar"></i> Del <b>${fmtFecha(cv.fechaInicio)}</b> al <b>${fmtFecha(cv.fechaFin)}</b></div>
        ${inq}
        <div class="ctr-actions">
          <button class="ctr-btn" onclick="abrirModalContrato('${p.id}',true)"><i class="fas fa-pen"></i> Editar</button>
          <button class="ctr-btn primary" onclick="abrirModalRenovar('${p.id}')"><i class="fas fa-rotate"></i> Renovar</button>
          <button class="ctr-btn ghost" onclick="finalizarContrato('${p.id}')"><i class="fas fa-flag-checkered"></i> Terminó / volver al mercado</button>
          ${histBtn}
        </div></div>`;
      return;
    }

    // Caso 3: alquiler disponible (no rented) que YA tuvo contratos → mostrar el
    // historial. Si nunca tuvo contrato y está disponible, no se muestra nada
    // (todavía no se alquiló): el panel aparecerá recién al marcarla alquilada.
    if ((p.contratos||[]).length){
      const n = p.contratos.length;
      box.innerHTML = `<div class="ctr-panel"><div class="ctr-head"><i class="fas fa-key"></i> Alquiler · disponible</div><p class="ctr-p">No hay un contrato vigente. Esta propiedad tuvo ${n} contrato${n===1?'':'s'} antes.</p><button class="ctr-btn ghost" onclick="verHistorialContratos('${p.id}')"><i class="fas fa-clock-rotate-left"></i> Ver historial (${n})</button></div>`;
      return;
    }
    box.innerHTML = '';
  }

  // ---- Modal para cargar / editar el contrato vigente ----
  function abrirModalContrato(pid, editando){
    const p = properties.find(x=>x.id===pid); if(!p) return;
    const cv = editando ? contratoVigente(p) : null;
    const hoy = new Date().toISOString().slice(0,10);
    const finDefault = cv ? cv.fechaFin : '';
    const iniDefault = cv ? cv.fechaInicio : hoy;
    const ov = document.createElement('div');
    ov.className = 'ctr-overlay'; ov.id = 'ctrOverlay';
    ov.onclick = e => { if(e.target===ov) ov.remove(); };
    const inpCss = 'width:100%;padding:10px 12px;border:1px solid var(--gray-200,#e5e7eb);border-radius:10px;font-family:inherit;font-size:.9rem;margin-bottom:12px;box-sizing:border-box';
    const lblCss = 'display:block;font-size:.78rem;font-weight:600;color:var(--gray-600,#555);margin:0 0 4px';
    ov.innerHTML = `<div class="ctr-modal">
      <h3><i class="fas fa-file-signature" style="color:var(--accent,#C9A227)"></i> ${editando?'Editar contrato':'Cargar contrato'}</h3>
      <label style="${lblCss}">Inicio del contrato</label>
      <input type="date" id="ctrInicio" value="${iniDefault}" style="${inpCss}">
      <label style="${lblCss}">Fin del contrato</label>
      <input type="date" id="ctrFin" value="${finDefault}" style="${inpCss}">
      <div class="ctr-quick"><button type="button" onclick="ctrCalcFin(1)">1 año</button><button type="button" onclick="ctrCalcFin(2)">2 años</button></div>
      <label style="${lblCss}">Inquilino (nombre)</label>
      <input type="text" id="ctrInquilino" value="${mvEsc((cv&&cv.inquilinoNombre)||'')}" placeholder="Nombre del inquilino" style="${inpCss}">
      <label style="${lblCss} display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" id="ctrGuardarCliente" ${cv&&cv.inquilinoClientId?'':'checked'} style="width:auto;margin:0"> Guardarlo como contacto en el CRM</label>
      <div class="ctr-modal-actions">
        <button class="ctr-btn" onclick="document.getElementById('ctrOverlay').remove()">Cancelar</button>
        <button class="ctr-btn primary" onclick="guardarContrato('${pid}',${!!editando})">Guardar</button>
      </div></div>`;
    document.body.appendChild(ov);
  }
  function ctrCalcFin(anios){
    const ini = document.getElementById('ctrInicio').value || new Date().toISOString().slice(0,10);
    const d = new Date(ini+'T00:00:00'); d.setFullYear(d.getFullYear()+anios);
    document.getElementById('ctrFin').value = d.toISOString().slice(0,10);
  }
  async function guardarContrato(pid, editando){
    const p = properties.find(x=>x.id===pid); if(!p) return;
    const ini = document.getElementById('ctrInicio').value;
    const fin = document.getElementById('ctrFin').value;
    const inq = (document.getElementById('ctrInquilino').value||'').trim();
    const guardarCli = document.getElementById('ctrGuardarCliente').checked;
    if (!fin){ showToast('Falta la fecha de fin', 'Es la que dispara los avisos de vencimiento', 'fa-exclamation-triangle'); return; }
    if (ini && fin < ini){ showToast('Fechas invertidas', 'El fin no puede ser antes del inicio', 'fa-exclamation-triangle'); return; }
    try {
      let inquilinoClientId = editando ? (contratoVigente(p)||{}).inquilinoClientId || null : null;
      // Vincular / crear el inquilino como contacto si se pidió y hay nombre.
      if (guardarCli && inq && !inquilinoClientId){
        const nuevo = { name: inq, phone: '', status: 'nuevo', source: 'inquilino',
          notes: `Inquilino de: ${p.title||'una propiedad'}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (currentUser){ nuevo.createdBy = p.ownerId||currentUser.uid; nuevo.agentId = p.ownerId||currentUser.uid; nuevo.ownerId = p.ownerId||currentUser.uid; }
        const ref = await db.collection('clients').add(nuevo);
        inquilinoClientId = ref.id;
      }
      const nuevoContrato = { fechaInicio: ini||new Date().toISOString().slice(0,10), fechaFin: fin,
        inquilinoNombre: inq, inquilinoClientId, vigente: true, hitosAvisados: [], creadoEn: new Date().toISOString() };
      let contratos = (p.contratos||[]).slice();
      if (editando){
        const i = contratos.findIndex(c=>c&&c.vigente);
        if (i>=0) contratos[i] = Object.assign({}, contratos[i], { fechaInicio: nuevoContrato.fechaInicio, fechaFin: fin, inquilinoNombre: inq, inquilinoClientId, hitosAvisados: [] });
        else contratos.push(nuevoContrato);
      } else {
        contratos.forEach(c=>{ if(c) c.vigente=false; });
        contratos.push(nuevoContrato);
      }
      await db.collection('properties').doc(pid).update({
        contratos, status: 'rented',
        contratoPendiente: firebase.firestore.FieldValue.delete(),
        contratoPendienteGestion: firebase.firestore.FieldValue.delete(),
        updatedAt: new Date().toISOString()
      });
      p.contratos = contratos; delete p.contratoPendiente;
      document.getElementById('ctrOverlay')?.remove();
      renderDetailContrato(p);
      showToast('Contrato guardado', 'Los avisos de vencimiento quedan activos', 'fa-check');
    } catch(e){ console.error('contrato:', e); showToast('No se pudo guardar', (e&&e.message)||'', 'fa-exclamation-triangle'); }
  }

  // ---- Renovar: cierra el vigente y abre uno nuevo (conserva historial) ----
  function abrirModalRenovar(pid){
    const p = properties.find(x=>x.id===pid); if(!p) return;
    const cv = contratoVigente(p);
    const iniNuevo = cv && cv.fechaFin ? cv.fechaFin : new Date().toISOString().slice(0,10);
    const ov = document.createElement('div');
    ov.className = 'ctr-overlay'; ov.id = 'ctrOverlay';
    ov.onclick = e => { if(e.target===ov) ov.remove(); };
    const inpCss = 'width:100%;padding:10px 12px;border:1px solid var(--gray-200,#e5e7eb);border-radius:10px;font-family:inherit;font-size:.9rem;margin-bottom:12px;box-sizing:border-box';
    const lblCss = 'display:block;font-size:.78rem;font-weight:600;color:var(--gray-600,#555);margin:0 0 4px';
    ov.innerHTML = `<div class="ctr-modal">
      <h3><i class="fas fa-rotate" style="color:var(--accent,#C9A227)"></i> Renovar contrato</h3>
      <p class="ctr-p" style="margin-top:0">El contrato actual queda en el historial y se crea un período nuevo.</p>
      <label style="${lblCss}">Inicio del nuevo período</label>
      <input type="date" id="ctrInicio" value="${iniNuevo}" style="${inpCss}">
      <label style="${lblCss}">Fin del nuevo período</label>
      <input type="date" id="ctrFin" value="" style="${inpCss}">
      <div class="ctr-quick"><button type="button" onclick="ctrCalcFin(1)">1 año</button><button type="button" onclick="ctrCalcFin(2)">2 años</button></div>
      <label style="${lblCss}">Inquilino</label>
      <input type="text" id="ctrInquilino" value="${mvEsc((cv&&cv.inquilinoNombre)||'')}" placeholder="Mismo inquilino u otro" style="${inpCss}">
      <div class="ctr-modal-actions">
        <button class="ctr-btn" onclick="document.getElementById('ctrOverlay').remove()">Cancelar</button>
        <button class="ctr-btn primary" onclick="confirmarRenovacion('${pid}')">Renovar</button>
      </div></div>`;
    document.body.appendChild(ov);
  }
  async function confirmarRenovacion(pid){
    const p = properties.find(x=>x.id===pid); if(!p) return;
    const ini = document.getElementById('ctrInicio').value;
    const fin = document.getElementById('ctrFin').value;
    const inq = (document.getElementById('ctrInquilino').value||'').trim();
    if (!fin){ showToast('Falta la fecha de fin', '', 'fa-exclamation-triangle'); return; }
    if (ini && fin < ini){ showToast('Fechas invertidas', '', 'fa-exclamation-triangle'); return; }
    try {
      const cv = contratoVigente(p);
      let contratos = (p.contratos||[]).slice();
      // Cerrar el vigente (queda en historial con marca de renovado).
      contratos.forEach(c=>{ if(c&&c.vigente){ c.vigente=false; c.renovadoEn=new Date().toISOString(); } });
      contratos.push({ fechaInicio: ini||new Date().toISOString().slice(0,10), fechaFin: fin,
        inquilinoNombre: inq, inquilinoClientId: (cv&&cv.inquilinoClientId)||null,
        vigente: true, hitosAvisados: [], creadoEn: new Date().toISOString(), esRenovacion: true });
      await db.collection('properties').doc(pid).update({ contratos, status:'rented', updatedAt:new Date().toISOString() });
      p.contratos = contratos;
      document.getElementById('ctrOverlay')?.remove();
      renderDetailContrato(p);
      showToast('Contrato renovado', 'Se creó un nuevo período y se guardó el anterior', 'fa-check');
    } catch(e){ console.error('renovar:', e); showToast('No se pudo renovar', '', 'fa-exclamation-triangle'); }
  }

  // ---- Finalizar: el inquilino se fue, la propiedad vuelve al mercado ----
  async function finalizarContrato(pid){
    const p = properties.find(x=>x.id===pid); if(!p) return;
    if (!confirm('¿El contrato terminó y la propiedad vuelve a estar disponible? El inquilino quedará como antiguo inquilino en el historial.')) return;
    try {
      let contratos = (p.contratos||[]).slice();
      contratos.forEach(c=>{ if(c&&c.vigente){ c.vigente=false; c.finalizadoEn=new Date().toISOString(); } });
      await db.collection('properties').doc(pid).update({
        contratos, status:'available',
        finalizadaPorGestion: firebase.firestore.FieldValue.delete(),
        updatedAt:new Date().toISOString()
      });
      p.contratos = contratos; p.status='available';
      renderDetailContrato(p);
      showToast('Propiedad disponible', 'Vuelve al mercado y al feed en la próxima sincronización', 'fa-check');
    } catch(e){ console.error('finalizar:', e); showToast('No se pudo actualizar', '', 'fa-exclamation-triangle'); }
  }

  // ---- Historial de contratos (períodos anteriores) ----
  function verHistorialContratos(pid){
    const p = properties.find(x=>x.id===pid); if(!p) return;
    const lista = (p.contratos||[]).slice().reverse();
    const ov = document.createElement('div');
    ov.className = 'ctr-overlay'; ov.id = 'ctrOverlay';
    ov.onclick = e => { if(e.target===ov) ov.remove(); };
    const filas = lista.map((c,i)=>{
      const estado = c.vigente ? '<span class="ctr-chip ok">Vigente</span>' : (i===0?'':'')+'<span class="ctr-chip" style="background:#f1f5f9;color:#64748b">Finalizado</span>';
      return `<div class="ctr-hist-item"><div><b>${fmtFecha(c.fechaInicio)} → ${fmtFecha(c.fechaFin)}</b> ${estado}</div>${c.inquilinoNombre?`<div class="ctr-hist-sub"><i class="fas fa-user"></i> ${mvEsc(c.inquilinoNombre)}${c.vigente?' (inquilino actual)':' (antiguo inquilino)'}</div>`:''}</div>`;
    }).join('');
    ov.innerHTML = `<div class="ctr-modal"><h3><i class="fas fa-clock-rotate-left" style="color:var(--accent,#C9A227)"></i> Historial de contratos</h3><div class="ctr-hist">${filas||'<p class="ctr-p">Sin contratos registrados.</p>'}</div><div class="ctr-modal-actions"><button class="ctr-btn primary" onclick="document.getElementById('ctrOverlay').remove()">Cerrar</button></div></div>`;
    document.body.appendChild(ov);
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

  // Espera a que la sesión de auth esté realmente lista y con token vigente, para
  // que las reglas de Firestore reciban request.auth != null en la primera escritura.
  function esperarSesion(user) {
    return new Promise((resolve) => {
      let listo = false;
      const finish = async () => {
        if (listo) return; listo = true;
        try { await user.getIdToken(true); } catch (e) { /* seguimos igual */ }
        resolve();
      };
      // Si ya hay currentUser con el mismo uid, listo; si no, esperamos el evento.
      if (auth.currentUser && auth.currentUser.uid === user.uid) { finish(); return; }
      const unsub = auth.onAuthStateChanged((u) => {
        if (u && u.uid === user.uid) { unsub(); finish(); }
      });
      // Red de seguridad: no colgarse más de 4s esperando el evento.
      setTimeout(finish, 4000);
    });
  }

  // Escribe el perfil reintentando si falla por permisos/timing (hasta 3 intentos,
  // con una pausa creciente y refrescando el token entre intentos).
  async function escribirPerfilConReintento(uid, ud) {
    let ultimoError = null;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        await db.collection('users').doc(uid).set(ud);
        return; // éxito
      } catch (err) {
        ultimoError = err;
        console.warn(`Registro: intento ${intento} de escribir el perfil falló:`, err && err.code);
        if (intento < 3) {
          await new Promise(r => setTimeout(r, 700 * intento));
          try { if (auth.currentUser) await auth.currentUser.getIdToken(true); } catch (e) {}
        }
      }
    }
    throw ultimoError; // los 3 intentos fallaron
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

      // IMPORTANTE (fix registros que no aparecían): tras crear la cuenta, la sesión
      // de auth puede tardar un instante en propagarse. Si escribimos el perfil antes
      // de que esté lista, las reglas ven request.auth == null y RECHAZAN la escritura
      // por permisos: queda la cuenta en Authentication pero SIN doc en Firestore, y el
      // panel no la ve. Por eso: (1) esperamos a que auth.currentUser esté confirmado,
      // (2) forzamos un token fresco, y (3) reintentamos la escritura si falla.
      await esperarSesion(uc.user);
      await escribirPerfilConReintento(uc.user.uid, ud);

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
      return `<div class="property-card ${st!=='available'?`status-${st}`:''} ${isFeatured?'featured':''}" onclick="openPropertyTab('${p.id}')"><div class="card-image"><img src="${p.images?.[0]||'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800'}" alt="${mvEsc(p.title)}" loading="lazy">${st!=='available'?`<div class="property-status-overlay ${st}"><div class="status-ribbon ${st}">${stLabel}</div></div>`:''}<div class="card-badges">${isFeatured?'<span class="badge badge-featured"><i class="fas fa-star"></i> DESTACADA</span>':''}<span class="badge ${p.type==='sale'?'badge-sale':'badge-rent'}">${p.type==='sale'?'VENTA':'ALQUILER'}</span>${p.type==='sale'&&p.propertyType==='ph'?'<span class="badge badge-ph">PH</span>':''}${c==='UYU'?'<span class="badge badge-currency">UYU</span>':''}${p.garage==='yes'?'<span class="badge badge-garage"><i class="fas fa-car"></i></span>':''}${hop?`<span class="badge badge-reduced">-${pdp}%</span>`:''}</div>${ce?`<div class="card-actions"><button class="card-action-btn calendar" onclick="event.stopPropagation();openVisitModal('${p.id}')" title="Agendar visita"><i class="fas fa-calendar-plus"></i></button><button class="card-action-btn edit" onclick="event.stopPropagation();openPropertyFormTab('${p.id}')" title="Editar"><i class="fas fa-edit"></i></button><button class="card-action-btn" onclick="event.stopPropagation();openMLModal('${p.id}')" title="Mercado Libre" style="background:#fff159;color:#2d3277"><i class="fas fa-tag"></i></button><button class="btn-feature ${p.featured?'active':''}" onclick="event.stopPropagation();toggleFeatured('${p.id}')" title="${p.featured?'Quitar destacado':'Destacar'}"><i class="fas fa-star"></i></button><button class="card-action-btn delete" onclick="event.stopPropagation();deleteProperty('${p.id}')" title="Eliminar"><i class="fas fa-trash"></i></button></div>`:''}<div class="card-owner" onclick="event.stopPropagation();showProfile('${p.ownerId}')">${o.profilePhoto?`<img src="${safeUrl(o.profilePhoto)}" alt="">`:`<div class="card-owner-initial">${oi}</div>`}<span>${mvEsc(o.name||'Usuario')}</span></div></div><div class="card-content"><div class="card-price ${hop?'card-price-reduced':''}">${hop?`<span class="card-price-old">${formatPrice(p.previousPrice,c)}</span>`:''}${formatPrice(p.price,c)}${p.type==='rent'?'<span>/mes</span>':''}${hop?`<span class="price-drop-badge" style="color:#FFFFFF!important">-${pdp}%</span>`:''}</div><h3 class="card-title">${mvEsc(p.title)}</h3><div class="card-location"><i class="fas fa-map-marker-alt"></i>${mvEsc(l)}</div><div class="card-features">${p.bedrooms?`<div class="card-feature"><i class="fas fa-bed"></i>${p.bedrooms}</div>`:''}${p.bathrooms?`<div class="card-feature"><i class="fas fa-bath"></i>${p.bathrooms}</div>`:''}${p.totalArea?`<div class="card-feature"><i class="fas fa-expand"></i>${p.totalArea}m²</div>`:''}${p.builtArea?`<div class="card-feature"><i class="fas fa-home"></i>${p.builtArea}m² edif.</div>`:''}${p.garage==='yes'?`<div class="card-feature"><i class="fas fa-car"></i>Garaje</div>`:''}</div></div><div class="card-footer"><div style="display:flex;gap:12px;align-items:center"><span class="card-views"><i class="fas fa-eye"></i> ${p.views||0}</span>${ce?`<span class="card-views" title="Tocaron Contactar"><i class="fab fa-whatsapp" style="color:#25d366"></i> ${p.contactClicks||0}</span>`:''}</div><div style="display:flex;gap:8px"><button class="btn-share" onclick="event.stopPropagation();openShareModal('${p.id}')" title="Compartir"><i class="fas fa-share-alt"></i></button>${hi?`<button class="btn-instagram" onclick="event.stopPropagation();window.open('${safeUrl(o.instagram)}','_blank')"><i class="fab fa-instagram"></i></button>`:''}<button class="btn-whatsapp" onclick="event.stopPropagation();contactWhatsapp('${p.id}')"><i class="fab fa-whatsapp"></i> Contactar</button></div></div></div>`
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
    const link = (url, cls, title, icon) => {
      const safe = safeUrl(url);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="profile-social-link ${cls}" title="${title}"><i class="${icon}"></i></a>` : '';
    };
    if (ud.instagram && ud.instagram.includes('instagram.com')) html += link(ud.instagram, 'instagram', 'Instagram', 'fab fa-instagram');
    if (ud.facebook && ud.facebook.includes('facebook.com')) html += link(ud.facebook, 'facebook', 'Facebook', 'fab fa-facebook-f');
    if (ud.linkedin && ud.linkedin.includes('linkedin.com')) html += link(ud.linkedin, 'linkedin', 'LinkedIn', 'fab fa-linkedin-in');
    if (ud.twitter && (ud.twitter.includes('twitter.com') || ud.twitter.includes('x.com'))) html += link(ud.twitter, 'twitter', 'Twitter/X', 'fab fa-twitter');
    if (ud.tiktok && ud.tiktok.includes('tiktok.com')) html += link(ud.tiktok, 'tiktok', 'TikTok', 'fab fa-tiktok');
    if (ud.youtube && ud.youtube.includes('youtube.com')) html += link(ud.youtube, 'youtube', 'YouTube', 'fab fa-youtube');
    if (ud.website) html += link(ud.website, '', 'Sitio Web', 'fas fa-globe');
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
    document.getElementById('profileAvatar').innerHTML = ud.profilePhoto ? `<img src="${safeUrl(ud.profilePhoto)}" alt="">` : i;
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
  // ===== Finanzas del agente en el menú (saldo a cobrar + puntos) =====
  // Lee los cierres CONFIRMADOS donde el usuario es el agente, calcula su comisión
  // (misma regla que el mapa de cierres) y los puntos de recompensa (1 por cada
  // US$100 de su ganancia). No duplica datos: es la misma fuente que ya existe.
  let _finBusy = false;
  // Calcula el estado financiero de CUALQUIER agente (saldo USD/UYU y puntos).
  // Misma lógica que el menú personal: cierres propios + participaciones en equipo
  // + referidos − retiros, MÁS los ajustes manuales del admin (correcciones
  // auditables). Recibe el uid y su perfil (para las comisiones). Devuelve montos
  // sin redondear; el que muestra decide el formato.
  async function calcularFinanzasAgente(uid, perfil, cfg) {
    perfil = perfil || {};
    if (!cfg) { cfg = { puntosPor100: 1, dolarPesos: 40 }; try { const c = await db.collection('config').doc('recompensas').get(); if (c.exists) cfg = Object.assign(cfg, c.data()); } catch (e) {} }
    const DEF_SALE = 3, DEF_MONTHS = 1;
    let sumUSD = 0, sumUYU = 0, pts = 0;

    // 1) Cierres propios
    const snap = await db.collection('properties').where('ownerId', '==', uid).get();
    snap.forEach(d => {
      const p = d.data();
      if (!p.cierre || p.cierreConfirmado !== true) return;
      const c = p.cierre;
      let gan = (c.gananciaAgente != null && c.gananciaAgente !== '' && isFinite(Number(c.gananciaAgente))) ? Number(c.gananciaAgente) : null;
      if (gan == null) {
        const precio = Number(c.precio) || 0;
        const comAg = (c.tipo === 'venta') ? precio * ((c.agencyPct != null ? Number(c.agencyPct) : DEF_SALE) / 100) : precio * (c.agencyMonths != null ? Number(c.agencyMonths) : DEF_MONTHS);
        const pct = (c.tipo === 'venta') ? Number(perfil.commissionSale) : Number(perfil.commissionRent);
        gan = pct ? comAg * pct / 100 : 0;
      }
      const moneda = c.moneda || 'USD';
      if (moneda === 'UYU') sumUYU += gan; else sumUSD += gan;
      const ganUSD = moneda === 'UYU' ? (cfg.dolarPesos > 0 ? gan / cfg.dolarPesos : 0) : gan;
      pts += Math.floor(ganUSD / 100) * (Number(cfg.puntosPor100) || 1);
    });

    // 2) Participaciones en equipo (cierres de otros donde este agente figura)
    try {
      const eqSnap = await db.collection('properties').where('cierreConfirmado', '==', true).get();
      eqSnap.forEach(d => {
        const p = d.data();
        if (!p.cierre || p.cierre.agenteUid === uid) return;
        const parts = Array.isArray(p.cierre.participantes) ? p.cierre.participantes : [];
        const mia = parts.find(x => x.uid === uid);
        if (!mia) return;
        const monto = Number(mia.monto) || 0;
        if (!monto) return;
        const moneda = p.cierre.moneda || 'USD';
        if (moneda === 'UYU') sumUYU += monto; else sumUSD += monto;
        const mUSD = moneda === 'UYU' ? (cfg.dolarPesos > 0 ? monto / cfg.dolarPesos : 0) : monto;
        pts += Math.floor(mUSD / 100) * (Number(cfg.puntosPor100) || 1);
      });
    } catch (e) { console.warn('[finanzas agente] equipo', e && e.message); }

    // 3) Referidos (este agente refirió a otros y cobra su %)
    try {
      const refSnap = await db.collection('referidos').where('referrerUid', '==', uid).get();
      for (const rd of refSnap.docs) {
        const refInfo = rd.data();
        const pctS = Number(refInfo.pctSale) || 0, pctR = Number(refInfo.pctRent) || 0;
        if (!pctS && !pctR) continue;
        const cs = await db.collection('properties').where('ownerId', '==', rd.id).get();
        cs.forEach(d => {
          const p = d.data();
          if (!p.cierre || p.cierreConfirmado !== true) return;
          const c = p.cierre;
          const ganRef = (c.gananciaAgente != null && c.gananciaAgente !== '' && isFinite(Number(c.gananciaAgente))) ? Number(c.gananciaAgente) : 0;
          const rfPct = (c.tipo === 'venta') ? pctS : pctR;
          if (!ganRef || !rfPct) return;
          const miParte = ganRef * rfPct / 100;
          const moneda = c.moneda || 'USD';
          if (moneda === 'UYU') sumUYU += miParte; else sumUSD += miParte;
        });
      }
    } catch (e) { console.warn('[finanzas agente] referidos', e && e.message); }

    // Guardar el bruto ganado (antes de retiros/ajustes) para mostrarlo desglosado
    const ganadoUSD = sumUSD, ganadoUYU = sumUYU, ganadoPts = pts;

    // 4) Ajustes manuales del admin (correcciones auditables). Suman o restan a
    //    saldo y/o puntos según su signo. Cada uno guarda motivo, autor y fecha.
    let ajUSD = 0, ajUYU = 0, ajPts = 0;
    try {
      const aj = await db.collection('ajustesFinancieros').where('agenteUid', '==', uid).get();
      aj.forEach(d => {
        const a = d.data();
        ajUSD += Number(a.montoUSD) || 0;
        ajUYU += Number(a.montoUYU) || 0;
        ajPts += Number(a.puntos) || 0;
      });
    } catch (e) { console.warn('[finanzas agente] ajustes', e && e.message); }
    sumUSD += ajUSD; sumUYU += ajUYU; pts += ajPts;

    // 5) Retiros (bajan el saldo, no los puntos)
    let retUSD = 0, retUYU = 0;
    try {
      const rs = await db.collection('retiros').where('agenteUid', '==', uid).get();
      rs.forEach(d => {
        const r = d.data();
        if (r.status === 'pagado' || r.status === 'pendiente' || r.status === 'aprobado') {
          const m = Number(r.monto) || 0;
          if (r.moneda === 'UYU') retUYU += m; else retUSD += m;
        }
      });
    } catch (e) { console.warn('[finanzas agente] retiros', e && e.message); }
    sumUSD -= retUSD; sumUYU -= retUYU;
    sumUSD = Math.max(0, sumUSD); sumUYU = Math.max(0, sumUYU); pts = Math.max(0, pts);

    return { usd: sumUSD, uyu: sumUYU, pts, ganadoUSD, ganadoUYU, ganadoPts, ajUSD, ajUYU, ajPts, retUSD, retUYU, cfg };
  }

  async function cargarFinanzasMenu() {
    if (_finBusy || !currentUser) return;
    _finBusy = true;
    try {
      // Config de puntos (para convertir pesos y saber el valor del punto)
      let cfg = { puntosPor100: 1, dolarPesos: 40 };
      try { const c = await db.collection('config').doc('recompensas').get(); if (c.exists) cfg = Object.assign(cfg, c.data()); } catch (e) {}

      const snap = await db.collection('properties').where('ownerId', '==', currentUser.uid).get();
      const DEF_SALE = 3, DEF_MONTHS = 1;
      let sumUSD = 0, sumUYU = 0, pts = 0;
      snap.forEach(d => {
        const p = d.data();
        if (!p.cierre || p.cierreConfirmado !== true) return;
        const c = p.cierre;
        // Ganancia del agente: la cargada en el cierre, o estimada por su comisión
        let gan = (c.gananciaAgente != null && c.gananciaAgente !== '' && isFinite(Number(c.gananciaAgente)))
          ? Number(c.gananciaAgente) : null;
        if (gan == null) {
          const precio = Number(c.precio) || 0;
          const comAg = (c.tipo === 'venta')
            ? precio * ((c.agencyPct != null ? Number(c.agencyPct) : DEF_SALE) / 100)
            : precio * (c.agencyMonths != null ? Number(c.agencyMonths) : DEF_MONTHS);
          const pct = (c.tipo === 'venta') ? Number(userProfile.commissionSale) : Number(userProfile.commissionRent);
          gan = pct ? comAg * pct / 100 : 0;
        }
        const moneda = c.moneda || 'USD';
        if (moneda === 'UYU') sumUYU += gan; else sumUSD += gan;
        const ganUSD = moneda === 'UYU' ? (cfg.dolarPesos > 0 ? gan / cfg.dolarPesos : 0) : gan;
        pts += Math.floor(ganUSD / 100) * (Number(cfg.puntosPor100) || 1);
      });

      // Participaciones en EQUIPO: cierres de OTROS agentes donde yo figuro como
      // participante con un monto fijo. Sumo mi parte y mis puntos por esa parte.
      try {
        const eqSnap = await db.collection('properties').where('cierreConfirmado', '==', true).get();
        eqSnap.forEach(d => {
          const p = d.data();
          if (!p.cierre || p.cierre.agenteUid === currentUser.uid) return; // los míos ya se contaron
          const parts = Array.isArray(p.cierre.participantes) ? p.cierre.participantes : [];
          const mia = parts.find(x => x.uid === currentUser.uid);
          if (!mia) return;
          const monto = Number(mia.monto) || 0;
          if (!monto) return;
          const moneda = p.cierre.moneda || 'USD';
          if (moneda === 'UYU') sumUYU += monto; else sumUSD += monto;
          const mUSD = moneda === 'UYU' ? (cfg.dolarPesos > 0 ? monto / cfg.dolarPesos : 0) : monto;
          pts += Math.floor(mUSD / 100) * (Number(cfg.puntosPor100) || 1);
        });
      } catch (e) { console.warn('[finanzas menú] equipo', e && e.message); }

      // Ganancia por REFERIDOS: si yo referí a otros agentes, cobro mi % de lo que
      // ganó cada uno en sus cierres confirmados. El % (por venta/alquiler) está en
      // referidos/{uidReferido}. Se suma solo al confirmarse el cierre del referido.
      try {
        const refSnap = await db.collection('referidos').where('referrerUid', '==', currentUser.uid).get();
        for (const rd of refSnap.docs) {
          const refInfo = rd.data();
          const referidoUid = rd.id; // el doc se identifica por el uid del referido
          const pctS = Number(refInfo.pctSale) || 0, pctR = Number(refInfo.pctRent) || 0;
          if (!pctS && !pctR) continue;
          const cs = await db.collection('properties').where('ownerId', '==', referidoUid).get();
          cs.forEach(d => {
            const p = d.data();
            if (!p.cierre || p.cierreConfirmado !== true) return;
            const c = p.cierre;
            // Ganancia del referido en ese cierre (base para mi %)
            const ganRef = (c.gananciaAgente != null && c.gananciaAgente !== '' && isFinite(Number(c.gananciaAgente)))
              ? Number(c.gananciaAgente) : 0;
            const rfPct = (c.tipo === 'venta') ? pctS : pctR;
            if (!ganRef || !rfPct) return;
            const miParte = ganRef * rfPct / 100;
            const moneda = c.moneda || 'USD';
            if (moneda === 'UYU') sumUYU += miParte; else sumUSD += miParte;
          });
        }
      } catch (e) { console.warn('[finanzas menú] referidos', e && e.message); }

      // Descontar retiros: los pagados ya salieron, y los pendientes/aprobados están
      // comprometidos. El SALDO a cobrar es lo ganado menos eso (los PUNTOS no bajan:
      // se ganan al cerrar y quedan). Esto corrige que el saldo no bajara al pagar.
      try {
        const rs = await db.collection('retiros').where('agenteUid', '==', currentUser.uid).get();
        rs.forEach(d => {
          const r = d.data();
          if (r.status === 'pagado' || r.status === 'pendiente' || r.status === 'aprobado') {
            const m = Number(r.monto) || 0;
            if (r.moneda === 'UYU') sumUYU -= m; else sumUSD -= m;
          }
        });
      } catch (e) { console.warn('[finanzas menú] retiros', e && e.message); }
      sumUSD = Math.max(0, sumUSD); sumUYU = Math.max(0, sumUYU);

      const usdEl = document.getElementById('mvFinUsd');
      const uyuEl = document.getElementById('mvFinUyu');
      const puntosEl = document.getElementById('mvFinPuntos');
      const rUsd = Math.round(sumUSD), rUyu = Math.round(sumUYU);
      if (usdEl) usdEl.textContent = 'US$ ' + rUsd.toLocaleString('es-UY');
      if (uyuEl) {
        uyuEl.textContent = '$U ' + rUyu.toLocaleString('es-UY');
        // Mostrar la línea de pesos solo si hay saldo en pesos (evita "$U 0" al pedo).
        uyuEl.style.display = rUyu ? '' : 'none';
      }
      if (puntosEl) puntosEl.textContent = pts.toLocaleString('es-UY');
    } catch (e) {
      console.warn('[finanzas menú]', e && e.message);
      ['mvFinUsd','mvFinUyu','mvFinPuntos'].forEach(function(id){ var e=document.getElementById(id); if(e) e.textContent='—'; });
    } finally {
      _finBusy = false;
    }
  }

  // Cuenta usuarios pendientes de aprobación leyendo la colección directamente.
  // Es a prueba de fallos: no depende de la Cloud Function ni del push. Aunque la
  // notificación no llegue, el admin ve acá cuántos registros esperan aprobación.
  async function actualizarBadgePendientes() {
    try {
      const s = await db.collection('users').where('status', '==', 'pending').get();
      const n = s.size;
      const badge = document.getElementById('mvPendBadge');
      if (badge) {
        badge.textContent = n;
        badge.style.display = n > 0 ? 'inline-flex' : 'none';
      }
    } catch (e) { console.warn('[pendientes]', e && e.message); }
  }

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
    // Datos de cobro
    poblarBancos();
    document.getElementById('editBanco').value = userProfile.bancoNombre || '';
    document.getElementById('editCuentaTitular').value = userProfile.cuentaTitular || '';
    document.getElementById('editCuentaCI').value = userProfile.cuentaCI || '';
    document.getElementById('editCuentaNumero').value = userProfile.cuentaNumero || '';
    document.getElementById('editCuentaMoneda').value = userProfile.cuentaMoneda || '';
    document.getElementById('editCuentaTipo').value = userProfile.cuentaTipo || '';
    document.getElementById('userDropdown')?.classList.remove('active');
    openModal('editProfileModal')
  }

  // Bancos y emisores de dinero electrónico habilitados en Uruguay (BCU).
  const BANCOS_UY = [
    'BROU - Banco República', 'Banco Itaú', 'Santander', 'BBVA', 'Scotiabank',
    'HSBC', 'Banco Heritage', 'Citibank', 'Banque Heritage', 'Banco de la Nación Argentina',
    'BANDES', 'Prex', 'Mi Dinero', 'Midinero', 'OCA Blue', 'Anda', 'Creditel', 'Otro'
  ];
  function poblarBancos() {
    const sel = document.getElementById('editBanco');
    if (!sel || sel.dataset.filled) return;
    sel.insertAdjacentHTML('beforeend', BANCOS_UY.map(b => `<option value="${b}">${b}</option>`).join(''));
    sel.dataset.filled = '1';
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
        bancoNombre: document.getElementById('editBanco').value,
        cuentaTitular: document.getElementById('editCuentaTitular').value.trim(),
        cuentaCI: document.getElementById('editCuentaCI').value.trim(),
        cuentaNumero: document.getElementById('editCuentaNumero').value.trim(),
        cuentaMoneda: document.getElementById('editCuentaMoneda').value,
        cuentaTipo: document.getElementById('editCuentaTipo').value,
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
    document.getElementById('detailOwnerAvatar').innerHTML = o.profilePhoto ? `<img src="${safeUrl(o.profilePhoto)}" alt="">` : oi;
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
    renderDetailContrato(p);
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
    sincronizarBloqueoFondo()
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
    sincronizarBloqueoFondo()
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
  // ===== Editor de datos del agente (solo admin) =====
  // El sitio público resuelve el nombre desde el perfil (getOwnerInfo prefiere
  // allUsers), así que ahí alcanza con editar users/{uid}. Pero clientes y
  // propiedades guardan COPIAS (createdByName / ownerName): al cambiar el
  // nombre, el guardado las propaga para que no queden nombres viejos en el CRM.
  // El email no se toca acá: es el usuario de ingreso y vive en Authentication.
  let _edAgenteUid = null;
  async function abrirEditorAgente(uid) {
    cerrarEditorAgente();
    let u = allUsers[uid];
    try { const d = await db.collection('users').doc(uid).get(); if (d.exists) u = { id: d.id, ...d.data() }; } catch (e) { /* uso la copia en memoria */ }
    if (!u) { showToast('No se encontró el perfil', '', 'fa-exclamation-triangle'); return; }
    _edAgenteUid = uid;
    const ov = document.createElement('div');
    ov.id = 'agenteEditorOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,25,40,.55);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px';
    ov.addEventListener('click', (e) => { if (e.target === ov) cerrarEditorAgente(); });
    const lbl = 'display:block;font-size:.78rem;font-weight:600;color:var(--gray-600,#555);margin:0 0 4px';
    const inp = 'width:100%;padding:10px 12px;border:1px solid var(--gray-200,#e5e7eb);border-radius:10px;font-family:inherit;font-size:.9rem;margin-bottom:12px;box-sizing:border-box';
    ov.innerHTML = `<div style="background:#fff;border-radius:16px;max-width:420px;width:100%;padding:22px;box-shadow:0 20px 60px rgba(10,20,35,.35)">
      <h3 style="margin:0 0 4px;font-size:1.05rem;color:var(--primary,#16273f)"><i class="fas fa-pen" style="color:var(--accent,#C9A227)"></i> Editar agente</h3>
      <p style="margin:0 0 14px;font-size:.78rem;color:var(--gray-500,#8a93a0)">${mvEsc(u.email || '')} · el email es el usuario de ingreso y no se edita desde acá</p>
      <label style="${lbl}">Nombre y apellido</label>
      <input id="edAgNombre" type="text" value="${mvEsc(u.name || '')}" style="${inp}">
      <label style="${lbl}">WhatsApp</label>
      <input id="edAgWhatsapp" type="text" value="${mvEsc(u.whatsapp || '')}" placeholder="598 99 123 456" style="${inp}">
      <label style="${lbl}">Instagram (sin @)</label>
      <input id="edAgInstagram" type="text" value="${mvEsc(u.instagram || '')}" placeholder="usuario" style="${inp}">
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
        <button onclick="cerrarEditorAgente()" style="border:1px solid var(--gray-200,#e5e7eb);background:#fff;border-radius:10px;padding:9px 16px;font-family:inherit;font-size:.85rem;font-weight:600;color:var(--gray-600,#555);cursor:pointer">Cancelar</button>
        <button onclick="guardarEditorAgente()" style="border:none;background:var(--primary,#16273f);color:#fff;border-radius:10px;padding:9px 18px;font-family:inherit;font-size:.85rem;font-weight:600;cursor:pointer">Guardar</button>
      </div></div>`;
    document.body.appendChild(ov);
  }
  function cerrarEditorAgente() { const ov = document.getElementById('agenteEditorOverlay'); if (ov) ov.remove(); }
  async function guardarEditorAgente() {
    const uid = _edAgenteUid; if (!uid) return;
    const nombre = (document.getElementById('edAgNombre').value || '').trim();
    const whatsapp = (document.getElementById('edAgWhatsapp').value || '').trim();
    const instagram = (document.getElementById('edAgInstagram').value || '').trim().replace(/^@/, '');
    if (!nombre) { showToast('Falta el nombre', 'El agente necesita un nombre visible', 'fa-exclamation-triangle'); return; }
    const previo = (allUsers[uid] && allUsers[uid].name) || '';
    try {
      await db.collection('users').doc(uid).update({ name: nombre, whatsapp, instagram, updatedAt: new Date().toISOString() });
      // Propagar el nombre a las copias desnormalizadas (propiedades y clientes).
      // Escala actual: decenas de docs por agente, entra cómodo en un batch (tope 500).
      if (nombre !== previo) {
        const [ps, cs1, cs2] = await Promise.all([
          db.collection('properties').where('ownerId', '==', uid).get(),
          db.collection('clients').where('createdBy', '==', uid).get(),
          db.collection('clients').where('ownerId', '==', uid).get(),
        ]);
        const batch = db.batch();
        let ops = 0;
        ps.docs.forEach(d => { batch.update(d.ref, { ownerName: nombre }); ops++; });
        const vistos = {};
        cs1.docs.concat(cs2.docs).forEach(d => {
          if (vistos[d.id]) return; vistos[d.id] = true;
          const c = d.data(), upd = {};
          if (c.createdByName != null) upd.createdByName = nombre;
          if (c.ownerName != null) upd.ownerName = nombre;
          if (Object.keys(upd).length) { batch.update(d.ref, upd); ops++; }
        });
        if (ops) await batch.commit();
        properties.forEach(p => { if (p.ownerId === uid) p.ownerName = nombre; });
      }
      if (allUsers[uid]) Object.assign(allUsers[uid], { name: nombre, whatsapp, instagram });
      cerrarEditorAgente();
      const tabU = document.getElementById('tabUsers');
      if (tabU && tabU.classList.contains('active')) showAdminTab('users');
      showToast('Agente actualizado', nombre !== previo ? 'El nombre se propagó a sus propiedades y clientes' : '', 'fa-check');
    } catch (e) {
      console.error('No se pudo guardar el agente:', e);
      showToast('No se pudo guardar', (e && e.message) || '', 'fa-exclamation-triangle');
    }
  }

  // ===== Panel financiero del agente (solo admin) =====
  // Muestra el saldo (USD/UYU) y los puntos calculados, con el desglose (ganado −
  // retiros ± ajustes), el historial de ajustes, y un formulario para registrar
  // una corrección. Los ajustes NO sobrescriben nada: son movimientos que entran
  // en el mismo cálculo, con motivo/autor/fecha, así queda auditoría de todo.
  let _finAgenteUid = null;
  async function abrirFinanzasAgente(uid) {
    cerrarFinanzasAgente();
    let u = allUsers[uid];
    try { const d = await db.collection('users').doc(uid).get(); if (d.exists) u = { id: d.id, ...d.data() }; } catch (e) {}
    if (!u) { showToast('No se encontró el perfil', '', 'fa-exclamation-triangle'); return; }
    _finAgenteUid = uid;
    const ov = document.createElement('div');
    ov.id = 'finAgenteOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,25,40,.55);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px';
    ov.addEventListener('click', e => { if (e.target === ov) cerrarFinanzasAgente(); });
    ov.innerHTML = `<div id="finAgenteBox" style="background:#fff;border-radius:16px;max-width:460px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(10,20,35,.35);padding:22px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <h3 style="margin:0;font-size:1.05rem;color:var(--primary,#16273f)"><i class="fas fa-wallet" style="color:var(--accent,#C9A227)"></i> ${mvEsc(u.name||'Agente')}</h3>
        <button onclick="cerrarFinanzasAgente()" style="border:none;background:var(--gray-100,#f1f5f9);width:30px;height:30px;border-radius:50%;cursor:pointer;color:var(--gray-500)"><i class="fas fa-times"></i></button>
      </div>
      <p style="font-size:.78rem;color:var(--gray-500,#8a93a0);margin:0 0 16px">${mvEsc(u.email||'')}</p>
      <div id="finAgenteBody"><div class="loading" style="padding:30px"><div class="spinner"></div></div></div>
    </div>`;
    document.body.appendChild(ov);
    await renderFinanzasAgente(uid, u);
  }
  function cerrarFinanzasAgente() { const o = document.getElementById('finAgenteOverlay'); if (o) o.remove(); }

  async function renderFinanzasAgente(uid, u) {
    const body = document.getElementById('finAgenteBody');
    if (!body) return;
    let f;
    try { f = await calcularFinanzasAgente(uid, u); }
    catch (e) { body.innerHTML = '<p style="color:var(--danger)">No se pudo calcular. ' + mvEsc((e&&e.message)||'') + '</p>'; return; }
    const vPunto = Number(f.cfg.valorPunto) || 0;
    const money = (n) => Math.round(n).toLocaleString('es-UY');
    // Historial de ajustes
    let ajustes = [];
    try { const aj = await db.collection('ajustesFinancieros').where('agenteUid','==',uid).get(); ajustes = aj.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||'')); } catch(e){}
    const histHtml = ajustes.length ? ajustes.map(a=>{
      const partes = [];
      if (a.montoUSD) partes.push((a.montoUSD>0?'+':'')+'US$ '+money(a.montoUSD));
      if (a.montoUYU) partes.push((a.montoUYU>0?'+':'')+'$U '+money(a.montoUYU));
      if (a.puntos) partes.push((a.puntos>0?'+':'')+a.puntos+' pts');
      return `<div style="padding:9px 0;border-bottom:1px solid var(--gray-100,#f1f5f9);font-size:.82rem"><div style="display:flex;justify-content:space-between;gap:8px"><b style="color:${(a.montoUSD||a.montoUYU||a.puntos)>=0?'#15803d':'#b91c1c'}">${partes.join(' · ')||'—'}</b><button onclick="borrarAjuste('${a.id}','${uid}')" style="border:none;background:transparent;color:var(--gray-400);cursor:pointer" title="Quitar ajuste"><i class="fas fa-times"></i></button></div><div style="color:var(--gray-500);margin-top:2px">${mvEsc(a.motivo||'Sin motivo')} · ${a.fecha?new Date(a.fecha).toLocaleDateString('es-UY'):''}</div></div>`;
    }).join('') : '<p style="font-size:.8rem;color:var(--gray-400);margin:4px 0">Sin ajustes registrados.</p>';

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px;text-align:center"><div style="font-size:1.35rem;font-weight:800;color:#15803d">US$ ${money(f.usd)}</div><div style="font-size:.72rem;color:#166534;margin-top:2px">Saldo a cobrar</div></div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px;text-align:center"><div style="font-size:1.35rem;font-weight:800;color:#1d4ed8">$U ${money(f.uyu)}</div><div style="font-size:.72rem;color:#1e40af;margin-top:2px">Saldo a cobrar</div></div>
      </div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:12px 14px;text-align:center;margin-bottom:16px"><div style="font-size:1.25rem;font-weight:800;color:#b45309">${f.pts.toLocaleString('es-UY')} puntos</div>${vPunto?`<div style="font-size:.72rem;color:#92400e;margin-top:2px">≈ US$ ${money(f.pts*vPunto)}</div>`:''}</div>

      <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--gray-400);margin-bottom:8px">Desglose</div>
      <div style="font-size:.82rem;color:var(--gray-600);line-height:1.9;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between"><span>Ganado (cierres)</span><span>US$ ${money(f.ganadoUSD)} · $U ${money(f.ganadoUYU)}</span></div>
        ${(f.ajUSD||f.ajUYU||f.ajPts)?`<div style="display:flex;justify-content:space-between;color:#b45309"><span>Ajustes del admin</span><span>${f.ajUSD?(f.ajUSD>0?'+':'')+'US$ '+money(f.ajUSD):''} ${f.ajUYU?(f.ajUYU>0?'+':'')+'$U '+money(f.ajUYU):''} ${f.ajPts?(f.ajPts>0?'+':'')+f.ajPts+'pts':''}</span></div>`:''}
        <div style="display:flex;justify-content:space-between;color:#b91c1c"><span>Retiros</span><span>− US$ ${money(f.retUSD)} · $U ${money(f.retUYU)}</span></div>
      </div>

      <details style="margin-bottom:14px"><summary style="cursor:pointer;font-size:.82rem;font-weight:600;color:var(--gray-600)">Historial de ajustes (${ajustes.length})</summary><div style="margin-top:8px">${histHtml}</div></details>

      <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--gray-400);margin-bottom:10px">Registrar ajuste / corrección</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input id="ajUSD" type="number" step="any" placeholder="USD (±)" style="padding:9px 11px;border:1px solid var(--gray-200,#e5e7eb);border-radius:9px;font-family:inherit;font-size:.85rem">
        <input id="ajUYU" type="number" step="any" placeholder="UYU (±)" style="padding:9px 11px;border:1px solid var(--gray-200,#e5e7eb);border-radius:9px;font-family:inherit;font-size:.85rem">
      </div>
      <input id="ajPts" type="number" step="1" placeholder="Puntos (±)" style="width:100%;padding:9px 11px;border:1px solid var(--gray-200,#e5e7eb);border-radius:9px;font-family:inherit;font-size:.85rem;margin-top:8px;box-sizing:border-box">
      <input id="ajMotivo" type="text" placeholder="Motivo (obligatorio)" style="width:100%;padding:9px 11px;border:1px solid var(--gray-200,#e5e7eb);border-radius:9px;font-family:inherit;font-size:.85rem;margin-top:8px;box-sizing:border-box">
      <p style="font-size:.72rem;color:var(--gray-400);margin:8px 0 12px">Usá números negativos para descontar. Ej: <b>-200</b> en USD para restar saldo. Los puntos y el dinero se ajustan por separado.</p>
      <button onclick="guardarAjuste('${uid}')" style="width:100%;border:none;background:var(--primary,#16273f);color:#fff;border-radius:10px;padding:11px;font-family:inherit;font-size:.88rem;font-weight:600;cursor:pointer">Guardar ajuste</button>`;
  }

  async function guardarAjuste(uid) {
    const usd = Number(document.getElementById('ajUSD').value) || 0;
    const uyu = Number(document.getElementById('ajUYU').value) || 0;
    const pts = Math.round(Number(document.getElementById('ajPts').value) || 0);
    const motivo = (document.getElementById('ajMotivo').value || '').trim();
    if (!usd && !uyu && !pts) { showToast('Ingresá un monto o puntos', '', 'fa-exclamation-triangle'); return; }
    if (!motivo) { showToast('El motivo es obligatorio', 'Queda registrado para auditoría', 'fa-exclamation-triangle'); return; }
    try {
      await db.collection('ajustesFinancieros').add({
        agenteUid: uid, montoUSD: usd, montoUYU: uyu, puntos: pts, motivo,
        autor: (userProfile && userProfile.name) || (currentUser && currentUser.email) || 'Admin',
        autorUid: currentUser ? currentUser.uid : null, fecha: new Date().toISOString()
      });
      let u = allUsers[uid]; try { const d = await db.collection('users').doc(uid).get(); if (d.exists) u = {id:d.id,...d.data()}; } catch(e){}
      await renderFinanzasAgente(uid, u);
      showToast('Ajuste registrado', 'El saldo y los puntos se recalcularon', 'fa-check');
    } catch (e) { console.error('ajuste:', e); showToast('No se pudo guardar', (e&&e.message)||'', 'fa-exclamation-triangle'); }
  }
  async function borrarAjuste(ajId, uid) {
    if (!confirm('¿Quitar este ajuste? El saldo volverá a calcularse sin él.')) return;
    try {
      await db.collection('ajustesFinancieros').doc(ajId).delete();
      let u = allUsers[uid]; try { const d = await db.collection('users').doc(uid).get(); if (d.exists) u = {id:d.id,...d.data()}; } catch(e){}
      await renderFinanzasAgente(uid, u);
      showToast('Ajuste quitado', '', 'fa-check');
    } catch (e) { console.error(e); showToast('No se pudo quitar', '', 'fa-exclamation-triangle'); }
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
        c.innerHTML = us.length === 0 ? '<div class="empty-state"><i class="fas fa-users"></i><h3>Sin usuarios</h3></div>' : us.map(u => `<div class="user-card"><div class="user-card-avatar">${u.profilePhoto?`<img src="${safeUrl(u.profilePhoto)}" alt="">`:'<i class="fas fa-user"></i>'}</div><div class="user-card-info"><h4>${mvEsc(u.name||'Sin nombre')} ${(u.email||'').toLowerCase()===ADMIN_EMAIL?'<span class="admin-badge">Admin</span>':''}</h4><p>${mvEsc(u.email||'')}</p><small style="color:var(--gray-500)"><i class="fas fa-id-badge" style="color:var(--accent,#C9A227)"></i> ${mvEsc(u.role||'Asesor Inmobiliario')}</small>${u.commissionSale!=null||u.commissionRent!=null||u.commissionPct!=null?`<br><small style="color:#8a6d12"><i class="fas fa-percent"></i> Venta: ${u.commissionSale!=null?u.commissionSale:(u.commissionPct!=null?u.commissionPct:'—')}% · Alq: ${u.commissionRent!=null?u.commissionRent:(u.commissionPct!=null?u.commissionPct:'—')}%</small>`:''}<br><small style="color:${u.status==='approved'?'var(--success)':u.status==='pending'?'var(--gold)':'var(--danger)'}">${u.status==='approved'?'✓ Aprobado':u.status==='pending'?'⏳ Pendiente':'✗ Rechazado'}</small></div><div class="user-card-actions"><button class="btn-edit" onclick="abrirEditorAgente('${u.id}')" title="Editar datos"><i class="fas fa-pen"></i></button><button class="btn-edit" onclick="abrirFinanzasAgente('${u.id}')" title="Dinero y puntos"><i class="fas fa-wallet"></i></button><button class="btn-edit" onclick="setUserRole('${u.id}')" title="Asignar cargo"><i class="fas fa-id-badge"></i></button><button class="btn-edit" onclick="showProfile('${u.id}')" title="Ver perfil"><i class="fas fa-eye"></i></button>${u.status==='pending'?`<button class="btn-approve" onclick="approveUser('${u.id}')"><i class="fas fa-check"></i></button>`:''}${(u.email||'').toLowerCase()!==ADMIN_EMAIL?`<button class="btn-reject" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button>`:''}</div></div>`).join('')
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
      } else if (tb === 'comisiones') {
        const [cfgSnap, refSnap, cierresSnap] = await Promise.all([
          db.collection('adminData').doc('comisionesConfig').get(),
          db.collection('referidos').get(),
          db.collection('properties').where('cierreConfirmado', '==', true).get()
        ]);
        const cfg = Object.assign({ agencyPctSale: 3, agencyMonthsRent: 1 }, cfgSnap.exists ? cfgSnap.data() : {});
        const refDocs = {};
        refSnap.docs.forEach(d => { refDocs[d.id] = d.data(); });
        const cierresPorAgente = {};
        cierresSnap.docs.forEach(d => {
          const p = d.data();
          if (!p.cierre || !p.ownerId) return;
          (cierresPorAgente[p.ownerId] = cierresPorAgente[p.ownerId] || []).push(p.cierre);
        });
        const nom = uid => (allUsers[uid] && (allUsers[uid].name || allUsers[uid].email)) || 'Agente';
        const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
        // Comisión de la inmobiliaria en UNA operación (base de toda la cadena).
        // Usa lo negociado en ese cierre; si el cierre no lo tiene, cae al valor por defecto.
        function comAgencia(cc) {
          const price = num(cc.precio);
          if (cc.tipo === 'venta') {
            const pct = (cc.agencyPct != null) ? num(cc.agencyPct) : num(cfg.agencyPctSale);
            return price * pct / 100;
          }
          const meses = (cc.agencyMonths != null) ? num(cc.agencyMonths) : num(cfg.agencyMonthsRent);
          return price * meses;
        }
        const addTo = (s, cc, monto) => { s[(cc.moneda === 'UYU') ? 'UYU' : 'USD'] += monto; };
        // Comisión que gana el AGENTE (su % de la comisión inmobiliaria)
        function comAgente(agenteUid) {
          const u = allUsers[agenteUid] || {}, s = { USD: 0, UYU: 0 };
          (cierresPorAgente[agenteUid] || []).forEach(cc => {
            const pct = (cc.tipo === 'venta') ? num(u.commissionSale) : num(u.commissionRent);
            if (pct) addTo(s, cc, comAgencia(cc) * pct / 100);
          });
          return s;
        }
        // Comisión que gana el REFERENTE (su % de la comisión del referido)
        function comReferente(referidoUid, refPctSale, refPctRent) {
          const u = allUsers[referidoUid] || {}, s = { USD: 0, UYU: 0 };
          (cierresPorAgente[referidoUid] || []).forEach(cc => {
            const agPct = (cc.tipo === 'venta') ? num(u.commissionSale) : num(u.commissionRent);
            const rfPct = (cc.tipo === 'venta') ? num(refPctSale) : num(refPctRent);
            if (agPct && rfPct) addTo(s, cc, comAgencia(cc) * agPct / 100 * rfPct / 100);
          });
          return s;
        }
        function fmtSums(s) {
          const parts = [];
          if (Math.round(s.USD)) parts.push('US$ ' + Math.round(s.USD).toLocaleString('es-UY'));
          if (Math.round(s.UYU)) parts.push('$U ' + Math.round(s.UYU).toLocaleString('es-UY'));
          return parts.length ? parts.join(' · ') : '—';
        }
        const agentes = Object.keys(allUsers)
          .filter(uid => (allUsers[uid].email || '').toLowerCase() !== ADMIN_EMAIL)
          .map(uid => Object.assign({ _uid: uid }, allUsers[uid]))
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        let html = '';
        html += `<style>
          .com-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 18px}
          @media(max-width:760px){.com-kpis{grid-template-columns:repeat(2,1fr)}}
          .com-kpi{background:#fff;border:1px solid #e9e6dd;border-radius:12px;padding:13px 15px}
          .com-kpi .n{font-size:1.55rem;font-weight:800;color:#16273f;line-height:1;font-variant-numeric:tabular-nums}
          .com-kpi .l{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;font-weight:600;margin-top:5px}
          .com-kpi.good .n{color:#15803d}.com-kpi.warn .n{color:#C9A227}
          .com-sec{font-family:'Cormorant Garamond',serif;font-size:1.4rem;color:#16273f;margin:24px 0 12px;display:flex;align-items:center;gap:8px}
          .com-tools{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}
          .com-search{flex:1;min-width:190px;position:relative}
          .com-search i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#b6bcc6;font-size:.85rem}
          .com-search input{width:100%;padding:9px 12px 9px 32px;border:1px solid #e2ded3;border-radius:10px;font-family:inherit;font-size:.9rem;background:#fff}
          .com-search input:focus{outline:none;border-color:#C9A227;box-shadow:0 0 0 3px rgba(201,162,39,.13)}
          .com-chip{border:1px solid #e2ded3;background:#fff;border-radius:20px;padding:8px 15px;font-size:.82rem;font-weight:600;color:#6b7280;cursor:pointer;white-space:nowrap}
          .com-chip.on{background:#16273f;color:#fff;border-color:#16273f}
          .com-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
          @media(max-width:820px){.com-grid{grid-template-columns:1fr}}
          .com-agent{background:#fff;border:1px solid #e9e6dd;border-radius:14px;padding:13px 14px;display:flex;gap:12px;align-items:flex-start;transition:border-color .15s, box-shadow .15s}
          .com-agent:hover{border-color:#C9A227;box-shadow:0 3px 14px rgba(0,0,0,.05)}
          .com-agent.nocom{background:#fffdf4;border-color:#efe3bd}
          .com-av{width:46px;height:46px;border-radius:50%;overflow:hidden;flex:0 0 46px;background:#eef1f6;display:flex;align-items:center;justify-content:center;color:#9aa4b2}
          .com-av img{width:100%;height:100%;object-fit:cover}
          .com-body{flex:1;min-width:0}
          .com-name{font-weight:700;color:#16273f;font-size:.98rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .com-rank{font-size:.72rem;color:#9aa4b2;margin-top:1px}
          .com-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
          .com-pill{font-size:.72rem;font-weight:600;padding:3px 9px;border-radius:8px;background:#f2f0ea;color:#5b6472;display:inline-flex;align-items:center;gap:4px;max-width:100%;overflow:hidden;text-overflow:ellipsis}
          .com-pill.sale{background:#eef4ff;color:#2b5cae}.com-pill.rent{background:#eafaf0;color:#1b7a45}
          .com-pill.ref{background:#f7f1e2;color:#8a6d12}.com-pill.none{background:#fdf3d6;color:#8a6d12}
          .com-earn{font-size:.76rem;color:#15803d;font-weight:600;margin-top:7px}
          .com-cobro{font-size:.74rem;color:#5b6472;margin-top:6px;line-height:1.4;background:#f6f7f9;border-radius:8px;padding:6px 9px}
          .com-cobro i{color:#16273f;margin-right:4px}
          .com-cobro-tit{color:#8a94a2}
          .com-cobro.falta{background:#fdf3d6;color:#8a6d12}.com-cobro.falta i{color:#8a6d12}
          .com-edit{flex:0 0 auto;border:1px solid #dfe3ea;background:#fff;color:#16273f;border-radius:9px;padding:7px 11px;cursor:pointer;font-size:.85rem;align-self:center}
          .com-edit:hover{background:#16273f;color:#fff;border-color:#16273f}
          .com-refcard{background:#fff;border:1px solid #e9e6dd;border-radius:14px;padding:14px 16px;margin-bottom:10px}
          .com-refhead{display:flex;justify-content:space-between;align-items:center;gap:10px}
          .com-refhead b{color:#16273f;font-size:1rem}
          .com-refrow{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #f0efe9;font-size:.85rem}
          .com-empty{background:#fff;border:1px dashed #dcd8cd;border-radius:12px;padding:22px;text-align:center;color:#9aa4b2;font-size:.9rem}
        </style>`;

        // ---- Config de la inmobiliaria (por defecto) ----
        html += `<div style="background:#0f1f33;color:#fff;border-radius:14px;padding:18px 20px;margin-bottom:18px"><div style="font-weight:600;margin-bottom:4px"><i class="fas fa-building" style="color:#C9A227"></i> Comisión de la inmobiliaria — por defecto</div><div style="font-size:.8rem;color:#aeb7c2;margin-bottom:14px">La comisión real se define <b>en cada cierre</b> (se negocia con el dueño). Esto es solo el valor por defecto para cierres que no tengan su propio dato.</div><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end"><div><label style="font-size:.75rem;color:#aeb7c2;display:block;margin-bottom:5px">Venta (% del precio)</label><input id="cfgAgencyPctSale" type="number" min="0" max="100" step="0.1" value="${num(cfg.agencyPctSale)}" style="width:130px;padding:9px 11px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(255,255,255,.08);color:#fff;font-family:inherit"></div><div><label style="font-size:.75rem;color:#aeb7c2;display:block;margin-bottom:5px">Alquiler (meses de renta)</label><input id="cfgAgencyMonthsRent" type="number" min="0" step="0.1" value="${num(cfg.agencyMonthsRent)}" style="width:150px;padding:9px 11px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(255,255,255,.08);color:#fff;font-family:inherit"></div><button onclick="saveComisionesConfig()" style="padding:9px 18px;border-radius:9px;border:none;background:#C9A227;color:#0f1f33;font-family:inherit;font-weight:700;cursor:pointer">Guardar</button></div></div>`;

        // ---- KPIs ----
        const _conCom = agentes.filter(u => u.commissionSale != null || u.commissionRent != null).length;
        const _conRef = agentes.filter(u => refDocs[u._uid] && refDocs[u._uid].referrerUid).length;
        html += `<div class="com-kpis"><div class="com-kpi"><div class="n">${agentes.length}</div><div class="l">Agentes</div></div><div class="com-kpi good"><div class="n">${_conCom}</div><div class="l">Con comisión</div></div><div class="com-kpi ${_conCom < agentes.length ? 'warn' : ''}"><div class="n">${agentes.length - _conCom}</div><div class="l">Falta comisión</div></div><div class="com-kpi"><div class="n">${_conRef}</div><div class="l">Con referente</div></div></div>`;
        html += `<div style="margin-bottom:6px;color:#94a3b8;font-size:.82rem"><i class="fas fa-circle-info"></i> Cadena: <b>precio</b> → comisión inmobiliaria → <b>comisión del agente</b> (% de esa) → <b>comisión del referente</b> (% de la del agente). Sobre cierres <b>confirmados</b>.</div>`;

        // ---- Resumen de ganancias por referidos ----
        const porReferente = {};
        Object.keys(refDocs).forEach(refUid => {
          const r = refDocs[refUid];
          if (!r.referrerUid) return;
          (porReferente[r.referrerUid] = porReferente[r.referrerUid] || []).push({ uid: refUid, pctSale: r.pctSale, pctRent: r.pctRent });
        });
        const referentes = Object.keys(porReferente).map(refUid => {
          const total = { USD: 0, UYU: 0 };
          const hijos = porReferente[refUid].map(h => {
            const g = comReferente(h.uid, h.pctSale, h.pctRent);
            total.USD += g.USD; total.UYU += g.UYU;
            return Object.assign({}, h, { g });
          });
          return { refUid, hijos, total };
        }).sort((a, b) => (b.total.USD + b.total.UYU) - (a.total.USD + a.total.UYU));
        if (referentes.length) {
          html += '<div class="com-sec"><i class="fas fa-trophy" style="color:#C9A227"></i> Ganancias por referidos</div>';
          html += referentes.map(rf => {
            const rows = rf.hijos.map(h => `<div class="com-refrow"><span>${mvEsc(nom(h.uid))} <small style="color:#aab">· ${num(h.pctSale)}% / ${num(h.pctRent)}% de su comisión</small></span><span style="font-weight:600;color:#15803d">${fmtSums(h.g)}</span></div>`).join('');
            return `<div class="com-refcard"><div class="com-refhead"><b><i class="fas fa-user-tie" style="color:#C9A227"></i> ${mvEsc(nom(rf.refUid))}</b><span style="font-weight:700;color:#15803d">${fmtSums(rf.total)}</span></div><div style="font-size:.75rem;color:#9aa4b2;margin-top:2px">${rf.hijos.length} referido${rf.hijos.length === 1 ? '' : 's'}</div>${rows}</div>`;
          }).join('');
        }

        // ---- Comisión por agente ----
        html += '<div class="com-sec"><i class="fas fa-users" style="color:#C9A227"></i> Comisión por agente</div>';
        if (!agentes.length) {
          html += '<div class="empty-state"><i class="fas fa-users"></i><h3>Sin agentes</h3></div>';
        } else {
          html += `<div class="com-tools"><div class="com-search"><i class="fas fa-search"></i><input id="comSearch" type="text" placeholder="Buscar agente…" oninput="filtrarComisiones()"></div><button class="com-chip on" data-f="todos" onclick="setComFilter(this)">Todos</button><button class="com-chip" data-f="sincom" onclick="setComFilter(this)">Falta comisión</button><button class="com-chip" data-f="conref" onclick="setComFilter(this)">Con referente</button></div>`;
          html += '<div class="com-grid" id="comGrid">';
          html += agentes.map(u => {
            const r = refDocs[u._uid];
            const hasCom = (u.commissionSale != null || u.commissionRent != null);
            const hasRef = !!(r && r.referrerUid);
            const photo = u.profilePhoto ? `<img src="${safeUrl(u.profilePhoto)}" alt="">` : '<i class="fas fa-user"></i>';
            const pills = hasCom
              ? `<span class="com-pill sale">Venta ${u.commissionSale != null ? u.commissionSale : 0}%</span><span class="com-pill rent">Alq ${u.commissionRent != null ? u.commissionRent : 0}%</span>`
              : '<span class="com-pill none"><i class="fas fa-triangle-exclamation"></i> Falta comisión</span>';
            const refPill = hasRef ? `<span class="com-pill ref" title="Gana ${num(r.pctSale)}% venta / ${num(r.pctRent)}% alquiler de su comisión"><i class="fas fa-user-tie"></i> ${mvEsc(nom(r.referrerUid))}</span>` : '';
            const ganado = comAgente(u._uid);
            const earn = (Math.round(ganado.USD) || Math.round(ganado.UYU)) ? `<div class="com-earn"><i class="fas fa-sack-dollar"></i> Ganó ${fmtSums(ganado)}</div>` : '';
            // Datos de cobro del agente (para que el admin transfiera).
            let cobro = '';
            if (u.bancoNombre || u.cuentaNumero) {
              const linea = [u.bancoNombre, u.cuentaTipo, u.cuentaMoneda ? (u.cuentaMoneda === 'UYU' ? '$U' : 'US$') : '', u.cuentaNumero ? ('Nº ' + u.cuentaNumero) : '']
                .filter(Boolean).join(' · ');
              const tit = [u.cuentaTitular, u.cuentaCI].filter(Boolean).join(' — ');
              cobro = `<div class="com-cobro"><i class="fas fa-university"></i> ${mvEsc(linea)}${tit ? '<br><span class="com-cobro-tit">' + mvEsc(tit) + '</span>' : ''}</div>`;
            } else {
              cobro = `<div class="com-cobro falta"><i class="fas fa-circle-info"></i> Sin datos de cobro cargados</div>`;
            }
            const rank = u.role ? `<div class="com-rank">${mvEsc(u.role)}</div>` : '';
            return `<div class="com-agent ${hasCom ? '' : 'nocom'}" data-name="${mvEsc((u.name || '').toLowerCase())}" data-com="${hasCom ? 1 : 0}" data-ref="${hasRef ? 1 : 0}"><div class="com-av">${photo}</div><div class="com-body"><div class="com-name">${mvEsc(u.name || 'Sin nombre')}</div>${rank}<div class="com-pills">${pills}${refPill}</div>${earn}${cobro}</div><button class="com-edit" onclick="openComisionAgente('${u._uid}')" title="Editar comisión y referente"><i class="fas fa-sliders-h"></i></button></div>`;
          }).join('');
          html += '<div class="com-empty" id="comEmpty" style="display:none;grid-column:1/-1">No hay agentes con ese filtro.</div>';
          html += '</div>';
        }
        c.innerHTML = html;
      } else if (tb === 'solicitudes') {
        try {
          const snap = await db.collection('leadsVenta').get();
          _solLeads = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        } catch (e) {
          c.innerHTML = '<div class="empty-state"><i class="fas fa-lock"></i><h3>No se pudieron cargar las solicitudes</h3><p>' + mvEsc(e.code === 'permission-denied' ? 'Sin permiso para leer "leadsVenta" (regla de Firestore).' : (e.message || e)) + '</p></div>';
          return;
        }
        _solLeads.sort((a, b) => _solMs(b.createdAt) - _solMs(a.createdAt));
        _solFiltro = 'nuevo';
        c.innerHTML = `<style>
          .sol-countbar{background:#fffdf5;border:1px solid #eee6cf;border-left:4px solid #C9A227;border-radius:12px;padding:12px 16px;font-weight:700;display:flex;align-items:center;gap:9px;margin-bottom:14px;color:#9a7d12}
          .sol-countbar.none{border-left-color:#2ecc71;color:#27ae60;background:#fff;border-color:#e4e6ea}
          .sol-toolrow{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
          .sol-chips{display:flex;gap:6px;background:#fff;border:1px solid #e4e6ea;border-radius:12px;padding:4px;width:fit-content;flex-wrap:wrap}
          .sol-chip{border:none;background:transparent;cursor:pointer;border-radius:9px;padding:7px 14px;font-size:.85rem;font-weight:600;color:#666;font-family:inherit}
          .sol-chip.active{background:#16273f;color:#fff}
          .sol-refresh{border:1px solid #e4e6ea;background:#fff;color:#444;border-radius:10px;padding:8px 13px;cursor:pointer;font-family:inherit;font-size:.85rem;font-weight:600;display:inline-flex;align-items:center;gap:7px}
          .sol-card{background:#fff;border:1px solid #e4e6ea;border-radius:14px;padding:16px;margin-bottom:12px}
          .sol-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
          .sol-nombre{font-weight:700;font-size:1.05rem;color:#16273f}
          .sol-when{color:#999;font-size:.82rem}
          .sol-badge{margin-left:auto;font-size:.72rem;font-weight:700;padding:4px 10px;border-radius:20px}
          .sol-badge.nuevo{background:#fff4e0;color:#b9770f}
          .sol-badge.contactado{background:#e7f7ec;color:#1f9d54}
          .sol-badge.archivado{background:#eef0f3;color:#888}
          .sol-rows{display:flex;flex-direction:column;gap:7px}
          .sol-row{display:flex;gap:10px;font-size:.9rem;align-items:flex-start}
          .sol-row i{color:#C9A227;width:18px;text-align:center;margin-top:3px}
          .sol-row .lbl{color:#888;min-width:74px}
          .sol-row .val{color:#1c1c1c;flex:1}
          .sol-row a{color:#2e86de;text-decoration:none}
          .sol-msg{background:#f8f9fb;border:1px solid #e4e6ea;border-radius:10px;padding:10px 12px;font-size:.9rem;color:#444;margin-top:4px;line-height:1.5}
          .sol-f{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid #e4e6ea;flex-wrap:wrap}
          .sol-act{border:none;cursor:pointer;border-radius:9px;padding:8px 13px;font-size:.83rem;font-weight:600;display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-family:inherit}
          .sol-act.wa{background:#25d366;color:#fff}
          .sol-act.ok{background:#27ae60;color:#fff}
          .sol-act.arch{background:#eef0f3;color:#666}
          .sol-empty{text-align:center;color:#999;padding:40px 20px;background:#fff;border:1px solid #e4e6ea;border-radius:14px}
        </style>
        <div id="solCountBar" class="sol-countbar"></div>
        <div class="sol-toolrow">
          <div class="sol-chips">
            <button class="sol-chip active" id="solChip-nuevo" onclick="solSetFiltro('nuevo')">Nuevas</button>
            <button class="sol-chip" id="solChip-contactado" onclick="solSetFiltro('contactado')">Contactadas</button>
            <button class="sol-chip" id="solChip-archivado" onclick="solSetFiltro('archivado')">Archivadas</button>
            <button class="sol-chip" id="solChip-todos" onclick="solSetFiltro('todos')">Todas</button>
          </div>
          <button class="sol-refresh" onclick="showAdminTab('solicitudes')"><i class="fas fa-rotate-right"></i> Actualizar</button>
        </div>
        <div id="solLista"></div>`;
        solRender();
      } else if (tb === 'revisiones') {
        try {
          const q = await db.collection('users').get();
          _revRecords = [];
          q.docs.forEach(d => {
            const u = d.data();
            Object.keys(_REV_TIPOS).forEach(tipo => {
              _revToList(u[_REV_TIPOS[tipo].field]).forEach(rec => {
                _revRecords.push(Object.assign({}, rec, {
                  _uid: d.id, _field: _REV_TIPOS[tipo].field,
                  tipo: rec.tipo || tipo,
                  _agente: rec.agenteNombre || u.name || u.email || 'Agente'
                }));
              });
            });
          });
        } catch (e) {
          c.innerHTML = '<div class="empty-state"><i class="fas fa-triangle-exclamation"></i><h3>No se pudieron cargar las revisiones</h3><p>' + mvEsc(e.message || e) + '</p></div>';
          return;
        }
        _revRecords.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
        _revPage = 1; _revFTipo = 'todas'; _revFEstado = 'todas';
        c.innerHTML = `<style>
          .rev-toolrow{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
          .rev-filters{display:flex;gap:10px;flex-wrap:wrap}
          .rev-sel{position:relative}
          .rev-sel i.lead{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:#6b7480;font-size:.8rem;pointer-events:none}
          .rev-sel i.caret{position:absolute;right:13px;top:50%;transform:translateY(-50%);color:#6b7480;font-size:.7rem;pointer-events:none}
          .rev-sel select{-webkit-appearance:none;appearance:none;border:1px solid #e7eaef;border-radius:12px;padding:10px 34px 10px 36px;font-size:.9rem;background:#fff;color:#3a4350;cursor:pointer;font-family:inherit;min-width:190px}
          .rev-btn{border:1px solid #e7eaef;background:#fff;color:#3a4350;cursor:pointer;border-radius:11px;padding:9px 14px;font-size:.86rem;font-weight:600;display:inline-flex;align-items:center;gap:8px;font-family:inherit}
          .rev-btn.danger{background:#fdecee;border-color:#f6d6da;color:#dc3545}
          .rev-banner{position:relative;overflow:hidden;border-radius:16px;padding:18px 22px;margin-bottom:16px;display:flex;align-items:center;gap:14px}
          .rev-banner.ok{background:#e8f7ee;border:1px solid #cdeed8}
          .rev-banner.alert{background:#fff6e3;border:1px solid #f4e2b8}
          .rev-banner .bic{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex:0 0 auto;color:#fff}
          .rev-banner.ok .bic{background:#15a05a}
          .rev-banner.alert .bic{background:#C9A227}
          .rev-banner h3{font-size:1.02rem;font-weight:700;margin:0}
          .rev-banner.ok h3{color:#127a45}
          .rev-banner.alert h3{color:#b9770f}
          .rev-banner p{font-size:.85rem;color:#6b7480;margin:2px 0 0}
          .rev-banner .bart{position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:4rem;opacity:.12}
          .rev-banner.ok .bart{color:#15a05a}
          .rev-banner.alert .bart{color:#C9A227}
          .rev-card{background:#fff;border:1px solid #e7eaef;border-radius:16px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(20,30,50,.04)}
          .rev-h{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
          .rev-tipo{font-size:.76rem;font-weight:700;padding:5px 11px;border-radius:8px;display:inline-flex;align-items:center;gap:6px}
          .rev-who{font-weight:700;font-size:1rem;color:#1f2733}
          .rev-when{color:#9aa2ad;font-size:.82rem}
          .rev-badge{margin-left:auto;font-size:.74rem;font-weight:700;padding:5px 11px;border-radius:20px;display:inline-flex;align-items:center;gap:6px}
          .rev-badge.pend{background:#fff6e3;color:#b9770f}
          .rev-badge.ok{background:#e8f7ee;color:#127a45}
          .rev-kwrap{position:relative}
          .rev-kebab{background:none;border:none;cursor:pointer;color:#aab2bd;font-size:1rem;padding:6px 8px;border-radius:8px}
          .rev-kebab:hover{background:#f3f5f8;color:#1f2733}
          .rev-menu{position:absolute;right:0;top:34px;background:#fff;border:1px solid #e7eaef;border-radius:12px;box-shadow:0 10px 30px rgba(20,30,50,.14);padding:6px;min-width:190px;z-index:30;display:none}
          .rev-menu.open{display:block}
          .rev-menu button{width:100%;text-align:left;background:none;border:none;cursor:pointer;font-family:inherit;font-size:.86rem;color:#3a4350;padding:9px 11px;border-radius:8px;display:flex;align-items:center;gap:9px}
          .rev-menu button:hover{background:#f3f5f8}
          .rev-menu button.danger{color:#dc3545}
          .rev-metrics{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:8px;background:#f8fafb;border:1px solid #eef1f5;border-radius:13px;padding:13px 15px;margin-top:14px}
          .rev-metric .lbl{font-size:.66rem;text-transform:uppercase;letter-spacing:.6px;color:#9aa2ad;font-weight:700}
          .rev-metric .val{font-size:1rem;font-weight:700;color:#1f2733;margin-top:5px}
          .rev-metric.big .val{font-size:1.45rem;font-weight:800;color:#15a05a}
          .rev-metric.unc .val{color:#15a05a}
          .rev-feats{display:flex;flex-wrap:wrap;gap:10px 24px;padding:13px 4px;border-bottom:1px solid #e7eaef;margin-top:4px}
          .rev-feat{display:flex;align-items:center;gap:10px}
          .rev-feat .fic{width:30px;height:30px;border-radius:9px;background:#f0f3f7;color:#5a6470;display:flex;align-items:center;justify-content:center;font-size:.8rem;flex:0 0 auto}
          .rev-feat b{font-size:.9rem;font-weight:700;display:block;line-height:1.1}
          .rev-feat small{font-size:.72rem;color:#9aa2ad}
          .rev-dets{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px 18px;padding:14px 4px 4px}
          .rev-det .dl{font-size:.72rem;color:#9aa2ad;font-weight:600;margin-bottom:3px}
          .rev-det .dv{font-size:.9rem;font-weight:600;color:#1f2733}
          .rev-stars i{font-size:.78rem;color:#e2c45a}
          .rev-stars i.off{color:#dfe3e9}
          .rev-more{display:none;margin-top:13px;padding-top:13px;border-top:1px dashed #e7eaef}
          .rev-more.open{display:block}
          .rev-kvgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
          .rev-kvg h4{font-size:.7rem;text-transform:uppercase;letter-spacing:.5px;color:#9aa2ad;margin:0 0 7px}
          .rev-kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed #eef1f5;font-size:.85rem}
          .rev-kv span{color:#7c848f}
          .rev-kv b{color:#1f2733;text-align:right}
          .rev-f{display:flex;align-items:center;gap:10px;margin-top:15px;padding-top:13px;border-top:1px solid #e7eaef;flex-wrap:wrap}
          .rev-lnk{display:inline-flex;align-items:center;gap:8px;border-radius:10px;padding:9px 14px;font-size:.85rem;font-weight:600;cursor:pointer;text-decoration:none;border:1px solid transparent;font-family:inherit;background:#fff}
          .rev-lnk.green{background:#e8f7ee;color:#127a45}
          .rev-lnk.ghost{border-color:#e7eaef;color:#3a4350}
          .rev-lnk.disabled{opacity:.5;cursor:not-allowed}
          .rev-mark{background:#15a05a;color:#fff;border:none;cursor:pointer;border-radius:10px;padding:9px 14px;font-size:.85rem;font-weight:600;display:inline-flex;align-items:center;gap:7px;font-family:inherit}
          .rev-trash{margin-left:auto;background:#fdecee;color:#dc3545;border:1px solid #f6d6da;cursor:pointer;border-radius:10px;width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center}
          .rev-pager{display:flex;justify-content:center;align-items:center;gap:7px;margin-top:20px;flex-wrap:wrap}
          .rev-pg{min-width:38px;height:38px;border-radius:10px;border:1px solid #e7eaef;background:#fff;color:#3a4350;cursor:pointer;font-size:.88rem;font-weight:600;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;padding:0 10px}
          .rev-pg.active{background:#15a05a;color:#fff;border-color:#15a05a}
          .rev-pg:disabled{opacity:.4;cursor:not-allowed}
          .rev-pg.dots{border:none;background:none;cursor:default}
          .rev-empty{text-align:center;color:#9aa2ad;padding:42px 20px;background:#fff;border:1px solid #e7eaef;border-radius:16px}
          .rev-empty i{font-size:1.6rem;display:block;margin-bottom:10px;color:#ccd2da}
          @media(max-width:680px){.rev-metrics{grid-template-columns:1fr 1fr}.rev-metric.big{grid-column:1/-1}.rev-kvgrid{grid-template-columns:1fr}}
        </style>
        <div class="rev-toolrow">
          <div class="rev-filters">
            <div class="rev-sel"><i class="fas fa-filter lead"></i><select id="revFTipo" onchange="revSetFiltro('tipo', this.value)"><option value="todas">Todos los tipos</option><option value="tasacion">Tasaciones</option><option value="gastos">Gastos y comisiones</option><option value="terreno">Cálculo de terrenos</option></select><i class="fas fa-chevron-down caret"></i></div>
            <div class="rev-sel"><i class="fas fa-list-check lead"></i><select id="revFEstado" onchange="revSetFiltro('estado', this.value)"><option value="todas">Todos</option><option value="pend">Sin revisar</option><option value="rev">Revisadas</option></select><i class="fas fa-chevron-down caret"></i></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="rev-btn" onclick="showAdminTab('revisiones')"><i class="fas fa-rotate-right"></i> Actualizar</button>
            <button class="rev-btn danger" onclick="revLimpiarRevisadas()"><i class="fas fa-trash-can"></i> Limpiar revisadas</button>
          </div>
        </div>
        <div id="revBanner"></div>
        <div id="revList"></div>
        <div id="revPager" class="rev-pager"></div>`;
        revRender();
      }
    } catch (err) {
      console.error('Error panel admin:', err);
      c.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i><h3>Error al cargar</h3><p style="color:var(--gray-500);margin-top:8px">${err.message}</p></div>`
    }
  }

  // ===== Comisiones (solo admin): config de la inmobiliaria + comisión y referente por agente =====
  async function saveComisionesConfig() {
    if (!isAdminUser()) return;
    const agencyPctSale = parseFloat(document.getElementById('cfgAgencyPctSale').value) || 0;
    const agencyMonthsRent = parseFloat(document.getElementById('cfgAgencyMonthsRent').value) || 0;
    try {
      await db.collection('adminData').doc('comisionesConfig').set({ agencyPctSale, agencyMonthsRent, updatedAt: new Date().toISOString() }, { merge: true });
      showToast('Guardado', 'Comisión de la inmobiliaria actualizada.', 'fa-check');
      showAdminTab('comisiones');
    } catch (e) {
      showToast('Error', 'No se pudo guardar: ' + (e.message || e), 'fa-triangle-exclamation');
    }
  }

  function setComFilter(el){
    const chips = el.parentElement.querySelectorAll('.com-chip');
    chips.forEach(x => x.classList.toggle('on', x === el));
    filtrarComisiones();
  }
  function filtrarComisiones(){
    const inp = document.getElementById('comSearch');
    const s = (inp ? inp.value : '').toLowerCase().trim();
    const chip = document.querySelector('.com-chip.on');
    const f = chip ? chip.getAttribute('data-f') : 'todos';
    let visibles = 0;
    document.querySelectorAll('.com-agent').forEach(el => {
      const name = el.getAttribute('data-name') || '';
      const hasCom = el.getAttribute('data-com') === '1';
      const hasRef = el.getAttribute('data-ref') === '1';
      let ok = name.indexOf(s) !== -1;
      if (ok && f === 'sincom') ok = !hasCom;
      if (ok && f === 'conref') ok = hasRef;
      el.style.display = ok ? '' : 'none';
      if (ok) visibles++;
    });
    const em = document.getElementById('comEmpty');
    if (em) em.style.display = visibles ? 'none' : 'block';
  }

  // ===== Panel admin: Solicitudes de venta (leadsVenta) =====
  let _solLeads = [], _solFiltro = 'nuevo';
  const _SOL_TIPO_LBL = { casa: 'Casa', apartamento: 'Apartamento', terreno: 'Terreno', local: 'Local', oficina: 'Oficina', galpon: 'Galpón', campo: 'Campo', otro: 'Otro' };
  function _solMs(v) { if (!v) return 0; if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().getTime(); if (typeof v === 'object' && v.seconds) return v.seconds * 1000; const d = new Date(v); return isNaN(d.getTime()) ? 0 : d.getTime(); }
  function _solFecha(v) { const ms = _solMs(v); return ms ? new Date(ms).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function _solWa(tel) { let d = String(tel || '').replace(/\D/g, ''); if (!d) return ''; if (d.indexOf('598') === 0) return d; if (d.charAt(0) === '0') d = d.slice(1); if (d.length <= 9) return '598' + d; return d; }
  function _solCard(l) {
    const est = l.estado || 'nuevo';
    const wa = _solWa(l.telefono);
    let rows = '<div class="sol-row"><i class="fas fa-phone"></i><span class="lbl">Teléfono</span><span class="val">' + mvEsc(l.telefono || '—') + '</span></div>';
    if (l.email) rows += '<div class="sol-row"><i class="fas fa-envelope"></i><span class="lbl">Email</span><span class="val"><a href="mailto:' + mvEsc(l.email) + '">' + mvEsc(l.email) + '</a></span></div>';
    if (l.tipo) rows += '<div class="sol-row"><i class="fas fa-building"></i><span class="lbl">Quiere</span><span class="val">' + mvEsc(_SOL_TIPO_LBL[l.tipo] || l.tipo) + '</span></div>';
    if (l.zona) rows += '<div class="sol-row"><i class="fas fa-location-dot"></i><span class="lbl">Zona</span><span class="val">' + mvEsc(l.zona) + '</span></div>';
    if (l.mensaje) rows += '<div class="sol-row"><i class="fas fa-comment"></i><span class="lbl">Mensaje</span><span class="val"><div class="sol-msg">' + mvEsc(l.mensaje) + '</div></span></div>';
    let foot = '';
    if (wa) foot += '<a class="sol-act wa" href="https://wa.me/' + wa + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> WhatsApp</a>';
    if (est !== 'contactado') foot += '<button class="sol-act ok" onclick="solMarcar(\'' + l.id + '\',\'contactado\')"><i class="fas fa-check"></i> Marcar contactada</button>';
    if (est !== 'archivado') foot += '<button class="sol-act arch" onclick="solMarcar(\'' + l.id + '\',\'archivado\')"><i class="fas fa-box-archive"></i> Archivar</button>';
    else foot += '<button class="sol-act arch" onclick="solMarcar(\'' + l.id + '\',\'nuevo\')"><i class="fas fa-rotate-left"></i> Reabrir</button>';
    return '<div class="sol-card"><div class="sol-h"><span class="sol-nombre">' + mvEsc(l.nombre || '(sin nombre)') + '</span><span class="sol-when">' + mvEsc(_solFecha(l.createdAt)) + '</span><span class="sol-badge ' + est + '">' + (est === 'nuevo' ? 'Nueva' : est === 'contactado' ? 'Contactada' : 'Archivada') + '</span></div><div class="sol-rows">' + rows + '</div><div class="sol-f">' + foot + '</div></div>';
  }
  function solRender() {
    const cb = document.getElementById('solCountBar'), list = document.getElementById('solLista');
    if (!cb || !list) return;
    const recs = _solLeads.filter(l => _solFiltro === 'todos' || (l.estado || 'nuevo') === _solFiltro);
    const nuevas = _solLeads.filter(l => (l.estado || 'nuevo') === 'nuevo').length;
    cb.className = 'sol-countbar' + (nuevas > 0 ? '' : ' none');
    cb.innerHTML = nuevas > 0
      ? '<i class="fas fa-bell"></i> ' + nuevas + (nuevas === 1 ? ' solicitud nueva sin contactar' : ' solicitudes nuevas sin contactar')
      : '<i class="fas fa-circle-check"></i> No hay solicitudes nuevas pendientes';
    list.innerHTML = recs.length ? recs.map(_solCard).join('') : '<div class="sol-empty">No hay solicitudes en esta categoría.</div>';
  }
  function solSetFiltro(f) {
    _solFiltro = f;
    ['nuevo', 'contactado', 'archivado', 'todos'].forEach(x => { const el = document.getElementById('solChip-' + x); if (el) el.classList.toggle('active', x === f); });
    solRender();
  }
  async function solMarcar(id, estado) {
    try {
      await db.collection('leadsVenta').doc(id).update({ estado: estado });
      const l = _solLeads.find(x => x.id === id); if (l) l.estado = estado;
      solRender();
      showToast('Solicitudes', estado === 'contactado' ? 'Marcada como contactada' : estado === 'archivado' ? 'Archivada' : 'Reabierta', 'fa-check');
    } catch (e) { alert('No se pudo actualizar: ' + (e.message || e)); }
  }

  // ===== Panel admin: Revisiones (tasaciones / gastos / terrenos en users) =====
  let _revRecords = [], _revFTipo = 'todas', _revFEstado = 'todas', _revPage = 1;
  const _REV_PAGE_SIZE = 5;
  const _REV_TIPOS = {
    tasacion: { field: 'tasaciones', label: 'Tasación', icon: 'fa-calculator', color: '#c9a227' },
    gastos: { field: 'calcGastos', label: 'Gastos y comisiones', icon: 'fa-file-invoice-dollar', color: '#2e86de' },
    terreno: { field: 'calcTerrenos', label: 'Cálculo de terreno', icon: 'fa-mountain-sun', color: '#27ae60' }
  };
  const _REV_LBL = {
    m2: 'm² construidos', construccion: 'Construcción', ubicacion: 'Ubicación', dormitorios: 'Dormitorios', banos: 'Baños', antecedentes: 'Comparables',
    cliente: 'Cliente', tipoInm: 'Tipo inmueble', direccion: 'Dirección', barrio: 'Barrio', departamento: 'Departamento', padron: 'Padrón',
    valor: 'Valor estimado', min: 'Mínimo', max: 'Máximo', incertidumbre: 'Incertidumbre',
    operacion: 'Operación', precio: 'Precio', moneda: 'Moneda', comision: 'Comisión', honorarios: 'Honorarios', iva: 'IVA', total: 'Total',
    area: 'Superficie', precioM2: 'Precio m²', costo: 'Costo', utilidad: 'Utilidad'
  };
  const _REV_MONEY = new Set(['valor', 'min', 'max', 'precio', 'comision', 'honorarios', 'iva', 'total', 'precioM2', 'costo', 'utilidad']);
  function _revToList(v) { if (Array.isArray(v)) return v; if (v && typeof v === 'object') return Object.values(v); return []; }
  function _revFecha(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return iso; return d.toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function _revMoney(v) { return 'US$ ' + Number(v || 0).toLocaleString('es-UY'); }
  function _revStars(n) { n = Math.max(0, Math.min(5, Math.round(Number(n) || 0))); let h = '<span class="rev-stars">'; for (let i = 1; i <= 5; i++) h += '<i class="fas fa-star' + (i <= n ? '' : ' off') + '"></i>'; return h + '</span>'; }
  function _revNum(v) { return (v === '' || v == null) ? '—' : v; }
  function _revKv(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return Object.keys(obj).map(k => {
      let v = obj[k];
      if (v === '' || v === null || v === undefined) return '';
      if (_REV_MONEY.has(k)) v = _revMoney(v);
      else if (k === 'incertidumbre') v = v + ' %';
      return '<div class="rev-kv"><span>' + mvEsc(_REV_LBL[k] || k) + '</span><b>' + mvEsc(String(v)) + '</b></div>';
    }).filter(Boolean).join('');
  }
  function _revFeat(ic, val, lbl) { return '<div class="rev-feat"><div class="fic"><i class="fas ' + ic + '"></i></div><div><b>' + val + '</b><small>' + lbl + '</small></div></div>'; }
  function _revDet(lbl, val) { return '<div class="rev-det"><div class="dl">' + lbl + '</div><div class="dv">' + val + '</div></div>'; }
  function _revCardTasacion(r) {
    const d = r.datos || {}, res = r.resultado || {};
    const metrics = '<div class="rev-metrics">'
      + '<div class="rev-metric big"><div class="lbl">Valor estimado</div><div class="val">' + _revMoney(res.valor) + '</div></div>'
      + '<div class="rev-metric"><div class="lbl">Mínimo</div><div class="val">' + _revMoney(res.min) + '</div></div>'
      + '<div class="rev-metric"><div class="lbl">Máximo</div><div class="val">' + _revMoney(res.max) + '</div></div>'
      + '<div class="rev-metric unc"><div class="lbl">Incertidumbre</div><div class="val">' + (res.incertidumbre != null ? res.incertidumbre + ' %' : '—') + '</div></div>'
      + '</div>';
    const feats = '<div class="rev-feats">'
      + _revFeat('fa-up-right-and-down-left-from-center', _revNum(d.m2) + ' m²', 'Construidos')
      + _revFeat('fa-house', _revNum(d.tipoInm), 'Tipo inmueble')
      + _revFeat('fa-bed', _revNum(d.dormitorios), 'Dormitorios')
      + _revFeat('fa-bath', _revNum(d.banos), 'Baños')
      + _revFeat('fa-location-dot', _revNum(d.barrio), 'Barrio')
      + '</div>';
    const dets = '<div class="rev-dets">'
      + _revDet('Cliente', mvEsc(_revNum(d.cliente)))
      + _revDet('Padrón', mvEsc(_revNum(d.padron)))
      + _revDet('Ubicación', mvEsc(_revNum(d.direccion)))
      + _revDet('Departamento', mvEsc(_revNum(d.departamento)))
      + _revDet('Comparables', mvEsc(_revNum(d.antecedentes)))
      + _revDet('Construcción', _revStars(d.construccion))
      + _revDet('Ubicación', _revStars(d.ubicacion))
      + '</div>';
    return metrics + feats + dets;
  }
  function _revCardGen(r) {
    const res = r.resultado || {};
    const keys = Object.keys(res).slice(0, 4);
    let mh = '<div class="rev-metrics">';
    keys.forEach((k, i) => {
      let v = res[k]; if (_REV_MONEY.has(k)) v = _revMoney(v); else if (k === 'incertidumbre') v = v + ' %';
      mh += '<div class="rev-metric' + (i === 0 ? ' big' : '') + '"><div class="lbl">' + mvEsc(_REV_LBL[k] || k) + '</div><div class="val">' + mvEsc(String(v)) + '</div></div>';
    });
    return mh + '</div>';
  }
  function _revCard(r) {
    const t = _REV_TIPOS[r.tipo] || { label: r.tipo, icon: 'fa-file', color: '#888' };
    const badge = r.revisado ? '<span class="rev-badge ok"><i class="fas fa-circle-check"></i> Revisada</span>' : '<span class="rev-badge pend"><i class="fas fa-clock"></i> Sin revisar</span>';
    const cuerpo = r.tipo === 'tasacion' ? _revCardTasacion(r) : _revCardGen(r);
    const pdfUrl = r.pdfUrl ? safeUrl(r.pdfUrl) : '';
    const verInf = pdfUrl
      ? '<a class="rev-lnk green" href="' + pdfUrl + '" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i> Ver informe</a>'
      : '<span class="rev-lnk green disabled"><i class="fas fa-file-pdf"></i> Sin PDF</span>';
    const toggleTxt = r.revisado ? '<i class="fas fa-rotate-left"></i> Volver a sin revisar' : '<i class="fas fa-check"></i> Marcar revisada';
    const markBtn = r.revisado ? '' : '<button class="rev-mark" onclick="revMarcar(\'' + r._uid + '\',\'' + r._field + '\',\'' + mvEsc(r.id) + '\',true)"><i class="fas fa-check"></i> Marcar revisada</button>';
    return '<div class="rev-card">'
      + '<div class="rev-h">'
      + '<span class="rev-tipo" style="background:' + t.color + '1f; color:' + t.color + '"><i class="fas ' + t.icon + '"></i> ' + mvEsc(t.label) + '</span>'
      + '<span class="rev-who">' + mvEsc(r._agente) + '</span>'
      + '<span class="rev-when">' + mvEsc(_revFecha(r.fecha)) + '</span>'
      + badge
      + '<div class="rev-kwrap">'
      + '<button class="rev-kebab" onclick="revToggleMenu(event,\'' + mvEsc(r.id) + '\')"><i class="fas fa-ellipsis-vertical"></i></button>'
      + '<div class="rev-menu" id="revMenu-' + mvEsc(r.id) + '">'
      + '<button onclick="revMarcar(\'' + r._uid + '\',\'' + r._field + '\',\'' + mvEsc(r.id) + '\',' + (!r.revisado) + ')">' + toggleTxt + '</button>'
      + '<button class="danger" onclick="revEliminar(\'' + r._uid + '\',\'' + r._field + '\',\'' + mvEsc(r.id) + '\')"><i class="fas fa-trash"></i> Eliminar</button>'
      + '</div>'
      + '</div>'
      + '</div>'
      + cuerpo
      + '<div class="rev-more" id="revMore-' + mvEsc(r.id) + '"><div class="rev-kvgrid">'
      + '<div class="rev-kvg"><h4>Datos</h4>' + (_revKv(r.datos) || '<div class="rev-kv"><span>—</span></div>') + '</div>'
      + '<div class="rev-kvg"><h4>Resultado</h4>' + (_revKv(r.resultado) || '<div class="rev-kv"><span>—</span></div>') + '</div>'
      + '</div></div>'
      + '<div class="rev-f">'
      + verInf
      + '<button class="rev-lnk ghost" onclick="revToggleMore(\'' + mvEsc(r.id) + '\',this)"><i class="fas fa-list"></i> Ver detalles <i class="fas fa-chevron-down" style="font-size:.7rem"></i></button>'
      + markBtn
      + '<button class="rev-trash" title="Eliminar" onclick="revEliminar(\'' + r._uid + '\',\'' + r._field + '\',\'' + mvEsc(r.id) + '\')"><i class="fas fa-trash"></i></button>'
      + '</div>'
      + '</div>';
  }
  function revToggleMore(id, btn) {
    const m = document.getElementById('revMore-' + id); if (!m) return;
    const open = m.classList.toggle('open');
    const chev = btn.querySelector('.fa-chevron-down, .fa-chevron-up');
    if (chev) { chev.classList.toggle('fa-chevron-down', !open); chev.classList.toggle('fa-chevron-up', open); }
  }
  function revToggleMenu(ev, id) {
    ev.stopPropagation();
    document.querySelectorAll('.rev-menu.open').forEach(m => { if (m.id !== 'revMenu-' + id) m.classList.remove('open'); });
    const m = document.getElementById('revMenu-' + id); if (m) m.classList.toggle('open');
  }
  document.addEventListener('click', () => document.querySelectorAll('.rev-menu.open').forEach(m => m.classList.remove('open')));
  function revRender() {
    const b = document.getElementById('revBanner'), list = document.getElementById('revList'), pager = document.getElementById('revPager');
    if (!b || !list || !pager) return;
    const recs = _revRecords.filter(r =>
      (_revFTipo === 'todas' || r.tipo === _revFTipo) &&
      (_revFEstado === 'todas' || (_revFEstado === 'pend' ? !r.revisado : r.revisado))
    );
    const pend = _revRecords.filter(r => !r.revisado).length;
    if (pend > 0) {
      b.innerHTML = '<div class="rev-banner alert"><div class="bic"><i class="fas fa-bell"></i></div><div><h3>' + pend + ' ' + (pend === 1 ? 'tasación sin revisar' : 'tasaciones sin revisar') + '</h3><p>Revisá los informes pendientes para que los agentes puedan descargarlos.</p></div><i class="fas fa-clipboard-list bart"></i></div>';
    } else {
      b.innerHTML = '<div class="rev-banner ok"><div class="bic"><i class="fas fa-check"></i></div><div><h3>No hay nada pendiente de revisar</h3><p>Todas las revisiones están al día.</p></div><i class="fas fa-clipboard-check bart"></i></div>';
    }
    if (!recs.length) {
      list.innerHTML = '<div class="rev-empty"><i class="fas fa-inbox"></i>No hay registros para mostrar con este filtro.</div>';
      pager.innerHTML = ''; return;
    }
    const totalPages = Math.ceil(recs.length / _REV_PAGE_SIZE);
    if (_revPage > totalPages) _revPage = totalPages;
    if (_revPage < 1) _revPage = 1;
    const start = (_revPage - 1) * _REV_PAGE_SIZE;
    list.innerHTML = recs.slice(start, start + _REV_PAGE_SIZE).map(_revCard).join('');
    pager.innerHTML = _revPagerHTML(totalPages);
  }
  function _revPagerHTML(total) {
    if (total <= 1) return '';
    let h = '<button class="rev-pg" onclick="revGoPage(' + (_revPage - 1) + ')" ' + (_revPage === 1 ? 'disabled' : '') + '><i class="fas fa-chevron-left"></i></button>';
    const win = [];
    win.push(1);
    if (_revPage > 3) win.push('...');
    for (let n = Math.max(2, _revPage - 1); n <= Math.min(total - 1, _revPage + 1); n++) win.push(n);
    if (_revPage < total - 2) win.push('...');
    if (total > 1) win.push(total);
    const seen = new Set();
    win.forEach(n => {
      if (n === '...') { h += '<span class="rev-pg dots">…</span>'; return; }
      if (seen.has(n)) return; seen.add(n);
      h += '<button class="rev-pg' + (n === _revPage ? ' active' : '') + '" onclick="revGoPage(' + n + ')">' + n + '</button>';
    });
    h += '<button class="rev-pg" onclick="revGoPage(' + (_revPage + 1) + ')" ' + (_revPage === total ? 'disabled' : '') + '><i class="fas fa-chevron-right"></i></button>';
    return h;
  }
  function revGoPage(n) { _revPage = n; revRender(); const p = document.getElementById('adminPanel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  function revSetFiltro(cual, val) { if (cual === 'tipo') _revFTipo = val; else _revFEstado = val; _revPage = 1; revRender(); }
  async function revMarcar(uid, field, id, valor) {
    try {
      const ref = db.collection('users').doc(uid);
      const d = await ref.get();
      const cur = d.exists ? d.data()[field] : null;
      let nuevo;
      if (Array.isArray(cur)) {
        nuevo = cur.map(x => (x && x.id === id) ? Object.assign({}, x, { revisado: valor }) : x);
      } else if (cur && typeof cur === 'object') {
        nuevo = Object.assign({}, cur);
        Object.keys(nuevo).forEach(k => { if (nuevo[k] && (nuevo[k].id === id || k === id)) nuevo[k] = Object.assign({}, nuevo[k], { revisado: valor }); });
      } else { return; }
      await ref.update({ [field]: nuevo });
      _revRecords.forEach(r => { if (r._uid === uid && r._field === field && r.id === id) { r.revisado = valor; } });
      revRender();
      showToast('Revisiones', valor ? 'Marcada como revisada · el agente ya puede descargarla' : 'Vuelta a sin revisar', 'fa-check');
    } catch (e) { alert('No se pudo actualizar: ' + (e.message || e)); }
  }
  async function revEliminar(uid, field, id) {
    if (!confirm('¿Eliminar este registro? Se borra también su PDF y el agente no podrá descargarlo.')) return;
    try {
      const ref = db.collection('users').doc(uid);
      const d = await ref.get();
      const cur = d.exists ? d.data()[field] : null;
      let nuevo;
      if (Array.isArray(cur)) {
        nuevo = cur.filter(x => !(x && x.id === id));
      } else if (cur && typeof cur === 'object') {
        nuevo = Object.assign({}, cur);
        Object.keys(nuevo).forEach(k => { if (nuevo[k] && (nuevo[k].id === id || k === id)) delete nuevo[k]; });
      } else { return; }
      await ref.update({ [field]: nuevo });
      try { await firebase.storage().ref('tasacionesPDF/' + id + '.pdf').delete(); } catch (e) { }
      _revRecords = _revRecords.filter(r => !(r._uid === uid && r._field === field && r.id === id));
      revRender();
      showToast('Revisiones', 'Registro eliminado', 'fa-trash');
    } catch (e) { alert('No se pudo eliminar: ' + (e.message || e)); }
  }
  async function revLimpiarRevisadas() {
    const revs = _revRecords.filter(r => r.revisado);
    if (!revs.length) { showToast('Revisiones', 'No hay revisiones revisadas para limpiar', 'fa-circle-info'); return; }
    if (!confirm('Esto elimina las ' + revs.length + ' revisión(es) ya revisadas y sus PDF de forma permanente. Asegurate de que los agentes ya las hayan descargado. ¿Continuar?')) return;
    try {
      const porDoc = {};
      revs.forEach(r => { const key = r._uid + '|' + r._field; (porDoc[key] = porDoc[key] || []).push(r.id); });
      for (const key of Object.keys(porDoc)) {
        const parts = key.split('|'); const uid = parts[0], field = parts[1];
        const ids = new Set(porDoc[key]);
        const ref = db.collection('users').doc(uid);
        const d = await ref.get();
        const cur = d.exists ? d.data()[field] : null;
        let nuevo;
        if (Array.isArray(cur)) nuevo = cur.filter(x => !(x && ids.has(x.id)));
        else if (cur && typeof cur === 'object') { nuevo = Object.assign({}, cur); Object.keys(nuevo).forEach(k => { if (nuevo[k] && (ids.has(nuevo[k].id) || ids.has(k))) delete nuevo[k]; }); }
        else continue;
        await ref.update({ [field]: nuevo });
        for (const id of ids) { try { await firebase.storage().ref('tasacionesPDF/' + id + '.pdf').delete(); } catch (e) { } }
      }
      _revRecords = _revRecords.filter(r => !r.revisado);
      _revPage = 1; revRender();
      showToast('Revisiones', 'Revisiones revisadas eliminadas', 'fa-check');
    } catch (e) { alert('No se pudo limpiar: ' + (e.message || e)); }
  }
  function showAdminAt(tb) {
    if (!currentUser || userProfile?.email?.toLowerCase() !== ADMIN_EMAIL) return;
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('profilePage').classList.add('hidden');
    document.getElementById('crmPage').classList.add('hidden');
    document.getElementById('clientProfilePage')?.classList.add('hidden');
    document.getElementById('adminPanel').classList.remove('hidden');
    showAdminTab(tb);
  }

  function openComisionAgente(agentId) {
    if (!isAdminUser()) { showToast('Solo administradores', 'Solo el administrador gestiona comisiones.', 'fa-lock'); return; }
    const agente = allUsers[agentId] || {};
    const posibles = Object.keys(allUsers)
      .filter(uid => uid !== agentId)
      .map(uid => Object.assign({ _uid: uid }, allUsers[uid]))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    let modal = document.getElementById('comisionModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'comisionModal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(16,39,63,.55);padding:20px;overflow:auto';
      modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;max-width:480px;width:100%;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.25);max-height:90vh;overflow:auto">' +
          '<h3 style="font-family:\'Cormorant Garamond\',serif;font-size:1.5rem;color:#16273f;margin-bottom:4px"><i class="fas fa-percent" style="color:#C9A227;margin-right:8px"></i>Comisión del agente</h3>' +
          '<p id="comWho" style="font-size:.85rem;color:#64748b;margin-bottom:18px"></p>' +
          '<div style="font-weight:600;color:#16273f;margin-bottom:8px;font-size:.9rem">Comisión del agente <span style="font-weight:400;color:#94a3b8">(% de la comisión de la inmobiliaria)</span></div>' +
          '<div style="display:flex;gap:12px">' +
            '<div style="flex:1"><label style="font-size:.75rem;color:#64748b;display:block;margin-bottom:5px">Venta %</label><input id="comSale" type="number" min="0" max="100" step="0.1" placeholder="0" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit"></div>' +
            '<div style="flex:1"><label style="font-size:.75rem;color:#64748b;display:block;margin-bottom:5px">Alquiler %</label><input id="comRent" type="number" min="0" max="100" step="0.1" placeholder="0" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit"></div>' +
          '</div>' +
          '<hr style="border:none;border-top:1px solid #eef2f7;margin:20px 0">' +
          '<div style="font-weight:600;color:#16273f;margin-bottom:8px;font-size:.9rem">Referente <span style="font-weight:400;color:#94a3b8">(quién lo refirió y qué gana de su comisión)</span></div>' +
          '<label style="font-size:.75rem;color:#64748b;display:block;margin-bottom:5px">¿Quién lo refirió?</label>' +
          '<select id="comReferrer" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit;background:#fff"></select>' +
          '<div style="display:flex;gap:12px;margin-top:12px">' +
            '<div style="flex:1"><label style="font-size:.75rem;color:#64748b;display:block;margin-bottom:5px">Gana % (venta)</label><input id="comRefSale" type="number" min="0" max="100" step="0.1" placeholder="0" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit"></div>' +
            '<div style="flex:1"><label style="font-size:.75rem;color:#64748b;display:block;margin-bottom:5px">Gana % (alquiler)</label><input id="comRefRent" type="number" min="0" max="100" step="0.1" placeholder="0" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit"></div>' +
          '</div>' +
          '<p style="font-size:.72rem;color:#94a3b8;margin-top:8px">El referente gana ese % de la comisión que le queda al agente en cada operación confirmada.</p>' +
          '<div style="display:flex;gap:10px;justify-content:space-between;margin-top:22px">' +
            '<button id="comRemoveRef" style="padding:10px 14px;border-radius:9px;border:1px solid #fecaca;background:#fff;color:#b91c1c;font-family:inherit;font-weight:600;cursor:pointer">Quitar referente</button>' +
            '<div style="display:flex;gap:10px"><button id="comCancel" style="padding:10px 18px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-family:inherit;font-weight:600;cursor:pointer">Cancelar</button>' +
            '<button id="comSave" style="padding:10px 18px;border-radius:9px;border:none;background:#16273f;color:#fff;font-family:inherit;font-weight:600;cursor:pointer">Guardar</button></div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.querySelector('#comCancel').addEventListener('click', () => { modal.style.display = 'none'; });
      modal.querySelector('#comRemoveRef').addEventListener('click', () => {
        modal.querySelector('#comReferrer').value = '';
        modal.querySelector('#comRefSale').value = '';
        modal.querySelector('#comRefRent').value = '';
      });
      modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    }
    const sel = modal.querySelector('#comReferrer');
    sel.innerHTML = '<option value="">— Sin referente —</option>' + posibles.map(u => `<option value="${u._uid}">${mvEsc(u.name || u.email || 'Agente')}</option>`).join('');
    modal.querySelector('#comWho').innerHTML = 'Agente: <b>' + mvEsc(agente.name || agente.email || 'Agente') + '</b>';
    modal.querySelector('#comSale').value = (agente.commissionSale != null) ? agente.commissionSale : '';
    modal.querySelector('#comRent').value = (agente.commissionRent != null) ? agente.commissionRent : '';
    sel.value = ''; modal.querySelector('#comRefSale').value = ''; modal.querySelector('#comRefRent').value = '';
    db.collection('referidos').doc(agentId).get().then(d => {
      const r = d.exists ? d.data() : {};
      sel.value = r.referrerUid || '';
      modal.querySelector('#comRefSale').value = (r.pctSale != null) ? r.pctSale : '';
      modal.querySelector('#comRefRent').value = (r.pctRent != null) ? r.pctRent : '';
    }).catch(() => {});
    modal.querySelector('#comSave').onclick = async function () {
      const referrerUid = sel.value;
      if (referrerUid === agentId) { showToast('No válido', 'Un agente no puede referirse a sí mismo.', 'fa-triangle-exclamation'); return; }
      const commissionSale = parseFloat(modal.querySelector('#comSale').value) || 0;
      const commissionRent = parseFloat(modal.querySelector('#comRent').value) || 0;
      const pctSale = parseFloat(modal.querySelector('#comRefSale').value) || 0;
      const pctRent = parseFloat(modal.querySelector('#comRefRent').value) || 0;
      const btn = this; btn.disabled = true; btn.textContent = 'Guardando...';
      try {
        await db.collection('users').doc(agentId).update({ commissionSale, commissionRent });
        if (allUsers[agentId]) { allUsers[agentId].commissionSale = commissionSale; allUsers[agentId].commissionRent = commissionRent; }
        if (referrerUid) {
          await db.collection('referidos').doc(agentId).set({ referredUid: agentId, referrerUid, pctSale, pctRent, updatedAt: new Date().toISOString() });
        } else {
          await db.collection('referidos').doc(agentId).delete().catch(() => {});
        }
        modal.style.display = 'none';
        showAdminTab('comisiones');
        showToast('Guardado', 'Comisión y referente actualizados.', 'fa-check');
      } catch (e) {
        showToast('Error', 'No se pudo guardar: ' + (e.message || e), 'fa-triangle-exclamation');
      } finally { btn.disabled = false; btn.textContent = 'Guardar'; }
    };
    modal.style.display = 'flex';
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
  // Asignar rango/cargo. El select usa el organigrama (RANKS); guarda 'rank' (clave,
  // para permisos) y 'role' (etiqueta visible). La opción "Otro" deja un título libre.
  function setUserRole(id) {
    if (!isAdminUser()) { showToast('Solo administradores', 'Solo el administrador puede asignar cargos.', 'fa-lock'); return; }
    const u = allUsers[id] || {};
    const rankActual = u.rank || '';
    const roleActual = u.role || '';
    // Si el cargo guardado no es un rango conocido, lo tratamos como "Otro".
    const esConocido = !!rankActual && RANKS.some(r => r.key === rankActual);

    let modal = document.getElementById('rankModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rankModal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(16,39,63,.55);padding:20px';
      // Optgroups por área del organigrama
      const grupos = {};
      RANKS.forEach(r => { (grupos[r.grupo] = grupos[r.grupo] || []).push(r); });
      let opts = '<option value="">— Sin cargo —</option>';
      Object.keys(grupos).forEach(g => {
        opts += '<optgroup label="' + g + '">';
        grupos[g].forEach(r => { opts += '<option value="' + r.key + '">' + r.label + '</option>'; });
        opts += '</optgroup>';
      });
      opts += '<option value="__otro__">Otro (personalizado)…</option>';
      modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;max-width:440px;width:100%;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.25)">' +
          '<h3 style="font-family:\'Cormorant Garamond\',serif;font-size:1.5rem;color:#16273f;margin-bottom:4px"><i class="fas fa-id-badge" style="color:#C9A227;margin-right:8px"></i>Cargo del agente</h3>' +
          '<p style="font-size:.85rem;color:#64748b;margin-bottom:16px">El cargo aparece en el perfil del agente. <b>El COO y el CEO</b> pueden ver la agenda de todo el equipo.</p>' +
          '<label style="font-size:.8rem;font-weight:600;color:#16273f;display:block;margin-bottom:6px">Rango</label>' +
          '<select id="rankSelect" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit;font-size:.95rem;background:#fff">' + opts + '</select>' +
          '<div id="rankCustomWrap" style="display:none;margin-top:12px">' +
            '<label style="font-size:.8rem;font-weight:600;color:#16273f;display:block;margin-bottom:6px">Título personalizado</label>' +
            '<input id="rankCustom" type="text" placeholder="Ej: Corredor Público" style="width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit;font-size:.95rem">' +
          '</div>' +
          '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:22px">' +
            '<button id="rankCancel" style="padding:10px 18px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-family:inherit;font-weight:600;cursor:pointer">Cancelar</button>' +
            '<button id="rankSave" style="padding:10px 18px;border-radius:9px;border:none;background:#16273f;color:#fff;font-family:inherit;font-weight:600;cursor:pointer">Guardar</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      const sel = modal.querySelector('#rankSelect');
      const wrap = modal.querySelector('#rankCustomWrap');
      sel.addEventListener('change', function(){ wrap.style.display = (sel.value === '__otro__') ? 'block' : 'none'; });
      modal.querySelector('#rankCancel').addEventListener('click', function(){ modal.style.display = 'none'; });
      modal.addEventListener('click', function(e){ if (e.target === modal) modal.style.display = 'none'; });
    }

    const sel = modal.querySelector('#rankSelect');
    const wrap = modal.querySelector('#rankCustomWrap');
    const custom = modal.querySelector('#rankCustom');
    if (esConocido) { sel.value = rankActual; wrap.style.display = 'none'; custom.value = ''; }
    else if (roleActual) { sel.value = '__otro__'; wrap.style.display = 'block'; custom.value = roleActual; }
    else { sel.value = ''; wrap.style.display = 'none'; custom.value = ''; }

    const saveBtn = modal.querySelector('#rankSave');
    saveBtn.onclick = async function(){
      let rank = sel.value, role;
      if (rank === '__otro__') { rank = ''; role = (custom.value || '').trim(); }
      else if (rank === '') { role = ''; }
      else { role = rankLabel(rank); }
      saveBtn.disabled = true; saveBtn.textContent = 'Guardando...';
      try {
        await db.collection('users').doc(id).update({ rank: rank, role: role });
        if (allUsers[id]) { allUsers[id].rank = rank; allUsers[id].role = role; }
        modal.style.display = 'none';
        if (currentProfileUserId === id) showProfile(id);
        showAdminTab('users');
        showToast('Cargo actualizado', role ? `Ahora figura como "${role}".` : 'Se quitó el cargo.', 'fa-id-badge');
      } catch (e) {
        showToast('Error', 'No se pudo guardar el cargo: ' + (e.message || e), 'fa-triangle-exclamation');
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Guardar';
      }
    };
    modal.style.display = 'flex';
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
    _icEditando = false;
    renderSharePortales(p);
    openModal('shareModal')
  }

  // ----- Links de los portales (Mercado Libre / InfoCasas) en el modal de compartir -----
  // Solo visible con sesión iniciada: es una herramienta para los agentes.
  // ML: el permalink lo guarda el backend al publicar (p.mlPermalink), es automático.
  // InfoCasas: asigna su propia URL al importar el feed y el sistema no la conoce,
  // así que el dueño (o el admin) la pega una vez acá y queda guardada para todos.
  let _icEditando = false;
  function renderSharePortales(p){
    const box = document.getElementById('sharePortales');
    if (!box) return;
    if (!currentUser){ box.style.display = 'none'; box.innerHTML = ''; return; }
    const puedeEditar = (p.ownerId === currentUser.uid) || isAdminUser();
    const fila = (tag, tagStyle, inner) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;min-height:34px"><span style="flex:none;padding:3px 8px;border-radius:6px;font-weight:700;font-size:11px;${tagStyle}">${tag}</span>${inner}</div>`;
    const urlSpan = u => `<span style="flex:1;min-width:0;font-size:12px;color:var(--gray-500);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${mvEsc(u)}">${mvEsc(u)}</span>`;
    const btnCopiar = cual => `<button onclick="copiarLinkPortal('${cual}')" style="flex:none;border:1px solid var(--gray-200,#e5e7eb);background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;font-weight:600;color:var(--gray-700,#374151)"><i class="fas fa-copy"></i> Copiar</button>`;
    const btnAbrir = u => safeUrl(u) ? `<a href="${safeUrl(u)}" target="_blank" rel="noopener" style="flex:none;color:var(--gray-400);padding:6px" title="Abrir el aviso"><i class="fas fa-external-link-alt"></i></a>` : '';
    const vacio = t => `<span style="flex:1;font-size:12px;color:var(--gray-400)">${t}</span>`;

    let ml;
    if (p.mlPermalink) ml = urlSpan(p.mlPermalink) + btnCopiar('ml') + btnAbrir(p.mlPermalink);
    else ml = vacio('Sin publicar en Mercado Libre');

    let ic;
    if (p.infocasasUrl && !_icEditando){
      ic = urlSpan(p.infocasasUrl) + btnCopiar('ic') + btnAbrir(p.infocasasUrl) +
        (puedeEditar ? `<button onclick="editarLinkInfocasas()" style="flex:none;border:none;background:transparent;color:var(--gray-400);cursor:pointer;padding:6px" title="Cambiar el link"><i class="fas fa-pen"></i></button>` : '');
    } else if (puedeEditar){
      ic = `<input id="icUrlInput" type="url" placeholder="Pegá el link del aviso en InfoCasas" value="${mvEsc(p.infocasasUrl||'')}" style="flex:1;min-width:0;padding:7px 10px;border:1px solid var(--gray-200,#e5e7eb);border-radius:8px;font-size:12px;font-family:inherit">` +
        `<button onclick="guardarLinkInfocasas()" style="flex:none;border:none;background:var(--accent,#C9A227);color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600">Guardar</button>`;
    } else {
      ic = vacio('El dueño todavía no cargó el link');
    }

    box.innerHTML =
      `<div style="font-size:11px;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:.4px;margin:0 0 10px"><i class="fas fa-store"></i> Links en los portales</div>` +
      fila('ML', 'background:#fff159;color:#2d3277', ml) +
      fila('IC', 'background:#dbeafe;color:#1d4ed8', ic);
    box.style.display = 'block';
  }

  function copiarLinkPortal(cual){
    const p = currentShareProperty; if (!p) return;
    const url = cual === 'ml' ? p.mlPermalink : p.infocasasUrl;
    if (!url) return;
    const nombre = cual === 'ml' ? 'Mercado Libre' : 'InfoCasas';
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link copiado', 'El aviso de ' + nombre + ' está listo para pegar', 'fa-link');
    }).catch(() => {
      const t = document.createElement('textarea');
      t.value = url; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); showToast('Link copiado', 'El aviso de ' + nombre + ' está listo para pegar', 'fa-link'); }
      catch (e) { showToast('No se pudo copiar', 'Copialo a mano desde el botón de abrir', 'fa-exclamation-triangle'); }
      t.remove();
    });
  }

  function editarLinkInfocasas(){ _icEditando = true; if (currentShareProperty) renderSharePortales(currentShareProperty); }

  async function guardarLinkInfocasas(){
    const p = currentShareProperty; if (!p) return;
    const inp = document.getElementById('icUrlInput');
    const v = ((inp && inp.value) || '').trim();
    if (v && (v.indexOf('infocasas.com') === -1 || !safeUrl(v))){
      showToast('Ese link no parece de InfoCasas', 'Pegá la URL completa del aviso publicado (empieza con https://www.infocasas.com.uy/...)', 'fa-exclamation-triangle');
      return;
    }
    try {
      await db.collection('properties').doc(p.id).update({ infocasasUrl: v });
      p.infocasasUrl = v;
      _icEditando = false;
      renderSharePortales(p);
      showToast(v ? 'Link de InfoCasas guardado' : 'Link de InfoCasas quitado', v ? 'Ahora todos los agentes lo pueden copiar desde Compartir' : '', 'fa-check');
    } catch (e) {
      console.error('No se pudo guardar el link de InfoCasas:', e);
      showToast('No se pudo guardar', (e && e.message) || 'Probá de nuevo', 'fa-exclamation-triangle');
    }
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


// ===== Inicio v2: foto del hero =====
// (Los "favoritos" con corazón se eliminaron: no aportaban nada porque el
// visitante no tiene cuenta ni una vista donde consultarlos.)
function mvSetHeroPhoto(ps) {
  // La imagen del hero ahora es una foto fija profesional definida en index.html
  // (antes tomaba la primera propiedad y no se integraba bien). No se toca.
}
