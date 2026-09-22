# 원본 DB를 변경하지 않는 암호화 내보내기

2026-09-16. 이 도구 추가와 CI 합성 복원은 실제 Render DB 백업 완료를 뜻하지 않는다. 운영 DB 접속은 기존 읽기 전용 MCP를 우회하지 않고, 사용자가 승인한 별도 실행 환경에서만 수행한다. 기존 서버 설정·결제 게이트를 바꾸지 않는다.

## 운영자 실행 경로

Linux/macOS 또는 Windows의 별도 승인된 WSL 환경에서 Node22, 해당 저장소의 잠금 의존성, PostgreSQL18 클라이언트, age가 필요하다. Windows 네이티브 파일 ACL을 가정하지 않아 win32 실행은 거절한다. 새 유료 서버·DB는 생성하지 않는다.

사용자 계정 비밀번호나 DB 비밀번호를 채팅·소스·명령행 인수에 넣지 않는다. 승인된 실행 환경에 DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE를 보호된 환경변수로 설정한다. 실제 대상은 Render 콘솔에서 확인한 외부 호스트여야 한다. 원격 연결은 Node TLS 인증서 검증 및 libpq verify-full/system CA를 요구하며 실패할 때 이를 끄는 옵션은 없다. 같은 PC의 권한 있는 프로세스는 환경변수를 볼 수 있으므로 PC와 계정 보호는 별도 조건이다.

1. 저장소 밖 사용자 소유의 0700 디렉터리를 준비한다. 공유·Git 동기화 폴더는 사용하지 않는다. 가능하면 암호화된 로컬 디스크를 사용한다.
2. 사용자 관리 아래 age 키를 준비한다. 공개 recipient만 BACKUP_AGE_RECIPIENT에 넣는다. 개인 키는 별도 보호하고 공개 저장소/Actions secrets/대화에 올리지 않는다. CI 키는 매번 생성되는 폐기용이다.
3. `node tools/release/protected-backup.cjs --plan`으로 읽기 전용 대상 지문을 확인한다.
4. 확인한 지문을 BACKUP_EXPECTED_TARGET, 보호된 폴더를 BACKUP_DIRECTORY에 설정한 승인된 실행에서 `--create`를 사용한다.
5. 생성한 `.dump.age`와 `.json` manifest를 함께 보존한다. 표준 출력에는 요약·암호문 체크섬만 있고 원본 행·DB 비밀번호·경로는 출력하지 않는다.
6. 같은 암호문을 사용자 관리 개인 키로 복호화해, 원본과 분리된 빈 DB로만 복원 검증한다. 기존 DB 위에 복원하지 않는다. 복원 대상의 소유자·연결 정보 확인과 승인, 별도 실행이 필요하다. pg_restore --no-owner/--no-acl을 시험에 사용했으므로 운영 역할/권한 복원은 별도로 확인한다.
7. 원본 백업 SHA256·보관 위치·키 복구·별도 복원 결과·만료를 보호된 기록에 남긴 뒤에만 배포의 BACKUP_VERIFIED 선언을 한다. 이 도구는 그 선언을 자동으로 설정하지 않는다.

## 안전성과 범위

네이티브 pg_dump custom 형식을 age로 파이프 암호화한다. 암호화되지 않은 평문 dump 파일을 디스크에 저장하거나 터미널 출력으로 노출하지 않는다. 암호문과 건수 등 메타데이터 manifest만 보호된 폴더에 저장한다. 프로세스 파이프와 메모리에는 원본 바이트가 존재하므로 신뢰할 수 있는 OS·사용자 계정이 전제다. 암호화 프로세스에는 DB 비밀번호를 전달하지 않는다. 원본은 READ ONLY REPEATABLE READ로 읽고 pg_export_snapshot을 pg_dump --snapshot에 전달하므로 manifest 테이블 건수와 덤프가 같은 MVCC 시점을 사용한다. 시퀀스는 PostgreSQL 특성상 MVCC 대상이 아니므로 계속 쓰는 서비스의 모든 상태가 한 물리 시점으로 고정됐다는 뜻은 아니다.

키 형식·보호 폴더·대상 확인이 틀리거나 export/encryption이 실패하면 성공 manifest를 만들지 않는다. 원시 오류·경고는 비공개 내용일 수 있어 콘솔에 복사하지 않는다. 도구가 stderr를 출력한 경우는 수동 비공개 검토 대상으로 중단한다. 강제 프로세스 종료 시 .partial 암호문은 남을 수 있으며 복원 가능한 완료 백업으로 취급하지 않는다. 원본 DB는 변경하지 않는다.

단일 DB 내보내기이며 클러스터 역할·외부 상품 이미지·외부 비밀 설정·PG 정산 데이터를 백업하지 않는다. PITR·지속 백업·보존 정책·다른 장소의 복제·키 복구 검증도 대체하지 않는다. manifest는 체크섬 기반 변경 감지 정보이지 서명된 증명서가 아니며, 건수 일치만으로 모든 값이 같다는 증명이 되지 않는다. 생성 결과는 항상 restoreVerified=false이며, 실제 복원 증거는 별도다.

## 시험

별도 워크플로는 PostgreSQL18 컨테이너와 합성 데이터만 사용한다. 기존 앱의 6개 migration으로 시험 DB를 만들고 보호된 export 함수에 컨테이너 pg_dump 실행 어댑터를 주입한다. 실제 TLS Render 호스트와 호스트 설치 pg_dump CLI 전체의 운영 접속은 시험하지 않는다.

암호화 후 개인 키로 별도 빈 시험 DB에 복원해 시험 회원 행의 실제 값과 전체 테이블 건수를 대조한다. export 시작 후 별도 연결에서 새 행을 추가해도 기존 snapshot의 건수/덤프가 일치하는지 검사한다. 잘못된 대상·폴더·키, 암호문 변조, export 실패 정리·CLI 비밀 비노출도 검사한다. CI에는 요약 JSON만 업로드하고 dump·암호문·개인 키는 업로드하지 않으며 임시 DB/파일은 정리한다. 합성 검증 통과를 원본 백업이나 운영 배포 점수로 대체하지 않는다.

공식 근거: https://www.postgresql.org/docs/18/app-pgdump.html , https://www.postgresql.org/docs/18/libpq-ssl.html , https://render.com/docs/postgresql-backups , https://github.com/FiloSottile/age .
