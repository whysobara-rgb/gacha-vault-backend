import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddAccountRecovery1789486000000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE users ADD email_verified_at timestamptz');
    await r.query(
      `CREATE TABLE auth_challenges(id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,purpose varchar(8) NOT NULL CHECK(purpose IN('RESET','VERIFY')),token_hash char(64) NOT NULL UNIQUE,email_snapshot varchar(255) NOT NULL,auth_version integer NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await r.query(
      'CREATE INDEX auth_challenges_owner ON auth_challenges(user_id,purpose)',
    );
    await r.query(
      `CREATE TABLE auth_mail_jobs(id uuid PRIMARY KEY,kind varchar(16) NOT NULL CHECK(kind IN('RESET','VERIFY','RESET_COMPLETE')),payload text,status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','PROCESSING','SENT','FAILED','CANCELLED')),challenge_id uuid REFERENCES auth_challenges(id) ON DELETE RESTRICT,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6),lease_id uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',provider_id varchar(255),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,CHECK((status IN('SENT','FAILED','CANCELLED'))=(payload IS NULL)))`,
    );
    await r.query(
      'CREATE INDEX auth_mail_pending ON auth_mail_jobs(status,available_at,lease_until)',
    );
    await r.query(
      'CREATE TABLE auth_recovery_limits(bucket_hash char(64) PRIMARY KEY,hits integer NOT NULL,expires_at timestamptz NOT NULL)',
    );
  }
  async down(r: QueryRunner) {
    const [{ n }] = await r.query(
      'SELECT (SELECT count(*) FROM auth_mail_jobs)+(SELECT count(*) FROM auth_challenges)+(SELECT count(*) FROM users WHERE email_verified_at IS NOT NULL) AS n',
    );
    if (Number(n)) throw new Error('Cannot remove account recovery history');
    await r.query(
      'DROP TABLE auth_mail_jobs,auth_challenges,auth_recovery_limits',
    );
    await r.query('ALTER TABLE users DROP email_verified_at');
  }
}
