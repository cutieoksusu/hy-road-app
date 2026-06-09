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

const CAREER_KEYWORDS = {
  'IT/소프트웨어': ['IT', '소프트웨어', '개발', '인공지능', 'AI', '데이터', '해커톤', '프로그래밍'],
  '기획/마케팅': ['기획', '마케팅', '브랜딩', '광고', '콘텐츠', '아이디어', '공모전'],
  '식품/F&B': ['식품', 'F&B', '푸드', '외식', '영양', '레시피', '공모전'],
  '패션/의류': ['패션', '의류', '디자인', '브랜드', '스타일', '공모전'],
  '금융/은행': ['금융', '은행', '핀테크', '투자', '경제', '데이터', '공모전'],
  '반도체/엔지니어링': ['반도체', '공학', '엔지니어링', '제조', '로봇', '전자', '기계'],
  '공기업 (NCS)': ['공공기관', '공기업', 'NCS', '정책', '행정', '공모전'],
  '로스쿨 (법조인)': ['법률', '법무', '인권', '정책', '토론', '논문', '공모전'],
  '언론고시 (기자/PD)': ['언론', '기자', 'PD', '방송', '미디어', '콘텐츠', '영상'],
};

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = Date.parse(timestampToIso(value));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const getCareerScore = (item, careerSub) => {
  const normalizedCareer = String(careerSub || '').trim().toLowerCase();
  if (!normalizedCareer) return 0;

  const careerTags = (item.careerTags || []).map((tag) => String(tag).trim().toLowerCase());
  const searchable = [
    item.title,
    item.summary,
    item.type,
    item.source,
    ...careerTags,
  ].join(' ').toLowerCase();

  if (careerTags.includes(normalizedCareer)) return 4;
  if (searchable.includes(normalizedCareer)) return 3;
  if ((CAREER_KEYWORDS[careerSub] || []).some((keyword) => searchable.includes(keyword.toLowerCase()))) return 2;
  return 0;
};

const sortOpportunities = (items, careerSub) => [...items].sort((a, b) => {
  const scoreDiff = getCareerScore(b, careerSub) - getCareerScore(a, careerSub);
  if (scoreDiff !== 0) return scoreDiff;
  return (toMillis(b.publishedAt) || toMillis(b.collectedAt)) - (toMillis(a.publishedAt) || toMillis(a.collectedAt));
});

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
    orderBy('publishedAt', 'desc'),
    limit(80)
  );
  const snapshot = await getDocs(baseQuery);
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
      collectedAt: timestampToIso(data.collectedAt),
      updatedAt: timestampToIso(data.updatedAt || data.collectedAt),
      careerTags: data.careerTags || [],
      type: data.type || '공모전',
      active: data.active,
      dynamicReason: data.sourceType?.includes('naver') ? '매일 업데이트 · 검색 API' : '매일 업데이트',
      fromFirestore: true,
    };
  }).filter((item) => item.active !== false);

  return sortOpportunities(items, careerSub).slice(0, maxItems);
};
