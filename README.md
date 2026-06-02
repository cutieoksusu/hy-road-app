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

홈 화면의 `liveActivities` 영역은 `VITE_OPPORTUNITY_API_URL`이 설정되어 있으면 앱 진입/진로 변경 시 HTTPS Function `getOpportunities`를 호출해 최신 공모전·해커톤 정보를 동적으로 받아옵니다. API 응답이 없을 때는 Firestore `opportunities` 컬렉션을 읽고, 그래도 데이터가 없거나 Firebase를 사용할 수 없을 때만 기존 플랫폼 검색 링크로 fallback합니다.

### Cloud Functions + Scheduler

`functions/`에는 앱에서 호출하는 HTTPS Function `getOpportunities`와 6시간마다 실행되는 `collectOpportunities` 스케줄 함수가 포함되어 있습니다. `getOpportunities`는 요청받은 진로 키워드로 허가된 API를 실시간 조회하고, API 남용을 막기 위해 기본 15분 TTL 캐시를 사용합니다. 함수는 저작권 침해를 피하기 위해 HTML 무단 스크래핑을 하지 않고 다음 출처만 사용합니다.

1. 공공데이터포털 Open API (`PUBLIC_DATA_SERVICE_KEY`, `PUBLIC_DATA_ENDPOINTS`)
2. 검색 API (`NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`)
3. 명시적으로 사용 허가를 받은 JSON 피드 (`PERMITTED_FEEDS`)

수집된 항목은 원문 전체를 저장하지 않고 `title`, `deadline`, `source`, `originalLink`, 앱이 직접 생성한 짧은 `summary`, `careerTags`와 추천 엔진용 `recommendationTags`, `baseWeight`, `recommendedGrades`만 Firestore `opportunities` 컬렉션에 저장합니다. `OPENAI_API_KEY`가 있으면 OpenAI Responses API의 JSON Schema 출력으로 태그를 보정하고, 키가 없거나 실패하면 키워드 기반 태깅으로 fallback합니다.

Firebase Functions v2 배포 환경에서는 Secret Manager, `.env`/`.env.<project-id>` 파일, 또는 CI/CD 환경변수로 아래 값을 주입하세요.

```bash
PUBLIC_DATA_SERVICE_KEY="공공데이터포털_서비스키"
NAVER_SEARCH_CLIENT_ID="검색_API_Client_ID"
NAVER_SEARCH_CLIENT_SECRET="검색_API_Client_Secret"
PUBLIC_DATA_ENDPOINTS='[{"name":"공공데이터포털 승인 API","url":"https://apis.data.go.kr/...","itemsPath":"response.body.items.item","fields":{"title":"title","url":"url","deadline":"endDate","publishedAt":"createdAt"}}]'
PERMITTED_FEEDS='[{"name":"제휴 피드명","url":"https://partner.example.com/opportunities.json","itemsPath":"items","fields":{"title":"title","url":"url","deadline":"deadline","publishedAt":"publishedAt","careerTags":"careerTags"}}]'
OPPORTUNITY_CACHE_TTL_MINUTES=15
OPPORTUNITY_ALLOWED_ORIGIN="https://cutieoksusu.github.io"
OPENAI_API_KEY="선택_OPENAI_API_KEY"
OPENAI_MODEL="gpt-4o-mini"
```

배포:

```bash
npm install --prefix functions
firebase deploy --only functions
```

배포 후 프론트엔드 환경변수에 HTTPS Function URL을 넣어야 앱이 실제 API를 호출합니다.

```bash
VITE_OPPORTUNITY_API_URL=https://asia-northeast3-<project-id>.cloudfunctions.net/getOpportunities
```

### Firestore 보안 규칙 예시

`opportunities`는 앱 홈 화면에 표시되는 공개 모집 정보이므로 읽기는 허용하고, 쓰기는 Cloud Functions Admin SDK만 수행하도록 클라이언트 쓰기를 차단합니다.

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /opportunities/{opportunityId} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```
