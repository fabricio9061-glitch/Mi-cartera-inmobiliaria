import React, { createContext, useContext, useState, useEffect } from 'react';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  doc, 
  setDoc, 
  getDoc, 
  updateDoc, 
  collection, 
  query, 
  where, 
  getDocs,
  onSnapshot
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, db, storage, ADMIN_EMAIL } from '../firebase/config';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const register = async (email, password, userData) => {
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      let profilePhotoURL = '';
      if (userData.profilePhoto) {
        const photoRef = ref(storage, `profiles/${user.uid}/photo`);
        await uploadBytes(photoRef, userData.profilePhoto);
        profilePhotoURL = await getDownloadURL(photoRef);
      }

      const userDoc = {
        uid: user.uid,
        email: email,
        name: userData.name,
        whatsapp: userData.whatsapp,
        profilePhoto: profilePhotoURL,
        status: 'pending',
        isAdmin: email.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
        createdAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'users', user.uid), userDoc);

      // Si es el admin, aprobar automáticamente
      if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
        await updateDoc(doc(db, 'users', user.uid), { status: 'approved' });
        userDoc.status = 'approved';
      }

      return { user, profile: userDoc };
    } catch (error) {
      throw error;
    }
  };

  const login = async (email, password) => {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      const userDoc = await getDoc(doc(db, 'users', user.uid));
      
      if (!userDoc.exists()) {
        await signOut(auth);
        throw new Error('Usuario no encontrado');
      }

      const userData = userDoc.data();
      
      if (userData.status === 'pending' && !userData.isAdmin) {
        await signOut(auth);
        throw new Error('Tu cuenta está pendiente de aprobación. Por favor espera a que el administrador la apruebe.');
      }

      if (userData.status === 'rejected') {
        await signOut(auth);
        throw new Error('Tu cuenta ha sido rechazada.');
      }

      return { user, profile: userData };
    } catch (error) {
      throw error;
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setCurrentUser(null);
      setUserProfile(null);
      setIsAdmin(false);
    } catch (error) {
      throw error;
    }
  };

  const updateUserProfile = async (updates, newPhoto = null) => {
    if (!currentUser) throw new Error('No hay usuario autenticado');
    
    try {
      let photoURL = userProfile?.profilePhoto || '';
      
      if (newPhoto) {
        const photoRef = ref(storage, `profiles/${currentUser.uid}/photo`);
        await uploadBytes(photoRef, newPhoto);
        photoURL = await getDownloadURL(photoRef);
      }

      const updateData = {
        ...updates,
        profilePhoto: photoURL
      };

      await updateDoc(doc(db, 'users', currentUser.uid), updateData);
      setUserProfile(prev => ({ ...prev, ...updateData }));

      return updateData;
    } catch (error) {
      throw error;
    }
  };

  const getAllUsers = async () => {
    try {
      const usersSnapshot = await getDocs(collection(db, 'users'));
      return usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      throw error;
    }
  };

  const getPendingUsers = async () => {
    try {
      const q = query(collection(db, 'users'), where('status', '==', 'pending'));
      const usersSnapshot = await getDocs(q);
      return usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      throw error;
    }
  };

  const approveUser = async (uid) => {
    try {
      await updateDoc(doc(db, 'users', uid), { status: 'approved' });
    } catch (error) {
      throw error;
    }
  };

  const rejectUser = async (uid) => {
    try {
      await updateDoc(doc(db, 'users', uid), { status: 'rejected' });
    } catch (error) {
      throw error;
    }
  };

  const deleteUser = async (uid) => {
    try {
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(doc(db, 'users', uid));
    } catch (error) {
      throw error;
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          if (userDoc.exists()) {
            const userData = userDoc.data();
            if (userData.status === 'approved' || userData.isAdmin) {
              setCurrentUser(user);
              setUserProfile(userData);
              setIsAdmin(userData.isAdmin || userData.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
            } else {
              await signOut(auth);
              setCurrentUser(null);
              setUserProfile(null);
              setIsAdmin(false);
            }
          }
        } catch (error) {
          console.error('Error fetching user profile:', error);
        }
      } else {
        setCurrentUser(null);
        setUserProfile(null);
        setIsAdmin(false);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const value = {
    currentUser,
    userProfile,
    isAdmin,
    loading,
    register,
    login,
    logout,
    updateUserProfile,
    getAllUsers,
    getPendingUsers,
    approveUser,
    rejectUser,
    deleteUser
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
