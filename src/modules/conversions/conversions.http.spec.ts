import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../../entities';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request = require('supertest');
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
describe('conversion authentication and input boundary', () => {
  let app: INestApplication;
  const secret = 'isolated-conversion-http-test-secret',
    jwt = new JwtService({ secret }),
    service = {
      capabilities: jest.fn(() => ({ enabled: false })),
      quote: jest.fn(() => ({ totalGP: 10 })),
      convert: jest.fn(() => ({ conversionId: 'fixture' })),
      restore: jest.fn(() => ({ status: 'RESTORED' })),
      list: jest.fn(),
      findOne: jest.fn(),
    };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [ConversionsController],
      providers: [
        { provide: ConversionsService, useValue: service },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
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
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());
  const token = jwt.sign({ sub: 7, email: 'fixture@example.invalid' });
  it('does not quote or convert without authentication', async () => {
    await request(app.getHttpServer())
      .post('/inventory-conversions/quote')
      .send({ inventoryItemIds: [1] })
      .expect(401);
    await request(app.getHttpServer())
      .post('/inventory-conversions')
      .send({})
      .expect(401);
    expect(service.quote).not.toHaveBeenCalled();
    expect(service.convert).not.toHaveBeenCalled();
  });
  it('rejects duplicates, more than 100, strings, and injected userId', async () => {
    for (const body of [
      { inventoryItemIds: [1, 1] },
      { inventoryItemIds: Array.from({ length: 101 }, (_, i) => i + 1) },
      { inventoryItemIds: ['1'] },
      { inventoryItemIds: [1], userId: 99 },
    ])
      await request(app.getHttpServer())
        .post('/inventory-conversions/quote')
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(400);
    expect(service.quote).not.toHaveBeenCalled();
  });
  it('derives ownership from JWT and accepts bounded quote selection', async () => {
    await request(app.getHttpServer())
      .post('/inventory-conversions/quote')
      .set('Authorization', 'Bearer ' + token)
      .send({ inventoryItemIds: [1, 2] })
      .expect(201);
    expect(service.quote).toHaveBeenCalledWith(7, [1, 2]);
  });
  it('rejects invalid restore IDs before a state change', async () => {
    await request(app.getHttpServer())
      .post('/inventory-conversions/invalid/restore')
      .set('Authorization', 'Bearer ' + token)
      .send({})
      .expect(400);
    expect(service.restore).not.toHaveBeenCalled();
  });
  it('keeps configuration unavailable explicit', async () => {
    await request(app.getHttpServer())
      .get('/inventory-conversions/capabilities')
      .set('Authorization', 'Bearer ' + token)
      .expect(200, { enabled: false });
  });
});
