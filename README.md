# HY ROAD

한양대 학생의 졸업 요건과 진로 로드맵을 관리하는 React + Vite 앱입니다.

## 로그인 및 프로필 저장

앱은 다음 순서로 사용자 정보를 다룹니다.

1. 온보딩에서 입력한 프로필, 스펙, 활동 일지를 브라우저 `localStorage`에 즉시 저장합니다.
2. 마이페이지의 `계정 및 저장`에서 Firebase 이메일 회원가입 또는 로그인을 할 수 있습니다.
3. 로그인된 사용자의 정보는 Firestore `users/{uid}` 문서에 자동 저장되며, 다른 기기에서 로그인하면 다시 불러옵니다.

Firebase 설정 전에도 1단계 로컬 저장은 동작합니다.

## Firebase 설정

1. Firebase Console에서 웹 앱을 생성합니다.
2. Authentication에서 `Email/Password` 로그인 제공업체를 활성화합니다.
3. Firestore Database를 생성합니다.
4. `.env.example`을 참고해 프로젝트 루트에 `.env.local`을 생성하고 웹 앱 설정 값을 입력합니다. GitHub Pages 배포용 값은 `.env.production`에 둡니다.

```bash
cp .env.example .env.local
```

Firebase 웹 앱 설정값은 브라우저에 전달되는 공개 연결 정보입니다. 실제 사용자 데이터 접근은 아래 Firestore 보안 규칙으로 제한해야 합니다.

개발 초기의 Firestore 규칙 예시는 다음과 같습니다. 로그인한 사용자가 자신의 문서만 읽고 쓸 수 있도록 제한합니다.

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 실행

```bash
npm install
npm run dev
```

검증 빌드는 `npm run build`, 코드 검사는 `npm run lint`로 실행합니다.

## 최신 공모전/해커톤 데이터 수집

Firebase Functions 결제가 필요하지 않도록, 최신 공고 수집은 GitHub Actions가 하루 1번 실행해서 `public/opportunities.json` 파일을 갱신하는 방식으로 동작합니다. 앱은 이 정적 JSON 파일을 읽고, 각 공고의 `recommendationTags`, `baseWeight`, `recommendedGrades`를 기존 추천 엔진에 섞어 전공/직무/학년별로 다시 정렬합니다.

### GitHub Actions 자동 수집

`.github/workflows/update-opportunities.yml`이 매일 03:00 KST에 실행됩니다.

필요한 GitHub Secrets:

```bash
NAVER_SEARCH_CLIENT_ID
NAVER_SEARCH_CLIENT_SECRET
OPENAI_API_KEY
```

OpenAI 사용량을 줄이고 싶으면 Repository Variables에 아래 값을 둘 수 있습니다.

```bash
OPENAI_MODEL=gpt-4o-mini
OPPORTUNITY_AI_MAX_ITEMS=10
```

OpenAI 키가 없거나 실패해도 수집은 멈추지 않고 키워드 기반 태그/가중치로 fallback합니다. 네이버 검색 API 키가 없으면 `public/opportunities.json`은 빈 목록으로 유지됩니다.

HTML 무단 크롤링은 하지 않고, 네이버 검색 API의 웹문서 검색 결과 중 링커리어 `/activity/` 공고와 `wevity.com` 원문 링크만 저장합니다. 저장 필드는 제목, 짧은 요약, 마감일, 본문 링크, 추천 태그/가중치입니다. 마감일을 찾지 못했거나 이미 마감된 항목은 추천 피드에서 제외합니다.
