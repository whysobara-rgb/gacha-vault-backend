import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import request = require('supertest');
import { dataSourceOptions } from '../src/config/typeorm.config';
import { User } from '../src/entities';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { AccountService } from '../src/modules/account-support/account.service';
import { ClosureReadController } from '../src/modules/account-support/closure-read.controller';

const db = new DataSource({
  ...dataSourceOptions, host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci', password: 'local-ci-only', database: 'gacha_integration_test',
  synchronize: false, migrationsRun: false, ssl: false,
  extra: { max: 8, statement_timeout: 10000 },
});

describe('closure receipt read-only HTTP on local PostgreSQL', () => {
  let app: INestApplication, service: AccountService, hash: string;
  const secret = 'SYNTHETIC_CLOSURE_READ_JWT_ONLY';
  const jwt = new JwtService({ secret });
  const password = 'SyntheticClosure123!';
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test' || process.env.TEST_POSTGRES !== 'true') {
      throw new Error('Local test database opt-in required');
    }
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    hash = await bcrypt.hash(password, 10);
    service = new AccountService(db);
    const module = await Test.createTestingModule({
      imports: [PassportModule], controllers: [ClosureReadController],
      providers: [JwtStrategy, { provide: DataSource, useValue: db },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: getRepositoryToken(User), useValue: db.getRepository(User) }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db.isInitialized) await db.destroy();
  });
  async function fixture() {
    const [u] = await db.query(
      'INSERT INTO users(email,nickname,password,"coinBalance") VALUES($1,$2,$3,500) RETURNING id,email',
      [randomUUID() + '@example.invalid', 'synthetic-closure', hash],
    );
    const actor = { userId: u.id, email: u.email, authVersion: 0 };
    const receipt = await service.requestClosure(actor, randomUUID(), {
      currentPassword: password, reason: '시험 탈퇴 접수', confirmation: '탈퇴 요청',
    });
    return { actor, receipt, token: jwt.sign({ sub: u.id, av: 0 }) };
  }
  const read = (id: string, token?: string) => {
    const req = request(app.getHttpServer()).get('/account/closure-requests/' + id);
    return token ? req.set('Authorization', 'Bearer ' + token) : req;
  };
  it('requires authentication and a UUID before the read', async () => {
    const f = await fixture();
    await read(f.receipt.requestId).expect(401);
    await read('not-a-uuid', f.token).expect(400);
  });
  it('returns the recorded snapshot without credentials or internal keys', async () => {
    const f = await fixture();
    const { body } = await read(f.receipt.requestId, f.token).expect(200);
    expect(body).toMatchObject({ requestId: f.receipt.requestId,
      status: 'REQUESTED', accountDeleted: false, summary: { balance: 500 } });
    expect(Object.keys(body).sort()).toEqual([
      'requestId','status','reason','summary','createdAt','cancelledAt','accountDeleted',
    ].sort());
    expect(JSON.stringify(body)).not.toContain(password);
    expect(JSON.stringify(body)).not.toContain(f.actor.email);
  });
  it('does not reveal another customer receipt or distinguish it from absent data', async () => {
    const a = await fixture(), b = await fixture();
    const other = await read(a.receipt.requestId, b.token).expect(404);
    const missing = await read(randomUUID(), b.token).expect(404);
    expect(other.body).toEqual(missing.body);
  });
  it('rejects an old session after server revocation', async () => {
    const f = await fixture();
    await db.query('UPDATE users SET auth_version=1 WHERE id=$1', [f.actor.userId]);
    await read(f.receipt.requestId, f.token).expect(401);
    await read(f.receipt.requestId, jwt.sign({ sub: f.actor.userId, av: 1 })).expect(200);
  });
  it('can confirm a cancellation without repeating its POST', async () => {
    const f = await fixture();
    await service.cancelClosure(f.actor, f.receipt.requestId);
    const { body } = await read(f.receipt.requestId, f.token).expect(200);
    expect(body.status).toBe('CANCELLED');
    expect(body.cancelledAt).not.toBeNull();
    expect(body.accountDeleted).toBe(false);
  });
  it('six concurrent reads preserve request, balance and audit records', async () => {
    const f = await fixture();
    const snapshot = async () => ({
      request: await db.query('SELECT * FROM account_closure_requests WHERE id=$1', [f.receipt.requestId]),
      user: await db.query('SELECT "coinBalance",auth_version FROM users WHERE id=$1', [f.actor.userId]),
      events: await db.query('SELECT * FROM account_security_events WHERE user_id=$1 ORDER BY id', [f.actor.userId]),
    });
    const before = await snapshot();
    const results = await Promise.all(Array.from({ length: 6 }, () => read(f.receipt.requestId, f.token).expect(200)));
    expect(results.every(r => r.body.status === 'REQUESTED')).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
