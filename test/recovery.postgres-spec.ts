import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import * as bcrypt from 'bcrypt';
import { RecoveryService } from '../src/modules/account-recovery/recovery.service';

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
describe('multi-connection email recovery races', () => {
  const env = { ...process.env },
    send = jest.fn().mockResolvedValue('fixture-mail');
  let service: RecoveryService;
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB required');
    Object.assign(process.env, {
      ENABLE_ACCOUNT_RECOVERY: 'true',
      AUTH_MAIL_DELIVERY_ENABLED: 'true',
      AUTH_MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'),
      AUTH_PUBLIC_WEB_ORIGIN: 'https://gachi.example',
      AUTH_MAIL_FROM: 'account@gachi.example',
      RESEND_API_KEY: 'isolated-postgres-test',
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    service = new RecoveryService(db, { send } as any);
  });
  beforeEach(async () => {
    send.mockClear();
    await db.query(
      "UPDATE auth_mail_jobs SET status='CANCELLED',payload=NULL,lease_id=NULL,lease_until=NULL WHERE status IN('PENDING','PROCESSING')",
    );
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  async function user() {
    const email = randomUUID() + '@example.invalid';
    const [u] = await db.query(
      'INSERT INTO users(email,nickname,password,"coinBalance") VALUES($1,\'test\',$2,500) RETURNING id',
      [email, await bcrypt.hash('Original123!', 4)],
    );
    return { id: u.id, email };
  }
  it('consumes the reset token only once across separate database connections', async () => {
    const u = await user();
    await service.requestReset(u.email);
    await service.tick();
    const t = send.mock.calls
      .at(-1)[1]
      .text.match(/auth-reset\/([a-f0-9]{64})/)[1];
    const outcomes = await Promise.allSettled([
      service.complete('RESET', t, 'FirstPassword123!'),
      service.complete('RESET', t, 'SecondPassword123!'),
    ]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const [stored] = await db.query(
      'SELECT auth_version,"coinBalance" FROM users WHERE id=$1',
      [u.id],
    );
    expect(stored).toEqual({ auth_version: 1, coinBalance: 500 });
  });
  it('leases one pending email to only one of two workers', async () => {
    const u = await user();
    await service.requestReset(u.email);
    const second = new RecoveryService(db, { send } as any);
    await Promise.all([service.tick(), second.tick()]);
    expect(send).toHaveBeenCalledTimes(1);
    const [job] = await db.query(
      'SELECT status,payload FROM auth_mail_jobs WHERE id=$1',
      [send.mock.calls[0][0]],
    );
    expect(job).toEqual({ status: 'SENT', payload: null });
  });
});
