import React from 'react';
import { Link } from 'react-router-dom';
import { Building2, Mail, Phone, MapPin, Facebook, Instagram, Twitter } from 'lucide-react';
import './Footer.css';

const Footer = () => {
  return (
    <footer className="footer">
      <div className="footer-content">
        <div className="footer-section footer-brand">
          <div className="footer-logo">
            <Building2 className="footer-logo-icon" />
            <div>
              <span className="footer-logo-name">Mi Cartera</span>
              <span className="footer-logo-subtitle">Inmobiliaria</span>
            </div>
          </div>
          <p className="footer-description">
            Tu portal inmobiliario de confianza. Encuentra la propiedad de tus sueños 
            con nosotros. Venta y alquiler de propiedades.
          </p>
          <div className="footer-social">
            <a href="#" className="social-link" aria-label="Facebook">
              <Facebook size={20} />
            </a>
            <a href="#" className="social-link" aria-label="Instagram">
              <Instagram size={20} />
            </a>
            <a href="#" className="social-link" aria-label="Twitter">
              <Twitter size={20} />
            </a>
          </div>
        </div>

        <div className="footer-section">
          <h4 className="footer-title">Enlaces</h4>
          <nav className="footer-nav">
            <Link to="/">Inicio</Link>
            <Link to="/?type=sale">Propiedades en Venta</Link>
            <Link to="/?type=rent">Propiedades en Alquiler</Link>
            <Link to="/login">Iniciar Sesión</Link>
            <Link to="/register">Registrarse</Link>
          </nav>
        </div>

        <div className="footer-section">
          <h4 className="footer-title">Contacto</h4>
          <div className="footer-contact">
            <div className="contact-item">
              <MapPin size={18} />
              <span>Montevideo, Uruguay</span>
            </div>
            <div className="contact-item">
              <Phone size={18} />
              <span>+598 99 000 000</span>
            </div>
            <div className="contact-item">
              <Mail size={18} />
              <span>info@micartera.com</span>
            </div>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <p className="footer-copyright">
          Página creada por Anibal Malave © 2026
        </p>
      </div>
    </footer>
  );
};

export default Footer;
