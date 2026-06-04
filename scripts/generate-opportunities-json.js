import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { TAGS } from '../src/recommendationData.js';

const CAREER_KEYWORDS = {
  'IT/소프트웨어': ['IT', '소프트웨어', '개발', '인공지능', 'AI', '데이터', '해커톤'],
  '기획/마케팅': ['기획', '마케팅', '브랜딩', '광고', '콘텐츠', '공모전'],
  '식품/F&B': ['식품', 'F&B', '푸드', '외식', '영양'],
  '패션/의류': ['패션', '의류', '디자인', '브랜드'],
  '금융/은행': ['금융', '은행', '핀테크', '투자', '경제'],
  '반도체/엔지니어링': ['반도체', '공학', '엔지니어링', '제조', '로봇'],
  '공기업 (NCS)': ['공공기관', '공기업', 'NCS', '정책', '행정'],
  '로스쿨 (법조인)': ['법률', '법무', '인권', '정책', '토론'],
  '언론고시 (기자/PD)': ['언론', '기자', 'PD', '방송', '미디어', '콘텐츠'],
};

const TAG_VALUES = Object.values(TAGS);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_AI_TAG_ITEMS = Number.parseInt(process.env.OPPORTUNITY_AI_MAX_ITEMS || '10', 10);
const MAX_ITEMS = Number.parseInt(process.env.OPPORTUNITY_MAX_ITEMS || '80', 10);
const SOURCE_SITE_QUERIES = ['site:linkareer.com/activity', 'site:wevity.com'];

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

const getTodayKst = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

const isExpiredDeadline = (deadline) => /^\d{4}-\d{2}-\d{2}$/.test(deadline) && deadline < getTodayKst();

const addTags = (set, ...tags) => tags.forEach((tag) => {
  if (TAG_VALUES.includes(tag)) set.add(tag);
});

const inferRecommendationTags = (text) => {
  const source = String(text || '').toLowerCase();
  const tags = new Set();
  if (/프론트|react|html|css|ui|웹|javascript|typescript/.test(source)) addTags(tags, TAGS.FRONTEND, TAGS.SOFTWARE, TAGS.PORTFOLIO);
  if (/백엔드|서버|api|spring|node|django|database/.test(source)) addTags(tags, TAGS.BACKEND, TAGS.SOFTWARE, TAGS.CLOUD);
  if (/앱|모바일|android|ios/.test(source)) addTags(tags, TAGS.MOBILE, TAGS.SOFTWARE);
  if (/데이터|분석|통계|sql|빅데이터|대시보드|리서치/.test(source)) addTags(tags, TAGS.DATA, TAGS.STATISTICS, TAGS.RESEARCH);
  if (/ai|인공지능|머신러닝|딥러닝|llm|생성형/.test(source)) addTags(tags, TAGS.AI, TAGS.DATA);
  if (/마케팅|브랜드|광고|홍보|crm|퍼포먼스|캠페인/.test(source)) addTags(tags, TAGS.MARKETING, TAGS.CONTENTS);
  if (/금융|투자|은행|회계|재무|핀테크|경제/.test(source)) addTags(tags, TAGS.FINANCE, TAGS.ACCOUNTING);
  if (/공공|공기업|ncs|행정|정책|공공기관/.test(source)) addTags(tags, TAGS.PUBLIC, TAGS.NCS);
  if (/법|로스쿨|노무|변리|특허|인권/.test(source)) addTags(tags, TAGS.LAW, TAGS.PUBLIC);
  if (/영상|미디어|콘텐츠|기자|pd|방송|작가|뉴스레터/.test(source)) addTags(tags, TAGS.MEDIA, TAGS.CONTENTS, TAGS.WRITING);
  if (/디자인|ux|ui|그래픽|브랜딩|포트폴리오/.test(source)) addTags(tags, TAGS.DESIGN, TAGS.UX, TAGS.PORTFOLIO);
  if (/반도체|공정|전자|전기|기계|로봇|제조|품질/.test(source)) addTags(tags, TAGS.ENGINEERING, TAGS.SEMICONDUCTOR);
  if (/바이오|제약|임상|보건|식품|영양|헬스/.test(source)) addTags(tags, TAGS.BIO, TAGS.HEALTHCARE, TAGS.FOOD);
  if (/환경|건축|도시|안전|bim|cad|에너지/.test(source)) addTags(tags, TAGS.ENVIRONMENT, TAGS.ARCHITECTURE, TAGS.ENGINEERING, TAGS.ENERGY);
  if (/무역|물류|유통|구매|해외영업|글로벌/.test(source)) addTags(tags, TAGS.TRADE, TAGS.LOGISTICS, TAGS.GLOBAL);
  if (/인사|hr|채용|교육|멘토링/.test(source)) addTags(tags, TAGS.HR, TAGS.EDUCATION, TAGS.MANAGEMENT);
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

  const source = normalizeSourceName(url);
  const type = raw.type || getType(`${title} ${summary}`);
  const careerTags = uniq([...toArray(raw.careerTags), ...getCareerTags(`${title} ${summary}`)]);
  const text = `${title} ${summary} ${type} ${careerTags.join(' ')}`;
  const recommendationTags = inferRecommendationTags(text);
  const recommendationType = inferRecommendationType(type, text, recommendationTags);
  const deadline = extractDeadline(`${title} ${summary}`);
  if (deadline === '확인 필요' || isExpiredDeadline(deadline)) return null;

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
    recommendationType,
    recommendationCat: inferRecommendationCat(recommendationType, recommendationTags),
    baseWeight: recommendationType === 'internship' ? 8 : recommendationType === 'competition' ? 7 : 6,
    recommendedGrades: inferRecommendedGrades(recommendationType),
    taggedBy: 'keyword',
    active: true,
  };
};

const buildQueries = () => uniq(Object.entries(CAREER_KEYWORDS).flatMap(([career, keywords]) => (
  SOURCE_SITE_QUERIES.flatMap((siteQuery) => [
    `${siteQuery} ${career} 공모전`,
    `${siteQuery} ${career} 대외활동`,
    `${siteQuery} ${career} 해커톤`,
    ...keywords.slice(0, 2).map((keyword) => `${siteQuery} ${keyword} 공모전 대외활동 해커톤`),
  ])
))).slice(0, 48);

const fetchNaverSearch = async () => {
  const clientId = process.env.NAVER_SEARCH_CLIENT_ID;
  const clientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[opportunities] NAVER_SEARCH_CLIENT_ID/SECRET missing. Writing fallback empty feed.');
    return [];
  }

  const results = [];
  for (const query of buildQueries()) {
    for (const searchType of ['webkr']) {
      const url = new URL(`https://openapi.naver.com/v1/search/${searchType}.json`);
      url.searchParams.set('query', query);
      url.searchParams.set('display', '10');
      const response = await fetch(url, {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      });
      if (!response.ok) {
        console.warn(`[opportunities] Naver ${searchType} failed: ${response.status} ${query}`);
        continue;
      }
      const data = await response.json();
      results.push(...toArray(data.items).map((item) => normalizeItem({
        title: item.title,
        description: item.description,
        url: item.link,
        publishedAt: item.pubDate || item.postdate || '',
        careerTags: getCareerTags(`${query} ${item.title} ${item.description}`),
      })).filter(Boolean));
    }
  }
  return results;
};

const extractResponseText = (data) => data.output_text
  || toArray(data.output).flatMap((item) => toArray(item.content)).find((item) => item.type === 'output_text')?.text;

const tagWithOpenAI = async (items) => {
  if (!process.env.OPENAI_API_KEY || items.length === 0) return items;
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
  const rawItems = await fetchNaverSearch();
  const uniqueItems = [...new Map(rawItems.map((item) => [item.url || item.title, item])).values()].slice(0, MAX_ITEMS);
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
