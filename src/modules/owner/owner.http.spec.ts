import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { User } from '../../entities';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { OwnerController, PublicCampaignController } from './owner.controller';
import { OwnerService } from './owner.service';
describe('owner console HTTP boundary', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'isolated-ops-http-test' }),
    token = jwt.sign({ sub: 10, av: 0 }),
    key = '44444444-4444-4444-8444-444444444444';
  const service = {
    overview: jest.fn(),
    createProcurement: jest.fn().mockResolvedValue({ id: key }),
    changeProcurement: jest.fn(),
    saveCampaign: jest.fn(),
    campaignState: jest.fn(),
    pauseSales: jest.fn(),
    publicCampaigns: jest
      .fn()
      .mockResolvedValue({ contract: 'CAMPAIGNS_V1', items: [] }),
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [OwnerController, PublicCampaignController],
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
        { provide: OwnerService, useValue: service },
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

  it('protects every operational route while keeping the safe public projection public', async () => {
    for (const path of [
      'overview',
      'orders',
      'finance',
      'audit',
      'procurements',
      'campaigns',
      'capabilities',
    ])
      await request(app.getHttpServer())
        .get('/owner/' + path)
        .expect(401);
    await request(app.getHttpServer())
      .post('/owner/procurements')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .get('/campaigns')
      .expect(200)
      .expect({ contract: 'CAMPAIGNS_V1', items: [] });
    expect(service.overview).not.toHaveBeenCalled();
  });
  const procurement = {
    skuId: 1,
    supplier: 'Test supplier',
    reference: 'TEST',
    quantity: 2,
    unitCostKRW: 300,
    expectedAt: '2026-10-01T00:00:00Z',
  };
  it('rejects role injection, unsafe quantities, invalid dates and unconfirmed state changes', async () => {
    for (const d of [
      { ...procurement, role: 'OWNER' },
      { ...procurement, quantity: 100001 },
      { ...procurement, unitCostKRW: -1 },
      { ...procurement, expectedAt: '2026-02-30T00:00:00Z' },
    ])
      await request(app.getHttpServer())
        .post('/owner/procurements')
        .set('Authorization', 'Bearer ' + token)
        .send(d)
        .expect(400);
    await request(app.getHttpServer())
      .post('/owner/procurements/' + key + '/status')
      .set('Authorization', 'Bearer ' + token)
      .send({
        expectedVersion: 1,
        action: 'RECEIVE',
        quantity: 1,
        reason: 'test',
        confirmed: false,
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/owner/pause-sales')
      .set('Authorization', 'Bearer ' + token)
      .send({ confirmation: 'yes', reason: 'test' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/owner/orders?limit=101')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    expect(service.createProcurement).not.toHaveBeenCalled();
    expect(service.changeProcurement).not.toHaveBeenCalled();
    expect(service.pauseSales).not.toHaveBeenCalled();
  });
  it('passes authenticated identity and the original retry key to the transaction', async () => {
    await request(app.getHttpServer())
      .post('/owner/procurements')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .send(procurement)
      .expect(201);
    expect(service.createProcurement).toHaveBeenCalledWith(
      { userId: 10, email: 'server@example.invalid', authVersion: 0 },
      key,
      procurement,
    );
  });
  it('rejects invalid campaign targets, lifecycle states and hidden reward fields', async () => {
    const c = {
      title: 'Test',
      body: 'Notice',
      kind: 'NOTICE',
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-10-02T00:00:00Z',
      budgetKRW: 0,
    };
    await request(app.getHttpServer())
      .post('/owner/campaigns')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...c, rewardGP: 100 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/owner/campaigns/not-a-uuid/draft')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...c, expectedVersion: 1 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/owner/campaigns/' + key + '/status')
      .set('Authorization', 'Bearer ' + token)
      .send({ expectedVersion: 1, status: 'PAID', confirmed: true })
      .expect(400);
    expect(service.saveCampaign).not.toHaveBeenCalled();
    expect(service.campaignState).not.toHaveBeenCalled();
  });
});
