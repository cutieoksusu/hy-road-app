import { initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, getFirestore, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
);

const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;

const auth = firebaseApp ? getAuth(firebaseApp) : null;
const db = firebaseApp ? getFirestore(firebaseApp) : null;

const timestampToIso = (value) => {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

export const observeAuth = (callback) => onAuthStateChanged(auth, callback);

export const createAccount = (email, password) => createUserWithEmailAndPassword(auth, email, password);

export const login = (email, password) => signInWithEmailAndPassword(auth, email, password);

export const logout = () => signOut(auth);

export const loadUserData = async (uid) => {
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.exists() ? snapshot.data() : null;
};

export const saveUserData = (uid, data) => setDoc(doc(db, 'users', uid), {
  ...data,
  updatedAt: serverTimestamp(),
}, { merge: true });

export const loadOpportunities = async ({ careerSub, maxItems = 12 } = {}) => {
  const baseQuery = query(
    collection(db, 'opportunities'),
    orderBy('collectedAt', 'desc'),
    limit(50)
  );
  const snapshot = await getDocs(baseQuery);
  const normalizedCareer = String(careerSub || '').trim();
  const items = snapshot.docs.map((item) => {
    const data = item.data();
    return {
      id: item.id,
      title: data.title || '',
      dDay: '',
      source: data.source || '허가된 출처',
      url: data.originalLink || '#',
      summary: data.summary || '',
      deadline: timestampToIso(data.deadline),
      publishedAt: timestampToIso(data.publishedAt),
      careerTags: data.careerTags || [],
      recommendationTags: data.recommendationTags || [],
      recommendationType: data.recommendationType || 'activity',
      recommendationCat: data.recommendationCat || 'activity',
      baseWeight: data.baseWeight || 6,
      recommendedGrades: data.recommendedGrades || [1, 2, 3],
      taggedBy: data.taggedBy || 'keyword',
      type: data.type || '공모전',
      active: data.active,
      fromFirestore: true,
    };
  }).filter((item) => item.active !== false);

  const careerMatched = normalizedCareer
    ? items.filter((item) => item.careerTags.includes(normalizedCareer))
    : items;
  return (careerMatched.length ? careerMatched : items).slice(0, maxItems);
};
