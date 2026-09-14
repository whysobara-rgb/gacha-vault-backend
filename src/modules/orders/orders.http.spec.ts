import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

describe('order HTTP boundary', () => {
  let app: INestApplication;
  const secret = 'isolated-order-http-test';
  const token = new JwtService({ secret }).sign({ sub: 10 });
  const purchase = jest.fn().mockResolvedValue({ orderId: 'test-order' });
  const listCapsules = jest.fn().mockResolvedValue({ items: [] });
  const findOne = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [OrdersController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        {
          provide: OrdersService,
          useValue: { purchase, listCapsules, findOne },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());
  it('requires authentication for purchase and inventory reads', async () => {
    await request(app.getHttpServer()).post('/orders/gp').send({}).expect(401);
    await request(app.getHttpServer()).get('/capsules').expect(401);
    expect(purchase).not.toHaveBeenCalled();
  });
  it('passes the JWT owner and request key rather than a supplied owner or total', async () => {
    const key = 'd4b608db-b251-4616-8017-c1eea6a9c1a1';
    await request(app.getHttpServer())
      .post('/orders/gp')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        gachaId: 1,
        quantity: 2,
        expectedUnitPrice: 100,
        userId: 99,
        total: 1,
      })
      .expect(201);
    expect(purchase).toHaveBeenCalledWith(10, key, {
      gachaId: 1,
      quantity: 2,
      expectedUnitPrice: 100,
    });
  });
  it('rejects string and fractional quantities before purchase', async () => {
    for (const quantity of ['2', 1.5, 101]) {
      await request(app.getHttpServer())
        .post('/orders/gp')
        .set('Authorization', `Bearer ${token}`)
        .send({ gachaId: 1, quantity, expectedUnitPrice: 100 })
        .expect(400);
    }
    expect(purchase).not.toHaveBeenCalled();
  });
  it('bounds capsule pagination', async () => {
    await request(app.getHttpServer())
      .get('/capsules?limit=101')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/capsules?page=2&limit=10')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listCapsules).toHaveBeenCalledWith(10, { page: 2, limit: 10 });
  });
  it('rejects malformed order identifiers before querying', async () => {
    await request(app.getHttpServer())
      .get('/orders/not-an-id')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(findOne).not.toHaveBeenCalled();
  });
});
