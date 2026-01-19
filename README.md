# Mi Cartera Inmobiliaria 🏠

Una aplicación web inmobiliaria moderna, atractiva y completamente responsive desarrollada con React y Firebase.

## ✨ Características

### Para Visitantes
- 🏘️ Galería de propiedades con tarjetas visuales y carrusel automático de imágenes
- 🔍 Filtros por tipo (venta/alquiler), precio, habitaciones y mascotas
- 📍 Búsqueda por ubicación
- 📱 Diseño responsive para móvil, tablet y escritorio

### Para Usuarios Registrados
- 👤 Registro con email, contraseña, WhatsApp y foto de perfil
- 💬 Sistema de comentarios en propiedades
- 📊 Estadísticas de visualizaciones de propiedades
- ✏️ Perfil editable

### Para Administradores
- ⚙️ Panel de administración exclusivo
- ✅ Aprobación/rechazo de usuarios pendientes
- 🏠 Gestión completa de propiedades (crear, editar, eliminar)
- 👥 Gestión de usuarios
- 📈 Vista de estadísticas generales

## 🛠️ Tecnologías

- **Frontend:** React 18
- **Backend:** Firebase (Authentication, Firestore, Storage)
- **Routing:** React Router DOM
- **Iconos:** Lucide React
- **Estilos:** CSS personalizado con variables y diseño responsive

## 📦 Instalación

1. Clona el repositorio:
```bash
git clone https://github.com/tu-usuario/mi-cartera-inmobiliaria.git
cd mi-cartera-inmobiliaria
```

2. Instala las dependencias:
```bash
npm install
```

3. Inicia el servidor de desarrollo:
```bash
npm start
```

## 🔧 Configuración de Firebase

El proyecto ya incluye la configuración de Firebase. Si deseas usar tu propia configuración:

1. Crea un proyecto en [Firebase Console](https://console.firebase.google.com/)
2. Habilita Authentication (Email/Password)
3. Crea una base de datos en Firestore
4. Configura Storage para imágenes
5. Actualiza el archivo `src/firebase/config.js` con tus credenciales

## 📁 Estructura del Proyecto

```
src/
├── components/
│   ├── Header/
│   ├── Footer/
│   ├── PropertyCard/
│   └── PropertyFilters/
├── context/
│   ├── AuthContext.js
│   └── PropertyContext.js
├── firebase/
│   └── config.js
├── pages/
│   ├── Home/
│   ├── Auth/
│   ├── Admin/
│   ├── Profile/
│   └── PropertyDetail/
├── styles/
│   └── globals.css
├── App.js
└── index.js
```

## 🔐 Roles de Usuario

- **Visitante:** Puede ver propiedades y sus detalles
- **Usuario Pendiente:** Esperando aprobación del administrador
- **Usuario Aprobado:** Puede comentar y publicar propiedades
- **Administrador:** Acceso completo al panel de administración

**Email del Administrador:** Fabricio9061@gmail.com

## 📱 Características de la Interfaz

- Tarjetas de propiedad con carrusel automático (4 segundos)
- Etiquetas de VENTA/ALQUILER destacadas
- Información detallada: precio, ubicación, m², habitaciones, baños, cochera
- Botón de WhatsApp con mensaje predefinido
- Contador de visualizaciones por propiedad
- Diseño oscuro elegante con acentos dorados y rojos

## 🚀 Despliegue

### GitHub Pages
```bash
npm run build
```

### Firebase Hosting
```bash
npm install -g firebase-tools
firebase login
firebase init hosting
firebase deploy
```

### Vercel/Netlify
Conecta tu repositorio de GitHub y despliega automáticamente.

## 📄 Licencia

© 2026 - Página creada por Anibal Malave

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Por favor, abre un issue primero para discutir los cambios que te gustaría hacer.
