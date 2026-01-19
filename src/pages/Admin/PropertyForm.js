import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { 
  ArrowLeft, Upload, X, Image, MapPin, DollarSign, 
  Home, Bed, Bath, Square, Car, PawPrint, Building, Save
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import './Admin.css';

const PropertyForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentUser, isAdmin, userProfile } = useAuth();
  const { addProperty, updateProperty, getPropertyById } = useProperty();
  const fileInputRef = useRef(null);
  const isEditing = Boolean(id);

  const [loading, setLoading] = useState(false);
  const [fetchingProperty, setFetchingProperty] = useState(isEditing);
  const [error, setError] = useState('');
  const [images, setImages] = useState([]);
  const [existingImages, setExistingImages] = useState([]);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    location: '',
    price: '',
    type: 'sale',
    propertyType: 'common',
    totalArea: '',
    privateArea: '',
    bedrooms: '',
    bathrooms: '',
    commonExpenses: '',
    hasGarage: false,
    acceptsPets: false
  });

  useEffect(() => {
    if (isEditing && id) {
      const fetchProperty = async () => {
        try {
          const property = await getPropertyById(id);
          if (property) {
            setFormData({
              title: property.title || '',
              description: property.description || '',
              location: property.location || '',
              price: property.price?.toString() || '',
              type: property.type || 'sale',
              propertyType: property.propertyType || 'common',
              totalArea: property.totalArea?.toString() || '',
              privateArea: property.privateArea?.toString() || '',
              bedrooms: property.bedrooms?.toString() || '',
              bathrooms: property.bathrooms?.toString() || '',
              commonExpenses: property.commonExpenses?.toString() || '',
              hasGarage: property.hasGarage || false,
              acceptsPets: property.acceptsPets || false
            });
            setExistingImages(property.images || []);
          } else {
            navigate('/admin');
          }
        } catch (error) {
          console.error('Error fetching property:', error);
          navigate('/admin');
        } finally {
          setFetchingProperty(false);
        }
      };
      fetchProperty();
    }
  }, [id, isEditing]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
    setError('');
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files);
    const maxSize = 10 * 1024 * 1024; // 10MB
    
    const validFiles = files.filter(file => {
      if (file.size > maxSize) {
        setError(`${file.name} excede el tamaño máximo de 10MB`);
        return false;
      }
      return true;
    });

    const newImages = validFiles.map(file => ({
      file,
      preview: URL.createObjectURL(file)
    }));

    setImages(prev => [...prev, ...newImages]);
  };

  const removeImage = (index) => {
    setImages(prev => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].preview);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  const removeExistingImage = (index) => {
    setExistingImages(prev => {
      const newImages = [...prev];
      newImages.splice(index, 1);
      return newImages;
    });
  };

  const validateForm = () => {
    if (!formData.title.trim()) {
      setError('El título es requerido');
      return false;
    }
    if (!formData.location.trim()) {
      setError('La ubicación es requerida');
      return false;
    }
    if (!formData.price || parseFloat(formData.price) <= 0) {
      setError('El precio debe ser mayor a 0');
      return false;
    }
    if (!isEditing && images.length === 0 && existingImages.length === 0) {
      setError('Debes subir al menos una imagen');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    setLoading(true);
    setError('');

    try {
      const propertyData = {
        ...formData,
        price: parseFloat(formData.price),
        totalArea: formData.totalArea ? parseFloat(formData.totalArea) : 0,
        privateArea: formData.privateArea ? parseFloat(formData.privateArea) : 0,
        bedrooms: formData.bedrooms ? parseInt(formData.bedrooms) : 0,
        bathrooms: formData.bathrooms ? parseInt(formData.bathrooms) : 0,
        commonExpenses: formData.commonExpenses ? parseFloat(formData.commonExpenses) : 0,
        ownerId: currentUser.uid,
        ownerName: userProfile?.name || 'Admin',
        ownerWhatsapp: userProfile?.whatsapp || ''
      };

      const imageFiles = images.map(img => img.file);

      if (isEditing) {
        await updateProperty(id, propertyData, imageFiles, existingImages);
      } else {
        await addProperty(propertyData, imageFiles);
      }

      navigate('/admin');
    } catch (error) {
      console.error('Error saving property:', error);
      setError('Error al guardar la propiedad. Intenta nuevamente.');
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser || !isAdmin) {
    return <Navigate to="/" replace />;
  }

  if (fetchingProperty) {
    return (
      <div className="loading-container">
        <div className="spinner" />
        <p>Cargando propiedad...</p>
      </div>
    );
  }

  return (
    <div className="property-form-page">
      <div className="container">
        <button className="back-button" onClick={() => navigate('/admin')}>
          <ArrowLeft size={20} />
          <span>Volver al panel</span>
        </button>

        <div className="form-container">
          <div className="form-header">
            <h1>{isEditing ? 'Editar Propiedad' : 'Nueva Propiedad'}</h1>
            <p>{isEditing ? 'Modifica los datos de la propiedad' : 'Completa todos los campos para publicar'}</p>
          </div>

          {error && (
            <div className="form-error">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Images Upload */}
            <div className="form-section">
              <h3>
                <Image size={20} />
                Imágenes
              </h3>
              
              <div className="images-upload-area">
                <div 
                  className="upload-zone"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={32} />
                  <span>Haz clic o arrastra imágenes aquí</span>
                  <span className="upload-hint">PNG, JPG hasta 10MB</span>
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImageUpload}
                  accept="image/*"
                  multiple
                  hidden
                />
              </div>

              {(existingImages.length > 0 || images.length > 0) && (
                <div className="images-preview">
                  {existingImages.map((url, index) => (
                    <div key={`existing-${index}`} className="image-preview">
                      <img src={url} alt={`Preview ${index}`} />
                      <button 
                        type="button"
                        className="remove-image"
                        onClick={() => removeExistingImage(index)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  {images.map((img, index) => (
                    <div key={`new-${index}`} className="image-preview">
                      <img src={img.preview} alt={`Preview ${index}`} />
                      <button 
                        type="button"
                        className="remove-image"
                        onClick={() => removeImage(index)}
                      >
                        <X size={16} />
                      </button>
                      <span className="new-badge">Nuevo</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Basic Info */}
            <div className="form-section">
              <h3>
                <Home size={20} />
                Información Básica
              </h3>
              
              <div className="form-group">
                <label className="form-label">Título de la Propiedad *</label>
                <input
                  type="text"
                  name="title"
                  value={formData.title}
                  onChange={handleChange}
                  placeholder="Ej: Apartamento moderno en Pocitos"
                  className="form-input"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Descripción</label>
                <textarea
                  name="description"
                  value={formData.description}
                  onChange={handleChange}
                  placeholder="Describe la propiedad con detalle..."
                  className="form-textarea"
                  rows={4}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Ubicación *</label>
                  <div className="input-wrapper">
                    <MapPin size={20} className="input-icon" />
                    <input
                      type="text"
                      name="location"
                      value={formData.location}
                      onChange={handleChange}
                      placeholder="Ej: Pocitos, Montevideo"
                      className="form-input"
                      required
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Precio (USD) *</label>
                  <div className="input-wrapper">
                    <DollarSign size={20} className="input-icon" />
                    <input
                      type="number"
                      name="price"
                      value={formData.price}
                      onChange={handleChange}
                      placeholder="150000"
                      className="form-input"
                      min="0"
                      required
                    />
                  </div>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Tipo de Operación *</label>
                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="type"
                        value="sale"
                        checked={formData.type === 'sale'}
                        onChange={handleChange}
                      />
                      <span className="radio-custom" />
                      <span>Venta</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="type"
                        value="rent"
                        checked={formData.type === 'rent'}
                        onChange={handleChange}
                      />
                      <span className="radio-custom" />
                      <span>Alquiler</span>
                    </label>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Tipo de Propiedad *</label>
                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="propertyType"
                        value="common"
                        checked={formData.propertyType === 'common'}
                        onChange={handleChange}
                      />
                      <span className="radio-custom" />
                      <span>Padrón Común</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="propertyType"
                        value="ph"
                        checked={formData.propertyType === 'ph'}
                        onChange={handleChange}
                      />
                      <span className="radio-custom" />
                      <span>PH</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Details */}
            <div className="form-section">
              <h3>
                <Building size={20} />
                Características
              </h3>
              
              <div className="form-row form-row-4">
                <div className="form-group">
                  <label className="form-label">Área Total (m²)</label>
                  <div className="input-wrapper">
                    <Square size={20} className="input-icon" />
                    <input
                      type="number"
                      name="totalArea"
                      value={formData.totalArea}
                      onChange={handleChange}
                      placeholder="100"
                      className="form-input"
                      min="0"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Área Privada (m²)</label>
                  <div className="input-wrapper">
                    <Square size={20} className="input-icon" />
                    <input
                      type="number"
                      name="privateArea"
                      value={formData.privateArea}
                      onChange={handleChange}
                      placeholder="80"
                      className="form-input"
                      min="0"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Habitaciones</label>
                  <div className="input-wrapper">
                    <Bed size={20} className="input-icon" />
                    <input
                      type="number"
                      name="bedrooms"
                      value={formData.bedrooms}
                      onChange={handleChange}
                      placeholder="3"
                      className="form-input"
                      min="0"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Baños</label>
                  <div className="input-wrapper">
                    <Bath size={20} className="input-icon" />
                    <input
                      type="number"
                      name="bathrooms"
                      value={formData.bathrooms}
                      onChange={handleChange}
                      placeholder="2"
                      className="form-input"
                      min="0"
                    />
                  </div>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Gastos Comunes (USD)</label>
                  <div className="input-wrapper">
                    <DollarSign size={20} className="input-icon" />
                    <input
                      type="number"
                      name="commonExpenses"
                      value={formData.commonExpenses}
                      onChange={handleChange}
                      placeholder="150"
                      className="form-input"
                      min="0"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">&nbsp;</label>
                  <div className="checkbox-group">
                    <label className="checkbox-option">
                      <input
                        type="checkbox"
                        name="hasGarage"
                        checked={formData.hasGarage}
                        onChange={handleChange}
                      />
                      <span className="checkbox-custom">
                        <Car size={18} />
                      </span>
                      <span>Tiene Cochera</span>
                    </label>

                    {formData.type === 'rent' && (
                      <label className="checkbox-option">
                        <input
                          type="checkbox"
                          name="acceptsPets"
                          checked={formData.acceptsPets}
                          onChange={handleChange}
                        />
                        <span className="checkbox-custom">
                          <PawPrint size={18} />
                        </span>
                        <span>Acepta Mascotas</span>
                      </label>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="form-actions">
              <button 
                type="button" 
                className="btn btn-outline"
                onClick={() => navigate('/admin')}
              >
                Cancelar
              </button>
              <button 
                type="submit" 
                className="btn btn-primary btn-lg"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spinner-sm" />
                    Guardando...
                  </>
                ) : (
                  <>
                    <Save size={20} />
                    {isEditing ? 'Guardar Cambios' : 'Publicar Propiedad'}
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default PropertyForm;
