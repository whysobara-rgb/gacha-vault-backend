# Render 테스트 상품·GP 준비

이 도구는 이미 가입한 계정 하나에 기능 검증용 GP 10,000을 한 번 지급한다. 공개 API·회원가입 보너스·운영 충전 기능이 아니다. 계정이나 공용 비밀번호를 생성하지 않는다.

## 데이터

- 박스: `[테스트 전용] 구매·개봉 확인 박스 v1`, 1회 100 GP, 총 구매 한도 10,000회.
- 가상 일반 카드 90%(900,000 PPM), 가상 프리미엄 카드 10%(100,000 PPM).
- 금전 가치·전환 GP는 모두 0. 실제 판매·배송 대상이 아니다.
- 기존 상품·확률·주문은 수정하지 않는다. 같은 이름의 기존 테스트 박스 구성이 달라졌으면 중단한다.
- 트랜잭션 및 advisory lock으로 동시 실행 시에도 박스와 지급이 중복되지 않는다. 계정 잔액은 행 잠금으로 보호하며, 지급 원장과 함께 커밋한다. 재시작 후 잔액을 10,000으로 복구하거나 재충전하지 않는다.

## 사전 조건

먼저 서버 연결 APK에서 본인 테스트 계정으로 회원가입한다. 기존 계정을 그대로 사용해도 된다. 로그인 비밀번호는 Render에 입력하지 않는다.

Render 서버 Environment에 아래 두 변수를 추가한다.

| 이름 | 값 |
|---|---|
| ENABLE_TEST_FIXTURES | true |
| TEST_FIXTURE_EMAIL | 앱에서 가입한 테스트 계정의 정확한 이메일 |

기존 NODE_ENV=test, ENABLE_GP_ORDER_PREVIEW=true, ENABLE_LEGACY_TRANSACTIONS=false를 유지한다. production/development 환경에서는 이 도구가 실패한다.

## 실행

무료 Web Service에는 shell이 없으므로 Settings의 Start Command를 다음과 같이 설정해 배포한다. DB 구조 갱신 성공 후 fixture를 준비하고, 성공한 경우에만 서버를 시작한다.

```sh
node node_modules/typeorm/cli.js migration:run -d dist/data-source.js && node dist/database/seeds/prepare-preview.js && node dist/main.js
```

성공 로그: `TEST_FIXTURE_READY gachaId=... grant=created` 또는 재실행 시 `grant=already-recorded`.
실패하면 계정의 선행 가입, 환경변수, DB 마이그레이션 상태를 확인한다. 실패 시 부분 지급·부분 상품 등록은 롤백된다. 상세 드라이버 오류나 비밀번호를 로그에 출력하지 않는다.

성공 후 Start Command를 원래 명령으로 복원하고 ENABLE_TEST_FIXTURES/TEST_FIXTURE_EMAIL을 제거하면 이후 시작에 fixture 실행이 필요 없다.

```sh
node node_modules/typeorm/cli.js migration:run -d dist/data-source.js && node dist/main.js
```

## 인수 검증

로그인 → 잔액 및 테스트 박스 확인 → 확률 동의 → 100 GP 구매 → 미개봉 캡슐 확인 → 개봉 → 보관함 상품 확인 순서로 진행한다. 서버 거래 원장·캡슐·지급 수량도 함께 대조해야 한다. 테스트 GP 지급만으로 실제 결제나 배송 검증이 완료된 것은 아니다. 기존 demo seed는 실행하지 않는다.
