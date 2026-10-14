import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { User } from '../../entities';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { SupplyController } from '../supply/supply.controller';
import { SupplyService } from '../supply/supply.service';
describe('supply HTTP authentication and validation', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'isolated-supply-http-test' }),
    token = jwt.sign({ sub: 10, av: 0 }),
    key = '44444444-4444-4444-8444-444444444444';
  const service = {
    createSku: jest.fn().mockResolvedValue({ skuId: 1 }),
    movement: jest.fn().mockResolvedValue({}),
    read: jest.fn().mockResolvedValue({}),
    saveAnnouncement: jest.fn().mockResolvedValue({}),
    skus: jest.fn().mockResolvedValue({ items: [] }),
    link: jest.fn().mockResolvedValue({}),
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [SupplyController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: 'isolated-supply-http-test',
          }),
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: async () => ({
              id: 10,
              email: 'server@example.invalid',
              authVersion: 0,
            }),
          },
        },
        { provide: SupplyService, useValue: service },
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
  it('requires JWT for stock changes, notices and inbox reading', async () => {
    for (const path of [
      '/ops/warehouse/skus',
      'ops/announcements',
      'notifications/read',
    ])
      await request(app.getHttpServer())
        .post('/' + path.replace(/^\//, ''))
        .send({})
        .expect(401);
    expect(service.createSku).not.toHaveBeenCalled();
    expect(service.read).not.toHaveBeenCalled();
  });
  it('rejects forged identity, illegal stock changes and oversized notices', async () => {
    for (const [path, body] of [
      [
        '/ops/warehouse/skus',
        { code: 'TEST', name: 'test', reorderPoint: 0, onHand: 100 },
      ],
      [
        '/ops/warehouse/skus/1/movements',
        { expectedVersion: 1, kind: 'DISPATCH', quantity: -1, reason: 'test' },
      ],
      ['/ops/warehouse/items/1/link', { expectedVersion: 0, skuId: -1 }],
      ['/notifications/read', { throughId: 1, userId: 99 }],
      [
        '/ops/announcements',
        { title: 'Notice', body: 'x'.repeat(5001), category: 'NOTICE' },
      ],
    ] as any[])
      await request(app.getHttpServer())
        .post(path)
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(400);
    expect(service.createSku).not.toHaveBeenCalled();
    expect(service.saveAnnouncement).not.toHaveBeenCalled();
    expect(service.movement).not.toHaveBeenCalled();
  });
  it('uses signed-in identity and forwards a bounded receipt with its original key', async () => {
    const dto = {
      expectedVersion: 2,
      kind: 'RECEIVE',
      quantity: 5,
      reason: 'verified receipt',
    };
    await request(app.getHttpServer())
      .post('/ops/warehouse/skus/1/movements')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .send(dto)
      .expect(201);
    expect(service.movement).toHaveBeenCalledWith(
      { userId: 10, email: 'server@example.invalid', authVersion: 0 },
      1,
      key,
      dto,
    );
  });
  it('rejects malformed targets and query filters before database access', async () => {
    for (const path of [
      '/ops/warehouse/skus?limit=101',
      '/ops/warehouse/skus?low=maybe',
      '/ops/warehouse/skus/nope',
      '/announcements/nope',
    ])
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer ' + token)
        .expect(400);
    expect(service.skus).not.toHaveBeenCalled();
  });
});
