import React, { useState, useEffect } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { 
  Users, Building2, Check, X, Trash2, Eye, 
  UserCheck, UserX, Clock, Plus, Edit, BarChart3
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import './Admin.css';

const AdminPanel = () => {
  const { currentUser, userProfile, isAdmin, getPendingUsers, approveUser, rejectUser, getAllUsers, deleteUser } = useAuth();
  const { properties, deleteProperty } = useProperty();
  const [activeTab, setActiveTab] = useState('pending');
  const [pendingUsers, setPendingUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const pending = await getPendingUsers();
        const users = await getAllUsers();
        setPendingUsers(pending);
        setAllUsers(users);
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        setLoading(false);
      }
    };

    if (isAdmin) {
      fetchData();
    }
  }, [isAdmin]);

  const handleApprove = async (userId) => {
    setActionLoading(userId);
    try {
      await approveUser(userId);
      setPendingUsers(prev => prev.filter(u => u.id !== userId));
      setAllUsers(prev => prev.map(u => 
        u.id === userId ? { ...u, status: 'approved' } : u
      ));
    } catch (error) {
      console.error('Error approving user:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (userId) => {
    setActionLoading(userId);
    try {
      await rejectUser(userId);
      setPendingUsers(prev => prev.filter(u => u.id !== userId));
      setAllUsers(prev => prev.map(u => 
        u.id === userId ? { ...u, status: 'rejected' } : u
      ));
    } catch (error) {
      console.error('Error rejecting user:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('¿Estás seguro de eliminar este usuario? Esta acción no se puede deshacer.')) {
      return;
    }
    setActionLoading(userId);
    try {
      await deleteUser(userId);
      setAllUsers(prev => prev.filter(u => u.id !== userId));
      setPendingUsers(prev => prev.filter(u => u.id !== userId));
    } catch (error) {
      console.error('Error deleting user:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteProperty = async (propertyId) => {
    if (!window.confirm('¿Estás seguro de eliminar esta propiedad?')) {
      return;
    }
    setActionLoading(propertyId);
    try {
      await deleteProperty(propertyId);
    } catch (error) {
      console.error('Error deleting property:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('es-UY', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  if (!currentUser || !isAdmin) {
    return <Navigate to="/" replace />;
  }

  const stats = {
    pendingCount: pendingUsers.length,
    totalUsers: allUsers.length,
    approvedUsers: allUsers.filter(u => u.status === 'approved').length,
    totalProperties: properties.length,
    propertiesForSale: properties.filter(p => p.type === 'sale').length,
    propertiesForRent: properties.filter(p => p.type === 'rent').length
  };

  return (
    <div className="admin-panel">
      <div className="container">
        <div className="admin-header">
          <div>
            <h1>Panel de Administración</h1>
            <p>Gestiona usuarios y propiedades</p>
          </div>
          <Link to="/admin/property/new" className="btn btn-primary">
            <Plus size={20} />
            Nueva Propiedad
          </Link>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon pending">
              <Clock size={28} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{stats.pendingCount}</span>
              <span className="stat-label">Pendientes</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon users">
              <Users size={28} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{stats.totalUsers}</span>
              <span className="stat-label">Usuarios</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon properties">
              <Building2 size={28} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{stats.totalProperties}</span>
              <span className="stat-label">Propiedades</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon analytics">
              <BarChart3 size={28} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{stats.propertiesForSale}/{stats.propertiesForRent}</span>
              <span className="stat-label">Venta/Alquiler</span>
            </div>
          </div>
        </div>

        <div className="admin-tabs">
          <button 
            className={`tab ${activeTab === 'pending' ? 'active' : ''}`}
            onClick={() => setActiveTab('pending')}
          >
            <Clock size={18} />
            Pendientes
            {stats.pendingCount > 0 && (
              <span className="tab-badge">{stats.pendingCount}</span>
            )}
          </button>
          <button 
            className={`tab ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            <Users size={18} />
            Usuarios
          </button>
          <button 
            className={`tab ${activeTab === 'properties' ? 'active' : ''}`}
            onClick={() => setActiveTab('properties')}
          >
            <Building2 size={18} />
            Propiedades
          </button>
        </div>

        <div className="admin-content">
          {loading ? (
            <div className="loading-container">
              <div className="spinner" />
              <p>Cargando...</p>
            </div>
          ) : (
            <>
              {activeTab === 'pending' && (
                <div className="users-list">
                  {pendingUsers.length > 0 ? (
                    pendingUsers.map(user => (
                      <div key={user.id} className="user-card">
                        <div className="user-avatar">
                          {user.profilePhoto ? (
                            <img src={user.profilePhoto} alt={user.name} />
                          ) : (
                            <Users size={24} />
                          )}
                        </div>
                        <div className="user-info">
                          <h4>{user.name}</h4>
                          <p>{user.email}</p>
                          <span className="user-meta">
                            WhatsApp: {user.whatsapp} • Registrado: {formatDate(user.createdAt)}
                          </span>
                        </div>
                        <div className="user-actions">
                          <button 
                            className="btn-action approve"
                            onClick={() => handleApprove(user.id)}
                            disabled={actionLoading === user.id}
                          >
                            <UserCheck size={18} />
                            Aprobar
                          </button>
                          <button 
                            className="btn-action reject"
                            onClick={() => handleReject(user.id)}
                            disabled={actionLoading === user.id}
                          >
                            <UserX size={18} />
                            Rechazar
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="empty-state">
                      <Check size={48} />
                      <h3>No hay usuarios pendientes</h3>
                      <p>Todos los usuarios han sido gestionados</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'users' && (
                <div className="users-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Usuario</th>
                        <th>Email</th>
                        <th>WhatsApp</th>
                        <th>Estado</th>
                        <th>Fecha</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allUsers.map(user => (
                        <tr key={user.id}>
                          <td>
                            <div className="table-user">
                              <div className="table-avatar">
                                {user.profilePhoto ? (
                                  <img src={user.profilePhoto} alt={user.name} />
                                ) : (
                                  <Users size={18} />
                                )}
                              </div>
                              <span>{user.name}</span>
                            </div>
                          </td>
                          <td>{user.email}</td>
                          <td>{user.whatsapp}</td>
                          <td>
                            <span className={`status-badge status-${user.status}`}>
                              {user.status === 'pending' && 'Pendiente'}
                              {user.status === 'approved' && 'Aprobado'}
                              {user.status === 'rejected' && 'Rechazado'}
                            </span>
                          </td>
                          <td>{formatDate(user.createdAt)}</td>
                          <td>
                            <div className="table-actions">
                              {user.status === 'pending' && (
                                <>
                                  <button 
                                    className="icon-btn approve"
                                    onClick={() => handleApprove(user.id)}
                                    title="Aprobar"
                                  >
                                    <Check size={16} />
                                  </button>
                                  <button 
                                    className="icon-btn reject"
                                    onClick={() => handleReject(user.id)}
                                    title="Rechazar"
                                  >
                                    <X size={16} />
                                  </button>
                                </>
                              )}
                              <button 
                                className="icon-btn delete"
                                onClick={() => handleDeleteUser(user.id)}
                                title="Eliminar"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === 'properties' && (
                <div className="properties-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Propiedad</th>
                        <th>Ubicación</th>
                        <th>Precio</th>
                        <th>Tipo</th>
                        <th>Vistas</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {properties.map(property => (
                        <tr key={property.id}>
                          <td>
                            <div className="table-property">
                              <div className="table-property-img">
                                <img 
                                  src={property.images?.[0] || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=100&h=100&fit=crop'} 
                                  alt={property.title} 
                                />
                              </div>
                              <span>{property.title}</span>
                            </div>
                          </td>
                          <td>{property.location}</td>
                          <td>
                            ${property.price?.toLocaleString()}
                            {property.type === 'rent' && '/mes'}
                          </td>
                          <td>
                            <span className={`type-badge type-${property.type}`}>
                              {property.type === 'sale' ? 'Venta' : 'Alquiler'}
                            </span>
                          </td>
                          <td>
                            <div className="views-count">
                              <Eye size={16} />
                              {property.views || 0}
                            </div>
                          </td>
                          <td>
                            <div className="table-actions">
                              <Link 
                                to={`/property/${property.id}`} 
                                className="icon-btn view"
                                title="Ver"
                              >
                                <Eye size={16} />
                              </Link>
                              <Link 
                                to={`/admin/property/${property.id}/edit`} 
                                className="icon-btn edit"
                                title="Editar"
                              >
                                <Edit size={16} />
                              </Link>
                              <button 
                                className="icon-btn delete"
                                onClick={() => handleDeleteProperty(property.id)}
                                title="Eliminar"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
