import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { User } from '../../entities';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
describe('recovery HTTP authentication and validation', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'isolated-recovery-http' }),
    token = jwt.sign({ sub: 10, av: 0 }),
    secret = 'a'.repeat(64),
    service = {
      capabilities: jest.fn().mockReturnValue({ enabled: false }),
      requestReset: jest.fn().mockResolvedValue({ accepted: true }),
      complete: jest.fn().mockResolvedValue({ changed: true }),
      requestVerification: jest.fn().mockResolvedValue({ accepted: true }),
      status: jest.fn().mockResolvedValue({ verified: false }),
    };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [RecoveryController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: 'isolated-recovery-http' }),
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: async () => ({
              id: 10,
              email: 'owner@example.invalid',
              authVersion: 0,
            }),
          },
        },
        { provide: RecoveryService, useValue: service },
      ],
    }).compile();
    app = m.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());
  it('allows public password recovery with no logged-in session', async () => {
    await request(app.getHttpServer())
      .post('/auth/recovery/request')
      .send({ email: 'owner@example.invalid' })
      .expect(201);
    expect(service.requestReset).toHaveBeenCalledWith('owner@example.invalid');
    await request(app.getHttpServer())
      .post('/auth/recovery/reset')
      .send({ token: secret, newPassword: 'NewPassword123!' })
      .expect(201);
    expect(service.complete).toHaveBeenCalledWith(
      'RESET',
      secret,
      'NewPassword123!',
    );
  });
  it('requires JWT for email verification requests and uses only signed-in identity', async () => {
    await request(app.getHttpServer())
      .post('/account/email/request')
      .send({})
      .expect(401);
    await request(app.getHttpServer()).get('/account/email').expect(401);
    await request(app.getHttpServer())
      .post('/account/email/request')
      .set('Authorization', 'Bearer ' + token)
      .send({})
      .expect(201);
    expect(service.requestVerification).toHaveBeenCalledWith({
      userId: 10,
      email: 'owner@example.invalid',
      authVersion: 0,
    });
  });
  it('rejects forged targets, redirect URLs, malformed tokens and oversized passwords', async () => {
    for (const [path, body] of [
      [
        '/auth/recovery/request',
        { email: 'owner@example.invalid', redirectUrl: 'https://evil.example' },
      ],
      ['/auth/recovery/request', { email: 'bad' }],
      [
        '/auth/recovery/reset',
        { token: 'short', newPassword: 'NewPassword123!' },
      ],
      ['/auth/recovery/reset', { token: secret, newPassword: 'x'.repeat(65) }],
      ['/auth/recovery/verify', { token: secret, userId: 99 }],
    ] as any[])
      await request(app.getHttpServer()).post(path).send(body).expect(400);
    expect(service.complete).not.toHaveBeenCalled();
    expect(service.requestReset).not.toHaveBeenCalled();
  });
  it('exposes no delivery queue or token issuance endpoint', async () => {
    for (const path of [
      '/auth/recovery/outbox',
      '/auth/recovery/tokens',
      '/auth/recovery/issue-token',
    ])
      await request(app.getHttpServer()).get(path).expect(404);
  });
});
