import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { 
  Home, 
  User, 
  LogOut, 
  Menu, 
  X, 
  Settings,
  Building2,
  Shield
} from 'lucide-react';
import './Header.css';

const Header = () => {
  const { currentUser, userProfile, isAdmin, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/');
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };

  const isActive = (path) => location.pathname === path;

  return (
    <header className="header">
      <div className="header-container">
        <Link to="/" className="logo">
          <Building2 className="logo-icon" />
          <div className="logo-text">
            <span className="logo-name">Mi Cartera</span>
            <span className="logo-subtitle">Inmobiliaria</span>
          </div>
        </Link>

        <nav className={`nav ${mobileMenuOpen ? 'nav-open' : ''}`}>
          <Link 
            to="/" 
            className={`nav-link ${isActive('/') ? 'active' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
          >
            <Home size={18} />
            <span>Inicio</span>
          </Link>

          {currentUser ? (
            <>
              <Link 
                to="/profile" 
                className={`nav-link ${isActive('/profile') ? 'active' : ''}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                <User size={18} />
                <span>Mi Perfil</span>
              </Link>

              {isAdmin && (
                <Link 
                  to="/admin" 
                  className={`nav-link nav-link-admin ${isActive('/admin') ? 'active' : ''}`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <Shield size={18} />
                  <span>Admin</span>
                </Link>
              )}

              <div className="nav-user">
                <div className="user-avatar">
                  {userProfile?.profilePhoto ? (
                    <img src={userProfile.profilePhoto} alt={userProfile.name} />
                  ) : (
                    <User size={20} />
                  )}
                </div>
                <span className="user-name">{userProfile?.name}</span>
              </div>

              <button className="nav-link logout-btn" onClick={handleLogout}>
                <LogOut size={18} />
                <span>Salir</span>
              </button>
            </>
          ) : (
            <>
              <Link 
                to="/login" 
                className={`nav-link ${isActive('/login') ? 'active' : ''}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                <User size={18} />
                <span>Iniciar Sesión</span>
              </Link>
              <Link 
                to="/register" 
                className="nav-btn"
                onClick={() => setMobileMenuOpen(false)}
              >
                Registrarse
              </Link>
            </>
          )}
        </nav>

        <button 
          className="mobile-menu-btn"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>
    </header>
  );
};

export default Header;
