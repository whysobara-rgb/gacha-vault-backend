# 관리자 MFA와 민감 작업 재인증 · 서버 개발 인수

2026-09-16. 이 변경은 기존 관리자 사이트의 로그인 UI·실제 인증앱 등록·Render 배포·실 PG·운영 보안 인수 완료를 뜻하지 않는다. 출시 체크리스트 39번을 자동 완료로 바꾸지 않는다. 새 DB 마이그레이션은 없다.

## 보호 범위

AppModule에 전역 인터셉터를 등록한다. 매치된 Nest 컨트롤러/핸들러 경로를 기준으로 /owner, /ops, /staff 하위 HTTP 경로를 보호한다. 호출자의 대소문자·URL 인코딩으로 보호 여부를 결정하지 않는다. 일반 고객 경로는 영향을 받지 않는다. 기존 JWT·DB 세션버전·각 업무 권한 검사에 **추가**하는 계층이며 그것들을 대체하지 않는다. 내부 서비스 직접 호출·CLI·새 비HTTP 전송 경로까지 자동 보호하지 않는다. 새 관리 경로를 다른 prefix로 추가할 때 별도 보안 검토가 필요하다.

production은 preview 플래그와 무관하게 보호한다. 개발/격리 시험에서는 ENABLE_ADMIN_MFA_PREVIEW=true로 명시한다. 미설정/미등록 인자가 있으면 보호 경로를 차단하고 기존 비밀번호 인증만으로 우회하지 않는다. 기존 거래 기능의 production 제한은 해제하지 않는다.

## 인증 방식과 등록 경계

현재 지원은 비밀번호 계정 + RFC6238 SHA1 TOTP(6자리, 30초, 최대 앞뒤 한 단계)이다. 패스키처럼 피싱 방지 인증은 아니다. TOTP 공유키는 서버 비밀 저장소에서 ADMIN_MFA_FACTORS_JSON으로 주입한다. 형식은 version=1, factors 배열의 userId/keyId/secret(정규 Base32, 160비트 이상)이다. 사용자마다 다른 무작위 공유키와 keyId를 써야 한다. 코드·공개 저장소·채팅·브라우저 저장소에 설정이나 키를 올리지 않는다.

최초 등록·교체·분실 복구는 서버 운영자가 본인/대상 계정 및 기기를 확인하는 별도 보호된 경로다. 이번 API에는 키 조회·생성·등록·해제·계정 이메일만으로 복구하는 기능이 없다. 이미 로그인했다는 이유만으로 새 인증기를 등록할 수 없다. 실제 사용자 등록·백업·비밀관리 권한·키 교체·외부 경보와 복구 절차의 실증은 출시 전 남아 있다. 공유키나 keyId가 바뀌면 이전 추가인증 세션은 거절된다. 등록 변경 때 auth_version 증가로 기본 로그인도 회수하고 변경 통지·감사 기록을 별도 승인 경로에서 남겨야 한다.

## API

JWT 로그인 후 POST /admin-security/session에 현재 password와 otp를 보낸다. DB의 실제 관리자/직원 권한, auth_version, 비밀번호 잠금 상태를 확인한다. 성공 시 5분 추가인증 세션 proof를 반환한다. 관리자 조회에 X-Admin-Session 헤더를 함께 사용한다. 같은 JWT 문자열에 바인딩되므로 새 로그인 토큰에는 재인증이 필요하다.

변경 작업 전 POST /admin-security/authorize에 현재 비밀번호와 새 OTP, action={method,path,body,idempotencyKey}를 보낸다. 기존 X-Admin-Session이 있어야 한다. 반환된 X-Admin-Action proof는 60초 이내이며 부모 세션 만료보다 길지 않다. 실제 method/정규 경로/전체 JSON 본문/요청키가 일치하는 한 요청에만 쓸 수 있다. 모든 변경 요청에 적용하며 기존 읽기 전용 환불 견적 POST /owner/refunds/quotes만 추가 session으로 조회한다. query가 있는 변경 요청과 모호한 경로는 거절한다.

OTP는 DB 시각으로 확인하고 사용자 행 잠금 아래 성공 counter를 기록한다. 동시 재사용은 한 번만 성공한다. 실패횟수는 롤백되지 않게 커밋하고 15분 구간 5회 실패 시 15분 잠금을 건다. 로그인 OTP를 즉시 민감 작업 인증에 다시 사용할 수 없으며 다음 코드가 필요하다. 서버 시각/장시간 잠금 대기/비밀번호 검사 뒤의 시간 경계를 재확인한다.

proof는 UUID와 256비트 무작위 값으로 구성한다. DB에는 proof의 해시와 용도·만료·세션/인자 바인딩만 저장한다. 로그·운영 이벤트에는 비밀번호·OTP·키·proof·원래 JWT·작업본문을 저장하지 않는다. 브라우저에서는 메모리만 사용하고 로그아웃 즉시 지운다. DELETE /admin-security/session은 부모 세션을 회수하며 기존 action도 사용할 수 없게 한다. 응답은 no-store다.

## 기존 장부 활용과 실패 처리

operations_requests에 permission=ADMIN_AUTH, response.contract=ADMIN_AUTH_V1로 격리해 상태/세션/일회성 인가를 기록한다. 계정별 rate/counter는 전용 결정적 v5 UUID 키를 쓰며 업무 요청키와 구분한다. 시간순 실패·인증·인가·소비·회수는 operations_events에 비밀 없이 남긴다. 직접 DB 변조까지 막는 별도 불변 감사 저장소는 아니다. 만료 세션 정리·보존 정책은 운영 인수에서 확정한다. 초기 구현은 1인/소규모 관리자용으로 50개 인자 상한이다.

action proof 소비는 인터셉터의 독립 트랜잭션에서 업무 실행 **전에** 커밋한다. 업무 검증/DB 변경이 실패해도 proof는 되살리지 않는다. 따라서 유실 응답은 기존 요청번호의 조회로 확인하고, 재실행 필요 시 새 OTP proof와 **같은 업무 요청키**로 처리해야 한다. 이를 업무 완료나 exactly-once 결제 증명으로 해석하지 않는다. 업무 쪽 멱등성·권한 재확인은 그대로다. 이미 승인된 진행 작업의 결과 저장은 별도 기존 정책을 따른다.

## 시험 범위

admin-security.spec.ts는 RFC 시험 벡터와 키/행위 해시 경계를 검사한다. admin-security.postgres-spec.ts는 임시 DB·실제 JWT·HTTP·모의 PG로 역할, 재사용 경쟁, 실패잠금, 만료/회수/인자 교체, 행위결합, 감사실패, 실제 GP/KRW 환불 경로를 검사한다. 운영 계정·원본 데이터·실제 PG·브라우저 인증앱을 사용하지 않는다. 결과는 해당 커밋의 실행 로그로 확인해야 한다.

참고: https://www.rfc-editor.org/rfc/rfc6238 ; https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html ; https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
