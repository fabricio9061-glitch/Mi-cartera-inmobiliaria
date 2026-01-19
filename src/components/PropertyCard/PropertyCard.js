import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  MapPin, 
  Bed, 
  Bath, 
  Square, 
  Car, 
  Eye,
  PawPrint,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { useProperty } from '../../context/PropertyContext';
import './PropertyCard.css';

const PropertyCard = ({ property }) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const intervalRef = useRef(null);
  const navigate = useNavigate();
  const { incrementViews } = useProperty();

  const {
    id,
    title,
    images = [],
    price,
    location,
    type,
    propertyType,
    totalArea,
    privateArea,
    bedrooms,
    bathrooms,
    hasGarage,
    acceptsPets,
    views = 0
  } = property;

  useEffect(() => {
    if (images.length > 1 && !isHovered) {
      intervalRef.current = setInterval(() => {
        setCurrentImageIndex((prev) => (prev + 1) % images.length);
      }, 4000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [images.length, isHovered]);

  const handlePrevImage = (e) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleNextImage = (e) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev + 1) % images.length);
  };

  const handleCardClick = async () => {
    await incrementViews(id);
    navigate(`/property/${id}`);
  };

  const formatPrice = (price) => {
    return new Intl.NumberFormat('es-UY', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(price);
  };

  const placeholderImage = 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=600&fit=crop';

  return (
    <div 
      className="property-card"
      onClick={handleCardClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="property-card-image">
        <div className="image-carousel">
          {images.length > 0 ? (
            images.map((img, index) => (
              <img
                key={index}
                src={img}
                alt={`${title} - ${index + 1}`}
                className={`carousel-image ${index === currentImageIndex ? 'active' : ''}`}
              />
            ))
          ) : (
            <img
              src={placeholderImage}
              alt={title}
              className="carousel-image active"
            />
          )}
        </div>

        {images.length > 1 && (
          <>
            <button 
              className="carousel-btn carousel-btn-prev"
              onClick={handlePrevImage}
            >
              <ChevronLeft size={20} />
            </button>
            <button 
              className="carousel-btn carousel-btn-next"
              onClick={handleNextImage}
            >
              <ChevronRight size={20} />
            </button>
            <div className="carousel-indicators">
              {images.map((_, index) => (
                <span 
                  key={index} 
                  className={`indicator ${index === currentImageIndex ? 'active' : ''}`}
                />
              ))}
            </div>
          </>
        )}

        <div className="property-badges">
          <span className={`badge ${type === 'sale' ? 'badge-sale' : 'badge-rent'}`}>
            {type === 'sale' ? 'VENTA' : 'ALQUILER'}
          </span>
          {propertyType === 'ph' && (
            <span className="badge badge-ph">PH</span>
          )}
        </div>

        <div className="property-views">
          <Eye size={14} />
          <span>{views}</span>
        </div>
      </div>

      <div className="property-card-content">
        <div className="property-price">
          {formatPrice(price)}
          {type === 'rent' && <span className="price-period">/mes</span>}
        </div>

        <h3 className="property-title">{title}</h3>

        <div className="property-location">
          <MapPin size={16} />
          <span>{location}</span>
        </div>

        <div className="property-features">
          {bedrooms > 0 && (
            <div className="feature">
              <Bed size={16} />
              <span>{bedrooms}</span>
            </div>
          )}
          {bathrooms > 0 && (
            <div className="feature">
              <Bath size={16} />
              <span>{bathrooms}</span>
            </div>
          )}
          {totalArea > 0 && (
            <div className="feature">
              <Square size={16} />
              <span>{totalArea} m²</span>
            </div>
          )}
          {hasGarage && (
            <div className="feature">
              <Car size={16} />
            </div>
          )}
          {type === 'rent' && acceptsPets && (
            <div className="feature feature-pets">
              <PawPrint size={16} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PropertyCard;
