# GP 전환·복구 · 출시 1단계

## 구현

- 로그인 소유자의 보관 상품 1~100개 선택 → 전환 견적 → 확정 → 내역 → 복구.
- 구매 당시 `capsule_openings.prize`의 기준가·프리미엄 여부·전환 GP를 검증한다. 일반 10%, 프리미엄 100%이며 공개 전환 GP가 일치해야 한다. 0 GP 상품, 구매 당시 정보가 없는 구형 상품, 배송 상품, 잠금 상품은 전환하지 않는다.
- 사용자 행 → 상품 ID 오름차순으로 잠그고, 상품 상태·잔액·원장을 하나의 DB 거래에서 바꾼다. 100개 전환은 부분 적립 없이 전부 성공하거나 전부 취소된다.
- 전환은 사용자별 요청 UUID와 본문 해시로 중복 적립을 방지한다. 복구는 전환 ID로 멱등 처리하며 전체 묶음 상품을 복구한다.
- 전환 시점의 정책과 복구 기한을 저장한다. 가격 변경은 이미 개봉된 상품의 전환 금액을 바꾸지 않는다.
- 전환 이후 GP 사용이 한 번이라도 있으면 복구 불가로 구현했다. 이후 잔액을 다시 늘려도 제한이 해제되지 않는다. GP 사용 범위는 보수적으로 **전환 이후 계정 전체 GP 사용**이다. 출시에 앞서 이 해석을 운영 약관과 일치시켜야 한다.
- DB 원장 INSERT 트리거가 GP 사용 버전을 증가시킨다. 상품 복구를 위한 반대 거래는 일반 GP 사용에서 제외한다. 향후 잔액 변경 기능도 같은 사용자 잠금·원장 규칙을 따라야 한다.
- 기간·상품별 복구 횟수는 환경 설정이며 전환 때 저장한다. 복구 횟수가 남지 않은 상품을 다시 전환할 때 견적에서 복구 불가를 안내한다.

## API

모두 JWT 인증이 필요하다. 기존 응답 포장 규칙을 사용한다.

| 메서드 | 경로 | 역할 |
| --- | --- | --- |
| GET | `/inventory-conversions/capabilities` | 기능 사용 가능 여부·정책 |
| POST | `/inventory-conversions/quote` | `{ inventoryItemIds }`로 견적 확인 |
| POST | `/inventory-conversions` | Idempotency-Key + `{ inventoryItemIds, expectedTotalGP, expectedQuoteVersion }` |
| GET | `/inventory-conversions?page=1&limit=20` | 계정의 전체 전환 목록 |
| GET | `/inventory-conversions/:id` | 상품·GP·복구 가능 여부 |
| POST | `/inventory-conversions/:id/restore` | 해당 묶음 복구, 반복 호출 안전 |

## 서버 설정과 반영

기존 배포 보호 조건을 풀지 않았다. `NODE_ENV`가 development/test이고 `ENABLE_GP_CONVERSION_PREVIEW=true`, `ENABLE_LEGACY_TRANSACTIONS`가 true가 아닐 때만 전환·복구할 수 있다. `GP_RESTORE_WINDOW_HOURS`(1~8760), `GP_RESTORE_MAX_PER_ITEM`(1~20)를 명시해야 한다. 운영 기간·횟수를 임의로 확정하지 않았다. 운영 환경으로 바꾸기 전 검수 완료와 별도 출시 변경이 필요하다.

명시적 마이그레이션 `1789480000000`을 실행해야 한다. 앱 실행이 DB 구조를 자동 변경하지 않는다. 전환 내역이 있으면 이 마이그레이션의 되돌리기를 거부한다. 실제 DB 반영은 하지 않았다.

기존 Render 테스트 상품은 기준가·전환 GP가 0인 불변 스냅샷이다. 해당 상품을 소급해 유상 가치가 있는 상품으로 수정하지 않는다. 서버 검증에는 전환 정책이 맞는 별도의 테스트 상품과 테스트 계정이 필요하다.

## 검증

- `npm run build` 성공.
- `npm test -- --runInBand`: 13개 묶음, 95개 검사 통과.
- 전환 전용 SQL 10개: 전체 7개 마이그레이션을 테스트용 PostgreSQL WASM에서 실제 실행. 일반/프리미엄 계산, 멱등성, 잠금·타인·배송 상태, 기준가 변경, 견적 변경, GP 사용 후 제한, 복구 기간·횟수, 원장 오류 시 롤백, 100개 처리, 계정별 목록.
- 전환 HTTP 5개: 인증, 소유자 출처, 입력 수량/타입/중복, 복구 ID, 비활성 상태.
- `test/conversions.postgres-spec.ts`: 실제 PostgreSQL 다중 연결용 중복 요청·복구·잠금 경합 검사를 추가했으나 이 환경에서 실행하지 못했다. PostgreSQL 설치는 시스템 권한 제약으로 실패했다. WASM은 단일 연결이므로 동시 접속 검증을 대체하지 않는다.
- 기존 CI는 별도 PostgreSQL 작업에서 위 다중 연결 검사를 실행하도록 구성되어 있다. GitHub 반영 전이므로 CI 실행 결과는 없다.

## 배포 상태

GitHub 저장소 검색에서 해당 저장소가 보이지만 `src/modules/orders/orders.service.ts`의 파일 조회가 404를 반환했다. 최신 원격 소스 검증·서버 코드 반영·PR·서버 배포는 완료하지 못했다. 다른 인증 경로나 접근 우회는 시도하지 않았다. 로컬 구현과 배포용 패치를 보존한다.
