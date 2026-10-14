# 재고 진단 화면 모듈 · 연결 전 개발본

2026-09-16. 서버 SUPPLY_READINESS_V1 응답을 검증·표시하는 의존성 없는 ES 모듈이다. **기존 admin.html의 소스 연결, 실제 사이트 게시, 원본 DB 접근, 실제 관리자 로그인, 브라우저 실기기 검증은 이 변경에 포함되지 않는다.** 원본 사이트를 덮어쓰거나 대체 관리자 페이지를 만들지 않는다. 출시 점수는 올리지 않는다.

## 범위

- 확정 부족·배송 예약·미개봉 잠재 상한·확률상 기대 수량·복구기간 상한을 서로 다른 열로 표시한다.
- 큰 수량은 정수 문자열/BigInt로 처리한다. 기대값으로 지급 개수를 제한한다고 표현하지 않는다.
- 서버 계약·읽기 전용·미출시 플래그·집계 수량·SKU 중복·판정과 데이터의 일치를 검사한다. 실패 시 숫자를 숨기며 0이나 연습 데이터로 대체하지 않는다.
- 이름과 코드는 HTML 이스케이프한다. 이메일·토큰·미등록 필드는 화면에 출력하지 않는다.
- 인증 만료·권한 없음·구버전 API·범위 초과·타임아웃은 별도 오류다. 새 조회 시작 시 이전 숫자를 지운다.
- 서버/계정/세션 변경의 늦은 응답을 버린다. 로그아웃 이벤트에서 invalidate()를 즉시 호출해야 표시 중 자료도 지워진다.
- 읽기 요청만 제공한다. 결제·재고 변경·판매 시작 버튼과 브라우저 자격증명 저장소는 없다.

## 기존 관리자 소스 확보 후 연결

```js
import { mountSupplyReadiness } from './supply-view.mjs';
const panel = mountSupplyReadiness(document.querySelector('#supply-report'), {
  // 기존 인증 API 클라이언트 사용. 실제 API의 응답 envelope를 명시적으로 해제한다.
  // 실패 시 throw { status: response.status }. 성공은 SUPPLY_READINESS_V1 객체만 반환한다.
  request: async (path, options) => authenticatedGetDecoded(path, options),
  // 토큰이 아닌 비밀정보 없는 서버/계정/세션 세대 조합. 비로그인은 null.
  getScope: () => currentAuthenticatedScope(),
});
await panel.refresh();
// 로그아웃, 계정·서버·세션 변경: panel.invalidate();
// 화면 종료: panel.destroy();
```

위 authenticatedGetDecoded/currentAuthenticatedScope는 프로젝트의 실제 인증 클라이언트로 대체하는 어댑터 예시다. 모듈 자체가 로그인하거나 서버의 OWNER 권한 검사를 대신하지 않는다. 모듈을 정적 자산으로 포함하고 기존 CSP·CORS·CSS에 맞춘 뒤 사용자 세션으로 검증해야 한다. 공급처 및 장부가 올바르다는 증거가 없으면 출시 승인으로 사용할 수 없다.

## 검증

`node --test tools/owner-console/supply-view.test.mjs`

검사는 합성 응답의 순수 렌더링·검증과 비동기 조회 상태 제어를 확인한다. DOM 마운트·실제 브라우저·실제 네트워크·실 PG 검사가 아니다. CI 소스·로그를 보존하며 아직 수행하지 않은 검사를 통과로 세지 않는다.
