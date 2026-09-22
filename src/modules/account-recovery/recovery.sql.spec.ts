import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { RecoveryService } from './recovery.service';
import { DeliveryError } from './recovery.mailer';
import { recoveryConfig, seal, unseal } from './recovery.policy';
describe('email verification and reset SQL lifecycle', () => {
  let db: PGlite, s: RecoveryService;
  const env = { ...process.env },
    send = jest.fn();
  const query = async (sql: string, p: any[] = []) =>
    (await db.query(sql, p)).rows as any[];
  beforeAll(async () => {
    Object.assign(process.env, {
      ENABLE_ACCOUNT_RECOVERY: 'true',
      AUTH_MAIL_DELIVERY_ENABLED: 'true',
      AUTH_MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      AUTH_PUBLIC_WEB_ORIGIN: 'https://gachi.example',
      AUTH_MAIL_FROM: 'accounts@gachi.example',
      RESEND_API_KEY: 'test_key_never_sent',
    });
    db = new PGlite();
    await db.waitReady;
    for (const f of readdirSync(join(__dirname, '../../database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      const C: any = Object.values(
        require('../../database/migrations/' + f),
      )[0];
      await db.transaction((tx) =>
        new C().up({ query: async (sql, p) => (await tx.query(sql, p)).rows }),
      );
    }
    const a = {
      query,
      manager: { query },
      transaction: async (...args: any[]) =>
        db.transaction((tx) =>
          args.at(-1)({
            query: async (sql, p) => {
              const result = await tx.query(sql, p);
              // Match TypeORM's PostgreSQL raw UPDATE/DELETE result contract.
              return /^\s*(UPDATE|DELETE)\b/i.test(sql)
                ? [result.rows, result.affectedRows]
                : result.rows;
            },
          }),
        ),
    } as unknown as DataSource;
    s = new RecoveryService(a, { send } as any);
  }, 30000);
  beforeEach(async () => {
    send.mockReset().mockResolvedValue('provider-fixture');
    await query(
      "UPDATE auth_mail_jobs SET status='CANCELLED',payload=NULL,lease_id=NULL,lease_until=NULL WHERE status IN('PENDING','PROCESSING')",
    );
    await query('DELETE FROM auth_recovery_limits');
  });
  afterAll(async () => {
    s.onModuleDestroy();
    await db?.close();
    process.env = env;
  });
  async function user() {
    const email = randomUUID() + '@example.invalid';
    const [r] = await query(
      'INSERT INTO users(email,nickname,password,"coinBalance") VALUES($1,\'recovery\',$2,800) RETURNING id',
      [email, await bcrypt.hash('Original123!', 4)],
    );
    return { userId: r.id, email, authVersion: 0 };
  }
  async function token(a: any, purpose: 'RESET' | 'VERIFY' = 'RESET') {
    if (purpose === 'RESET') await s.requestReset(a.email);
    else await s.requestVerification(a);
    await s.tick();
    const mail = send.mock.calls.at(-1)?.[1];
    expect(mail).toBeDefined();
    return mail.text.match(/auth-(reset|verify)\/([a-f0-9]{64})/)[2];
  }
  it('requires explicit valid delivery configuration and authenticated encryption context', () => {
    const c = recoveryConfig();
    expect(c).not.toBeNull();
    expect(
      recoveryConfig({
        ...process.env,
        AUTH_PUBLIC_WEB_ORIGIN: 'http://unsafe.example',
      }),
    ).toBeNull();
    expect(
      recoveryConfig({ ...process.env, AUTH_MAIL_ENCRYPTION_KEY: 'random' }),
    ).toBeNull();
    expect(
      recoveryConfig({ ...process.env, AUTH_MAIL_DELIVERY_ENABLED: 'false' }),
    ).toBeNull();
    const ciphertext = seal({ token: 'private' }, c.key, 'job-1');
    expect(ciphertext).not.toContain('private');
    expect(unseal(ciphertext, c.key, 'job-1')).toEqual({ token: 'private' });
    expect(() => unseal(ciphertext, c.key, 'job-2')).toThrow();
  });
  it('returns the identical response and queues encrypted work for known and unknown addresses', async () => {
    const a = await user();
    const known = await s.requestReset(a.email),
      unknown = await s.requestReset('absent@example.invalid');
    expect(known).toEqual(unknown);
    expect(JSON.stringify(known)).not.toContain(a.email);
    const jobs = await query(
      "SELECT payload FROM auth_mail_jobs WHERE status='PENDING'",
    );
    expect(jobs).toHaveLength(2);
    expect(
      jobs.some((j) => j.payload.includes('@') || j.payload.includes('token')),
    ).toBe(false);
    await s.tick();
    await s.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('resets password only once, invalidates sessions, verifies email and preserves GP', async () => {
    const a = await user(),
      t = await token(a);
    expect(await s.complete('RESET', t, 'NewPassword123!')).toEqual({
      changed: true,
      reauthenticate: true,
    });
    const [u] = await query(
      'SELECT password,auth_version,email_verified_at,"coinBalance" FROM users WHERE id=$1',
      [a.userId],
    );
    expect(await bcrypt.compare('NewPassword123!', u.password)).toBe(true);
    expect(u.auth_version).toBe(1);
    expect(u.coinBalance).toBe(800);
    expect(u.email_verified_at).not.toBeNull();
    await expect(s.complete('RESET', t, 'Another123!')).rejects.toMatchObject({
      status: 400,
    });
    await s.tick();
    expect(send.mock.calls.at(-1)[1].subject).toContain('변경됐습니다');
    expect(send.mock.calls.at(-1)[1].text).not.toContain('NewPassword');
  });
  it('requires the correct purpose, rejects expired tokens and old-session tokens', async () => {
    const a = await user(),
      t = await token(a);
    await expect(s.complete('VERIFY', t)).rejects.toMatchObject({
      status: 400,
    });
    await query(
      "UPDATE auth_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [a.userId],
    );
    await expect(
      s.complete('RESET', t, 'NewPassword123!'),
    ).rejects.toMatchObject({ status: 400 });
    const b = await user(),
      other = await token(b);
    await query('UPDATE users SET auth_version=1 WHERE id=$1', [b.userId]);
    await expect(
      s.complete('RESET', other, 'NewPassword123!'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('verifies the signed-in email, consumes all verification links, and never changes GP or credentials', async () => {
    const a = await user();
    await expect(
      s.requestVerification({ ...a, authVersion: 5 }),
    ).rejects.toMatchObject({ status: 401 });
    const t = await token(a, 'VERIFY'),
      second = await token(a, 'VERIFY');
    await s.complete('VERIFY', t);
    expect((await s.status(a)).verified).toBe(true);
    await expect(s.complete('VERIFY', second)).rejects.toMatchObject({
      status: 400,
    });
    const [u] = await query(
      'SELECT password,auth_version,"coinBalance" FROM users WHERE id=$1',
      [a.userId],
    );
    expect(await bcrypt.compare('Original123!', u.password)).toBe(true);
    expect(u.auth_version).toBe(0);
    expect(u.coinBalance).toBe(800);
  });
  it('persists per-address throttling without locking accounts or leaking membership', async () => {
    const a = await user(),
      answers = [];
    for (let i = 0; i < 6; i++) answers.push(await s.requestReset(a.email));
    expect(new Set(answers.map((x) => JSON.stringify(x)))).toHaveProperty(
      'size',
      1,
    );
    expect(
      await query("SELECT * FROM auth_mail_jobs WHERE status='PENDING'"),
    ).toHaveLength(3);
    const [u] = await query(
      'SELECT password_check_failures,password_locked_until FROM users WHERE id=$1',
      [a.userId],
    );
    expect(u).toMatchObject({
      password_check_failures: 0,
      password_locked_until: null,
    });
  });
  it('retries uncertain sends with the same provider key and exactly the same encrypted message', async () => {
    const a = await user();
    send
      .mockRejectedValueOnce(new DeliveryError(true))
      .mockResolvedValue('sent');
    await s.requestReset(a.email);
    await s.tick();
    const first = send.mock.calls[0];
    await query(
      "UPDATE auth_mail_jobs SET available_at=clock_timestamp() WHERE status='PENDING'",
    );
    await s.tick();
    expect(send.mock.calls[1]).toEqual(first);
    const rows = await query('SELECT * FROM auth_challenges WHERE user_id=$1', [
      a.userId,
    ]);
    expect(rows).toHaveLength(1);
    const [j] = await query(
      'SELECT status,payload FROM auth_mail_jobs WHERE id=$1',
      [first[0]],
    );
    expect(j).toEqual({ status: 'SENT', payload: null });
  });
  it('recovers abandoned leases and retires expired mail without sending it', async () => {
    const a = await user();
    await s.requestReset(a.email);
    await query(
      "UPDATE auth_mail_jobs SET status='PROCESSING',lease_id=$1,lease_until=clock_timestamp()-interval '1 second' WHERE status='PENDING'",
      [randomUUID()],
    );
    await s.tick();
    expect(send).toHaveBeenCalledTimes(1);
    await s.requestReset(a.email);
    await query(
      "UPDATE auth_mail_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE status='PENDING'",
    );
    await s.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await query("SELECT payload FROM auth_mail_jobs WHERE status='FAILED'")
      ).every((j) => j.payload === null),
    ).toBe(true);
  });
  it('rolls back password and token consumption if the security audit cannot be recorded', async () => {
    const a = await user(),
      t = await token(a);
    await query(
      `CREATE FUNCTION reject_password_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='PASSWORD_RESET' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
    );
    await query(
      'CREATE TRIGGER reject_password_reset BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION reject_password_reset()',
    );
    try {
      await expect(s.complete('RESET', t, 'NewPassword123!')).rejects.toThrow();
    } finally {
      await query(
        'DROP TRIGGER reject_password_reset ON account_security_events',
      );
      await query('DROP FUNCTION reject_password_reset()');
    }
    const [u] = await query(
      'SELECT password,auth_version FROM users WHERE id=$1',
      [a.userId],
    );
    expect(await bcrypt.compare('Original123!', u.password)).toBe(true);
    expect(u.auth_version).toBe(0);
    expect(await s.complete('RESET', t, 'NewPassword123!')).toMatchObject({
      changed: true,
    });
  });
  it('does not email social-only accounts, reuses no used links and rejects disabled requests', async () => {
    const a = await user();
    await query(
      "UPDATE users SET provider='GOOGLE',password=NULL WHERE id=$1",
      [a.userId],
    );
    await s.requestReset(a.email);
    await s.tick();
    expect(send).not.toHaveBeenCalled();
    process.env.AUTH_MAIL_DELIVERY_ENABLED = 'false';
    try {
      expect(s.capabilities().enabled).toBe(false);
      await expect(s.requestReset(a.email)).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      process.env.AUTH_MAIL_DELIVERY_ENABLED = 'true';
    }
  });
});
