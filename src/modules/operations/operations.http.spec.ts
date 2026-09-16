import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { User } from '../../entities';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
describe('operations HTTP authentication and validation', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'isolated-ops-http-test' }),
    token = jwt.sign({ sub: 10, av: 0 }),
    key = '44444444-4444-4444-8444-444444444444';
  const service = {
    create: jest.fn().mockResolvedValue({ gachaId: 1 }),
    publish: jest.fn().mockResolvedValue({}),
    dispatch: jest.fn().mockResolvedValue({}),
    catalog: jest.fn().mockResolvedValue({ items: [] }),
  };
  const config = {
    title: 'Test box',
    description: 'test',
    imageUrl: null,
    price: 100,
    totalStock: 100,
    saleType: 'STANDARD',
    entries: [
      {
        name: 'Test item',
        rarity: 'N',
        imageUrl: null,
        estimatedValue: 100,
        isPremium: false,
        probabilityPpm: 1000000,
        fulfillmentType: 'PHYSICAL',
        shippingEnabled: true,
      },
    ],
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [OperationsController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: 'isolated-ops-http-test' }),
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
        { provide: OperationsService, useValue: service },
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
  it('requires JWT authentication before catalog and dispatch', async () => {
    await request(app.getHttpServer()).get('/ops/catalog').expect(401);
    await request(app.getHttpServer())
      .post('/ops/fulfillments/' + key + '/status')
      .send({ status: 'PREPARING', expectedVersion: 1 })
      .expect(401);
    expect(service.dispatch).not.toHaveBeenCalled();
  });
  it('rejects forged ownership, nested unknown fields and out-of-range probability', async () => {
    for (const body of [
      { config, role: 'ADMIN' },
      {
        config: { ...config, entries: [{ ...config.entries[0], itemId: 999 }] },
      },
      {
        config: {
          ...config,
          entries: [{ ...config.entries[0], probabilityPpm: 1000001 }],
        },
      },
    ])
      await request(app.getHttpServer())
        .post('/ops/catalog')
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it('accepts bounded nested drafts and supplies identity only from JWT strategy', async () => {
    await request(app.getHttpServer())
      .post('/ops/catalog')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .send({ config })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      { userId: 10, email: 'server@example.invalid', authVersion: 0 },
      key,
      config,
    );
  });
  it('requires publish confirmation and bounded versions, status and target IDs', async () => {
    await request(app.getHttpServer())
      .post('/ops/catalog/1/publish')
      .set('Authorization', 'Bearer ' + token)
      .send({ expectedVersion: 1, confirmation: 'yes' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/ops/fulfillments/' + key + '/status')
      .set('Authorization', 'Bearer ' + token)
      .send({ expectedVersion: 0, status: 'CANCELLED' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/ops/catalog?limit=101')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    await request(app.getHttpServer())
      .get('/ops/catalog/not-number')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    expect(service.publish).not.toHaveBeenCalled();
    expect(service.dispatch).not.toHaveBeenCalled();
  });
});
