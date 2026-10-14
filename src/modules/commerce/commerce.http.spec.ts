import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../../entities';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request = require('supertest');
import {
  CommerceController,
  PaymentReturnController,
} from './commerce.controller';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { HistoryService } from './history.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
const id = '0876bd3c-d35b-4322-a379-ece53b4df615';
describe('commerce authentication and request boundary', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'commerce-http-test-secret' }),
    token = jwt.sign({ sub: 7, email: 'test@example.invalid' }),
    payments = {
      prepare: jest.fn(() => ({ paymentId: id })),
      confirm: jest.fn(() => ({ status: 'PAID' })),
      cancelPrepared: jest.fn(),
      capabilities: jest.fn(() => ({ enabled: false })),
      findOne: jest.fn(),
    },
    refunds = {
      quote: jest.fn(() => ({ amount: 100 })),
      refund: jest.fn(() => ({ status: 'SUCCEEDED' })),
    },
    history = {
      orders: jest.fn(() => ({ items: [] })),
      openings: jest.fn(),
      capabilities: jest.fn(),
    };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [PaymentReturnController, CommerceController],
      providers: [
        { provide: PaymentsService, useValue: payments },
        { provide: RefundsService, useValue: refunds },
        { provide: HistoryService, useValue: history },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: 'commerce-http-test-secret',
          }),
        },
        JwtAuthGuard,
        JwtStrategy,
        {provide:getRepositoryToken(User),useValue:{findOne:async({where}:any)=>({id:where.id,email:"http@example.invalid",authVersion:0})}},
      ],
    }).compile();
    app = m.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('requires JWT on payment/refund mutations and all owner history', async () => {
    for (const path of [
      '/payments',
      '/payments/' + id + '/confirm',
      '/orders/' + id + '/refunds',
    ])
      await request(app.getHttpServer()).post(path).send({}).expect(401);
    await request(app.getHttpServer()).get('/transactions/orders').expect(401);
    expect(payments.confirm).not.toHaveBeenCalled();
    expect(refunds.refund).not.toHaveBeenCalled();
  });
  it('rejects user/amount injection and duplicate selections before service calls', async () => {
    for (const body of [
      { capsuleIds: [id, id] },
      { capsuleIds: [id], userId: 99 },
      { capsuleIds: [] },
      { capsuleIds: Array(101).fill(id) },
    ])
      await request(app.getHttpServer())
        .post('/orders/' + id + '/refund-quote')
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .post('/payments/' + id + '/confirm')
      .set('Authorization', 'Bearer ' + token)
      .send({ transactionId: 'test', amount: 100, userId: 99 })
      .expect(400);
    expect(refunds.quote).not.toHaveBeenCalled();
  });
  it('takes user identity only from the JWT', async () => {
    await request(app.getHttpServer())
      .post('/orders/' + id + '/refund-quote')
      .set('Authorization', 'Bearer ' + token)
      .send({ capsuleIds: [id] })
      .expect(201);
    expect(refunds.quote).toHaveBeenCalledWith(7, id, [id]);
    await request(app.getHttpServer())
      .get('/transactions/orders?page=2&limit=5')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(history.orders).toHaveBeenCalledWith(7, 2, 5);
  });
  it('rejects malformed or oversized transaction IDs', async () => {
    for (const tid of ['x'.repeat(33), '../other', ''])
      await request(app.getHttpServer())
        .post('/payments/' + id + '/confirm')
        .set('Authorization', 'Bearer ' + token)
        .send({ transactionId: tid, amount: 100 })
        .expect(400);
    expect(payments.confirm).not.toHaveBeenCalled();
  });
  it('PG browser return never grants capsules or calls approval; redirect origin is fixed', async () => {
    const r = await request(app.getHttpServer())
      .post('/payments/return')
      .type('form')
      .send({
        orderId: id,
        code: 'SUCCESS',
        transactionId: 'test',
        amount: '100',
        method: 'CARD',
        redirect: 'https://example.invalid',
      })
      .expect(303);
    expect(r.headers.location).toMatch(
      /^https:\/\/gachigacha-studio-preview\.bara3840\.chatgpt\.site\/#payment-return\//,
    );
    expect(r.headers.location).not.toContain('example.invalid');
    expect(payments.confirm).not.toHaveBeenCalled();
    expect(payments.prepare).not.toHaveBeenCalled();
  });
});
