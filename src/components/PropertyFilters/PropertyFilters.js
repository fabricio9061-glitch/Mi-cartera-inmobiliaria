import React, { useState } from 'react';
import { Search, Filter, X, ChevronDown, ChevronUp } from 'lucide-react';
import './PropertyFilters.css';

const PropertyFilters = ({ filters, onFilterChange, onSearch }) => {
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedSection, setExpandedSection] = useState(null);

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    onFilterChange({
      ...filters,
      [name]: type === 'checkbox' ? checked : value
    });
  };

  const clearFilters = () => {
    onFilterChange({
      search: '',
      type: '',
      minPrice: '',
      maxPrice: '',
      bedrooms: '',
      acceptsPets: false
    });
  };

  const hasActiveFilters = filters.type || filters.minPrice || filters.maxPrice || 
    filters.bedrooms || filters.acceptsPets;

  return (
    <div className="property-filters">
      <div className="filters-search">
        <Search size={20} className="search-icon" />
        <input
          type="text"
          name="search"
          value={filters.search}
          onChange={handleInputChange}
          placeholder="Buscar por ubicación, nombre..."
          className="search-input"
        />
        <button 
          className="mobile-filter-btn"
          onClick={() => setShowMobileFilters(!showMobileFilters)}
        >
          <Filter size={20} />
          {hasActiveFilters && <span className="filter-badge" />}
        </button>
      </div>

      <div className={`filters-panel ${showMobileFilters ? 'show' : ''}`}>
        <div className="filters-header">
          <h3>Filtros</h3>
          <button 
            className="filters-close"
            onClick={() => setShowMobileFilters(false)}
          >
            <X size={20} />
          </button>
        </div>

        <div className="filters-content">
          <div className="filter-group">
            <label className="filter-label">Tipo de operación</label>
            <div className="filter-buttons">
              <button
                className={`filter-btn ${filters.type === '' ? 'active' : ''}`}
                onClick={() => onFilterChange({ ...filters, type: '' })}
              >
                Todos
              </button>
              <button
                className={`filter-btn ${filters.type === 'sale' ? 'active' : ''}`}
                onClick={() => onFilterChange({ ...filters, type: 'sale' })}
              >
                Venta
              </button>
              <button
                className={`filter-btn ${filters.type === 'rent' ? 'active' : ''}`}
                onClick={() => onFilterChange({ ...filters, type: 'rent' })}
              >
                Alquiler
              </button>
            </div>
          </div>

          <div className="filter-group">
            <label className="filter-label">Rango de precio (USD)</label>
            <div className="filter-range">
              <input
                type="number"
                name="minPrice"
                value={filters.minPrice}
                onChange={handleInputChange}
                placeholder="Mínimo"
                className="filter-input"
              />
              <span className="range-separator">-</span>
              <input
                type="number"
                name="maxPrice"
                value={filters.maxPrice}
                onChange={handleInputChange}
                placeholder="Máximo"
                className="filter-input"
              />
            </div>
          </div>

          <div className="filter-group">
            <label className="filter-label">Habitaciones</label>
            <select
              name="bedrooms"
              value={filters.bedrooms}
              onChange={handleInputChange}
              className="filter-select"
            >
              <option value="">Cualquiera</option>
              <option value="1">1+</option>
              <option value="2">2+</option>
              <option value="3">3+</option>
              <option value="4">4+</option>
              <option value="5">5+</option>
            </select>
          </div>

          <div className="filter-group">
            <label className="filter-checkbox">
              <input
                type="checkbox"
                name="acceptsPets"
                checked={filters.acceptsPets}
                onChange={handleInputChange}
              />
              <span className="checkbox-custom" />
              <span className="checkbox-label">Acepta mascotas</span>
            </label>
          </div>

          {hasActiveFilters && (
            <button className="clear-filters-btn" onClick={clearFilters}>
              <X size={16} />
              Limpiar filtros
            </button>
          )}
        </div>

        <div className="filters-actions">
          <button 
            className="btn btn-primary"
            onClick={() => setShowMobileFilters(false)}
          >
            Ver resultados
          </button>
        </div>
      </div>

      {showMobileFilters && (
        <div 
          className="filters-overlay"
          onClick={() => setShowMobileFilters(false)}
        />
      )}
    </div>
  );
};

export default PropertyFilters;
