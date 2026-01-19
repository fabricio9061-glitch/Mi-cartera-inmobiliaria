import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { 
  MapPin, Bed, Bath, Square, Car, PawPrint, Eye, 
  ChevronLeft, ChevronRight, ArrowLeft, MessageCircle,
  Home, Building, Send, User, Calendar, X
} from 'lucide-react';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import './PropertyDetail.css';

const PropertyDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getPropertyById, incrementViews, addComment, getComments } = useProperty();
  const { currentUser, userProfile } = useAuth();
  
  const [property, setProperty] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);

  useEffect(() => {
    const fetchProperty = async () => {
      try {
        const propertyData = await getPropertyById(id);
        if (propertyData) {
          setProperty(propertyData);
          await incrementViews(id);
          const commentsData = await getComments(id);
          setComments(commentsData);
        } else {
          navigate('/');
        }
      } catch (error) {
        console.error('Error fetching property:', error);
        navigate('/');
      } finally {
        setLoading(false);
      }
    };

    fetchProperty();
  }, [id]);

  const handlePrevImage = () => {
    setCurrentImageIndex((prev) => 
      (prev - 1 + property.images.length) % property.images.length
    );
  };

  const handleNextImage = () => {
    setCurrentImageIndex((prev) => 
      (prev + 1) % property.images.length
    );
  };

  const handleCommentSubmit = async (e) => {
    e.preventDefault();
    if (!newComment.trim() || !currentUser) return;

    setSubmittingComment(true);
    try {
      await addComment(id, {
        userId: currentUser.uid,
        userName: userProfile?.name || 'Usuario',
        userPhoto: userProfile?.profilePhoto || '',
        text: newComment.trim()
      });
      
      const updatedComments = await getComments(id);
      setComments(updatedComments);
      setNewComment('');
    } catch (error) {
      console.error('Error adding comment:', error);
    } finally {
      setSubmittingComment(false);
    }
  };

  const formatPrice = (price) => {
    return new Intl.NumberFormat('es-UY', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(price);
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('es-UY', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  const handleWhatsAppClick = () => {
    const message = `Hola, me interesa la propiedad: ${property.title} - ${formatPrice(property.price)}`;
    const whatsappNumber = property.ownerWhatsapp || '59899000000';
    const cleanNumber = whatsappNumber.replace(/\D/g, '');
    window.open(`https://wa.me/${cleanNumber}?text=${encodeURIComponent(message)}`, '_blank');
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner" />
        <p>Cargando propiedad...</p>
      </div>
    );
  }

  if (!property) {
    return (
      <div className="not-found">
        <h2>Propiedad no encontrada</h2>
        <Link to="/" className="btn btn-primary">Volver al inicio</Link>
      </div>
    );
  }

  const placeholderImage = 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=600&fit=crop';

  return (
    <div className="property-detail">
      <div className="container">
        <button className="back-button" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
          <span>Volver</span>
        </button>

        <div className="property-detail-grid">
          <div className="property-main">
            <div className="property-gallery">
              <div 
                className="gallery-main"
                onClick={() => setShowImageModal(true)}
              >
                <img 
                  src={property.images?.[currentImageIndex] || placeholderImage} 
                  alt={property.title}
                />
                
                {property.images?.length > 1 && (
                  <>
                    <button 
                      className="gallery-nav gallery-prev"
                      onClick={(e) => { e.stopPropagation(); handlePrevImage(); }}
                    >
                      <ChevronLeft size={24} />
                    </button>
                    <button 
                      className="gallery-nav gallery-next"
                      onClick={(e) => { e.stopPropagation(); handleNextImage(); }}
                    >
                      <ChevronRight size={24} />
                    </button>
                  </>
                )}

                <div className="gallery-badges">
                  <span className={`badge ${property.type === 'sale' ? 'badge-sale' : 'badge-rent'}`}>
                    {property.type === 'sale' ? 'VENTA' : 'ALQUILER'}
                  </span>
                  {property.propertyType === 'ph' && (
                    <span className="badge badge-ph">PH</span>
                  )}
                </div>

                <div className="gallery-counter">
                  {currentImageIndex + 1} / {property.images?.length || 1}
                </div>
              </div>

              {property.images?.length > 1 && (
                <div className="gallery-thumbnails">
                  {property.images.map((img, index) => (
                    <button
                      key={index}
                      className={`thumbnail ${index === currentImageIndex ? 'active' : ''}`}
                      onClick={() => setCurrentImageIndex(index)}
                    >
                      <img src={img} alt={`${property.title} ${index + 1}`} />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="property-info-card">
              <div className="property-header">
                <div>
                  <h1 className="property-title">{property.title}</h1>
                  <div className="property-location">
                    <MapPin size={18} />
                    <span>{property.location}</span>
                  </div>
                </div>
                <div className="property-price-box">
                  <span className="price">{formatPrice(property.price)}</span>
                  {property.type === 'rent' && <span className="price-period">/mes</span>}
                </div>
              </div>

              <div className="property-features-grid">
                {property.bedrooms > 0 && (
                  <div className="feature-item">
                    <Bed size={24} />
                    <div>
                      <span className="feature-value">{property.bedrooms}</span>
                      <span className="feature-label">Habitaciones</span>
                    </div>
                  </div>
                )}
                {property.bathrooms > 0 && (
                  <div className="feature-item">
                    <Bath size={24} />
                    <div>
                      <span className="feature-value">{property.bathrooms}</span>
                      <span className="feature-label">Baños</span>
                    </div>
                  </div>
                )}
                {property.totalArea > 0 && (
                  <div className="feature-item">
                    <Square size={24} />
                    <div>
                      <span className="feature-value">{property.totalArea} m²</span>
                      <span className="feature-label">Área Total</span>
                    </div>
                  </div>
                )}
                {property.privateArea > 0 && (
                  <div className="feature-item">
                    <Home size={24} />
                    <div>
                      <span className="feature-value">{property.privateArea} m²</span>
                      <span className="feature-label">Área Privada</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="property-details">
                <h3>Detalles</h3>
                <div className="details-grid">
                  <div className="detail-item">
                    <span className="detail-label">Tipo:</span>
                    <span className="detail-value">
                      {property.propertyType === 'ph' ? 'Propiedad Horizontal (PH)' : 'Padrón Común'}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Operación:</span>
                    <span className="detail-value">
                      {property.type === 'sale' ? 'Venta' : 'Alquiler'}
                    </span>
                  </div>
                  {property.commonExpenses > 0 && (
                    <div className="detail-item">
                      <span className="detail-label">Gastos Comunes:</span>
                      <span className="detail-value">{formatPrice(property.commonExpenses)}</span>
                    </div>
                  )}
                  <div className="detail-item">
                    <span className="detail-label">Cochera:</span>
                    <span className="detail-value">
                      {property.hasGarage ? 'Sí' : 'No'}
                    </span>
                  </div>
                  {property.type === 'rent' && (
                    <div className="detail-item">
                      <span className="detail-label">Acepta Mascotas:</span>
                      <span className="detail-value">
                        {property.acceptsPets ? 'Sí' : 'No'}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {property.description && (
                <div className="property-description">
                  <h3>Descripción</h3>
                  <p>{property.description}</p>
                </div>
              )}

              <div className="property-stats">
                <div className="stat">
                  <Eye size={18} />
                  <span>{property.views || 0} visualizaciones</span>
                </div>
                <div className="stat">
                  <Calendar size={18} />
                  <span>Publicado: {formatDate(property.createdAt)}</span>
                </div>
              </div>
            </div>

            <div className="comments-section">
              <h3>
                <MessageCircle size={24} />
                Comentarios ({comments.length})
              </h3>

              {currentUser ? (
                <form onSubmit={handleCommentSubmit} className="comment-form">
                  <div className="comment-input-wrapper">
                    <div className="comment-avatar">
                      {userProfile?.profilePhoto ? (
                        <img src={userProfile.profilePhoto} alt={userProfile.name} />
                      ) : (
                        <User size={20} />
                      )}
                    </div>
                    <input
                      type="text"
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Escribe un comentario..."
                      className="comment-input"
                    />
                    <button 
                      type="submit" 
                      className="comment-submit"
                      disabled={!newComment.trim() || submittingComment}
                    >
                      <Send size={20} />
                    </button>
                  </div>
                </form>
              ) : (
                <div className="login-prompt">
                  <p>
                    <Link to="/login">Inicia sesión</Link> para dejar un comentario
                  </p>
                </div>
              )}

              <div className="comments-list">
                {comments.length > 0 ? (
                  comments.map((comment) => (
                    <div key={comment.id} className="comment">
                      <div className="comment-avatar">
                        {comment.userPhoto ? (
                          <img src={comment.userPhoto} alt={comment.userName} />
                        ) : (
                          <User size={20} />
                        )}
                      </div>
                      <div className="comment-content">
                        <div className="comment-header">
                          <span className="comment-author">{comment.userName}</span>
                          <span className="comment-date">{formatDate(comment.createdAt)}</span>
                        </div>
                        <p className="comment-text">{comment.text}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="no-comments">Aún no hay comentarios</p>
                )}
              </div>
            </div>
          </div>

          <div className="property-sidebar">
            <div className="contact-card">
              <h3>¿Te interesa esta propiedad?</h3>
              <p>Contacta directamente por WhatsApp</p>
              <button className="btn btn-whatsapp btn-lg" onClick={handleWhatsAppClick}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                </svg>
                Contactar por WhatsApp
              </button>
            </div>
          </div>
        </div>
      </div>

      {showImageModal && (
        <div className="image-modal" onClick={() => setShowImageModal(false)}>
          <button className="modal-close-btn">
            <X size={28} />
          </button>
          <div className="modal-image-container" onClick={(e) => e.stopPropagation()}>
            <img 
              src={property.images?.[currentImageIndex] || placeholderImage} 
              alt={property.title}
            />
            {property.images?.length > 1 && (
              <>
                <button 
                  className="modal-nav modal-prev"
                  onClick={handlePrevImage}
                >
                  <ChevronLeft size={32} />
                </button>
                <button 
                  className="modal-nav modal-next"
                  onClick={handleNextImage}
                >
                  <ChevronRight size={32} />
                </button>
              </>
            )}
          </div>
          <div className="modal-counter">
            {currentImageIndex + 1} / {property.images?.length || 1}
          </div>
        </div>
      )}
    </div>
  );
};

export default PropertyDetail;
