import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  accountLock,
  fail,
  password,
} from '../account-support/account-support.policy';
import {
  accepted,
  bucket,
  emailInput,
  Purpose,
  recoveryConfig,
  requireRecovery,
  seal,
  tokenHash,
  unseal,
} from './recovery.policy';
import { DeliveryError, Mail, RecoveryMailer } from './recovery.mailer';
const invalid = () =>
  fail('만료되었거나 사용할 수 없는 링크입니다. 다시 요청해주세요', 400);
@Injectable()
export class RecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly db: DataSource,
    private readonly mailer: RecoveryMailer,
  ) {}
  onModuleInit() {
    if (recoveryConfig()) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => undefined);
      }, 5000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  capabilities() {
    return {
      contract: 'ACCOUNT_RECOVERY_V1',
      enabled: !!recoveryConfig(),
      resetMinutes: 15,
      verificationMinutes: 30,
      delivery: 'EMAIL',
      identityVerificationEnabled: false,
    };
  }
  async status(a: AuthenticatedUser) {
    const [u] = await this.db.query(
      'SELECT email,email_verified_at,auth_version FROM users WHERE id=$1',
      [a.userId],
    );
    if (!u || u.auth_version !== (a.authVersion ?? 0))
      throw fail('다시 로그인해주세요', 401);
    return {
      email: u.email,
      verified: !!u.email_verified_at,
      verifiedAt: u.email_verified_at,
    };
  }
  private async rate(
    m: EntityManager,
    hash: string,
    limit: number,
    minutes: number,
  ) {
    const [r] = await m.query(
      `INSERT INTO auth_recovery_limits(bucket_hash,hits,expires_at) VALUES($1,1,clock_timestamp()+$3*interval '1 minute') ON CONFLICT(bucket_hash) DO UPDATE SET hits=CASE WHEN auth_recovery_limits.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(auth_recovery_limits.hits+1,$2+1) END,expires_at=CASE WHEN auth_recovery_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+$3*interval '1 minute' ELSE auth_recovery_limits.expires_at END RETURNING hits`,
      [hash, limit, minutes],
    );
    return r.hits <= limit;
  }
  private async queue(
    m: EntityManager,
    kind: string,
    payload: any,
    key: Buffer,
  ) {
    const id = randomUUID();
    await m.query(
      'INSERT INTO auth_mail_jobs(id,kind,payload) VALUES($1,$2,$3)',
      [id, kind, seal(payload, key, id)],
    );
    return id;
  }
  async requestReset(value: string) {
    const c = requireRecovery(),
      email = emailInput(value);
    await this.db.transaction(async (m) => {
      const global = await this.rate(m, bucket('global', c.key), 300, 1),
        address = await this.rate(m, bucket(email.toLowerCase(), c.key), 3, 15);
      if (global && address) await this.queue(m, 'RESET', { email }, c.key);
    });
    return accepted;
  }
  async requestVerification(a: AuthenticatedUser) {
    const c = requireRecovery();
    await this.db.transaction(async (m) => {
      const u = await accountLock(m, a);
      const global = await this.rate(m, bucket('global', c.key), 300, 1),
        address = await this.rate(
          m,
          bucket(u.email.toLowerCase(), c.key),
          3,
          15,
        );
      if (global && address)
        await this.queue(
          m,
          'VERIFY',
          { email: u.email, userId: u.id, authVersion: u.auth_version },
          c.key,
        );
    });
    return accepted;
  }
  async complete(purpose: Purpose, token: string, next?: string) {
    const c = requireRecovery(),
      hash = tokenHash(token);
    if (purpose === 'RESET') password(next);
    const [owner] = await this.db.query(
      'SELECT user_id FROM auth_challenges WHERE token_hash=$1 AND purpose=$2',
      [hash, purpose],
    );
    if (!owner) throw invalid();
    return this.db.transaction(async (m) => {
      const [u] = await m.query(
        'SELECT id,email,password,provider,auth_version,email_verified_at FROM users WHERE id=$1 FOR UPDATE',
        [owner.user_id],
      );
      const [t] = await m.query(
        'SELECT *,expires_at>clock_timestamp() AS live FROM auth_challenges WHERE token_hash=$1 AND purpose=$2 FOR UPDATE',
        [hash, purpose],
      );
      if (
        !u ||
        !t ||
        !t.live ||
        t.used_at ||
        t.email_snapshot !== u.email ||
        t.auth_version !== u.auth_version ||
        (purpose === 'RESET' && (!u.password || u.provider !== 'EMAIL'))
      )
        throw invalid();
      if (purpose === 'RESET') {
        const encoded = await bcrypt.hash(next, 10);
        await m.query(
          'UPDATE users SET password=$2,auth_version=auth_version+1,email_verified_at=COALESCE(email_verified_at,clock_timestamp()),password_check_failures=0,password_locked_until=NULL,"updatedAt"=clock_timestamp() WHERE id=$1',
          [u.id, encoded],
        );
        await m.query(
          'UPDATE auth_challenges SET used_at=COALESCE(used_at,clock_timestamp()) WHERE user_id=$1',
          [u.id],
        );
        await this.queue(
          m,
          'RESET_COMPLETE',
          {
            email: u.email,
            mail: {
              from: c.from,
              to: u.email,
              subject: '[가치가차] 비밀번호가 변경됐습니다',
              text:
                '비밀번호 재설정이 완료되어 기존 로그인 세션이 종료됐습니다. 본인이 변경하지 않았다면 고객센터에 문의하고 다시 비밀번호를 재설정해주세요.\n' +
                c.origin +
                '/#forgot-password',
            },
          },
          c.key,
        );
      } else {
        await m.query(
          'UPDATE users SET email_verified_at=COALESCE(email_verified_at,clock_timestamp()) WHERE id=$1',
          [u.id],
        );
        await m.query(
          "UPDATE auth_challenges SET used_at=COALESCE(used_at,clock_timestamp()) WHERE user_id=$1 AND purpose='VERIFY'",
          [u.id],
        );
      }
      await m.query(
        'INSERT INTO account_security_events(user_id,event) VALUES($1,$2)',
        [u.id, purpose === 'RESET' ? 'PASSWORD_RESET' : 'EMAIL_VERIFIED'],
      );
      return purpose === 'RESET'
        ? { changed: true, reauthenticate: true }
        : { verified: true };
    });
  }
  private async finish(
    id: string,
    lease: string,
    status: string,
    provider: string | null = null,
  ) {
    await this.db.query(
      'UPDATE auth_mail_jobs SET status=$3,payload=NULL,lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp(),provider_id=$4 WHERE id=$1 AND lease_id=$2',
      [id, lease, status, provider],
    );
  }
  private async prepare(job: any) {
    const c = requireRecovery(),
      p = unseal(job.payload, c.key, job.id);
    if (p.mail) return p.mail as Mail;
    // User locks precede job/challenge locks in every path.
    return this.db.transaction(async (m) => {
      const [u] = await m.query(
        'SELECT id,email,password,provider,auth_version,email_verified_at FROM users WHERE email=$1 FOR UPDATE',
        [p.email],
      );
      const [j] = await m.query(
        'SELECT *,expires_at>clock_timestamp() AS live FROM auth_mail_jobs WHERE id=$1 AND lease_id=$2 FOR UPDATE',
        [job.id, job.lease_id],
      );
      if (!j || !j.live) return null;
      const latest = unseal(j.payload, c.key, j.id);
      if (latest.mail) return latest.mail as Mail;
      if (
        !u ||
        (job.kind === 'RESET' && (!u.password || u.provider !== 'EMAIL')) ||
        (job.kind === 'VERIFY' &&
          (u.id !== p.userId ||
            u.auth_version !== p.authVersion ||
            u.email_verified_at))
      )
        return null;
      const token = randomBytes(32).toString('hex'),
        challenge = randomUUID(),
        minutes = job.kind === 'RESET' ? 15 : 30,
        link =
          c.origin +
          '/#auth-' +
          (job.kind === 'RESET' ? 'reset' : 'verify') +
          '/' +
          token,
        mail: Mail = {
          from: c.from,
          to: u.email,
          subject:
            job.kind === 'RESET'
              ? '[가치가차] 비밀번호 재설정'
              : '[가치가차] 이메일 주소 확인',
          text: `${job.kind === 'RESET' ? '비밀번호 재설정' : '이메일 주소 확인'}을 요청하셨습니다. 아래 링크에서 직접 확인해주세요. 이 링크는 ${minutes}분 동안 한 번만 사용할 수 있습니다.\n\n${link}\n\n본인이 요청하지 않았다면 이 메일을 무시해주세요. 비밀번호·결제 정보는 메일로 요구하지 않습니다.`,
        };
      await m.query(
        "INSERT INTO auth_challenges(id,user_id,purpose,token_hash,email_snapshot,auth_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 minute')",
        [
          challenge,
          u.id,
          job.kind,
          tokenHash(token),
          u.email,
          u.auth_version,
          minutes,
        ],
      );
      await m.query(
        'UPDATE auth_mail_jobs SET challenge_id=$3,payload=$4 WHERE id=$1 AND lease_id=$2',
        [job.id, job.lease_id, challenge, seal({ ...p, mail }, c.key, job.id)],
      );
      return mail;
    });
  }
  async tick() {
    if (this.running || !recoveryConfig()) return false;
    this.running = true;
    try {
      const job = await this.db.transaction(async (m) => {
        await m.query(
          "UPDATE auth_mail_jobs SET status='FAILED',payload=NULL,lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE status IN('PENDING','PROCESSING') AND (expires_at<=clock_timestamp() OR attempts>=6) AND (lease_until IS NULL OR lease_until<=clock_timestamp())",
        );
        await m.query(
          "DELETE FROM auth_recovery_limits WHERE expires_at<clock_timestamp()-interval '1 day'",
        );
        const [j] = await m.query(
          "SELECT * FROM auth_mail_jobs WHERE attempts<6 AND expires_at>clock_timestamp() AND ((status='PENDING' AND available_at<=clock_timestamp()) OR(status='PROCESSING' AND lease_until<=clock_timestamp())) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
        );
        if (!j) return null;
        const lease = randomUUID();
        const [claimed] = await m.query(
          "WITH claimed AS (UPDATE auth_mail_jobs SET status='PROCESSING',attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1 RETURNING *) SELECT * FROM claimed",
          [j.id, lease],
        );
        return claimed;
      });
      if (!job) return false;
      try {
        const mail = await this.prepare(job);
        if (!mail) {
          await this.finish(job.id, job.lease_id, 'CANCELLED');
          return true;
        }
        const [current] = await this.db.query(
          'SELECT j.expires_at>clock_timestamp() AS live,j.challenge_id,c.used_at,c.expires_at>clock_timestamp() AS token_live,c.auth_version,u.auth_version AS current_version FROM auth_mail_jobs j LEFT JOIN auth_challenges c ON c.id=j.challenge_id LEFT JOIN users u ON u.id=c.user_id WHERE j.id=$1 AND j.lease_id=$2',
          [job.id, job.lease_id],
        );
        if (
          !current ||
          !current.live ||
          (current.challenge_id &&
            (current.used_at ||
              !current.token_live ||
              current.auth_version !== current.current_version))
        ) {
          await this.finish(job.id, job.lease_id, 'CANCELLED');
          return true;
        }
        const providerId = await this.mailer.send(job.id, mail);
        await this.finish(job.id, job.lease_id, 'SENT', providerId);
      } catch (e) {
        if (e instanceof DeliveryError && e.retryable && job.attempts < 6)
          await this.db.query(
            "UPDATE auth_mail_jobs SET status='PENDING',lease_id=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND lease_id=$2",
            [job.id, job.lease_id],
          );
        else await this.finish(job.id, job.lease_id, 'FAILED');
      }
      return true;
    } finally {
      this.running = false;
    }
  }
}
