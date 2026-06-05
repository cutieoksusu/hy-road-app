import {
  ACTIVITIES,
  CAREER_CATEGORY_TAG_WEIGHTS,
  CAREER_TAG_WEIGHTS,
  COLLEGE_TAG_WEIGHTS,
  GRADE_TAG_WEIGHTS,
  MAJOR_TAG_WEIGHTS,
  TAG_LABELS,
} from './recommendationData.js';

const mergeWeights = (...weightMaps) => weightMaps.reduce((acc, weights = {}) => {
  Object.entries(weights).forEach(([tag, weight]) => {
    acc[tag] = (acc[tag] || 0) + weight;
  });
  return acc;
}, {});

const getGrade = (grade) => {
  const parsed = Number.parseInt(grade, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(4, Math.max(1, parsed));
};

const formatReason = (matchedTags, user) => {
  const labels = matchedTags.slice(0, 3).map(tag => TAG_LABELS[tag] || tag);
  if (labels.length === 0) {
    return `${user.careerSub || user.careerMain || '선택한 진로'} 준비에 기본으로 도움이 되는 활동입니다.`;
  }
  return `${labels.join(', ')} 태그가 전공/직무/학년 조건과 잘 맞아 추천합니다.`;
};

const getActivityTagWeight = (activity, tag) => {
  if (activity.weightedTags && Number.isFinite(activity.weightedTags[tag])) {
    return activity.weightedTags[tag];
  }
  return activity.tags?.includes(tag) ? 10 : 0;
};

const EXTERNAL_TAG_SCORE_MULTIPLIERS = {
  competition: 0.15,
  activity: 0.15,
  project: 0.15,
  volunteer: 0.2,
  internship: 0.45,
  certificate: 0.45,
};

const getTagScoreMultiplier = (activity, tag) => (
  activity.isExternalOpportunity ? (EXTERNAL_TAG_SCORE_MULTIPLIERS[tag] ?? 1) : 1
);

const getExternalTagScoreMultiplier = (tag) => EXTERNAL_TAG_SCORE_MULTIPLIERS[tag] ?? 1;

const CORE_CAREER_TAG_MIN_WEIGHT = 7;
const MIN_EXTERNAL_CORE_SCORE = 8;
const EXCLUDED_EXTERNAL_TAGS_BY_CAREER = {
  '손해사정사': ['ai', 'data', 'software', 'startup', 'marketing', 'contents', 'media'],
  '법무사': ['ai', 'data', 'software', 'startup', 'robotics', 'control', 'patent'],
  '법무담당자': ['ai', 'data', 'software', 'startup', 'robotics', 'control', 'patent'],
  '변호사(로스쿨)': ['ai', 'data', 'software', 'startup', 'robotics', 'control', 'patent'],
};

const getOpportunityTags = (activity) => {
  const weightedTags = activity.weightedTags || {};
  return [...new Set([
    ...(activity.tags || []),
    ...(activity.recommendationTags || []),
    ...Object.keys(weightedTags),
  ])];
};

const hasExcludedExternalTag = (activity, user) => {
  const excludedTags = EXCLUDED_EXTERNAL_TAGS_BY_CAREER[user.careerSub] || [];
  if (!excludedTags.length) return false;
  return excludedTags.some(tag => getActivityTagWeight(activity, tag) >= 7);
};

export const buildUserTagWeights = (user) => {
  const grade = getGrade(user.grade);
  return mergeWeights(
    COLLEGE_TAG_WEIGHTS[user.college],
    MAJOR_TAG_WEIGHTS[user.major],
    CAREER_CATEGORY_TAG_WEIGHTS[user.careerMain],
    CAREER_TAG_WEIGHTS[user.careerSub],
    GRADE_TAG_WEIGHTS[grade],
  );
};

export const scoreExternalOpportunity = (activity, user = {}) => {
  const careerWeights = CAREER_TAG_WEIGHTS[user.careerSub] || {};
  const userWeights = buildUserTagWeights(user);
  const grade = getGrade(user.grade);
  const tags = getOpportunityTags(activity);

  if (!Object.keys(careerWeights).length || hasExcludedExternalTag(activity, user)) {
    return { score: 0, matchedTags: [], coreScore: 0 };
  }

  const coreMatchedTags = tags
    .filter(tag => (careerWeights[tag] || 0) >= CORE_CAREER_TAG_MIN_WEIGHT && getActivityTagWeight(activity, tag) >= 4)
    .sort((a, b) => careerWeights[b] - careerWeights[a]);

  const coreScore = coreMatchedTags.reduce((score, tag) => (
    score + ((careerWeights[tag] || 0) * getActivityTagWeight(activity, tag) / 10)
  ), 0);

  if (coreMatchedTags.length === 0 || coreScore < MIN_EXTERNAL_CORE_SCORE) {
    return { score: 0, matchedTags: [], coreScore };
  }

  const contextScore = tags.reduce((score, tag) => (
    score + ((userWeights[tag] || 0) * getActivityTagWeight(activity, tag) * getExternalTagScoreMultiplier(tag) / 10)
  ), 0);
  const gradeBonus = activity.recommendedGrades?.includes(grade) ? 4 : 0;
  const nearGradeBonus = activity.recommendedGrades?.some(item => Math.abs(item - grade) === 1) ? 1.5 : 0;

  return {
    score: (activity.baseWeight || 0) + (coreScore * 1.8) + (contextScore * 0.25) + gradeBonus + nearGradeBonus,
    matchedTags: coreMatchedTags,
    coreScore,
  };
};

export const recommendActivities = ({ user, activities = ACTIVITIES, limit = 7 }) => {
  const grade = getGrade(user.grade);
  const userWeights = buildUserTagWeights(user);

  const ranked = activities
    .map((activity) => {
      if (activity.isExternalOpportunity) {
        const externalScore = scoreExternalOpportunity(activity, user);
        return {
          ...activity,
          score: externalScore.score,
          matchedTags: externalScore.matchedTags,
          dynamicReason: formatReason(externalScore.matchedTags, user),
        };
      }

      const tagScore = activity.tags.reduce((score, tag) => (
        score + ((userWeights[tag] || 0) * getActivityTagWeight(activity, tag) * getTagScoreMultiplier(activity, tag) / 10)
      ), 0);
      const gradeBonus = activity.recommendedGrades?.includes(grade) ? 8 : 0;
      const nearGradeBonus = activity.recommendedGrades?.some(item => Math.abs(item - grade) === 1) ? 3 : 0;
      const score = activity.baseWeight + tagScore + gradeBonus + nearGradeBonus;
      const matchedTags = activity.tags
        .filter(tag => userWeights[tag])
        .sort((a, b) => userWeights[b] - userWeights[a]);

      return {
        ...activity,
        score,
        matchedTags,
        dynamicReason: formatReason(matchedTags, user),
      };
    })
    .filter(activity => (
      activity.score > activity.baseWeight
      && (!activity.isExternalOpportunity || activity.matchedTags.length > 0)
    ))
    .sort((a, b) => b.score - a.score || b.baseWeight - a.baseWeight);

  const picked = [];
  const typeCounts = {};

  ranked.forEach((activity) => {
    const currentTypeCount = typeCounts[activity.type] || 0;
    const typeLimit = activity.type === 'certificate' ? 3 : 2;
    if (picked.length < limit && currentTypeCount < typeLimit) {
      picked.push(activity);
      typeCounts[activity.type] = currentTypeCount + 1;
    }
  });

  if (picked.length < limit) {
    ranked.forEach((activity) => {
      if (picked.length < limit && !picked.find(item => item.id === activity.id)) {
        picked.push(activity);
      }
    });
  }

  return picked;
};

export { ACTIVITIES, TAG_LABELS };
