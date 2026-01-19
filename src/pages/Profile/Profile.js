import React, { useState, useRef, useEffect } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { 
  User, Mail, Phone, Camera, Edit, Save, X, 
  Building2, Eye, Calendar, TrendingUp
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import PropertyCard from '../../components/PropertyCard/PropertyCard';
import './Profile.css';

const Profile = () => {
  const { currentUser, userProfile, updateUserProfile } = useAuth();
  const { properties } = useProperty();
  const fileInputRef = useRef(null);
  
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newPhoto, setNewPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    whatsapp: ''
  });

  useEffect(() => {
    if (userProfile) {
      setFormData({
        name: userProfile.name || '',
        whatsapp: userProfile.whatsapp || ''
      });
    }
  }, [userProfile]);

  const userProperties = properties.filter(p => p.ownerId === currentUser?.uid);
  
  const totalViews = userProperties.reduce((acc, p) => acc + (p.views || 0), 0);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError('');
  };

  const handlePhotoChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        setError('La imagen no debe superar los 5MB');
        return;
      }
      setNewPhoto(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      setError('El nombre es requerido');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await updateUserProfile({
        name: formData.name,
        whatsapp: formData.whatsapp
      }, newPhoto);
      
      setSuccess('Perfil actualizado correctamente');
      setEditing(false);
      setNewPhoto(null);
      setPhotoPreview(null);
    } catch (error) {
      console.error('Error updating profile:', error);
      setError('Error al actualizar el perfil');
    } finally {
      setLoading(false);
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    setNewPhoto(null);
    setPhotoPreview(null);
    setFormData({
      name: userProfile?.name || '',
      whatsapp: userProfile?.whatsapp || ''
    });
    setError('');
  };

  if (!currentUser) {
    return <Navigate to="/login" replace />;
  }

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('es-UY', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  return (
    <div className="profile-page">
      <div className="container">
        <div className="profile-grid">
          <div className="profile-sidebar">
            <div className="profile-card">
              <div className="profile-cover" />
              
              <div className="profile-avatar-container">
                {editing ? (
                  <div 
                    className="profile-avatar editable"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {photoPreview || userProfile?.profilePhoto ? (
                      <img src={photoPreview || userProfile?.profilePhoto} alt={userProfile?.name} />
                    ) : (
                      <User size={48} />
                    )}
                    <div className="avatar-overlay">
                      <Camera size={24} />
                    </div>
                  </div>
                ) : (
                  <div className="profile-avatar">
                    {userProfile?.profilePhoto ? (
                      <img src={userProfile.profilePhoto} alt={userProfile?.name} />
                    ) : (
                      <User size={48} />
                    )}
                  </div>
                )}
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handlePhotoChange}
                  accept="image/*"
                  hidden
                />
              </div>

              {editing ? (
                <form onSubmit={handleSubmit} className="profile-edit-form">
                  {error && <div className="profile-error">{error}</div>}
                  
                  <div className="form-group">
                    <label className="form-label">Nombre</label>
                    <input
                      type="text"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      className="form-input"
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">WhatsApp</label>
                    <input
                      type="tel"
                      name="whatsapp"
                      value={formData.whatsapp}
                      onChange={handleChange}
                      className="form-input"
                      placeholder="+598 99 123 456"
                    />
                  </div>

                  <div className="edit-actions">
                    <button 
                      type="button" 
                      className="btn btn-outline-sm"
                      onClick={cancelEdit}
                    >
                      <X size={16} />
                      Cancelar
                    </button>
                    <button 
                      type="submit" 
                      className="btn btn-primary-sm"
                      disabled={loading}
                    >
                      {loading ? (
                        <span className="spinner-sm" />
                      ) : (
                        <>
                          <Save size={16} />
                          Guardar
                        </>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="profile-info">
                    <h2>{userProfile?.name || 'Usuario'}</h2>
                    <span className={`status-badge status-${userProfile?.status}`}>
                      {userProfile?.status === 'approved' ? 'Aprobado' : 
                       userProfile?.status === 'pending' ? 'Pendiente' : 'Rechazado'}
                    </span>
                  </div>

                  {success && <div className="profile-success">{success}</div>}

                  <div className="profile-details">
                    <div className="profile-detail">
                      <Mail size={18} />
                      <span>{currentUser?.email}</span>
                    </div>
                    {userProfile?.whatsapp && (
                      <div className="profile-detail">
                        <Phone size={18} />
                        <span>{userProfile.whatsapp}</span>
                      </div>
                    )}
                    {userProfile?.createdAt && (
                      <div className="profile-detail">
                        <Calendar size={18} />
                        <span>Miembro desde {formatDate(userProfile.createdAt)}</span>
                      </div>
                    )}
                  </div>

                  <button 
                    className="btn btn-outline edit-profile-btn"
                    onClick={() => setEditing(true)}
                  >
                    <Edit size={18} />
                    Editar Perfil
                  </button>
                </>
              )}
            </div>

            <div className="stats-card">
              <h3>Estadísticas</h3>
              <div className="stats-list">
                <div className="stat-item">
                  <div className="stat-icon">
                    <Building2 size={20} />
                  </div>
                  <div className="stat-content">
                    <span className="stat-value">{userProperties.length}</span>
                    <span className="stat-label">Propiedades</span>
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-icon">
                    <Eye size={20} />
                  </div>
                  <div className="stat-content">
                    <span className="stat-value">{totalViews}</span>
                    <span className="stat-label">Visualizaciones</span>
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-icon">
                    <TrendingUp size={20} />
                  </div>
                  <div className="stat-content">
                    <span className="stat-value">
                      {userProperties.length > 0 ? Math.round(totalViews / userProperties.length) : 0}
                    </span>
                    <span className="stat-label">Promedio por propiedad</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="profile-main">
            <div className="section-header">
              <h2>Mis Propiedades</h2>
              <p>{userProperties.length} propiedades publicadas</p>
            </div>

            {userProperties.length > 0 ? (
              <div className="properties-grid">
                {userProperties.map(property => (
                  <PropertyCard key={property.id} property={property} showViews />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <Building2 size={64} />
                <h3>Aún no tienes propiedades</h3>
                <p>Comienza publicando tu primera propiedad</p>
                {userProfile?.status === 'approved' && (
                  <Link to="/admin/property/new" className="btn btn-primary">
                    Publicar Propiedad
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Profile;
