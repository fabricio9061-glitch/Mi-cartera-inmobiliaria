import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, TrendingUp, Users, Shield } from 'lucide-react';
import PropertyCard from '../../components/PropertyCard/PropertyCard';
import PropertyFilters from '../../components/PropertyFilters/PropertyFilters';
import { useProperty } from '../../context/PropertyContext';
import './Home.css';

const Home = () => {
  const { properties, loading } = useProperty();
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    search: '',
    type: searchParams.get('type') || '',
    minPrice: '',
    maxPrice: '',
    bedrooms: '',
    acceptsPets: false
  });

  useEffect(() => {
    const type = searchParams.get('type');
    if (type) {
      setFilters(prev => ({ ...prev, type }));
    }
  }, [searchParams]);

  const filteredProperties = useMemo(() => {
    return properties.filter(property => {
      // Filtro por búsqueda
      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const matchesSearch = 
          property.title?.toLowerCase().includes(searchLower) ||
          property.location?.toLowerCase().includes(searchLower) ||
          property.description?.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }

      // Filtro por tipo (venta/alquiler)
      if (filters.type && property.type !== filters.type) {
        return false;
      }

      // Filtro por precio mínimo
      if (filters.minPrice && property.price < parseInt(filters.minPrice)) {
        return false;
      }

      // Filtro por precio máximo
      if (filters.maxPrice && property.price > parseInt(filters.maxPrice)) {
        return false;
      }

      // Filtro por habitaciones
      if (filters.bedrooms && property.bedrooms < parseInt(filters.bedrooms)) {
        return false;
      }

      // Filtro por mascotas
      if (filters.acceptsPets && !property.acceptsPets) {
        return false;
      }

      return true;
    });
  }, [properties, filters]);

  const stats = useMemo(() => ({
    total: properties.length,
    forSale: properties.filter(p => p.type === 'sale').length,
    forRent: properties.filter(p => p.type === 'rent').length
  }), [properties]);

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-background">
          <div className="hero-overlay" />
        </div>
        <div className="hero-content container">
          <div className="hero-badge">
            <Building2 size={18} />
            <span>Tu portal inmobiliario de confianza</span>
          </div>
          <h1 className="hero-title">
            Encuentra la propiedad<br />
            <span className="hero-title-accent">de tus sueños</span>
          </h1>
          <p className="hero-subtitle">
            Explora nuestra amplia selección de propiedades en venta y alquiler. 
            Encuentra tu hogar ideal con nosotros.
          </p>
          <div className="hero-stats">
            <div className="hero-stat">
              <span className="stat-number">{stats.total}+</span>
              <span className="stat-label">Propiedades</span>
            </div>
            <div className="stat-divider" />
            <div className="hero-stat">
              <span className="stat-number">{stats.forSale}</span>
              <span className="stat-label">En Venta</span>
            </div>
            <div className="stat-divider" />
            <div className="hero-stat">
              <span className="stat-number">{stats.forRent}</span>
              <span className="stat-label">En Alquiler</span>
            </div>
          </div>
        </div>
      </section>

      <section className="features-section container">
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">
              <TrendingUp size={28} />
            </div>
            <h3>Mejores Precios</h3>
            <p>Propiedades a precios competitivos del mercado</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <Users size={28} />
            </div>
            <h3>Atención Personalizada</h3>
            <p>Te acompañamos en todo el proceso</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <Shield size={28} />
            </div>
            <h3>Seguridad Garantizada</h3>
            <p>Transacciones seguras y transparentes</p>
          </div>
        </div>
      </section>

      <section className="properties-section container">
        <div className="section-header">
          <h2 className="section-title">Propiedades Disponibles</h2>
          <p className="section-subtitle">
            {filteredProperties.length} propiedades encontradas
          </p>
        </div>

        <PropertyFilters 
          filters={filters} 
          onFilterChange={setFilters}
        />

        {loading ? (
          <div className="loading-container">
            <div className="spinner" />
            <p>Cargando propiedades...</p>
          </div>
        ) : filteredProperties.length > 0 ? (
          <div className="properties-grid">
            {filteredProperties.map((property, index) => (
              <div 
                key={property.id} 
                className="property-item"
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <PropertyCard property={property} />
              </div>
            ))}
          </div>
        ) : (
          <div className="no-results">
            <Building2 size={64} className="no-results-icon" />
            <h3>No se encontraron propiedades</h3>
            <p>Intenta ajustar los filtros de búsqueda</p>
          </div>
        )}
      </section>
    </div>
  );
};

export default Home;
