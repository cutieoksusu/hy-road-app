import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';

initializeApp();

const db = getFirestore();
const COLLECTION = 'opportunities';
const MAX_ITEMS_PER_SOURCE = 30;
const DEFAULT_REGION = 'asia-northeast3';
const CACHE_COLLECTION = 'opportunityQueryCache';
const DEFAULT_CACHE_TTL_MINUTES = 15;

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

const BASE_KEYWORDS = ['공모전', '해커톤', '대외활동', '인턴십'];

const toArray = (value) => (Array.isArray(value) ? value : []);

const uniq = (values) => [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];

const stripHtml = (value = '') => String(value)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
};

const getDomain = (value) => {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const parseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const normalized = String(value)
    .replace(/[./]/g, '-')
    .replace(/년|월/g, '-')
    .replace(/일/g, '')
    .trim();
  const match = normalized.match(/(20\d{2})-?\s*(\d{1,2})-?\s*(\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 14, 59, 59));
  return Number.isNaN(date.getTime()) ? null : date;
};

const getCareerTags = (text) => {
  const source = text.toLowerCase();
  return Object.entries(CAREER_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => source.includes(keyword.toLowerCase())))
    .map(([career]) => career);
};

const getType = (text) => {
  const source = text.toLowerCase();
  if (source.includes('해커톤')) return '해커톤';
  if (source.includes('인턴')) return '인턴십';
  if (source.includes('대외활동') || source.includes('서포터') || source.includes('봉사')) return '대외활동';
  return '공모전';
};

const makeSummary = ({ type, source, careerTags }) => {
  const target = careerTags.length ? `${careerTags.slice(0, 2).join('·')} 진로` : '관심 진로';
  return `${target}와 연결해 검토할 만한 ${type}입니다. ${source}의 원문에서 모집 대상, 일정, 제출 요건을 확인하세요.`;
};

const makeId = ({ sourceType, source, originalLink, title }) => {
  const basis = safeUrl(originalLink) || `${source}:${title}`;
  return Buffer.from(`${sourceType}:${basis}`).toString('base64url').slice(0, 120);
};

const normalizeItem = (raw) => {
  const title = stripHtml(raw.title);
  const originalLink = safeUrl(raw.originalLink || raw.link || raw.url);
  if (!title || !originalLink) return null;

  const source = stripHtml(raw.source) || getDomain(originalLink) || raw.sourceType || '허가된 출처';
  const type = raw.type || getType(`${title} ${raw.description || ''}`);
  const deadline = parseDate(raw.deadline || raw.endDate || raw.endAt);
  const publishedAt = parseDate(raw.publishedAt || raw.pubDate || raw.createdAt);
  const textForTags = `${title} ${raw.description || ''} ${raw.keywords || ''}`;
  const careerTags = uniq([...toArray(raw.careerTags), ...getCareerTags(textForTags)]);

  return {
    id: makeId({ sourceType: raw.sourceType, source, originalLink, title }),
    title: title.slice(0, 120),
    type,
    source,
    originalLink,
    summary: makeSummary({ type, source, careerTags }),
    careerTags,
    keywords: uniq([...careerTags, type, ...BASE_KEYWORDS.filter((keyword) => textForTags.includes(keyword))]),
    deadline: deadline ? Timestamp.fromDate(deadline) : null,
    publishedAt: publishedAt ? Timestamp.fromDate(publishedAt) : null,
    sourceType: raw.sourceType,
    active: !deadline || deadline.getTime() >= Date.now() - 24 * 60 * 60 * 1000,
  };
};

const readJsonEnv = (name, fallback) => {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn(`${name} 환경변수를 JSON으로 해석하지 못했습니다.`, { message: error.message });
    return fallback;
  }
};

const buildOpportunityQueries = (career) => {
  const normalizedCareer = stripHtml(career);
  if (normalizedCareer) {
    const relatedKeywords = CAREER_KEYWORDS[normalizedCareer] || [];
    return uniq([
      `${normalizedCareer} 공모전`,
      `${normalizedCareer} 해커톤`,
      `${normalizedCareer} 대외활동`,
      ...relatedKeywords.slice(0, 4).map((keyword) => `${keyword} 공모전 해커톤 대외활동`),
    ]).slice(0, 8);
  }

  return uniq(Object.values(CAREER_KEYWORDS)
    .flatMap((keywords) => keywords.slice(0, 2).map((keyword) => `${keyword} 공모전 해커톤 대외활동`)))
    .slice(0, 12);
};

const fetchNaverSearch = async ({ career } = {}) => {
  const clientId = process.env.NAVER_SEARCH_CLIENT_ID;
  const clientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const uniqueQueries = buildOpportunityQueries(career);
  const endpoints = ['news', 'blog'];
  const results = [];

  for (const searchType of endpoints) {
    for (const searchQuery of uniqueQueries) {
      const url = new URL(`https://openapi.naver.com/v1/search/${searchType}.json`);
      url.searchParams.set('query', searchQuery);
      url.searchParams.set('display', '10');
      url.searchParams.set('sort', searchType === 'news' ? 'date' : 'date');

      const response = await fetch(url, {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      });
      if (!response.ok) {
        logger.warn('Naver Search API 응답 오류', { status: response.status, query: searchQuery, searchType });
        continue;
      }
      const data = await response.json();
      results.push(...toArray(data.items).map((item) => ({
        title: item.title,
        description: item.description,
        originalLink: item.originallink || item.link,
        publishedAt: item.pubDate || item.postdate,
        source: getDomain(item.originallink || item.link) || `Naver ${searchType}`,
        sourceType: `naver-${searchType}-search-api`,
        careerTags: career ? [career] : [],
      })));
    }
  }

  return results;
};

const fetchPublicDataPortal = async () => {
  const serviceKey = process.env.PUBLIC_DATA_SERVICE_KEY;
  const endpoints = readJsonEnv('PUBLIC_DATA_ENDPOINTS', []);
  if (!serviceKey || !Array.isArray(endpoints) || endpoints.length === 0) return [];

  const results = [];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint.url);
    url.searchParams.set(endpoint.serviceKeyParam || 'serviceKey', serviceKey);
    url.searchParams.set(endpoint.typeParam || 'type', endpoint.typeValue || 'json');
    Object.entries(endpoint.params || {}).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await fetch(url);
    if (!response.ok) {
      logger.warn('공공데이터포털 API 응답 오류', { status: response.status, name: endpoint.name });
      continue;
    }
    const data = await response.json();
    const itemsPath = endpoint.itemsPath || 'response.body.items.item';
    const items = itemsPath.split('.').reduce((acc, key) => acc?.[key], data);
    results.push(...toArray(items).map((item) => ({
      title: item[endpoint.fields?.title || 'title'],
      description: item[endpoint.fields?.description || 'description'],
      originalLink: item[endpoint.fields?.url || 'url'],
      deadline: item[endpoint.fields?.deadline || 'endDate'],
      publishedAt: item[endpoint.fields?.publishedAt || 'createdAt'],
      source: endpoint.name || '공공데이터포털',
      sourceType: 'public-data-portal',
    })));
  }

  return results;
};

const fetchPermittedFeeds = async () => {
  const feeds = readJsonEnv('PERMITTED_FEEDS', []);
  if (!Array.isArray(feeds) || feeds.length === 0) return [];

  const results = [];
  for (const feed of feeds) {
    const response = await fetch(feed.url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      logger.warn('허가 피드 응답 오류', { status: response.status, name: feed.name });
      continue;
    }
    const data = await response.json();
    const items = feed.itemsPath ? feed.itemsPath.split('.').reduce((acc, key) => acc?.[key], data) : data.items;
    results.push(...toArray(items).map((item) => ({
      title: item[feed.fields?.title || 'title'],
      description: item[feed.fields?.description || 'description'],
      originalLink: item[feed.fields?.url || 'url'],
      deadline: item[feed.fields?.deadline || 'deadline'],
      publishedAt: item[feed.fields?.publishedAt || 'publishedAt'],
      source: feed.name || getDomain(feed.url),
      sourceType: 'permitted-feed',
      careerTags: item[feed.fields?.careerTags || 'careerTags'],
    })));
  }

  return results;
};

const fetchAllowedSources = async ({ career } = {}) => (await Promise.all([
  fetchPublicDataPortal(),
  fetchNaverSearch({ career }),
  fetchPermittedFeeds(),
])).flat();

export const collectOpportunitiesNow = async () => {
  const rawItems = await fetchAllowedSources();

  const normalized = rawItems.map(normalizeItem).filter(Boolean).slice(0, 200);
  const uniqueMap = new Map(normalized.map((item) => [item.id, item]));
  const uniqueItems = [...uniqueMap.values()]
    .sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0))
    .slice(0, MAX_ITEMS_PER_SOURCE * 6);

  if (uniqueItems.length === 0) {
    logger.info('수집된 공모전/해커톤 데이터가 없습니다. API 키와 허가 피드 설정을 확인하세요.');
    return { saved: 0 };
  }

  const writer = db.bulkWriter();
  uniqueItems.forEach((item) => {
    const { id, ...data } = item;
    writer.set(db.collection(COLLECTION).doc(id), {
      ...data,
      collectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  await writer.close();
  logger.info('opportunities 컬렉션 저장 완료', { count: uniqueItems.length });
  return { saved: uniqueItems.length };
};


const timestampToIso = (value) => {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return String(value);
};

const toClientItem = (item) => ({
  id: item.id,
  title: item.title,
  type: item.type,
  source: item.source,
  url: item.originalLink,
  summary: item.summary,
  deadline: timestampToIso(item.deadline),
  publishedAt: timestampToIso(item.publishedAt),
  careerTags: item.careerTags || [],
  dynamicReason: item.sourceType === 'public-data-portal'
    ? '공공데이터 API'
    : item.sourceType?.includes('naver')
      ? '검색 API 실시간 조회'
      : '허가 피드',
});

const getCacheTtlMs = () => {
  const ttlMinutes = Number(process.env.OPPORTUNITY_CACHE_TTL_MINUTES || DEFAULT_CACHE_TTL_MINUTES);
  return (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : DEFAULT_CACHE_TTL_MINUTES) * 60 * 1000;
};

const getCachedQuery = async (career) => {
  const snapshot = await db.collection(CACHE_COLLECTION).doc(Buffer.from(career).toString('base64url')).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  const cachedAt = data.cachedAt?.toDate?.();
  if (!cachedAt || Date.now() - cachedAt.getTime() > getCacheTtlMs()) return null;
  return toArray(data.items);
};

const saveCachedQuery = async (career, items) => {
  await db.collection(CACHE_COLLECTION).doc(Buffer.from(career).toString('base64url')).set({
    career,
    items,
    cachedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
};

const rankForCareer = (items, career) => {
  const normalizedCareer = String(career || '').toLowerCase();
  return [...items]
    .filter((item) => item.active !== false)
    .sort((a, b) => {
      const aText = `${a.title} ${(a.careerTags || []).join(' ')}`.toLowerCase();
      const bText = `${b.title} ${(b.careerTags || []).join(' ')}`.toLowerCase();
      const aCareerMatch = normalizedCareer && aText.includes(normalizedCareer) ? 1 : 0;
      const bCareerMatch = normalizedCareer && bText.includes(normalizedCareer) ? 1 : 0;
      if (aCareerMatch !== bCareerMatch) return bCareerMatch - aCareerMatch;
      return (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0);
    });
};

const setCorsHeaders = (response) => {
  const allowedOrigin = process.env.OPPORTUNITY_ALLOWED_ORIGIN || '*';
  response.set('Access-Control-Allow-Origin', allowedOrigin);
  response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
};

export const collectOpportunities = onSchedule({
  schedule: 'every 6 hours',
  timeZone: 'Asia/Seoul',
  region: process.env.FUNCTION_REGION || DEFAULT_REGION,
  memory: '512MiB',
  timeoutSeconds: 540,
}, collectOpportunitiesNow);

export const refreshOpportunities = onCall({
  region: process.env.FUNCTION_REGION || DEFAULT_REGION,
  timeoutSeconds: 540,
}, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인한 사용자만 수집을 수동 실행할 수 있습니다.');
  }
  return collectOpportunitiesNow();
});


export const getOpportunities = onRequest({
  region: process.env.FUNCTION_REGION || DEFAULT_REGION,
  memory: '512MiB',
  timeoutSeconds: 60,
}, async (request, response) => {
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    response.status(204).send('');
    return;
  }
  if (request.method !== 'GET') {
    response.status(405).json({ items: [], error: 'GET 요청만 지원합니다.' });
    return;
  }

  const career = stripHtml(request.query.career || request.query.careerSub || '관심 진로');
  const maxItems = Math.min(Number(request.query.maxItems) || 12, 30);

  try {
    const cached = await getCachedQuery(career);
    if (cached) {
      response.json({ items: cached.slice(0, maxItems), cached: true, career });
      return;
    }

    const rawItems = await fetchAllowedSources({ career });
    const normalized = rawItems.map(normalizeItem).filter(Boolean);
    const uniqueMap = new Map(normalized.map((item) => [item.id, item]));
    const items = rankForCareer([...uniqueMap.values()], career)
      .slice(0, maxItems)
      .map(toClientItem);

    await saveCachedQuery(career, items);
    response.json({ items, cached: false, career });
  } catch (error) {
    logger.error('실시간 모집 정보 조회 실패', { message: error.message, career });
    response.status(500).json({ items: [], error: '모집 정보를 불러오지 못했습니다.' });
  }
});
