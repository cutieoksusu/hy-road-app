import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { TAGS } from '../src/recommendationData.js';

const CAREER_KEYWORDS = {
  'IT/소프트웨어': ['IT', '소프트웨어', '개발', '인공지능', 'AI', '데이터', '해커톤'],
  '기획/마케팅': ['기획', '마케팅', '브랜딩', '광고', '콘텐츠', '공모전'],
  '식품/F&B': ['식품', 'F&B', '푸드', '외식', '영양'],
  '패션/의류': ['패션', '의류', '디자인', '브랜드'],
  '금융/은행': ['금융', '은행', '핀테크', '투자', '경제'],
  '반도체/엔지니어링': ['반도체', '공정', '엔지니어링', '로봇'],
  '공기업 (NCS)': ['공공기관', '공기업', 'NCS', '정책', '행정'],
  '로스쿨 (법조인)': ['법률', '법무', '인권', '정책', '토론'],
  '언론고시 (기자/PD)': ['언론', '기자', 'PD', '방송', '미디어', '콘텐츠'],
};

const TAG_VALUES = Object.values(TAGS);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_AI_TAG_ITEMS = Number.parseInt(process.env.OPPORTUNITY_AI_MAX_ITEMS || '10', 10);
const MAX_ITEMS = Number.parseInt(process.env.OPPORTUNITY_MAX_ITEMS || '1000', 10);
const LINKAREER_MAX_PAGES = Number.parseInt(process.env.LINKAREER_MAX_PAGES || '80', 10);
const WEVITY_MAX_PAGES = Number.parseInt(process.env.WEVITY_MAX_PAGES || '30', 10);
const REQUEST_DELAY_MS = Number.parseInt(process.env.OPPORTUNITY_REQUEST_DELAY_MS || '250', 10);

const toArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (values) => [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
const stripHtml = (value = '') => String(value)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const decodeHtml = (value = '') => stripHtml(String(value)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' '));

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

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

const isAllowedSourceUrl = (value) => {
  try {
    const url = new URL(value);
    const domain = url.hostname.replace(/^www\./, '');
    if (domain === 'linkareer.com') return url.pathname.startsWith('/activity/');
    if (domain === 'wevity.com') return true;
    return false;
  } catch {
    return false;
  }
};

const normalizeSourceName = (url) => {
  const domain = getDomain(url);
  if (domain.includes('linkareer.com')) return '링커리어';
  if (domain.includes('wevity.com')) return '위비티';
  return domain || '공고 플랫폼';
};

const extractDeadline = (text) => {
  const source = stripHtml(text);
  const fullDates = [...source.matchAll(/\b(20\d{2})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})\b/g)]
    .map(([, year, month, day]) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  if (fullDates.length) return fullDates.at(-1);

  const explicit = source.match(/(?:마감|접수\s*마감|모집\s*마감|기간|접수기간|신청기간)\s*[:：]?\s*(?:~|까지)?\s*(\d{1,2}[./-]\d{1,2})/);
  const dateLike = explicit?.[1] || source.match(/(?:~|-|까지)\s*(\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2})/)?.[1];
  if (!dateLike) {
    if (/상시|수시|채용시|모집\s*중/.test(source)) return '상시';
    return '확인 필요';
  }

  const normalized = dateLike.replace(/[./]/g, '-');
  const parts = normalized.split('-');
  if (parts.length === 2) {
    const year = new Date().getFullYear();
    return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
};

const deadlineFromDDay = (value) => {
  const source = stripHtml(value);
  if (/접수예정|상시/.test(source)) return '상시';
  const matched = source.match(/D-(\d+)/i);
  if (!matched) return '';
  const date = new Date();
  date.setHours(date.getHours() + 9);
  date.setDate(date.getDate() + Number.parseInt(matched[1], 10));
  return date.toISOString().slice(0, 10);
};

const getTodayKst = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

const isExpiredDeadline = (deadline) => /^\d{4}-\d{2}-\d{2}$/.test(deadline) && deadline < getTodayKst();

const hasOldYearMarker = (text) => {
  const currentYear = Number.parseInt(getTodayKst().slice(0, 4), 10);
  return [...String(text || '').matchAll(/\b(20\d{2})\b/g)]
    .some(([, year]) => Number.parseInt(year, 10) < currentYear);
};

const hasOldYearInTitle = (title) => hasOldYearMarker(title);

const isRelevantOpportunityText = (text) => {
  const source = stripHtml(text);
  const positive = /(공모전|대외활동|해커톤|서포터즈|기자단|홍보대사|앰버서더|챌린지|대회|콘테스트|아이디어\s*공모|봉사단|멘토링|캠페인|공개SW\s*컨트리뷰톤)/i;
  const educationOnly = /(국비지원|무료교육|교육과정|수강생|부트캠프|양성과정|채용|신입사원|인턴연계|취업준비|직무교육|아카데미|훈련과정|개발자\s*과정|엔지니어\s*과정|분석.*과정|과정\s*\()/i;
  if (!positive.test(source)) return false;
  if (educationOnly.test(source) && !/(공모전|대외활동|해커톤|서포터즈|기자단|홍보대사|앰버서더|챌린지|대회|콘테스트)/i.test(source)) return false;
  return true;
};

const getCanonicalOpportunityKey = (item) => {
  try {
    const url = new URL(item.url);
    const domain = url.hostname.replace(/^www\./, '');
    if (domain === 'wevity.com') {
      const ix = url.searchParams.get('ix');
      if (ix) return `wevity:${ix}`;
    }
    if (domain === 'linkareer.com' && url.pathname.startsWith('/activity/')) {
      return `linkareer:${url.pathname.split('/').filter(Boolean).slice(0, 2).join('/')}`;
    }
  } catch {
    // fall through to title/url key
  }
  return item.url || item.title;
};

const normalizeTitleKey = (title) => String(title || '')
  .replace(/\[[^\]]+\]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .toLowerCase();

const getOpportunityBucket = (item) => {
  const source = `${item.type || ''} ${item.title || ''} ${item.summary || ''}`;
  if (/대외활동|서포터즈|기자단|홍보대사|앰버서더|봉사단|멘토링|캠페인/.test(source)) return 'activity';
  if (/해커톤/.test(source)) return 'hackathon';
  if (/인턴/.test(source)) return 'internship';
  if (/공모전|대회|콘테스트|챌린지/.test(source)) return 'contest';
  return 'other';
};

const selectBalancedItems = (items, limit) => {
  const seenKeys = new Set();
  const uniqueItems = [];
  items.forEach((item) => {
    const keys = [
      getCanonicalOpportunityKey(item),
      normalizeTitleKey(item.title),
    ].filter(Boolean);
    if (keys.some((key) => seenKeys.has(key))) return;
    keys.forEach((key) => seenKeys.add(key));
    uniqueItems.push(item);
  });

  const bucketOrder = ['activity', 'contest', 'hackathon', 'internship', 'other'];
  const buckets = new Map(bucketOrder.map((bucket) => [bucket, []]));

  uniqueItems.forEach((item) => {
    const bucket = getOpportunityBucket(item);
    buckets.set(bucket, [...(buckets.get(bucket) || []), item]);
  });

  const selected = [];
  let cursor = 0;
  while (selected.length < limit && [...buckets.values()].some((bucketItems) => bucketItems.length)) {
    const bucketName = bucketOrder[cursor % bucketOrder.length];
    const item = buckets.get(bucketName)?.shift();
    if (item) selected.push(item);
    cursor += 1;
  }

  return selected;
};

const fetchText = async (url) => {
  const parsedUrl = new URL(url);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Referer: `${parsedUrl.origin}/`,
    },
  });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${url}`);
  return response.text();
};

const addTags = (set, ...tags) => tags.forEach((tag) => {
  if (TAG_VALUES.includes(tag)) set.add(tag);
});

const addWeightedTag = (weights, tag, weight) => {
  if (TAG_VALUES.includes(tag)) {
    weights[tag] = Math.max(weights[tag] || 0, weight);
  }
};

const inferWeightedRecommendationTags = (text) => {
  const source = String(text || '').toLowerCase();
  const weights = {};

  if (/프론트|react|html|css|ui|웹|javascript|typescript/.test(source)) {
    addWeightedTag(weights, TAGS.FRONTEND, 9);
    addWeightedTag(weights, TAGS.SOFTWARE, 8);
    addWeightedTag(weights, TAGS.PORTFOLIO, 6);
  }
  if (/백엔드|서버|api|spring|node|django|database/.test(source)) {
    addWeightedTag(weights, TAGS.BACKEND, 9);
    addWeightedTag(weights, TAGS.SOFTWARE, 8);
    addWeightedTag(weights, TAGS.CLOUD, 5);
  }
  if (/앱|모바일|android|ios/.test(source)) {
    addWeightedTag(weights, TAGS.MOBILE, 9);
    addWeightedTag(weights, TAGS.SOFTWARE, 8);
  }
  if (/데이터|분석|통계|sql|빅데이터|대시보드|리서치/.test(source)) {
    addWeightedTag(weights, TAGS.DATA, 9);
    addWeightedTag(weights, TAGS.STATISTICS, 7);
    addWeightedTag(weights, TAGS.RESEARCH, 5);
  }
  if (/ai|인공지능|머신러닝|딥러닝|llm|생성형/.test(source)) {
    const hasTechnicalAiContext = /활용|개발|프로그래밍|경진대회|해커톤|분석|모델|솔루션|제어|데이터/.test(source);
    addWeightedTag(weights, TAGS.AI, hasTechnicalAiContext ? 8 : 4);
    if (hasTechnicalAiContext) addWeightedTag(weights, TAGS.SOFTWARE, 6);
  }
  if (/로봇|robot|robotics/.test(source)) {
    addWeightedTag(weights, TAGS.ROBOTICS, 8);
    addWeightedTag(weights, TAGS.ENGINEERING, 7);
  }
  if (/제어|제어\s*솔루션|control|자동제어/.test(source)) {
    addWeightedTag(weights, TAGS.CONTROL, 8);
    addWeightedTag(weights, TAGS.ENGINEERING, 7);
  }
  if (/마케팅|브랜드|광고|홍보|pr|sns|서포터즈|앰버서더|크리에이터|쇼츠|캠페인|crm|퍼포먼스/.test(source)) {
    addWeightedTag(weights, TAGS.MARKETING, 8);
    addWeightedTag(weights, TAGS.CONTENTS, 6);
  }
  if (/금융|투자|은행|핀테크|경제|자산운용|증권|보험/.test(source)) {
    addWeightedTag(weights, TAGS.FINANCE, 8);
  }
  if (/투자|자산운용|증권|etf|펀드|주식|가치투자|밸류에이션|포트폴리오|리서치/.test(source)) {
    addWeightedTag(weights, TAGS.INVESTMENT, 8);
  }
  if (/경제|거시|미시|산업분석|시장분석|정책금융/.test(source)) {
    addWeightedTag(weights, TAGS.ECONOMICS, 7);
  }
  if (/회계|재무|세무|감사|cpa|ifrs|결산|원가/.test(source)) {
    addWeightedTag(weights, TAGS.ACCOUNTING, 6);
  }
  if (/공공|공기업|ncs|행정|정책|공공기관|전자정부/.test(source)) {
    addWeightedTag(weights, TAGS.PUBLIC, 8);
    addWeightedTag(weights, TAGS.NCS, 6);
  }
  if (/법률|법무|로스쿨|노무|변리|특허|인권/.test(source)) {
    addWeightedTag(weights, TAGS.LAW, 8);
    addWeightedTag(weights, TAGS.PUBLIC, 5);
  }
  if (/영상|미디어|콘텐츠|기자|pd|방송|작가|뉴스레터|도슨트|기획단|심사단|크리에이터|쇼츠/.test(source)) {
    addWeightedTag(weights, TAGS.MEDIA, 8);
    addWeightedTag(weights, TAGS.CONTENTS, 8);
    addWeightedTag(weights, TAGS.WRITING, 5);
  }
  if (/디자인|ux|ui|그래픽|브랜딩|포트폴리오/.test(source)) {
    addWeightedTag(weights, TAGS.DESIGN, 8);
    addWeightedTag(weights, TAGS.UX, 7);
    addWeightedTag(weights, TAGS.PORTFOLIO, 5);
  }
  if (/반도체/.test(source)) {
    addWeightedTag(weights, TAGS.SEMICONDUCTOR, 10);
    addWeightedTag(weights, TAGS.ENGINEERING, 8);
  }
  if (/공정|전기|기계|생산|품질|전자공학|전자기기|전자부품|전자회로|전자제어|반도체/.test(source)) {
    addWeightedTag(weights, TAGS.ENGINEERING, 8);
  }
  if (/바이오|제약|임상|보건|식품|영양|헬스/.test(source)) {
    addWeightedTag(weights, TAGS.BIO, 8);
    addWeightedTag(weights, TAGS.HEALTHCARE, 6);
    addWeightedTag(weights, TAGS.FOOD, 6);
  }
  if (/환경|건축|도시|bim|cad|에너지/.test(source)) {
    addWeightedTag(weights, TAGS.ENVIRONMENT, 7);
    addWeightedTag(weights, TAGS.ARCHITECTURE, 6);
    addWeightedTag(weights, TAGS.ENGINEERING, 5);
    addWeightedTag(weights, TAGS.ENERGY, 5);
  }
  if (/무역|물류|유통|구매|해외영업|글로벌/.test(source)) {
    addWeightedTag(weights, TAGS.TRADE, 8);
    addWeightedTag(weights, TAGS.LOGISTICS, 7);
    addWeightedTag(weights, TAGS.GLOBAL, 5);
  }
  if (/인사|hr|채용/.test(source)) {
    addWeightedTag(weights, TAGS.HR, 7);
    addWeightedTag(weights, TAGS.MANAGEMENT, 5);
  }
  if (/교육|멘토링|멘토|강연|커리어세션/.test(source)) {
    addWeightedTag(weights, TAGS.EDUCATION, 5);
    addWeightedTag(weights, TAGS.MANAGEMENT, 5);
  }
  if (/인턴|현장실습|실무/.test(source)) addWeightedTag(weights, TAGS.INTERNSHIP, 5);
  if (/영어|일본|중국|해외|통번역|언어/.test(source)) {
    addWeightedTag(weights, TAGS.GLOBAL, 7);
    addWeightedTag(weights, TAGS.LANGUAGE, 7);
  }
  return Object.fromEntries(Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10));
};

const inferRecommendationTags = (text) => {
  const source = String(text || '').toLowerCase();
  const tags = new Set();
  if (/프론트|react|html|css|ui|웹|javascript|typescript/.test(source)) addTags(tags, TAGS.FRONTEND, TAGS.SOFTWARE, TAGS.PORTFOLIO);
  if (/백엔드|서버|api|spring|node|django|database/.test(source)) addTags(tags, TAGS.BACKEND, TAGS.SOFTWARE, TAGS.CLOUD);
  if (/앱|모바일|android|ios/.test(source)) addTags(tags, TAGS.MOBILE, TAGS.SOFTWARE);
  if (/데이터|분석|통계|sql|빅데이터|대시보드|리서치/.test(source)) addTags(tags, TAGS.DATA, TAGS.STATISTICS, TAGS.RESEARCH);
  if (/ai|인공지능|머신러닝|딥러닝|llm|생성형/.test(source)) addTags(tags, TAGS.AI, TAGS.DATA);
  if (/마케팅|브랜드|광고|홍보|pr|sns|서포터즈|앰버서더|크리에이터|쇼츠|캠페인|crm|퍼포먼스/.test(source)) addTags(tags, TAGS.MARKETING, TAGS.CONTENTS);
  if (/금융|투자|은행|회계|재무|핀테크|경제/.test(source)) addTags(tags, TAGS.FINANCE, TAGS.ACCOUNTING);
  if (/공공|공기업|ncs|행정|정책|공공기관/.test(source)) addTags(tags, TAGS.PUBLIC, TAGS.NCS);
  if (/법|로스쿨|노무|변리|특허|인권/.test(source)) addTags(tags, TAGS.LAW, TAGS.PUBLIC);
  if (/영상|미디어|콘텐츠|기자|pd|방송|작가|뉴스레터|도슨트|기획단|심사단|크리에이터|쇼츠/.test(source)) addTags(tags, TAGS.MEDIA, TAGS.CONTENTS, TAGS.WRITING);
  if (/디자인|ux|ui|그래픽|브랜딩|포트폴리오/.test(source)) addTags(tags, TAGS.DESIGN, TAGS.UX, TAGS.PORTFOLIO);
  if (/반도체/.test(source)) addTags(tags, TAGS.SEMICONDUCTOR, TAGS.ENGINEERING);
  if (/공정|전자|전기|기계|로봇|생산|품질/.test(source)) addTags(tags, TAGS.ENGINEERING);
  if (/바이오|제약|임상|보건|식품|영양|헬스/.test(source)) addTags(tags, TAGS.BIO, TAGS.HEALTHCARE, TAGS.FOOD);
  if (/환경|건축|도시|안전|bim|cad|에너지/.test(source)) addTags(tags, TAGS.ENVIRONMENT, TAGS.ARCHITECTURE, TAGS.ENGINEERING, TAGS.ENERGY);
  if (/무역|물류|유통|구매|해외영업|글로벌/.test(source)) addTags(tags, TAGS.TRADE, TAGS.LOGISTICS, TAGS.GLOBAL);
  if (/인사|hr|채용|교육|멘토링|멘토|강연|커리어세션/.test(source)) addTags(tags, TAGS.HR, TAGS.EDUCATION, TAGS.MANAGEMENT);
  if (/봉사|서포터즈|기자단|대외활동|앰버서더/.test(source)) addTags(tags, TAGS.ACTIVITY, TAGS.VOLUNTEER);
  if (/공모전|해커톤|대회|콘테스트|챌린지|아이디어/.test(source)) addTags(tags, TAGS.COMPETITION, TAGS.PROJECT);
  if (/인턴|현장실습|실무/.test(source)) addTags(tags, TAGS.INTERNSHIP);
  if (/자격|기사|시험|cert|certificate/.test(source)) addTags(tags, TAGS.CERTIFICATE);
  if (/영어|일본|중국|해외|통번역|언어/.test(source)) addTags(tags, TAGS.GLOBAL, TAGS.LANGUAGE);
  if (tags.size === 0) addTags(tags, TAGS.ACTIVITY, TAGS.PROJECT);
  return [...tags].slice(0, 7);
};

const inferRecommendationType = (type, text, tags) => {
  const source = `${type} ${text}`.toLowerCase();
  if (source.includes('인턴') || tags.includes(TAGS.INTERNSHIP)) return 'internship';
  if (source.includes('해커톤') || source.includes('공모전') || source.includes('대회') || tags.includes(TAGS.COMPETITION)) return 'competition';
  if (source.includes('자격') || source.includes('시험') || tags.includes(TAGS.CERTIFICATE)) return 'certificate';
  if (source.includes('프로젝트')) return 'project';
  return 'activity';
};

const inferRecommendationCat = (recommendationType, tags) => {
  if (tags.includes(TAGS.LANGUAGE)) return 'lang';
  if (recommendationType === 'certificate') return 'cert';
  if (recommendationType === 'internship') return 'intern';
  if (recommendationType === 'competition' || recommendationType === 'project') return 'project';
  return 'activity';
};

const inferRecommendedGrades = (recommendationType) => {
  if (recommendationType === 'internship') return [3, 4];
  if (recommendationType === 'certificate') return [2, 3, 4];
  if (recommendationType === 'competition' || recommendationType === 'project') return [2, 3];
  return [1, 2, 3];
};

const getCareerTags = (text) => {
  const source = String(text || '').toLowerCase();
  return Object.entries(CAREER_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => source.includes(keyword.toLowerCase())))
    .map(([career]) => career);
};

const getType = (text) => {
  const source = String(text || '').toLowerCase();
  if (source.includes('해커톤')) return '해커톤';
  if (source.includes('인턴')) return '인턴십';
  if (source.includes('대외활동') || source.includes('서포터') || source.includes('봉사')) return '대외활동';
  return '공모전';
};

const normalizeItem = (raw) => {
  const title = stripHtml(raw.title);
  const summary = stripHtml(raw.description || raw.summary || '');
  const url = safeUrl(raw.url || raw.link || raw.originalLink);
  if (!title || !url) return null;
  if (!isAllowedSourceUrl(url)) return null;
  if (hasOldYearInTitle(title)) return null;
  if (/과정/.test(title) && !/(공모전|대외활동|해커톤|서포터즈|기자단|챌린지|대회|콘테스트)/.test(title)) return null;
  if (!isRelevantOpportunityText(`${title} ${summary}`)) return null;

  const source = normalizeSourceName(url);
  const type = raw.type || getType(`${title} ${summary}`);
  const careerTags = uniq([...toArray(raw.careerTags), ...getCareerTags(`${title} ${summary}`)]);
  const text = `${title} ${summary} ${type}`;
  const weightedTags = inferWeightedRecommendationTags(text);
  if (!Object.keys(weightedTags).length) return null;
  const recommendationTags = Object.keys(weightedTags);
  const recommendationType = inferRecommendationType(type, text, recommendationTags);
  const deadline = raw.deadline || extractDeadline(`${title} ${summary}`);
  if (deadline === '확인 필요' || isExpiredDeadline(deadline)) return null;
  if (deadline === '상시' && hasOldYearMarker(`${title} ${summary}`)) return null;

  return {
    id: crypto.createHash('sha1').update(url || title).digest('hex').slice(0, 16),
    title: title.slice(0, 120),
    type,
    source,
    url,
    summary: summary || `${careerTags.slice(0, 2).join('·') || '관심 진로'}와 연결해 검토할 만한 ${type}입니다. 원문에서 모집 대상과 일정을 확인하세요.`,
    deadline,
    publishedAt: raw.publishedAt || '',
    careerTags,
    recommendationTags,
    weightedTags,
    recommendationType,
    recommendationCat: inferRecommendationCat(recommendationType, recommendationTags),
    baseWeight: recommendationType === 'internship' ? 8 : recommendationType === 'competition' ? 7 : 6,
    recommendedGrades: inferRecommendedGrades(recommendationType),
    taggedBy: 'keyword',
    active: true,
  };
};

const extractNextData = (html) => {
  const matched = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!matched) return null;
  return JSON.parse(matched[1]);
};

const getApolloCache = (nextData) => nextData?.props?.pageProps?.apolloState?.data
  || nextData?.props?.pageProps?.__APOLLO_STATE__
  || nextData?.props?.pageProps?.initialApolloState
  || nextData?.props?.pageProps?.apolloState
  || {};

const parseLinkareerPage = (html, type) => {
  const cache = getApolloCache(extractNextData(html));
  return Object.entries(cache)
    .filter(([key, value]) => key.startsWith('Activity:') && value?.id && value?.title)
    .map(([, activity]) => normalizeItem({
      title: activity.title,
      summary: [
        activity.organizationName,
        activity.activityTypeID ? `activityTypeID: ${activity.activityTypeID}` : '',
        activity.scrapCount ? `스크랩 ${activity.scrapCount}` : '',
      ].filter(Boolean).join(' · '),
      url: `https://linkareer.com/activity/${activity.id}`,
      type,
      deadline: activity.recruitCloseAt ? new Date(activity.recruitCloseAt).toISOString().slice(0, 10) : '',
      careerTags: getCareerTags(`${activity.title} ${activity.organizationName || ''}`),
    }))
    .filter(Boolean);
};

const parseWevityPage = (html, type, pageCategory) => {
  const cardPattern = /<div class="tit">\s*<a href="([^"]*ix=(\d+)[^"]*)">([\s\S]*?)<\/a>\s*<div class="sub-tit">([\s\S]*?)<\/div>[\s\S]*?<div class="day">\s*([\s\S]*?)<span class="dday/gi;
  const items = [];
  for (const match of html.matchAll(cardPattern)) {
    const [, , ix, rawTitle, rawSummary, rawDay] = match;
    const title = decodeHtml(rawTitle.replace(/<span[\s\S]*?<\/span>/g, ''));
    const summary = decodeHtml(rawSummary);
    const dDayDeadline = deadlineFromDDay(rawDay);
    items.push(normalizeItem({
      title,
      summary,
      url: `https://www.wevity.com/?c=${pageCategory}&gbn=viewok&ix=${ix}`,
      type,
      deadline: dDayDeadline,
      careerTags: getCareerTags(`${title} ${summary}`),
    }));
  }
  return items.filter(Boolean);
};

const fetchLinkareerList = async () => {
  const results = [];
  const sources = [
    {
      type: '공모전',
      urlForPage: (page) => `https://linkareer.com/list/contest?page=${page}`,
    },
    {
      type: '대외활동',
      urlForPage: (page) => `https://linkareer.com/list/activity?filterType=CATEGORY&orderBy_direction=DESC&orderBy_field=CREATED_AT&page=${page}`,
    },
  ];

  for (const source of sources) {
    for (let page = 1; page <= LINKAREER_MAX_PAGES; page += 1) {
      try {
        const html = await fetchText(source.urlForPage(page));
        const items = parseLinkareerPage(html, source.type);
        if (!items.length) break;
        results.push(...items);
      } catch (error) {
        console.warn(`[opportunities] Linkareer failed: ${error.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  return results;
};

const fetchWevityList = async () => {
  const results = [];
  const sources = [
    { type: '공모전', category: 'find' },
    { type: '대외활동', category: 'active' },
  ];

  for (const source of sources) {
    for (let page = 1; page <= WEVITY_MAX_PAGES; page += 1) {
      try {
        const html = await fetchText(`https://www.wevity.com/?c=${source.category}&gp=${page}`);
        const items = parseWevityPage(html, source.type, source.category);
        if (!items.length) break;
        results.push(...items);
      } catch (error) {
        console.warn(`[opportunities] Wevity failed: ${error.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  return results;
};

const fetchAllowedSources = async () => (await Promise.all([
  fetchLinkareerList(),
  fetchWevityList(),
])).flat();

const extractResponseText = (data) => data.output_text
  || toArray(data.output).flatMap((item) => toArray(item.content)).find((item) => item.type === 'output_text')?.text;

const tagWithOpenAI = async (items) => {
  if (!process.env.OPENAI_API_KEY || items.length === 0 || MAX_AI_TAG_ITEMS <= 0) return items;
  const aiItems = items.slice(0, MAX_AI_TAG_ITEMS);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: 'Classify Korean undergraduate opportunities for a career recommendation app. Return schema-valid JSON only.' },
        { role: 'user', content: JSON.stringify(aiItems.map(({ id, title, type, source, summary, careerTags }) => ({ id, title, type, source, summary, careerTags }))) },
      ],
      text: { format: { type: 'json_schema', name: 'hy_road_static_opportunity_tags', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['id', 'recommendationTags', 'recommendationType', 'recommendationCat', 'baseWeight', 'recommendedGrades', 'summary'], properties: {
            id: { type: 'string' },
            recommendationTags: { type: 'array', items: { type: 'string', enum: TAG_VALUES }, minItems: 1, maxItems: 7 },
            recommendationType: { type: 'string', enum: ['certificate', 'activity', 'project', 'competition', 'internship', 'exam', 'language'] },
            recommendationCat: { type: 'string', enum: ['lang', 'cert', 'activity', 'project', 'intern'] },
            baseWeight: { type: 'integer', minimum: 1, maximum: 10 },
            recommendedGrades: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 4 }, minItems: 1, maxItems: 4 },
            summary: { type: 'string' },
          },
        } } },
      } } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI tagging failed: ${response.status}`);
  const parsed = JSON.parse(extractResponseText(await response.json()) || '{"items":[]}');
  const byId = new Map(parsed.items.map((item) => [item.id, item]));
  return items.map((item) => byId.has(item.id) ? { ...item, ...byId.get(item.id), taggedBy: 'openai' } : item);
};

const main = async () => {
  const rawItems = await fetchAllowedSources();
  const uniqueItems = selectBalancedItems(rawItems, MAX_ITEMS);
  let items = uniqueItems;
  try {
    items = await tagWithOpenAI(uniqueItems);
  } catch (error) {
    console.warn(`[opportunities] AI tagging skipped: ${error.message}`);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'github-actions-static-json',
    itemCount: items.length,
    items,
  };
  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/opportunities.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[opportunities] wrote public/opportunities.json with ${items.length} items`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
