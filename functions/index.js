import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';

initializeApp();

const db = getFirestore();
const COLLECTION = 'opportunities';
const MAX_ITEMS_PER_SOURCE = 30;
const MAX_DAILY_ITEMS = MAX_ITEMS_PER_SOURCE * 8;
const STORED_QUERY_LIMIT = 120;
const DEFAULT_REGION = 'asia-northeast3';
const CACHE_COLLECTION = 'opportunityQueryCache';
const META_COLLECTION = 'opportunityMeta';
const DAILY_CRAWLER_META_DOC = 'dailyCrawler';
const DEFAULT_CACHE_TTL_MINUTES = 60 * 24;
const DEFAULT_DAILY_SCHEDULE = '0 7 * * *';

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
const DEFAULT_CRAWL_CAREERS = Object.keys(CAREER_KEYWORDS);

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  if (value && typeof value === 'object') return [value];
  return [];
};

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

const getConfiguredCrawlCareers = () => {
  const configured = readJsonEnv('OPPORTUNITY_CRAWL_CAREERS', null);
  if (Array.isArray(configured) && configured.length > 0) {
    return uniq(configured);
  }
  return DEFAULT_CRAWL_CAREERS;
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

const getTimestampMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const getFreshnessMillis = (item) => (
  getTimestampMillis(item.publishedAt)
    || getTimestampMillis(item.collectedAt)
    || getTimestampMillis(item.updatedAt)
);

const fetchDailySources = async ({ careers }) => {
  const [publicItems, permittedItems] = await Promise.all([
    fetchPublicDataPortal(),
    fetchPermittedFeeds(),
  ]);
  const searchItems = [];

  for (const career of careers) {
    searchItems.push(...await fetchNaverSearch({ career }));
  }

  return [...publicItems, ...permittedItems, ...searchItems];
};

const saveOpportunityItems = async (items) => {
  const writer = db.bulkWriter();
  items.forEach((item) => {
    const { id, ...data } = item;
    writer.set(db.collection(COLLECTION).doc(id), {
      ...data,
      collectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  await writer.close();
  return items.length;
};

const clearCachedQueries = async () => {
  const snapshot = await db.collection(CACHE_COLLECTION).limit(300).get();
  if (snapshot.empty) return 0;

  const writer = db.bulkWriter();
  snapshot.docs.forEach((item) => writer.delete(item.ref));
  await writer.close();
  return snapshot.size;
};

const saveCrawlerMeta = async ({ saved, careers }) => {
  await db.collection(META_COLLECTION).doc(DAILY_CRAWLER_META_DOC).set({
    saved,
    careers,
    schedule: process.env.OPPORTUNITY_CRAWL_SCHEDULE || DEFAULT_DAILY_SCHEDULE,
    lastCollectedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
};

export const collectOpportunitiesNow = async ({ careers } = {}) => {
  const crawlCareers = uniq(careers?.length ? careers : getConfiguredCrawlCareers());
  const rawItems = await fetchDailySources({ careers: crawlCareers });

  const normalized = rawItems.map(normalizeItem).filter(Boolean);
  const uniqueMap = new Map(normalized.map((item) => [item.id, item]));
  const uniqueItems = [...uniqueMap.values()]
    .sort((a, b) => getFreshnessMillis(b) - getFreshnessMillis(a))
    .slice(0, MAX_DAILY_ITEMS);

  if (uniqueItems.length === 0) {
    logger.info('수집된 공모전/해커톤 데이터가 없습니다. API 키와 허가 피드 설정을 확인하세요.');
    await saveCrawlerMeta({ saved: 0, careers: crawlCareers });
    return { saved: 0, careers: crawlCareers.length };
  }

  const saved = await saveOpportunityItems(uniqueItems);
  const cacheCleared = await clearCachedQueries();
  await saveCrawlerMeta({ saved, careers: crawlCareers });

  logger.info('opportunities 컬렉션 일일 업데이트 완료', {
    count: saved,
    careers: crawlCareers.length,
    cacheCleared,
  });
  return { saved, careers: crawlCareers.length, cacheCleared };
};


const timestampToIso = (value) => {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return String(value);
};

const getSourceLabel = (sourceType) => {
  if (sourceType === 'public-data-portal') return '매일 업데이트 · 공공데이터 API';
  if (sourceType?.includes('naver')) return '매일 업데이트 · 검색 API';
  return '매일 업데이트 · 허가 피드';
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
  collectedAt: timestampToIso(item.collectedAt),
  updatedAt: timestampToIso(item.updatedAt || item.collectedAt),
  careerTags: item.careerTags || [],
  dynamicReason: getSourceLabel(item.sourceType),
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
  return {
    items: toArray(data.items),
    source: data.source || 'cache',
    updatedAt: timestampToIso(data.updatedAt),
  };
};

const saveCachedQuery = async (career, items, meta = {}) => {
  await db.collection(CACHE_COLLECTION).doc(Buffer.from(career).toString('base64url')).set({
    career,
    items,
    ...meta,
    cachedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
};

const getCareerMatchScore = (item, career) => {
  const normalizedCareer = String(career || '').trim().toLowerCase();
  if (!normalizedCareer) return 0;

  const careerTags = toArray(item.careerTags).map((tag) => String(tag).trim().toLowerCase());
  const keywords = toArray(item.keywords).map((keyword) => String(keyword).trim().toLowerCase());
  const searchable = [
    item.title,
    item.summary,
    item.type,
    item.source,
    ...careerTags,
    ...keywords,
  ].join(' ').toLowerCase();

  if (careerTags.includes(normalizedCareer)) return 4;
  if (searchable.includes(normalizedCareer)) return 3;

  const relatedKeywords = CAREER_KEYWORDS[career] || [];
  if (relatedKeywords.some((keyword) => searchable.includes(keyword.toLowerCase()))) return 2;
  return 0;
};

const rankForCareer = (items, career) => {
  return [...items]
    .filter((item) => item.active !== false)
    .sort((a, b) => {
      const aCareerScore = getCareerMatchScore(a, career);
      const bCareerScore = getCareerMatchScore(b, career);
      if (aCareerScore !== bCareerScore) return bCareerScore - aCareerScore;
      return getFreshnessMillis(b) - getFreshnessMillis(a);
    });
};

const loadStoredOpportunities = async ({ career, maxItems }) => {
  const snapshot = await db.collection(COLLECTION)
    .orderBy('publishedAt', 'desc')
    .limit(STORED_QUERY_LIMIT)
    .get();
  const items = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  return rankForCareer(items, career).slice(0, maxItems);
};

const getCrawlerMeta = async () => {
  const snapshot = await db.collection(META_COLLECTION).doc(DAILY_CRAWLER_META_DOC).get();
  return snapshot.exists ? snapshot.data() : {};
};

const setCorsHeaders = (response) => {
  const allowedOrigin = process.env.OPPORTUNITY_ALLOWED_ORIGIN || '*';
  response.set('Access-Control-Allow-Origin', allowedOrigin);
  response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
};

export const collectOpportunities = onSchedule({
  schedule: process.env.OPPORTUNITY_CRAWL_SCHEDULE || DEFAULT_DAILY_SCHEDULE,
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
  const requestedCareers = uniq(toArray(request.data?.careers)).slice(0, 20);
  return collectOpportunitiesNow({
    careers: requestedCareers.length ? requestedCareers : undefined,
  });
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
  const maxItems = Math.min(Math.max(Number(request.query.maxItems) || 12, 1), 30);

  try {
    const cached = await getCachedQuery(career);
    if (cached) {
      response.json({
        items: cached.items.slice(0, maxItems),
        cached: true,
        career,
        source: cached.source,
        updatedAt: cached.updatedAt,
      });
      return;
    }

    const crawlerMeta = await getCrawlerMeta();
    const storedItems = await loadStoredOpportunities({ career, maxItems });
    if (storedItems.length) {
      const items = storedItems.map(toClientItem);
      const updatedAt = crawlerMeta.lastCollectedAt || storedItems[0].collectedAt || storedItems[0].updatedAt;
      await saveCachedQuery(career, items, {
        source: 'firestore-daily-crawl',
        updatedAt,
      });
      response.json({
        items,
        cached: false,
        career,
        source: 'firestore-daily-crawl',
        updatedAt: timestampToIso(updatedAt),
      });
      return;
    }

    const rawItems = await fetchAllowedSources({ career });
    const normalized = rawItems.map(normalizeItem).filter(Boolean);
    const uniqueMap = new Map(normalized.map((item) => [item.id, item]));
    const liveItems = rankForCareer([...uniqueMap.values()], career).slice(0, maxItems);
    if (liveItems.length) await saveOpportunityItems(liveItems);
    const items = liveItems.map(toClientItem);

    await saveCachedQuery(career, items, {
      source: 'live-api-fallback',
      updatedAt: Timestamp.now(),
    });
    response.json({
      items,
      cached: false,
      career,
      source: 'live-api-fallback',
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('실시간 모집 정보 조회 실패', { message: error.message, career });
    response.status(500).json({ items: [], error: '모집 정보를 불러오지 못했습니다.' });
  }
});
