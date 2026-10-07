# 가치가차 (Gacha Vault) API

실물 상품(명품 시계·가방, 애플 기기, 가전, 뷰티, 식품, 기프티콘) 랜덤박스 앱 **가치가차**의 백엔드입니다.
NestJS 10 + TypeORM + PostgreSQL. 클라이언트는 Flutter 앱(`whysobara-rgb/-`)입니다.

## 실행

```bash
npm install
cp .env.example .env          # DB 접속 정보, JWT_SECRET 설정
npm run migration:run         # 스키마 생성/갱신
npm run seed                  # 데모 박스 8종 + 데모 계정 (demo@gachivault.com / Password1)
npm run start:dev             # http://localhost:3000, Swagger: /docs
```

테스트: `npm test` (확률·천장·출석·충전 한도 로직 단위 테스트, 실제 뽑기 엔진 시뮬레이션 포함)

## 뽑기 규칙

| 규칙 | 내용 | 위치 |
| --- | --- | --- |
| 난수 | `crypto.randomInt` 기반 가중치 추첨 (정수 가중치, 오차 없음) | `modules/draws/draw-engine.ts` |
| 천장 | 박스별 `pityThreshold`회 연속 SSR이 안 나오면 다음 뽑기 SSR 확정. 유저·박스별로 카운트 | `gacha_pity_counters` |
| 10+1 | 한 번에 10회 결제할 때마다 1회 무료 보너스 뽑기 | `MULTI_DRAW_BONUS` |
| 포인트 전환 | 보관 중인 아이템을 예상 가치의 80% GP로 전환 (배송 불가 상태가 됨) | `ITEM_EXCHANGE_RATE` |
| 출석체크 | 7일 주기 100/100/150/150/200/200/500 GP, 하루 빠지면 1일차부터 | `ATTENDANCE_REWARDS` |
| 월 충전 한도 | 유저가 직접 설정. 낮추면 즉시, 올리거나 해제하면 7일 뒤 적용 | `modules/wallet/topup-limit.ts` |

경제 파라미터는 모두 `src/common/constants/economy.constant.ts`에 있습니다. 확률 공시 API로 그대로 노출되는 값이므로 환경 변수가 아니라 코드로 관리합니다.

### 환급률(기대 가치)과 확률 설계

박스별 확률은 손으로 정하지 않고 시드에서 **목표 환급률로 역산**합니다(`solveTierWeights`).
- `TARGET_PAYOUT_RATIO = 0.8`: 천장을 포함해 1회 뽑기 기대 상품가치가 가격의 80%, 10+1은 88%.
- 천장은 각 박스 SSR의 약 1/3을 책임지도록 설정(안전망 역할, 대부분의 SSR은 자연 당첨).
- 시드는 `뽑기 → 포인트 전환`의 GP 회수율이 1 이상이면(무한 수익 버그) 실행을 거부합니다.

1 GP = 1원으로 가정합니다(배송비 3,000 GP = 3,000원).

## 추가된 API

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/gachas/:id/odds` | 확률 공시: 아이템/등급별 확률, 천장·실질 SSR 확률, 10+1, 전환율, 기대 가치 |
| GET | `/gachas/:id/pity` | 내 천장 진행도 (`remaining`: SSR 확정까지 남은 횟수) |
| POST | `/draws` | 응답에 `bonusCount`, `totalResults`, `highestRarity`, `pity`, 결과별 `isPity`/`isBonus`/`exchangeValue` 추가 |
| POST | `/inventory/exchange` | 보관함 아이템 포인트 전환 |
| GET/POST | `/rewards/attendance` | 출석체크 현황 / 출석 |
| GET/PUT | `/wallet/limit` | 월 충전 한도 조회 / 설정 |

`GET /inventory`는 기본적으로 전환(EXCHANGED)된 아이템을 제외합니다(`?status=EXCHANGED`로 조회 가능). 포인트 내역에는 `reason`(TOPUP, DRAW, EXCHANGE, ATTENDANCE, SHIPPING_FEE, SIGNUP_BONUS, ADJUSTMENT)이 추가됐습니다.

신규 응답 코드: `10007` 월 충전 한도 초과, `10008` 오늘 이미 출석함.

## 출시 전 체크리스트

랜덤박스는 공정거래위원회 제재 이력이 있는 업종이라, 아래 항목은 매출과 직결되는 리스크입니다.

- [ ] **가짜 판매량 제거**: `gachas.soldStockBaseline`은 실제로 팔리지 않은 수량을 판매된 것처럼 더해 "OOO/전체"를 표시합니다. `totalStock`도 판매를 실제로 막지 않습니다. 실제 재고 기반으로 바꾸거나 표시를 내려야 합니다.
- [ ] **가짜 랭킹/당첨 피드 제거**: 시드가 만드는 8개 데모 계정과 합성 뽑기 이력이 `/rankings/*`(실시간 당첨 포함)에 노출됩니다. 운영 DB에서는 시드를 돌리지 마세요.
- [ ] **GP 현금 환급 금지**: GP는 앱 안에서만 사용. 아이템→GP 전환에 더해 GP→현금 출금이 생기면 사행성 문제로 번질 수 있습니다. 포인트 전환 기능 자체도 출시 전 법률 검토를 받으세요.
- [ ] **상품 정보·확률 고지**: 박스 상세 화면에서 `/gachas/:id/odds` 내용을 노출하고, 상품별 실제 시세에 맞게 `estimatedValue`를 갱신하세요(현재 값은 데모용).
- [ ] **결제 연동**: `POST /wallet/topup`은 데모용입니다. PG 웹훅으로 교체하고, 미성년자 결제 취소·청약철회 정책을 정하세요.
- [ ] **상품 이미지 라이선스** 확인.
