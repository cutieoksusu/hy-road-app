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
