import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AccountService } from './account.service';
import { SupportService } from './support.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { ConfigService } from '@nestjs/config';

describe('account security and support SQL lifecycle', () => {
  let db: PGlite,
    accounts: AccountService,
    support: SupportService,
    strategy: JwtStrategy;
  const query = async (s: string, p: any[] = []) =>
    (await db.query(s, p)).rows as any[];
  const password = 'AccountTest123!';
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash(password, 10);
    db = new PGlite();
    await db.waitReady;
    for (const f of readdirSync(join(__dirname, '../../database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      const Cls: any = Object.values(
        require('../../database/migrations/' + f),
      )[0];
      await db.transaction((tx) =>
        new Cls().up({ query: async (s, p) => (await tx.query(s, p)).rows }),
      );
    }
    const adapter = {
      query,
      transaction: async (...args: any[]) =>
        db.transaction((tx) =>
          args[args.length - 1]({
            query: async (s, p) => {
              const result = await tx.query(s, p);
              // Match TypeORM's PostgreSQL raw UPDATE/DELETE result contract.
              return /^\s*(UPDATE|DELETE)\b/i.test(s)
                ? [result.rows, result.affectedRows]
                : result.rows;
            },
          }),
        ),
    } as unknown as DataSource;
    accounts = new AccountService(adapter);
    support = new SupportService(adapter);
    strategy = new JwtStrategy(
      new ConfigService({ JWT_SECRET: 'isolated-account-sql-secret' }),
      {
        findOne: async ({ where }: any) =>
          (
            await query(
              'SELECT id,email,auth_version AS "authVersion" FROM users WHERE id=$1',
              [where.id],
            )
          )[0],
      } as any,
    );
  }, 30000);
  afterAll(async () => db?.close());
  async function user(staff = false) {
    const [u] = await query(
      'INSERT INTO users(email,nickname,password) VALUES($1,$2,$3) RETURNING id,email',
      [randomUUID() + '@example.invalid', staff ? 'staff' : 'customer', hash],
    );
    if (staff)
      await query('INSERT INTO support_staff(user_id) VALUES($1)', [u.id]);
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  async function ticket(u: any) {
    return support.create(u, randomUUID(), {
      category: 'OTHER',
      subject: '상품 문의',
      body: '문의 내용을 확인해주세요',
    });
  }
  it('changes a password, preserves GP and invalidates all old access tokens', async () => {
    const u = await user();
    await query('UPDATE users SET "coinBalance"=500 WHERE id=$1', [u.userId]);
    await strategy.validate({ sub: u.userId, email: 'untrusted' });
    await accounts.changePassword(u, password, 'ChangedPassword456!');
    await expect(
      strategy.validate({ sub: u.userId, email: u.email }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      strategy.validate({ sub: u.userId, email: u.email, av: 1 }),
    ).resolves.toMatchObject({ userId: u.userId, authVersion: 1 });
    const [r] = await query(
      'SELECT password,"coinBalance" AS n FROM users WHERE id=$1',
      [u.userId],
    );
    expect(await bcrypt.compare('ChangedPassword456!', r.password)).toBe(true);
    expect(Number(r.n)).toBe(500);
    expect(
      JSON.stringify(
        await query('SELECT * FROM account_security_events WHERE user_id=$1', [
          u.userId,
        ]),
      ),
    ).not.toContain('Password');
  });
  it('persists failed reauthentication counters and temporarily throttles repeated attempts', async () => {
    const u = await user();
    for (let i = 0; i < 5; i++)
      await expect(
        accounts.revokeSessions(u, 'WrongPassword123'),
      ).rejects.toMatchObject({ status: 400 });
    await expect(accounts.revokeSessions(u, password)).rejects.toMatchObject({
      status: 429,
    });
    await query(
      "UPDATE users SET password_locked_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [u.userId],
    );
    await accounts.revokeSessions(u, password);
    expect(
      (
        await query(
          'SELECT auth_version,password_check_failures FROM users WHERE id=$1',
          [u.userId],
        )
      )[0],
    ).toEqual({ auth_version: 1, password_check_failures: 0 });
  });
  it('rejects unchanged and byte-truncated new passwords without changing session version', async () => {
    const u = await user();
    await expect(
      accounts.changePassword(u, password, password),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      accounts.changePassword(u, password, '가'.repeat(30) + 'A1'),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await query('SELECT auth_version FROM users WHERE id=$1', [u.userId]))[0]
        .auth_version,
    ).toBe(0);
  });
  it('stores one cancellable closure request and never deletes assets or credits', async () => {
    const u = await user();
    await query('UPDATE users SET "coinBalance"=700 WHERE id=$1', [u.userId]);
    const key = randomUUID(),
      dto = {
        currentPassword: password,
        reason: '사용 중단',
        confirmation: '탈퇴 요청',
      };
    const r = await accounts.requestClosure(u, key, dto);
    expect(r.summary.balance).toBe(700);
    expect(r.accountDeleted).toBe(false);
    expect((await accounts.requestClosure(u, key, dto)).requestId).toBe(
      r.requestId,
    );
    await expect(
      accounts.requestClosure(u, randomUUID(), dto),
    ).rejects.toMatchObject({ status: 409 });
    expect((await accounts.closureByKey(u.userId, key)).status).toBe(
      'REQUESTED',
    );
    await accounts.cancelClosure(u, r.requestId);
    await accounts.cancelClosure(u, r.requestId);
    expect((await accounts.closureCheck(u)).active).toBeNull();
    expect(
      (
        await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
          u.userId,
        ])
      )[0].n,
    ).toBe(700);
  });
  it('does not let another account recover or cancel a closure request', async () => {
    const u = await user(),
      other = await user(),
      key = randomUUID(),
      r = await accounts.requestClosure(u, key, {
        currentPassword: password,
        reason: 'test',
        confirmation: '탈퇴 요청',
      });
    await expect(
      accounts.closureByKey(other.userId, key),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      accounts.cancelClosure(other, r.requestId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      accounts.requestClosure(u, key, {
        currentPassword: password,
        reason: 'changed',
        confirmation: '탈퇴 요청',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('creates one ticket and binds its request key to the original content', async () => {
    const u = await user(),
      key = randomUUID(),
      dto = {
        category: 'PAYMENT',
        subject: '구매 확인',
        body: '결제 내용을 확인해주세요',
      },
      r = await support.create(u, key, dto);
    expect((await support.create(u, key, dto)).ticketId).toBe(r.ticketId);
    await expect(
      support.create(u, key, { ...dto, body: 'different' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await support.detail(u, r.ticketId)).messages).toHaveLength(1);
    expect((await support.list(u, { page: 1, limit: 20 })).totalCount).toBe(1);
    await expect(
      support.create(u, randomUUID(), { ...dto, orderId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rejects cross-account reads and client attempts to use staff routes', async () => {
    const u = await user(),
      other = await user(),
      t = await ticket(u);
    await expect(support.detail(other, t.ticketId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      support.reply(other, t.ticketId, randomUUID(), 'spoof'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(support.detail(u, t.ticketId, 0, true)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      support.list(u, { page: 1, limit: 20 }, true),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('keeps ordered replies, unread positions, and staff revocation consistent', async () => {
    const u = await user(),
      staff = await user(true),
      t = await ticket(u),
      key = randomUUID();
    const r = await support.reply(staff, t.ticketId, key, '첫 답변', true);
    await support.reply(staff, t.ticketId, key, '첫 답변', true);
    expect((await support.detail(u, t.ticketId)).ticket).toMatchObject({
      status: 'ANSWERED',
      unread: true,
      lastSequence: 2,
    });
    await support.markRead(u, t.ticketId, 2);
    await support.reply(staff, t.ticketId, randomUUID(), '추가 답변', true);
    await support.markRead(u, t.ticketId, 2);
    expect((await support.detail(u, t.ticketId)).ticket.unread).toBe(true);
    expect((await support.messageByKey(staff, key, true)).messageId).toBe(
      r.messageId,
    );
    await query('UPDATE support_staff SET active=false WHERE user_id=$1', [
      staff.userId,
    ]);
    await expect(
      support.reply(staff, t.ticketId, randomUUID(), '권한 없는 답변', true),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('rejects stale close actions after a reply and permits explicit reopening', async () => {
    const u = await user(),
      staff = await user(true),
      t = await ticket(u);
    await support.reply(staff, t.ticketId, randomUUID(), '답변', true);
    await expect(
      support.status(u, t.ticketId, { status: 'CLOSED', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    const closed = await support.status(u, t.ticketId, {
      status: 'CLOSED',
      expectedVersion: 2,
    });
    await expect(
      support.reply(u, t.ticketId, randomUUID(), '추가'),
    ).rejects.toMatchObject({ status: 409 });
    await support.status(u, t.ticketId, {
      status: 'OPEN',
      expectedVersion: closed.version,
    });
    await support.reply(u, t.ticketId, randomUUID(), '다시 문의');
    expect((await support.detail(u, t.ticketId)).messages).toHaveLength(3);
  });
  it('rolls back a ticket when its first message cannot be saved', async () => {
    const u = await user();
    await query(
      `CREATE FUNCTION fail_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test write failure'; END $$`,
    );
    await query(
      'CREATE TRIGGER fail_message BEFORE INSERT ON support_messages FOR EACH ROW EXECUTE FUNCTION fail_message()',
    );
    try {
      await expect(ticket(u)).rejects.toThrow('test write failure');
      expect((await support.list(u, { page: 1, limit: 20 })).totalCount).toBe(
        0,
      );
    } finally {
      await query('DROP TRIGGER fail_message ON support_messages');
      await query('DROP FUNCTION fail_message()');
    }
  });
  it('lets authorized staff inspect closure requests without completing deletion', async () => {
    const u = await user(),
      staff = await user(true);
    await accounts.requestClosure(u, randomUUID(), {
      currentPassword: password,
      reason: '문의 후 탈퇴',
      confirmation: '탈퇴 요청',
    });
    await expect(
      support.closures(u, { page: 1, limit: 20 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await support.closures(staff, { page: 1, limit: 20 })).completionEnabled,
    ).toBe(false);
  });
  it('fails closed for missing members or revoked JWT versions before a new mutation', async () => {
    const u = await user();
    await accounts.revokeSessions(u, password);
    await expect(ticket(u)).rejects.toMatchObject({ status: 401 });
    await expect(
      strategy.validate({ sub: 9999999, email: 'none' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      strategy.validate({ sub: 1, email: 'none', av: -1 }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
