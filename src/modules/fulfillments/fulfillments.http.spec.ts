import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request = require('supertest');
import { FulfillmentsController } from './fulfillments.controller';
import { FulfillmentsService } from './fulfillments.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
describe('fulfillment authentication and input boundary', () => {
  let app: INestApplication;
  const secret = 'isolated-fulfillment-http-test-secret',
    jwt = new JwtService({ secret }),
    service = {
      capabilities: jest.fn(() => ({ enabled: false })),
      quote: jest.fn(() => ({ feeGP: 3000 })),
      create: jest.fn(() => ({ fulfillmentId: 'fixture' })),
      cancel: jest.fn(() => ({ status: 'CANCELLED' })),
      getQuote: jest.fn(),
      byRequest: jest.fn(),
      list: jest.fn(),
      findOne: jest.fn(),
    };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [FulfillmentsController],
      providers: [
        { provide: FulfillmentsService, useValue: service },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        JwtAuthGuard,
        JwtStrategy,
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
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());
  const recipient = {
    name: 'Test',
    phone: '01000000000',
    postalCode: '00000',
    address1: 'Test address',
    address2: '101',
    country: 'KR',
  };
  const token = jwt.sign({ sub: 7, email: 'fixture@example.invalid' });
  it('does not quote or convert without authentication', async () => {
    await request(app.getHttpServer())
      .post('/fulfillments/quotes')
      .send({ inventoryItemIds: [1] })
      .expect(401);
    await request(app.getHttpServer())
      .post('/fulfillments')
      .send({})
      .expect(401);
    expect(service.quote).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });
  it('rejects duplicates, more than 100, strings, and injected userId', async () => {
    for (const body of [
      { inventoryItemIds: [1, 1] },
      { inventoryItemIds: Array.from({ length: 101 }, (_, i) => i + 1) },
      { inventoryItemIds: ['1'] },
      { inventoryItemIds: [1], userId: 99 },
    ])
      await request(app.getHttpServer())
        .post('/fulfillments/quotes')
        .set('Authorization', 'Bearer ' + token)
        .send({ ...body, recipient })
        .expect(400);
    expect(service.quote).not.toHaveBeenCalled();
  });
  it('derives ownership from JWT and accepts bounded quote selection', async () => {
    await request(app.getHttpServer())
      .post('/fulfillments/quotes')
      .set('Authorization', 'Bearer ' + token)
      .send({ inventoryItemIds: [1, 2], recipient })
      .expect(201);
    expect(service.quote).toHaveBeenCalledWith(7, {
      inventoryItemIds: [1, 2],
      recipient,
    });
  });
  it('rejects invalid restore IDs before a state change', async () => {
    await request(app.getHttpServer())
      .post('/fulfillments/invalid/cancel')
      .set('Authorization', 'Bearer ' + token)
      .send({})
      .expect(400);
    expect(service.cancel).not.toHaveBeenCalled();
  });
  it('rejects missing recipient and client fee injection', async () => {
    for (const body of [
      { inventoryItemIds: [1] },
      { inventoryItemIds: [1], recipient: { ...recipient, postalCode: '12' } },
      { inventoryItemIds: [1], recipient, feeGP: 0 },
    ])
      await request(app.getHttpServer())
        .post('/fulfillments/quotes')
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(400);
    expect(service.quote).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post('/fulfillments')
      .set('Authorization', 'Bearer ' + token)
      .send({ quoteId: '6d9d5852-630a-4a9a-8f3e-6bf45642fd50', feeGP: 0 })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it('keeps configuration unavailable explicit', async () => {
    await request(app.getHttpServer())
      .get('/fulfillments/capabilities')
      .set('Authorization', 'Bearer ' + token)
      .expect(200, { enabled: false });
  });
});
