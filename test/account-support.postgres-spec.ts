import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { AccountService } from '../src/modules/account-support/account.service';
import { SupportService } from '../src/modules/account-support/support.service';
const db = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 8, statement_timeout: 10000 },
});
describe('multi-connection account/support races', () => {
  let accounts: AccountService, support: SupportService, hash: string;
  const password = 'ConcurrentPassword123';
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB required');
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    hash = await bcrypt.hash(password, 10);
    accounts = new AccountService(db);
    support = new SupportService(db);
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
  });
  async function user(staff = false) {
    const [u] = await db.query(
      'INSERT INTO users(email,nickname,password) VALUES($1,$2,$3) RETURNING id,email',
      [randomUUID() + '@example.invalid', 'race', hash],
    );
    if (staff)
      await db.query('INSERT INTO support_staff(user_id) VALUES($1)', [u.id]);
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  it('creates one inquiry across six identical submissions', async () => {
    const u = await user(),
      key = randomUUID(),
      dto = { subject: '중복 접수', body: '원래 문의', category: 'OTHER' };
    const r = await Promise.all(
      Array.from({ length: 6 }, () => support.create(u, key, dto)),
    );
    expect(new Set(r.map((x) => x.ticketId)).size).toBe(1);
    expect((await support.detail(u, r[0].ticketId)).messages).toHaveLength(1);
  });
  it('serializes staff replies and keeps stale close from hiding a new answer', async () => {
    const u = await user(),
      a = await user(true),
      b = await user(true),
      t = await support.create(u, randomUUID(), {
        subject: '답변 경합',
        body: '문의',
        category: 'OTHER',
      });
    await Promise.all([
      support.reply(a, t.ticketId, randomUUID(), '첫 운영자 답변', true),
      support.reply(b, t.ticketId, randomUUID(), '둘째 운영자 답변', true),
    ]);
    expect(
      (await support.detail(u, t.ticketId)).messages.map((x) => x.sequence),
    ).toEqual([1, 2, 3]);
    await expect(
      support.status(u, t.ticketId, { status: 'CLOSED', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('allows only one current-password action after a session version changes', async () => {
    const u = await user();
    const results = await Promise.allSettled([
      accounts.changePassword(u, password, 'NewPassword456'),
      accounts.revokeSessions(u, password),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await db.query('SELECT auth_version FROM users WHERE id=$1', [u.userId])
      )[0].auth_version,
    ).toBe(1);
  });
  it('accepts one active closure request without erasing GP', async () => {
    const u = await user();
    await db.query('UPDATE users SET "coinBalance"=500 WHERE id=$1', [
      u.userId,
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        accounts.requestClosure(u, randomUUID(), {
          currentPassword: password,
          reason: '정리 요청',
          confirmation: '탈퇴 요청',
        }),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      Number(
        (
          await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
            u.userId,
          ])
        )[0].n,
      ),
    ).toBe(500);
  });
});
