# 운영자 원결제수단 환불 API · 개발/시험 전용

2026-09-16. 출시 체크리스트 40번의 서버 코드 인수 범위다. 실제 PG 환불, Render 배포, 관리자 웹 버튼, MFA, 예외적 사후 보상, 개봉/배송 후 반품의 자동 금전 처리가 완료됐다는 뜻은 아니다. PG는 기존 다날 어댑터이고 PortOne 연동은 별도다.

## API 계약

모든 `/owner/refunds` 경로에 실제 JWT 인증과 DB OWNER 권한·auth_version 검증이 필요하다. 토큰의 OWNER 문자열만으로 권한을 인정하지 않는다.

- GET /owner/refunds/capabilities: OPERATOR_REFUND_V1, 개발 기능 활성 여부, 실결제/추가 인증 준비 여부를 구분.
- POST /owner/refunds/quotes: orderId, capsuleIds로 원주문·대상·환불액·통화·정책을 조회한다. 환불을 실행하지 않는다.
- POST /owner/refunds: 위 대상과 expectedAmount, expectedCurrency, 고객에게 보이는 reason 및 idempotency-key로 실행한다. customerId·actorId·override 등 임의 필드는 거절한다.
- GET /owner/refunds/by-request/:key: 현재 운영자의 요청번호로 유실된 응답을 조회한다. 다른 업무나 다른 운영자의 요청번호와 혼동하지 않는다.
- GET /owner/refunds/:id: 현재 OWNER가 환불의 최신 상태를 조회한다. 조회는 환불을 실행하거나 PG를 호출하지 않는다. 고객용 조회는 기존 소유권 경계를 그대로 유지한다.

## 보존하는 거래 규칙

미개봉/환불 가능 기간/구매 당시 환불 정책/금액을 기존 RefundsService에서 검사한다. 이 정책이 모든 법적 환불 상황을 포함한다는 판정은 하지 않는다. 개봉 상품·배송/하자·예외 보상은 별도 운영 절차이며 이 API로 정책을 우회하지 않는다.

원주문의 소유자를 서버가 결정한다. GP 결제는 그 고객의 GP 원장으로, KRW 결제는 원 PG 거래 취소로만 반환한다. 관리자의 GP·임의 계좌·다른 통화로 변경할 수 없다. 부분 환불 총량·개봉과 환불의 경합은 기존 주문/캡슐 상태와 고객 잠금으로 보호한다.

운영자와 고객 행을 ID 오름차순으로 잠근 후 세션·권한을 다시 확인한다. 승인 기록을 커밋한 후에만 외부 PG를 호출하며 외부 I/O 동안 DB 잠금을 유지하지 않는다. 일단 승인한 진행 건의 외부 결과 기록은 도중 권한 회수가 있더라도 마무리한다. 회수된 계정의 새 실행·조회는 차단한다.

운영자 요청키는 operations_requests에 묶고 내부 환불키는 별도로 생성해 고객 요청키와 충돌하지 않는다. 같은 키에서 금액/통화/캡슐/사유/주문이 달라지면 거절한다. 응답 캐시가 아닌 실제 환불 상태를 반환한다.

## 감사와 실패 처리

새 DB 구조 없이 기존 operations_requests와 operations_events를 활용한다. 요청·PG 승인/불명확·완료 상태 변경과 이벤트 기록을 같은 트랜잭션에 넣는다. 이벤트에는 작업자, 고객, 주문, 환불, 요청키, 원금액·통화·캡슐·사유를 연결한다. 인증정보·개인키·PG 원문은 넣지 않는다. 사유는 고객에게 공개되므로 개인정보나 내부 메모를 적지 않는다. DB 관리자에 의한 직접 변조까지 막는 불변 감사 저장소는 별도 요건이다.

요청 감사 저장 실패는 PG 호출 전 롤백한다. GP 완료 감사 실패도 잔액·원장·환불을 함께 롤백한다. PG 승인 저장 이후 완료 단계 실패는 APPROVED 상태를 보존하고 같은 운영자 요청키로 내부 완료만 재시도한다. 외부 PG는 재호출하지 않는다.

PG 응답 유실/예외/취소 승인 기록 저장 실패는 PROCESSING 또는 UNKNOWN으로 남을 수 있다. 재요청으로 취소를 다시 보내거나 강제로 성공 처리하지 않는다. 실제 PG 조회·대사 후 해결 경로는 69번 등 별도 출시 작업이다. 최초 운영자 권한이 소실된 APPROVED 건의 다른 운영자 복구 UI/절차도 출시 운영 인수에서 다룬다.

## 활성화와 검증

NODE_ENV가 development/test이며 ENABLE_LEGACY_TRANSACTIONS가 true가 아니어야 한다. ENABLE_ORDER_REFUND_PREVIEW=true, ENABLE_OPERATOR_REFUND_PREVIEW=true가 모두 필요하다. production은 플래그를 켜도 거절하며 productionEnabled=false, additionalAuthenticationReady=false를 표시한다. 이 플래그를 운영 활성화 승인으로 해석하지 않는다. 기존 Render 설정과 실제 데이터는 변경하지 않는다.

`test/operator-refunds.postgres-spec.ts`는 로컬 임시 PostgreSQL·시험 JWT·모의 PG에서만 실행한다. HTTP 인증·입력 제한·6회 재시도, 운영자/고객/개봉 경쟁, 원결제/부분 취소, UNKNOWN/외부 예외, 감사 실패, APPROVED 복구, 권한 회수 및 운영 차단을 검사한다. 일반 기존 테스트와 PostgreSQL 16/18 통합·전체 앱 기동 리허설도 최종 커밋에서 성공해야 한다. 테스트 파일 추가만으로 40번을 DONE으로 바꾸지 않는다.

설계 참고: PostgreSQL explicit locking(일관된 잠금 순서), OWASP Web Service Security(요청별 권한 확인). 실제 실행 증거와 본 문서의 구현 설명을 구분한다.
