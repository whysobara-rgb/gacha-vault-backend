# 서버 웹 접근·API 문서 설정

2026-10-14. 서버 소스와 자동 검사 범위이며 실제 Render 환경변수·운영 DB·배포 설정은 변경하지 않는다.

## 적용 내용

- 기존 전체 출처 CORS 허용을 `CORS_ALLOWED_ORIGINS`의 정확한 출처 목록으로 제한한다. 미설정/빈 값이면 다른 출처의 웹 화면에 응답 읽기 권한을 주지 않는다.
- 네이티브 앱·서버 상태 점검 등 Origin 없는 요청은 유지한다. CORS는 브라우저의 응답 접근 정책이므로 인증·관리자 MFA·거래 권한 검사나 요청 실행 차단의 대체물이 아니다.
- `ENABLE_API_DOCS=true`이고 `NODE_ENV=development` 또는 `test`인 경우에만 Swagger UI와 OpenAPI JSON/YAML을 등록한다. production 및 불명확한 환경에서는 true여도 모두 비공개다. 미설정 시 개발 환경도 기본 비공개다.
- Helmet 보안 헤더와 CSP를 기본 적용한다. 명시적으로 활성화한 개발 문서의 `/docs`·`/docs/…`에만 인라인 스크립트 허용과 로컬 HTTP 자산 예외를 둔다. `/docs-json`·`/docs-yaml`·`/docs-evil`·일반 API에는 기본 CSP가 유지된다.
- 정책은 ConfigModule 환경 로딩 이후 ConfigService에서 읽는다. 잘못된 허용 주소/문서 플래그는 리스너 시작 전에 오류가 되며, 초기화한 앱을 닫는다. 오류에 입력 주소나 비밀 값을 포함하지 않는다.

## 설정 절차

1. 접속할 고객 웹·관리자 웹 주소에서 `https://호스트[:포트]` 부분만 확인한다. `/admin.html`, 경로, 끝의 `/`, 쿼리, 사용자 이름·비밀번호를 넣지 않는다.
2. 승인된 배포 작업에서 실제 주소를 쉼표로 나열한다. 예: `CORS_ALLOWED_ORIGINS=https://admin.example.com,https://app.example.com`. 이는 형식 예시이며 실제 허용 주소가 아니다. wildcard·하위 도메인 자동 허용은 지원하지 않는다.
3. 로컬 개발은 `NODE_ENV=development`, `CORS_ALLOWED_ORIGINS=http://localhost:5173`처럼 정확한 포트를 지정한다. 개발 문서가 필요할 때만 `ENABLE_API_DOCS=true`로 설정한다. 그 외에는 false로 둔다.
4. 기존 배포 승인·백업/복원·migration·준비 상태 확인 절차를 진행한 뒤 허용된 웹 화면의 로그인·관리자 요청을 확인한다. 이 변경 자체로 배포나 환경변수 변경을 승인하지 않는다.
5. 허용된 출처에는 해당 출처의 `Access-Control-Allow-Origin`과 `Vary: Origin`이 나오며 쿠키 credentials는 켜지지 않는다. 다른 출처에는 CORS 허용 헤더가 없어야 한다. 기존 Bearer 인증은 계속 필요하다.

요청 헤더는 Authorization, Content-Type, Idempotency-Key, X-Admin-Session, X-Admin-Action을 허용한다. 관리자의 추가 인증·작업 승인 헤더를 포함하므로 기존 관리자 절차를 유지한다. 프리플라이트 캐시는 최대 600초이므로 주소 회수 검수 시 이 캐시를 고려한다.

## 호환성과 검증

미허용 Origin에 일괄 403을 반환하지 않는다. 결제사의 `/payments/return` HTML form POST는 기존처럼 303 복귀를 수행한다. 이 경로는 결제 승인·지급·취소를 실행하지 않는다. 실제 결제사 통신은 이번 검사에 포함하지 않는다.

`src/config/http.config.spec.ts`는 실제 Nest HTTP 응답으로 허용/미허용 출처, 호스트 접미사 위장, 프로토콜·포트 차이, null/Origin 없음, 관리자 preflight 헤더, Swagger 비등록, 개발 문서 한정 CSP, 실제 결제 복귀 컨트롤러를 확인한다. 정책 파서 검사는 잘못된 주소·비밀정보 비노출·로컬 HTTP 범위를 확인한다. 기존 품질 CI에서 함께 실행한다.

기존 `startup-rehearsal.cjs`에도 실제 빌드된 AppModule을 production 모드로 시작한 뒤 CORS·CSP 헤더와 Swagger UI/JSON/YAML 404를 확인하는 검사를 추가한다. 전용 PostgreSQL 18 합성 데이터 CI 안에서만 실행하며 실제 운영 서버는 사용하지 않는다.

미설정 상태로 배포하면 별도 주소에 있는 웹 관리자·고객 웹의 서버 연결이 동작하지 않으므로 배포 전에 실제 허용 주소를 확정해야 한다. CORS나 Swagger 비공개만으로 유료 출시 준비가 끝난 것은 아니다.
