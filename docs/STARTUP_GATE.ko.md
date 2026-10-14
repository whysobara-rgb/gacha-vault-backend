# 실제 서버 시작 경로의 DB 준비 상태 게이트

2026-09-16. 범위: 코드·격리된 CI의 전체 서버 프로세스. 원본 Render DB 백업·실서버 배포·실결제·출시 승인이 아니다.

## 반영한 변경

`npm run start:prod`는 이제 `node tools/release/start.cjs`를 실행한다. 이 진입점은 필수 실행 환경·32자 이상의 JWT 비밀 값·포트 형식을 확인하고, 기존 guarded migration CLI의 `--check-ready`를 호출한다. 체크는 READ ONLY 트랜잭션이며 미적용/알 수 없는 DB 변경, 다른 마이그레이션 실행자의 잠금, DB 연결 실패 시 서버를 시작하지 않는다. 비밀 값의 길이 검사는 강도·회전·권한 검수의 대체물이 아니다.

성공하면 고정된 `dist/main.js`를 별도 Node 프로세스로 시작한다. 임의 실행 파일·추가 실행 옵션은 받지 않는다. 시작 경로는 DB 변경이나 seed를 호출하지 않으며, 백업 확인 환경변수가 남아 있어도 자동 적용하지 않는다. 해당 배포 확인 변수는 앱 자식 프로세스에 전달하지 않는다. SIGTERM/SIGINT는 앱으로 전달하고 종료를 기다린다.

이 변경은 기존 Render 서비스의 시작 설정을 원격으로 바꾸지 않는다. `node dist/main.js` 직접 실행과 기존 TypeORM CLI는 게이트를 우회하므로 승인된 배포 설정을 새 진입점으로 일원화해야 한다. 모든 운영 권한을 가진 사용자의 우회를 기술적으로 봉쇄하는 도구는 아니다.

## 실제 배포 순서와 중단 조건

1. 실제 대상 DB와 원본 백업·별도 복원 검증 증거를 확보한다. 아래 CI의 합성 백업은 대체 증거가 아니다.
2. 대상 서버를 변경할 수 있는 승인된 실행 환경에서 검증 커밋을 빌드한다.
3. `npm run release:plan`으로 대상 지문·예상 변경 목록을 확인한다. `docs/GUARDED_DEPLOYMENT.ko.md`에 기재한 네 가지 승인 값을 확인된 작업 실행에만 제공한다.
4. DB 변경은 별도 단일 실행자로 `npm run release:apply`를 사용한다. 조회용 Render SQL 도구로 실행하거나 읽기 전용 제한을 우회하지 않는다.
5. 해당 서버의 시작 명령은 `node tools/release/start.cjs`, HTTP 점검 경로는 `/health/ready`로 지정한다. 새 코드를 반영하기 전에 기존 시작 명령의 migration/시험 seed 결합을 제거한다.
6. 적용한 커밋, /health/ready, 실제 계정의 기존 주문·잔액·보관함, 관리자 권한을 확인한다. 운영 거래 플래그는 별도의 승인 조건을 만족하기 전에는 해제하지 않는다.

공식 Render 문서에서 pre-deploy command는 유료 web service 등에 제공한다고 명시한다. 현재 무료 서비스를 유료로 바꾸거나 임의의 신규 유료 실행기를 생성하는 작업은 포함하지 않는다. 현재 연결된 도구에는 기존 branch/start command 변경과 원본 pg_dump 실행 기능이 없으므로, 해당 작업은 지원되는 제어 경로와 보호된 비밀정보 설정이 확보되기 전에는 BLOCKED 상태다.

## 이번 전체 프로세스 시험의 인수조건

`tools/release/startup-rehearsal.cjs`는 전용 Docker PostgreSQL 18과 임시 DB 3개를 사용한다. 실제 Render 주소·계정·PG 키는 사용하지 않는다. 시험할 앱은 테스트 모듈로 교체하지 않은 빌드된 AppModule 전체이며 실제 로컬 HTTP로 확인한다.

- 잘못된 시작 옵션·JWT 설정·포트 거절, 빈 DB에 이력 테이블조차 만들지 않고 기동 차단.
- 합성 6개 변경 DB를 pg_dump/pg_restore로 별도 DB에 복원하고 기록 대조.
- 6개 이력에서 기동 차단, 실행 중인 마이그레이션과 충돌하면 기동 차단.
- 실제 CLI의 승인 지문을 이용해 복원한 합성 DB에만 9개 변경 적용 후 /health 및 /health/ready 확인.
- 인증 없는 보관함·관리자 요청 401, 일반 사용자가 JWT에 OWNER를 넣어도 관리자 권한 403, 본인 보관함 조회 200.
- production 환경에 개발 플래그가 켜져 있어도 GP 구매 503, 주문·캡슐·GP 잔액 변화 없음.
- 실행 중 알 수 없는 마이그레이션 이력을 주입하면 readiness 503, 단순 liveness 200, HTTP에 DB 정보 비노출.
- SIGTERM이 앱에 전달되어 HTTP 리스너가 종료됨, 이력 불일치 시 재기동 차단, 이력 복구 후 재시작해도 seed·자동 마이그레이션·잔액 변화 없음.

실제 결과는 최종 커밋의 GitHub Actions 및 `startup-report.json`, `startup-execution.log`로 판정한다. 파일 추가만으로 통과라고 보고하지 않는다. 기존 50명 GP HTTP·카드/GP 혼합 경쟁·수정 전후 대조·마이그레이션 안전장치 시험도 그대로 유지한다.

## 변하지 않은 출시 차단 요소

원본 DB 백업·복원, 실제 서버/DB 업그레이드, PG 계약과 실제 승인·취소·대사, 실물 공급과 구매 시 확률 보장, 본인/연령 확인·보존 정책, 관리자 보안·실기기·스토어 심사는 각각 별도 완료 증거가 필요하다. 서버가 ready라는 것과 거래·출시가 승인됐다는 것은 다르다.

참고 문서: https://render.com/docs/deploys , https://render.com/docs/health-checks , https://typeorm.io/docs/migrations/faking/ .
