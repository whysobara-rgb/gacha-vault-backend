import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { User } from '../../entities';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AccountSupportController } from './account-support.controller';
import { AccountService } from './account.service';
import { SupportService } from './support.service';
describe('account/support authentication and input boundary', () => {
  let app: INestApplication;
  let version = 0,
    exists = true;
  const jwt = new JwtService({ secret: 'isolated-account-http-test' }),
    token = jwt.sign({ sub: 10, av: 0, email: 'client-untrusted' }),
    key = '44444444-4444-4444-8444-444444444444';
  const accounts = {
    capabilities: jest.fn().mockResolvedValue({ enabled: true }),
    changePassword: jest.fn().mockResolvedValue({ changed: true }),
    closureCheck: jest.fn().mockResolvedValue({}),
    requestClosure: jest.fn().mockResolvedValue({ status: 'REQUESTED' }),
  };
  const support = {
    create: jest.fn().mockResolvedValue({ ticketId: key }),
    detail: jest.fn().mockResolvedValue({}),
    list: jest.fn().mockResolvedValue({ items: [] }),
    reply: jest.fn().mockResolvedValue({}),
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AccountSupportController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: 'isolated-account-http-test',
          }),
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: async () =>
              exists
                ? {
                    id: 10,
                    email: 'server@example.invalid',
                    authVersion: version,
                  }
                : null,
          },
        },
        { provide: AccountService, useValue: accounts },
        { provide: SupportService, useValue: support },
      ],
    }).compile();
    app = m.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  beforeEach(() => {
    version = 0;
    exists = true;
    jest.clearAllMocks();
  });
  afterAll(async () => app.close());
  it('requires a valid member for account and ticket routes', async () => {
    await request(app.getHttpServer())
      .get('/account/closure-check')
      .expect(401);
    await request(app.getHttpServer())
      .post('/support/tickets')
      .send({})
      .expect(401);
    expect(support.create).not.toHaveBeenCalled();
  });
  it('invalidates previously issued tokens on all authenticated routes', async () => {
    version = 1;
    await request(app.getHttpServer())
      .get('/support/tickets')
      .set('Authorization', 'Bearer ' + token)
      .expect(401);
    expect(support.list).not.toHaveBeenCalled();
    const fresh = jwt.sign({ sub: 10, av: 1 });
    await request(app.getHttpServer())
      .get('/support/tickets')
      .set('Authorization', 'Bearer ' + fresh)
      .expect(200);
  });
  it('rejects removed members and malformed subject/version claims', async () => {
    exists = false;
    await request(app.getHttpServer())
      .get('/account/capabilities')
      .set('Authorization', 'Bearer ' + token)
      .expect(401);
    exists = true;
    for (const claims of [
      { sub: '10' },
      { sub: 10, av: '0' },
      { sub: 0 },
      { sub: 10, av: -1 },
    ])
      await request(app.getHttpServer())
        .get('/account/capabilities')
        .set('Authorization', 'Bearer ' + jwt.sign(claims))
        .expect(401);
  });
  it('uses database identity and rejects client ownership/role fields', async () => {
    const body = { category: 'OTHER', subject: '문의 제목', body: '문의 내용' };
    await request(app.getHttpServer())
      .post('/support/tickets')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .send({ ...body, userId: 20, role: 'SUPPORT' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/support/tickets')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(support.create).toHaveBeenCalledWith(
      { userId: 10, email: 'server@example.invalid', authVersion: 0 },
      key,
      body,
    );
  });
  it('bounds messages, categories, UUIDs and pagination', async () => {
    for (const body of [
      { category: 'ADMIN', subject: 'test', body: 'test' },
      { category: 'OTHER', subject: 'test', body: 'x'.repeat(4001) },
    ])
      await request(app.getHttpServer())
        .post('/support/tickets')
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .get('/support/tickets/not-id')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    await request(app.getHttpServer())
      .get('/support/tickets?limit=101')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    await request(app.getHttpServer())
      .get('/support/tickets/' + key + '?after=-1')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
  });
  it('requires reauthentication and explicit closure wording', async () => {
    await request(app.getHttpServer())
      .post('/account/password')
      .set('Authorization', 'Bearer ' + token)
      .send({ newPassword: 'NewPassword123' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/account/closure-requests')
      .set('Authorization', 'Bearer ' + token)
      .send({
        currentPassword: 'Current123',
        reason: 'test',
        confirmation: 'yes',
      })
      .expect(400);
    expect(accounts.changePassword).not.toHaveBeenCalled();
    expect(accounts.requestClosure).not.toHaveBeenCalled();
  });
});
