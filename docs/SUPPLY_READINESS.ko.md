# 소유자용 실물 지급 의무 진단 V1

2026-09-16. GET `/owner/supply-readiness`는 OWNER 권한을 검사하는 읽기 전용 **진단 API**다. 관리자 웹 화면 반영·실제 Render 배포·실물 재고 확보·자동 판매 제한은 이 변경에 포함되지 않는다. 신규 DB 변경 파일도 없다.

## 계산

- awardedAwaitingDispatch: 현재 PHYSICAL인 STORED/SHIPPING_REQUESTED. 잠금 또는 shipping_enabled=false 때문에 제외하지 않는다.
- creditedShipmentReservations: PREPARING 배송의 활성 상품 수·SKU·RESERVED 배정량과 창고 reserved 합계가 일치할 때만 인정. 동일 예약을 두 번 차감하지 않는다. 불일치 시 0으로 두고 DATA_REVIEW_REQUIRED를 반환한다.
- available = onHand - reserved. awardedShortfall = max(0, awardedAwaitingDispatch - creditedShipmentReservations - available).
- restoreWindowUpperBound: 현재 CONVERTED 상품의 복구 기한이 남은 CONVERTED 전환 기록을 EXISTS로 집계. GP 사용 버전·잔액·횟수에 따른 실제 복구 자격 판단과 다르며 보수적인 상한이다.
- pendingDrawUpperBound: UNOPENED/REFUND_PENDING 캡슐 및 유효한 PREPARED/AUTHENTICATED 카드 예약, 만료와 무관한 CONFIRMING/UNKNOWN/APPROVED 수량의 SKU별 상한. PAID 카드 기록은 주문과 중복 계산하지 않는다. 같은 확률표에서 여러 상품이 SKU를 공유해도 캡슐당 한 번만 센다. 서로 다른 박스의 같은 SKU 노출은 합산한다.
- expectedUnitsIfPendingDrawsComplete: 관련 수량 × 구매/결제 당시 스냅샷 확률의 합. 소수점 6자리 문자열이며 확정 지급 수량이 아니다. 현재 gacha_items가 아니라 저장한 스냅샷과 버전 해시를 검증해 사용한다.
- conservativeShortfall: 확정 미예약 의무 + 복구기간 노출 + 미확정 추첨의 SKU별 상한 - 가용 재고의 양수 부분. 위험 점검용이며 전량 즉시 사입 지시가 아니다. SKU별 상한은 동시에 발생할 수 없는 조합을 포함하므로 합계를 실제 동시 당첨량으로 해석하면 안 된다.

예: 다른 의무가 없는 재고 1대, 미개봉 1,000개, 해당 확률 0.1%라면 기대값 1.000000대와 SKU별 잠재 상한 1,000대를 구분한다. 기대값 1을 이유로 당첨 수량이 1대에 제한된다고 표시하지 않는다.

## 안전장치와 한계

REPEATABLE READ + READ ONLY로 동일 DB 스냅샷과 단일 DB 시각을 사용한다. 조회 직후 재고는 바뀔 수 있으며 이 API가 예약을 잡지는 않는다. OWNER 권한과 auth_version을 DB에서 검사하며 Cache-Control: no-store를 적용한다. 회원·주소·결제키·개별 주문 식별자·인증토큰은 응답에 없다.

입력 집계별 2,000건/SQL별 5초 제한을 둔다. 범위를 넘으면 503으로 중단하고 잘린 결과를 전체 진단으로 표시하지 않는다. 대규모 장부 최적화는 별도다. 미분류·미연결·없는 상품·잘못된 확률표·예약 장부 불일치는 DATA_REVIEW_REQUIRED다.

분류와 SKU는 **현재 카탈로그 기준**이다. 구매 당시 실물 계약의 불변 분류 스냅샷은 현재 모델에 없으므로 과거 분류 변경까지 검증했다고 할 수 없다. 디지털 공급, 반품·교환·재지급, 공급처 확약·불량품·원가·향후 신규 판매도 범위 밖이다. 결과가 NO_SHORTFALL_IN_ASSESSED_SCOPE여도 productionReady는 항상 false다.

예약/차감, 확률 필터링, 판매 중지, 환전 정책 변경을 수행하지 않는다. 실제 공급 보장 모델 승인·구현·동시성 검증이 별도로 남는다.

## 시험

supply-readiness.spec.ts의 수량 계산 10개 검사와 supply-readiness.postgres-spec.ts의 실제 PostgreSQL·JWT·HTTP 10개 검사를 추가한다. 신규 검사는 임시 합성 DB만 사용하며 실제 PG나 원본 Render DB를 건드리지 않는다. 결과는 최종 커밋의 CI 로그로 판정한다. 테스트 파일 추가만으로 통과했다고 간주하지 않는다.

공식 격리 수준 근거: https://www.postgresql.org/docs/18/transaction-iso.html
