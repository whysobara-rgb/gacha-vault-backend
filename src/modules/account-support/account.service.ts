import { recoveryConfig } from '../account-recovery/recovery.policy';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { accountLock, fail, password, plain } from './account-support.policy';
import { validKey } from '../conversions/conversion.policy';
import { ClosureDto } from './account-support.dto';

@Injectable()
export class AccountService {
  constructor(private readonly db: DataSource) {}
  async capabilities(userId: number) {
    const [s] = await this.db.query(
      'SELECT user_id FROM support_staff WHERE user_id=$1 AND active=true',
      [userId],
    );
    return {
      contract: 'ACCOUNT_SUPPORT_V1',
      enabled: true,
      isSupportStaff: !!s,
      closureMode: 'REQUEST_ONLY',
      passwordResetEnabled: !!recoveryConfig(),
    };
  }
  private async protectedAction(
    actor: AuthenticatedUser,
    current: string,
    work: (m: EntityManager, u: any) => Promise<any>,
  ) {
    if (typeof current !== 'string' || current.length > 64)
      throw fail('현재 비밀번호를 확인해주세요', 400);
    const result = await this.db.transaction(async (m) => {
      const u = await accountLock(m, actor);
      if (
        u.password_locked_until &&
        new Date(u.password_locked_until).getTime() > Date.now()
      )
        throw fail(
          '비밀번호 확인이 잠시 제한됐습니다. 15분 후 다시 시도해주세요',
          429,
        );
      if (!u.password)
        throw fail('이메일 비밀번호 계정에서 사용할 수 있습니다', 409);
      if (!(await bcrypt.compare(current, u.password))) {
        await m.query(
          `UPDATE users SET password_check_failures=CASE WHEN password_locked_until IS NOT NULL THEN 1 ELSE password_check_failures+1 END,password_locked_until=CASE WHEN password_locked_until IS NULL AND password_check_failures>=4 THEN clock_timestamp()+interval '15 minutes' ELSE NULL END WHERE id=$1`,
          [u.id],
        );
        await this.event(m, u.id, 'PASSWORD_CHECK_FAILED');
        return { denied: true };
      }
      await m.query(
        'UPDATE users SET password_check_failures=0,password_locked_until=NULL WHERE id=$1',
        [u.id],
      );
      return { data: await work(m, u) };
    });
    if (result.denied) throw fail('현재 비밀번호가 일치하지 않습니다', 400);
    return result.data;
  }
  private async event(m: EntityManager, id: number, event: string) {
    await m.query(
      'INSERT INTO account_security_events(user_id,event) VALUES($1,$2)',
      [id, event],
    );
  }
  async changePassword(
    actor: AuthenticatedUser,
    current: string,
    next: string,
  ) {
    password(next);
    return this.protectedAction(actor, current, async (m, u) => {
      if (await bcrypt.compare(next, u.password))
        throw fail('현재와 다른 비밀번호를 입력해주세요', 400);
      const hash = await bcrypt.hash(next, 10);
      await m.query(
        'UPDATE users SET password=$1,auth_version=auth_version+1,"updatedAt"=clock_timestamp() WHERE id=$2',
        [hash, u.id],
      );
      await this.event(m, u.id, 'PASSWORD_CHANGED');
      return { changed: true, reauthenticate: true };
    });
  }
  async revokeSessions(actor: AuthenticatedUser, current: string) {
    return this.protectedAction(actor, current, async (m, u) => {
      await m.query(
        'UPDATE users SET auth_version=auth_version+1 WHERE id=$1',
        [u.id],
      );
      await this.event(m, u.id, 'SESSIONS_REVOKED');
      return { revoked: true, reauthenticate: true };
    });
  }
  private async summary(m: EntityManager, userId: number) {
    const [r] = await m.query(
      `SELECT "coinBalance"::text AS "balance",(SELECT count(*)::int FROM owned_capsules WHERE order_id IN(SELECT id FROM capsule_orders WHERE user_id=$1) AND status IN('UNOPENED','REFUND_PENDING')) AS "unopened",(SELECT count(*)::int FROM inventory_items WHERE user_id=$1 AND status IN('STORED','SHIPPING_REQUESTED','SHIPPING')) AS "inventory",(SELECT count(*)::int FROM fulfillment_orders WHERE user_id=$1 AND status NOT IN('DELIVERED','CANCELLED'))+(SELECT count(*)::int FROM shipping_requests WHERE user_id=$1 AND status<>'DELIVERED') AS "shipping",(SELECT count(*)::int FROM payment_intents WHERE user_id=$1 AND (status IN('CONFIRMING','UNKNOWN','APPROVED') OR(status IN('PREPARED','AUTHENTICATED') AND expires_at>clock_timestamp()))) AS "payments",(SELECT count(*)::int FROM order_refunds WHERE user_id=$1 AND status<>'SUCCEEDED') AS "refunds",(SELECT count(*)::int FROM support_tickets WHERE user_id=$1 AND status<>'CLOSED') AS "tickets" FROM users WHERE id=$1`,
      [userId],
    );
    if (!r) throw fail('계정을 찾을 수 없습니다', 404);
    return { ...r, balance: Number(r.balance) };
  }
  async closureCheck(actor: AuthenticatedUser) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const summary = await this.summary(m, actor.userId);
      const [active] = await m.query(
        'SELECT id,status,reason,created_at AS "createdAt" FROM account_closure_requests WHERE user_id=$1 AND status=\'REQUESTED\'',
        [actor.userId],
      );
      return {
        mode: 'REQUEST_ONLY',
        summary,
        active: active ?? null,
        automaticDeletionEnabled: false,
      };
    });
  }
  async requestClosure(actor: AuthenticatedUser, key: string, dto: ClosureDto) {
    key = validKey(key);
    const reason = plain(dto.reason, 1, 255);
    if (dto.confirmation !== '탈퇴 요청')
      throw fail('탈퇴 요청 문구를 확인해주세요', 400);
    return this.protectedAction(actor, dto.currentPassword, async (m, u) => {
      const [prior] = await m.query(
        'SELECT * FROM account_closure_requests WHERE user_id=$1 AND idempotency_key=$2',
        [u.id, key],
      );
      if (prior) {
        if (prior.reason !== reason)
          throw fail('같은 요청 번호의 내용이 다릅니다', 409);
        return this.closureReceipt(prior);
      }
      const [active] = await m.query(
        "SELECT id FROM account_closure_requests WHERE user_id=$1 AND status='REQUESTED'",
        [u.id],
      );
      if (active) throw fail('진행 중인 탈퇴 요청을 먼저 확인해주세요', 409);
      const summary = await this.summary(m, u.id);
      const [r] = await m.query(
        `INSERT INTO account_closure_requests(id,user_id,idempotency_key,reason,status,summary) VALUES($1,$2,$3,$4,'REQUESTED',$5::jsonb) RETURNING *`,
        [randomUUID(), u.id, key, reason, JSON.stringify(summary)],
      );
      await this.event(m, u.id, 'CLOSURE_REQUESTED');
      return this.closureReceipt(r);
    });
  }
  private closureReceipt(r: any) {
    return {
      requestId: r.id,
      status: r.status,
      reason: r.reason,
      summary: r.summary,
      createdAt: r.created_at,
      cancelledAt: r.cancelled_at,
      accountDeleted: false,
    };
  }
  async closureByKey(userId: number, key: string) {
    const [r] = await this.db.query(
      'SELECT * FROM account_closure_requests WHERE user_id=$1 AND idempotency_key=$2',
      [userId, validKey(key)],
    );
    if (!r) throw fail('확인된 탈퇴 요청이 없습니다', 404);
    return this.closureReceipt(r);
  }
  async cancelClosure(actor: AuthenticatedUser, id: string) {
    return this.db.transaction(async (m) => {
      await accountLock(m, actor);
      const [r] = await m.query(
        'SELECT * FROM account_closure_requests WHERE user_id=$1 AND id=$2 FOR UPDATE',
        [actor.userId, validKey(id)],
      );
      if (!r) throw fail('탈퇴 요청을 찾을 수 없습니다', 404);
      if (r.status === 'CANCELLED') return this.closureReceipt(r);
      const [updated] = await m.query(
        "UPDATE account_closure_requests SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [id],
      );
      await this.event(m, actor.userId, 'CLOSURE_CANCELLED');
      return this.closureReceipt(updated);
    });
  }
}
