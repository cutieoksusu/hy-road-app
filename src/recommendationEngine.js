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

export const recommendActivities = ({ user, activities = ACTIVITIES, limit = 7 }) => {
  const grade = getGrade(user.grade);
  const userWeights = buildUserTagWeights(user);

  const ranked = activities
    .map((activity) => {
      const tagScore = activity.tags.reduce((score, tag) => score + (userWeights[tag] || 0), 0);
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
    .filter(activity => activity.score > activity.baseWeight)
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
