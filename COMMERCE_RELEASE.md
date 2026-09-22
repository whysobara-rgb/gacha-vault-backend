# 출시 3단계 · 결제·미개봉 환불·거래 이력

구현일: 2026-09-15. 이 문서는 출시 승인서가 아니다. 다날 가맹점 설정과 실제 PG 시험을 완료하지 않았으며 운영 환경 결제·환불 활성화는 코드에서 차단한다.

## 구현

- 직접 다날 ONE API 카드 결제 준비 → 브라우저 인증 → 로그인한 소유자의 서버 승인 → 구매 주문·최대 100개 캡슐 지급을 분리했다. 브라우저 복귀 자체는 결제 성공으로 인정하지 않는다.
- 서버 가격·확률 버전·상품 내용을 고정하고 결제 대기 재고를 예약한다. GP 구매도 같은 재고 예약을 반영한다. 승인 후 캡슐 저장이 실패하면 승인된 거래의 지급만 재시도한다.
- 외부 응답이 불명확하면 UNKNOWN을 유지한다. 승인·취소 요청을 자동 반복하지 않는다. 운영자 대사와 공급자 조회 연동은 후속 작업이다.
- 주문의 미개봉 캡슐을 1~100개 선택해 부분 환불한다. 원 결제 수단이 GP이면 GP 원장에 환급하고, KRW이면 카드 취소 요청으로 처리한다. 카드 취소는 GP를 지급하지 않는다.
- 개봉·환불은 소유자 잠금 아래 경쟁한다. 환불 처리 중인 캡슐은 개봉할 수 없다. 완료된 환불만 판매 수량을 줄이고 남은 캡슐은 계속 개봉할 수 있다.
- 구매·개봉·결제·환불 목록은 로그인 계정의 전체 서버 기록을 안정적인 페이지 순서로 조회한다. 기존 브라우저 기록과는 별개다.
- 동일 요청 번호의 중복 지급·환급 방지, 다른 계정 조회 차단, 금액·상품·확률 변경 검증, 트랜잭션 롤백을 구현했다.

## 환불 정책과 활성화

업로드된 서비스 정책의 '미개봉 구매 후 7영업일, 이벤트 상품 제외'를 구현했다. STANDARD로 명시한 상품만 대상이며 기존 주문에 환불 권리를 임의로 추가하지 않는다. 구매일은 제외하고 한국 시간 기준 7번째 영업일의 종료까지 허용한다. 이 계산 해석과 휴일표는 출시 전 운영 정책 검토가 필요하다.

`REFUND_CALENDAR_JSON`에 적용 기간과 휴일 목록을 명시해야 한다. 새 주문은 기한·정책 버전을 고정한다. 체험 웹의 주말만 제외하는 예시는 운영 휴일표가 아니다. 일반 상품으로 바꾸기 전에 달력을 설정해야 한다.

기본값은 비활성이다. `.env.example`의 `ENABLE_ORDER_REFUND_PREVIEW`, `ENABLE_DANAL_TEST_PAYMENTS`를 참고한다. development/test 및 레거시 거래 비활성 조건에서만 허용한다. 다날은 테스트 클라이언트 키·비밀 키·가맹점 번호를 별도 설정한다. 비밀 키는 서버 환경에만 둔다. 상품도 `cash_enabled=true`, 명시적 현금 단가, 판매 유형을 요구한다. 운영 데이터나 자격 증명을 이 작업에서 변경하지 않았다.

## API

| 기능 | 경로 |
| --- | --- |
| 결제 준비/목록 | POST / GET `/payments` |
| 소유 결제/요청 복구/인증 파라미터 | GET `/payments/:id`, `/payments/by-request/:key`, `/payments/:id/checkout` |
| 서버 승인/인증 전 취소 | POST `/payments/:id/confirm`, `/payments/:id/cancel` |
| 브라우저 복귀(승인 기능 없음) | GET / POST `/payments/return` |
| 환불 견적/실행 | POST `/orders/:id/refund-quote`, `/orders/:id/refunds` |
| 환불 내역/상세/복구 | GET `/order-refunds`, `/order-refunds/:id`, `/order-refunds/by-request/:key` |
| 전체 구매/개봉 이력 | GET `/transactions/orders`, `/transactions/openings` |

결제 준비와 환불 실행은 `Idempotency-Key` UUID를 요구한다. 복귀 경로를 제외한 거래 API는 JWT를 요구한다. capabilities 응답으로 서버 반영·활성화 상태를 구분한다.

## 검증 범위

- Nest 빌드·TypeScript 검사, 18개 모음의 135개 테스트 통과.
- 신규 테스트: SQL 11개, 실제 Nest HTTP 5개, 공급자 요청/응답 계약 8개. 외부 다날 통신은 모킹했다.
- SQL 검사는 9개 마이그레이션을 PGlite에서 실행한다. 다중 연결 PostgreSQL과 동일한 검증이라고 주장하지 않는다.
- 실제 PostgreSQL 16에서 중복 환불, 개봉/환불 경쟁, GP 구매/카드 재고 예약 경쟁을 확인할 CI 3개를 추가했다. 로컬 실행은 하지 못했으며 GitHub Actions 결과를 별도로 확인해야 한다.
- 웹 체험 엔진은 59개 검사와 DOM 어댑터 79개 경로 및 거래 이벤트를 검사한다. 실제 iPhone 브라우저·다날 인증창·네이티브 앱 검증은 남아 있다.

## 출시 전에 남은 작업

- 다날 테스트 가맹점 인증창·서버 승인·전체/부분 취소·모바일 복귀를 실제로 검증하고, 불명확 거래 조회/정산 대사 및 영수증 발급을 구현한다.
- 카드 외 계좌이체·간편결제·휴대폰 결제는 구현하지 않았다.
- 운영 환불 휴일표, 가격/재고/상품 분류, 복구 규칙, 배송 요금을 확정한다.
- 검증된 서버 변경과 9개 DB 마이그레이션을 Render에 반영하고 인증 계정으로 통합 시험한다.
- 계정 복구·본인확인·탈퇴, 운영 관리·문의, 출고·추적, 네이티브 이식과 실기기 검수는 후속 단계다.

## 확인한 공식 다날 자료

- [클라이언트 인증 SDK](https://developers.danalpay.com/reference/client/auth), [결제 요청](https://developers.danalpay.com/reference/client/payment), [인증 결과](https://developers.danalpay.com/reference/client/verify)
- [서버 인증 헤더](https://developers.danalpay.com/reference/server/header), [서버 승인](https://developers.danalpay.com/reference/server/confirm), [결제 취소](https://developers.danalpay.com/reference/server/cancel)

승인과 취소는 고정 `https://one-api.danalpay.com` 경로만 사용하며 실패 시 임의 대체 공급자나 자동 승인 처리를 사용하지 않는다. 취소 응답의 transactionId는 별도 취소 거래 번호로 보존한다.
