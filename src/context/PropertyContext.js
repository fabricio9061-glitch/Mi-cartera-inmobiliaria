import React, { createContext, useContext, useState, useEffect } from 'react';
import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  getDocs, 
  getDoc,
  query, 
  where, 
  orderBy,
  increment,
  onSnapshot
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage } from '../firebase/config';
import { useAuth } from './AuthContext';

const PropertyContext = createContext();

export const useProperty = () => useContext(PropertyContext);

export const PropertyProvider = ({ children }) => {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const { currentUser } = useAuth();

  const uploadImages = async (files, propertyId) => {
    const imageUrls = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const imageRef = ref(storage, `properties/${propertyId}/image_${i}_${Date.now()}`);
      await uploadBytes(imageRef, file);
      const url = await getDownloadURL(imageRef);
      imageUrls.push(url);
    }
    
    return imageUrls;
  };

  const createProperty = async (propertyData, images) => {
    try {
      const docRef = await addDoc(collection(db, 'properties'), {
        ...propertyData,
        images: [],
        views: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const imageUrls = await uploadImages(images, docRef.id);

      await updateDoc(docRef, { images: imageUrls });

      return { id: docRef.id, ...propertyData, images: imageUrls };
    } catch (error) {
      throw error;
    }
  };

  const addProperty = async (propertyData, images) => {
    return createProperty(propertyData, images);
  };

  const updateProperty = async (propertyId, propertyData, newImages = [], existingImages = []) => {
    try {
      const propertyRef = doc(db, 'properties', propertyId);
      
      let allImages = existingImages || [];
      
      if (newImages.length > 0) {
        const newImageUrls = await uploadImages(newImages, propertyId);
        allImages = [...allImages, ...newImageUrls];
      }

      const updateData = { ...propertyData };
      delete updateData.images; // Remove images from propertyData to avoid confusion

      await updateDoc(propertyRef, {
        ...updateData,
        images: allImages,
        updatedAt: new Date().toISOString()
      });

      return { id: propertyId, ...updateData, images: allImages };
    } catch (error) {
      throw error;
    }
  };

  const deleteProperty = async (propertyId) => {
    try {
      await deleteDoc(doc(db, 'properties', propertyId));
    } catch (error) {
      throw error;
    }
  };

  const getPropertyById = async (propertyId) => {
    try {
      const propertyDoc = await getDoc(doc(db, 'properties', propertyId));
      if (propertyDoc.exists()) {
        return { id: propertyDoc.id, ...propertyDoc.data() };
      }
      return null;
    } catch (error) {
      throw error;
    }
  };

  const getUserProperties = async (userId) => {
    try {
      const q = query(
        collection(db, 'properties'), 
        where('ownerId', '==', userId),
        orderBy('createdAt', 'desc')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      throw error;
    }
  };

  const incrementViews = async (propertyId) => {
    try {
      const propertyRef = doc(db, 'properties', propertyId);
      await updateDoc(propertyRef, {
        views: increment(1)
      });
    } catch (error) {
      console.error('Error incrementing views:', error);
    }
  };

  const addComment = async (propertyId, commentData) => {
    try {
      const commentsRef = collection(db, 'properties', propertyId, 'comments');
      await addDoc(commentsRef, {
        ...commentData,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      throw error;
    }
  };

  const getComments = async (propertyId) => {
    try {
      const commentsRef = collection(db, 'properties', propertyId, 'comments');
      const q = query(commentsRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      throw error;
    }
  };

  const deleteComment = async (propertyId, commentId) => {
    try {
      await deleteDoc(doc(db, 'properties', propertyId, 'comments', commentId));
    } catch (error) {
      throw error;
    }
  };

  useEffect(() => {
    const q = query(collection(db, 'properties'), orderBy('createdAt', 'desc'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const propertiesList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setProperties(propertiesList);
      setLoading(false);
    }, (error) => {
      console.error('Error fetching properties:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const value = {
    properties,
    loading,
    createProperty,
    addProperty,
    updateProperty,
    deleteProperty,
    getPropertyById,
    getUserProperties,
    incrementViews,
    addComment,
    getComments,
    deleteComment
  };

  return (
    <PropertyContext.Provider value={value}>
      {children}
    </PropertyContext.Provider>
  );
};

export default PropertyContext;
