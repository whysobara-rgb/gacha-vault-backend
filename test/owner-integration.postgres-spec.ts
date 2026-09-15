import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { dataSourceOptions } from '../src/config/typeorm.config';
import { User, Gacha, GachaItem, Draw } from '../src/entities';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  OwnerController,
  PublicCampaignController,
} from '../src/modules/owner/owner.controller';
import { OwnerService } from '../src/modules/owner/owner.service';
import { OwnerReviewController } from '../src/modules/owner/owner-review.controller';
import { OwnerReviewService } from '../src/modules/owner/owner-review.service';
import { OperationsController } from '../src/modules/operations/operations.controller';
import { OperationsService } from '../src/modules/operations/operations.service';
import { SupplyController } from '../src/modules/supply/supply.controller';
import { SupplyService } from '../src/modules/supply/supply.service';
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';
import { FulfillmentsController } from '../src/modules/fulfillments/fulfillments.controller';
import { FulfillmentsService } from '../src/modules/fulfillments/fulfillments.service';
import { AccountSupportController } from '../src/modules/account-support/account-support.controller';
import { AccountService } from '../src/modules/account-support/account.service';
import { SupportService } from '../src/modules/account-support/support.service';
import { GachaController } from '../src/modules/gacha/gacha.controller';
import { GachaService } from '../src/modules/gacha/gacha.service';
const db = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 8, statement_timeout: 10000 },
});
describe('owner to customer HTTP integration over PostgreSQL', () => {
  let app: INestApplication, owner: string, buyer: string, outsider: string;
  const env = { ...process.env },
    jwt = new JwtService({ secret: 'isolated-owner-integration-test' });
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw Error('Dedicated test DB required');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_OPERATIONS_PREVIEW: 'true',
      ENABLE_GP_ORDER_PREVIEW: 'true',
      ENABLE_SHIPPING_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      SHIPPING_RATE_TABLE_JSON: JSON.stringify([
        { id: 'test', label: 'Test only', prefixes: ['*'], feeGP: 100 },
      ]),
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    const ops = new OperationsService(db);
    const services = [
      [OperationsService, ops],
      [OwnerService, new OwnerService(db, ops)],
      [OwnerReviewService, new OwnerReviewService(db, ops)],
      [SupplyService, new SupplyService(db, ops)],
      [OrdersService, new OrdersService(db)],
      [FulfillmentsService, new FulfillmentsService(db)],
      [AccountService, new AccountService(db)],
      [SupportService, new SupportService(db)],
      [
        GachaService,
        new GachaService(
          db.getRepository(Gacha),
          db.getRepository(GachaItem),
          db.getRepository(Draw),
        ),
      ],
    ];
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [
        OwnerController,
        PublicCampaignController,
        OwnerReviewController,
        OperationsController,
        SupplyController,
        OrdersController,
        FulfillmentsController,
        AccountSupportController,
        GachaController,
      ],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: 'isolated-owner-integration-test',
          }),
        },
        { provide: getRepositoryToken(User), useValue: db.getRepository(User) },
        ...services.map(([provide, useValue]) => ({
          provide: provide as any,
          useValue,
        })),
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    async function user(isOwner = false) {
      const [u] = await db.query(
        `INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'integration',10000) RETURNING id`,
        [randomUUID() + '@example.invalid'],
      );
      if (isOwner) {
        for (const p of [
          'OWNER',
          'CATALOG',
          'FULFILLMENT',
          'WAREHOUSE',
          'ANNOUNCEMENTS',
        ])
          await db.query(
            'INSERT INTO operations_permissions(user_id,permission) VALUES($1,$2)',
            [u.id, p],
          );
        await db.query('INSERT INTO support_staff(user_id) VALUES($1)', [u.id]);
      }
      return jwt.sign({ sub: u.id, av: 0 });
    }
    owner = await user(true);
    buyer = await user();
    outsider = await user();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  async function call(
    method: 'get' | 'post',
    path: string,
    token: string | null,
    data?: any,
    expected = method === 'post' ? 201 : 200,
    key = randomUUID(),
  ) {
    let r = request(app.getHttpServer())[method](path);
    if (token) r = r.set('Authorization', 'Bearer ' + token);
    if (method === 'post') r = r.set('idempotency-key', key).send(data ?? {});
    const result = await r;
    expect({
      path,
      status: result.status,
      body: result.status === expected ? undefined : result.body,
    }).toEqual({ path, status: expected, body: undefined });
    if (expected < 300) expect(result.body.statusCode).toBe(10000);
    return result.body.data;
  }
  it('publishes a box and banner, purchases old odds, ships it, answers a ticket and tracks a case without leaking internal data', async () => {
    const sku = await call('post', '/ops/warehouse/skus', owner, {
      code: 'HTTP-' + randomUUID().slice(0, 8).toUpperCase(),
      name: 'HTTP physical product',
      reorderPoint: 2,
    });
    await call('post', `/ops/warehouse/skus/${sku.skuId}/movements`, owner, {
      expectedVersion: sku.version,
      kind: 'RECEIVE',
      quantity: 20,
      reason: 'Checked test stock',
    });
    const config = {
      title: 'HTTP trace box',
      category: 'tech',
      description: 'test catalog',
      imageUrl: null,
      price: 100,
      totalStock: 10,
      saleType: 'STANDARD',
      entries: [
        {
          name: 'Original prize',
          rarity: 'N',
          imageUrl: null,
          estimatedValue: 100,
          isPremium: false,
          probabilityPpm: 1000000,
          fulfillmentType: 'PHYSICAL',
          shippingEnabled: true,
          warehouseSkuId: sku.skuId,
        },
      ],
    };
    const draft = await call('post', '/ops/catalog', owner, { config });
    const published = await call(
      'post',
      `/ops/catalog/${draft.gachaId}/publish`,
      owner,
      { expectedVersion: draft.version, confirmation: '판매 설정 적용' },
    );
    const active = await call(
      'post',
      `/ops/catalog/${draft.gachaId}/availability`,
      owner,
      { expectedVersion: published.version, active: true },
    );
    expect(
      (await call('get', `/gachas/${draft.gachaId}`, buyer)).category,
    ).toBe('tech');
    const campaign = {
      title: 'HTTP home banner',
      body: 'Published terms',
      kind: 'SHOWCASE',
      gachaId: draft.gachaId,
      startsAt: new Date(Date.now() - 10000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      budgetKRW: 5000,
      imageUrl: 'https://example.invalid/hero.png',
      homeVisible: true,
      sortOrder: 1,
    };
    const c = await call('post', '/owner/campaigns', owner, campaign);
    await call('post', `/owner/campaigns/${c.id}/status`, owner, {
      expectedVersion: 1,
      status: 'PUBLISHED',
      confirmed: true,
    });
    const publicCampaign = (await call('get', '/campaigns', null)).items.find(
      (x) => x.id === c.id,
    );
    expect(publicCampaign).toMatchObject({
      homeVisible: true,
      sortOrder: 1,
      imageUrl: campaign.imageUrl,
    });
    expect(publicCampaign).not.toHaveProperty('budgetKRW');
    const odds = await call('get', `/gachas/${draft.gachaId}/odds`, buyer);
    const order = await call('post', '/orders/gp', buyer, {
      gachaId: draft.gachaId,
      quantity: 1,
      expectedUnitPrice: odds.unitPrice,
      expectedProbabilityVersion: odds.version,
    });
    // Change the catalog after purchase; customer opening and owner trace must retain the purchased snapshot.
    const changed = await call(
      'post',
      `/ops/catalog/${draft.gachaId}/draft`,
      owner,
      {
        expectedVersion: active.version,
        config: {
          ...config,
          category: 'home',
          entries: [{ ...config.entries[0], name: 'New prize' }],
        },
      },
    );
    await call('post', `/ops/catalog/${draft.gachaId}/publish`, owner, {
      expectedVersion: changed.version,
      confirmation: '판매 설정 적용',
    });
    const opening = await call(
      'post',
      `/capsules/${order.capsules[0].id}/open`,
      buyer,
    );
    expect(opening.prize.name).toBe('Original prize');
    expect(
      (await call('get', `/gachas/${draft.gachaId}`, buyer)).category,
    ).toBe('home');
    const recipient = {
      name: 'Test recipient',
      phone: '01000000000',
      postalCode: '00000',
      address1: 'Test address',
      address2: '101',
      notes: '',
      country: 'KR',
    };
    const quote = await call('post', '/fulfillments/quotes', buyer, {
      inventoryItemIds: [opening.inventoryItemId],
      recipient,
    });
    const parcel = await call('post', '/fulfillments', buyer, {
      quoteId: quote.quoteId,
    });
    const preparing = await call(
      'post',
      `/ops/fulfillments/${parcel.fulfillmentId}/status`,
      owner,
      { expectedVersion: 1, status: 'PREPARING' },
    );
    await call(
      'post',
      `/ops/fulfillments/${parcel.fulfillmentId}/status`,
      owner,
      {
        expectedVersion: preparing.version,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST12345',
      },
    );
    expect(
      await call('get', `/fulfillments/${parcel.fulfillmentId}`, buyer),
    ).toMatchObject({
      status: 'COLLECTED',
      carrier: 'CJ',
      trackingNumber: 'TEST12345',
    });
    const ticket = await call('post', '/support/tickets', buyer, {
      category: 'SHIPPING',
      subject: '상품 문의',
      body: '출고를 확인해주세요',
      orderId: order.orderId,
    });
    await call(
      'post',
      `/staff/support/tickets/${ticket.ticketId}/messages`,
      owner,
      { body: '택배사 인계 확인했습니다' },
    );
    expect(
      (
        await call('get', `/support/tickets/${ticket.ticketId}`, buyer)
      ).messages.at(-1).body,
    ).toBe('택배사 인계 확인했습니다');
    const privateNotes = {
      orderId: order.orderId,
      ticketId: ticket.ticketId,
      kind: 'OTHER',
      summary: '출고 확인 요청을 처리 중입니다',
      internalNote: 'PRIVATE supplier note',
      externalReference: 'PRIVATE-REFERENCE',
    };
    const k = randomUUID(),
      caseRow = await call('post', '/owner/cases', owner, privateNotes, 201, k);
    expect(
      await call('post', '/owner/cases', owner, privateNotes, 201, k),
    ).toEqual(caseRow);
    await call('post', `/owner/cases/${caseRow.id}`, owner, {
      expectedVersion: 1,
      status: 'CLOSED',
      summary: '확인이 완료되었습니다',
      internalNote: '실제 처리 확인',
      externalReference: 'EXT-001',
      reason: '처리 결과 확인',
    });
    const trace = await call('get', `/owner/orders/${order.orderId}`, owner);
    expect(trace.order.probabilityVersion).toBe(odds.version);
    expect(trace.capsules[0].prize.name).toBe('Original prize');
    expect(trace.shipments[0].trackingNumber).toBe('TEST12345');
    expect(trace.tickets[0].id).toBe(ticket.ticketId);
    expect(trace.cases[0].status).toBe('CLOSED');
    expect(trace.audit.length).toBeGreaterThan(0);
    expect(
      (
        await call(
          'get',
          `/owner/trace?kind=shipment&reference=${parcel.fulfillmentId}`,
          owner,
        )
      ).orders[0].id,
    ).toBe(order.orderId);
    const publicCases = await call(
      'get',
      '/support/cases?page=1&limit=20',
      buyer,
    );
    expect(publicCases.items[0].status).toBe('CLOSED');
    expect(JSON.stringify(publicCases)).not.toMatch(
      /PRIVATE|internalNote|externalReference/,
    );
    expect(
      (await call('get', '/support/cases?page=1&limit=20', outsider)).items,
    ).toEqual([]);
    await call('get', `/owner/orders/${order.orderId}`, buyer, undefined, 403);
    await call('get', `/orders/${order.orderId}`, outsider, undefined, 404);
    await call(
      'get',
      `/fulfillments/${parcel.fulfillmentId}`,
      outsider,
      undefined,
      404,
    );
    await call(
      'post',
      '/owner/cases',
      owner,
      { ...privateNotes, role: 'OWNER' },
      400,
    );
    await call(
      'get',
      '/owner/trace?kind=users&reference=' + randomUUID(),
      owner,
      undefined,
      400,
    );
    await call('post', '/owner/cases', null, privateNotes, 401);
  }, 30000);
});
