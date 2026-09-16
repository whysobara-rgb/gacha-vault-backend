# DB 변경을 서버 시작과 분리하는 배포 도구

2026-09-16. 이 문서는 운영 반영 완료 보고서가 아니다. 현재 Render의 브랜치·시작 명령·DB를 자동 변경하지 않는다. 보호된 원본 백업과 별도 복원 검증은 여전히 실제 배포의 선행 조건이다.

## 변경 내용

`node tools/release/migrations.cjs`의 기본 동작은 읽기 전용 계획 조회다. TypeORM의 migration:show/getExecutedMigrations는 초기 이력 테이블을 만들 수 있어 사용하지 않고, READ ONLY 트랜잭션에서 직접 이력을 조회한다. 이력 없는 빈 DB에서도 테이블을 만들지 않는다.

계획에는 실제 DB·접속 대상·역할·스키마를 묶은 대상 지문과, 그 대상·기존 이력·마이그레이션 함수 코드를 묶은 계획 지문을 표시한다. DB 비밀번호·연결 URL·회원·주문 데이터는 출력하지 않는다. 지문은 변경 감지용이지 백업 검증이나 완전한 빌드 서명을 대체하지 않는다.

적용은 `--apply`를 명시하고 아래 값이 모두 있는 경우에만 허용한다.

- RELEASE_EXPECTED_TARGET: 운영자가 확인한 계획의 targetFingerprint.
- RELEASE_EXPECTED_PLAN: 운영자가 확인한 계획의 planFingerprint.
- RELEASE_BACKUP_VERIFIED=true: 운영자가 실제 원본 백업·별도 복원을 확인했다는 명시적 선언.
- RELEASE_BACKUP_REFERENCE: 승인 기록에 연결할 비밀정보 없는 참조명.

백업 선언은 도구가 백업을 수행하거나 검증했다는 뜻이 아니다. 거짓 선언으로 실행해서는 안 된다. CI에서는 격리된 합성 DB에만 이 선언을 사용한다.

## 안전장치

동일 DB에서 고정된 PostgreSQL 트랜잭션 advisory lock을 사용한다. 배포 커밋이나 계획 지문마다 다른 잠금을 만들지 않는다. 다른 실행자가 잠금을 보유하면 기다리며 자동 재시도하지 않고 MIGRATION_BUSY로 중지한다. 계획 조회 역시 shared lock으로 실행 중 변경과 충돌하면 중지한다.

잠금을 획득한 같은 연결·트랜잭션에서 대상을 재확인하고, 승인된 계획과 현재 이력이 일치할 때만 TypeORM MigrationExecutor를 실행한다. 모든 변경을 한 트랜잭션으로 적용하고 실패하면 되돌린다. 잠금은 commit/rollback으로 해제된다. 다른 도구가 이 잠금 규약을 무시하고 원래 TypeORM CLI나 SQL을 직접 실행하면 보호되지 않는다. 배포 실행 경로를 이 도구로 일원화해야 한다.

알 수 없는·빠진·순서가 바뀐 이력, 관리 이력 없이 기존 테이블이 있는 DB, public 외 스키마, 자동 schema 동기화/마이그레이션 설정 등은 거절한다. 기존 migration 파일의 과거 변경을 검증하는 DB 체크섬 장부는 이번 범위에 포함하지 않는다. 코드 리뷰와 배포 아티팩트 관리가 별도로 필요하다.

## 승인된 실행 환경에서 사용할 순서

1. 정확한 서버/DB와 배포 커밋을 확인하고 원본 백업·복원을 별도로 완료한다. 실제 데이터의 기존 권리·잔액·주문을 보존한다.
2. 동일한 검증 커밋으로 빌드하고 실행 환경의 비밀 저장소에서 DB 설정을 읽는다.
3. `node tools/release/migrations.cjs --plan`을 실행한다. 예상한 대상/미적용 목록인지 확인한다.
4. 위 네 가지 확인 값을 해당 실행에만 전달하고 `node tools/release/migrations.cjs --apply`를 실행한다.
5. 서버 시작 명령은 `node tools/release/migrations.cjs --check-ready && node dist/main.js`로 분리한다. 이 시작 명령은 DB 변경이나 시험 데이터 준비를 실행하지 않는다.
6. 기존 `/health/ready` HTTP 경로와 인증·기존 주문·보관함·관리자 연결을 별도로 확인한다.

`--check-ready`는 계획 조회만 수행하고 미적용 변경이 있으면 실패한다. 실패한 상태에서 서버가 올라오도록 무시하는 옵션은 없다. 이 명령이나 `/health/ready` 통과는 PG 계약·실승인·배송 공급·스토어 인수조건을 만족한다는 뜻이 아니다. 이전 Render 시작 설정은 별도 승인된 제어 경로에서 바꿔야 한다.

## 검증 범위

`test/migration-guard.postgres-spec.ts`는 127.0.0.1의 합성 전용 PostgreSQL에서 실행마다 새로운 DB를 생성·정리한다. 읽기 전용 계획, 승인 누락, 대상 불일치, 오래된 계획, 중복 실행, 전부 롤백, 잠금 해제, 이력 공백, 관리되지 않은 테이블, 실제 6→15개 마이그레이션, CLI 비밀정보 비노출을 검사한다. PostgreSQL 16 일반 CI와 PostgreSQL 18 리허설에서 실행 결과를 확인해야 한다.

카드 예약 시험도 실행별 DB와 결제번호를 분리했다. 기존 전체 테스트 이후 전후 대조를 실행하면 같은 테스트 결제번호가 중복되어 실패했던 문제를 제거한다. 실제 코드의 회귀 검출 assertion이나 DB의 결제번호 UNIQUE 제약은 완화하지 않았다. 원본 ec899c7 결제 코드에서 두 결함이 재현되고 수정 코드에서 7개 검사가 통과해야 한다는 조건을 유지한다.

참고: PostgreSQL 18 explicit locking 및 TypeORM QueryRunner/transaction all 문서. 실제 작업 결과는 해당 커밋의 GitHub Actions 및 첨부된 결과 원본으로 구분해 기록한다.
