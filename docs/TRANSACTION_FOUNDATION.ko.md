# 서버 출시 기반 보완

대상: `whysobara-rgb/gacha-vault-backend`, 기준 `630e21a`.
앱 연계: https://github.com/whysobara-rgb/-/pull/1

## 이번 변경

| 발견한 문제 | 반영 내용 |
| --- | --- |
| 클라이언트의 providerId/email만으로 계정 연결·JWT 발급 | 기존 social-login은 항상 410. 계정 조회·변경·토큰 발급 없음 |
| 사용자가 지정한 금액만큼 GP 충전 | 기존 topup은 항상 410. 원장·잔액 변경 없음 |
| 구매·개봉이 단일 API, 검증되지 않은 고정 배송비 | 기존 draws/shipping 변경 API는 기본 차단. development/test + 명시적 ENABLE_LEGACY_TRANSACTIONS=true에서만 허용 |
| 잠금 API 없음 | 인증된 PUT /inventory/:id/lock 구현. 소유권 조건+행 잠금 트랜잭션, STORED만 수정 |
| 잠금 상품을 배송 불가로 처리 | 전환 잠금과 배송 상태 분리. 잠금만으로 배송을 막지 않음 |
| 임의 판매 기준 수량을 실제 수량처럼 표시 | 상세 응답에서 soldStockBaseline 가산 제거. 현재 값은 실제 draws 개수이며 주문 기반 판매 수량은 후속 구현 |
| 환경 누락 시 DB 자동 스키마 변경 | 앱 TypeORM synchronize 항상 false, 마이그레이션 사용 |
| 데모 seed가 기존 이력 삭제·가짜 랭킹 생성 가능 | DB 연결 전에 development/test, ALLOW_DEMO_SEED=true, DB_DATABASE의 _demo/_test 접미사를 모두 확인 |

## 잠금 API

`PUT /inventory/7/lock`, `Authorization: Bearer ...`

요청: `{ "locked": true }` 또는 `{ "locked": false }`.
응답의 data: `{ "inventoryItemId": 7, "isLocked": true, "status": "STORED" }`.

인증 없음 401, 타인/없는 상품 404, 보관중이 아닌 상태 409, 잘못된 ID·boolean 400. 반복 PUT은 원하는 상태를 그대로 유지하며 이미 동일하면 다시 저장하지 않는다. 반전(toggle)을 서버에서 수행하지 않는다. 잠금 상태와 상품 처리 상태는 독립적이다. 전환 API 구현 시 같은 상품 행을 잠그고 isLocked를 검사해야 한다.

Flutter 변경은 이 응답을 확인한 뒤 보관함을 재조회한다. 통신 실패 시 로컬 잠금 성공으로 표시하지 않는다. 배송/전환 완료를 흉내내지 않는다.

## 확인한 범위와 제한

- npm ci --ignore-scripts 성공, 기존 lockfile 유지.
- NestJS build 성공.
- Jest 단위/HTTP 계약 검증 통과. 실제 JWT 인증, 타인 ID, boolean 검증, 잠금 반복 요청, 폐쇄된 인증/GP 경로 및 seed/거래 guard 검증 포함.
- HTTP 테스트는 Nest 라우팅·JWT·ValidationPipe를 실행하지만 DB repository는 테스트 대역이다. PostgreSQL 행 잠금/동시성, 실제 DB 마이그레이션·통합 테스트 완료를 의미하지 않는다.
- 기존 의존성 설치 중 class-validator와 @nestjs/mapped-types의 peer 범위 경고가 발생했다. 이번 기능 테스트와 빌드는 통과했으나 버전 정합성 정리는 별도 작업이다.
- 실제 API 서버에 배포하거나 운영 DB를 변경하지 않았다.

## 배포 전 확인

1. 새 API만 켜도 기존 발급 JWT가 자동 폐기되지는 않는다. 기존 모의 계정/이메일 연결 이력과 접근 로그를 확인하고, 영향 범위에 맞춰 토큰 무효화·계정 복구 방안을 적용한다. 이미 검증되지 않은 경로로 연결된 계정을 임의 삭제하지 않는다.
2. 기존 seed가 만든 계정·당첨 이력·GP 잔액은 자동 삭제하지 않았다. 운영 데이터와 분리·대사한 후 정리해야 한다. soldStockBaseline을 제거했다고 과거 합성 draw까지 제거되는 것은 아니다.
3. `NODE_ENV=production`에서 기존 거래는 항상 차단된다. ENV 플래그만 켜 운영을 재개할 수 없다. 구매/개봉 분리와 다날 검증 구현을 먼저 완료한다.
4. 최초 DB는 기존 마이그레이션 검증 후 생성한다. 자동 synchronize에 기대던 개발 환경도 migration을 적용해야 한다. 운영 DB에서 seed를 실행하지 않는다.
5. 잠금 API 신규 배포가 앱의 잠금 기능 사용에 선행해야 한다. 앱 API_BASE_URL은 배포한 HTTPS 서버로 지정한다.

## 이어서 구현할 거래 구조

현 DB에는 Order/Payment/OwnedCapsule/Refund/Idempotency/확률 버전/GP 출처 소비배분 테이블이 없다. 관리자 모듈·다날 검증·OAuth 검증도 확인되지 않았다.

1. 원주문·가격·확률 버전·상품 전환 GP 스냅샷 설계와 additive migration.
2. 주문 생성과 GP 구매: 중복 키, 가격 서버 검증, GP 원장 차감, 미개봉 캡슐 지급을 같은 트랜잭션에 기록.
3. 다날 승인 조회/콜백 검증 어댑터: PG 거래 ID 유일성, 주문·통화·금액 대조, 승인 후 미지급 대사. 실제 계약/테스트 키 없이 성공 응답을 만들어내지 않음.
4. 미개봉 캡슐 개봉: 서버 CSPRNG, 재고·소유권·결과 원자 저장, 중단 후 같은 결과 조회. 기존 Math.random 기반 legacy 코드를 출시 엔진으로 사용하지 않음.
5. 환불: 캡슐 개봉과 경합 차단, 원결제 취소·원장 보정, PG 불명 결과 대사.
6. 상품 전환/복구: 일반/프리미엄 명시 필드와 획득 당시 스냅샷, GP 출처별 소비 배분, 기한·횟수 검증.

연령 기준, 배송 요금, 일반/프리미엄 분류, 유한 재고형 확률의 구매/개봉 시점, 다날 테스트 계약을 확정해야 운영 거래를 활성화할 수 있다. 해당 내용을 추정해 배포하지 않는다.
