import { User } from '../../entities';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { InventoryItem, InventoryStatus } from '../../entities';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('authenticated inventory lock HTTP contract', () => {
  let app: INestApplication;
  const secret = 'isolated-test-secret-not-for-real-deployment';
  const jwt = new JwtService({ secret });
  const save = jest.fn(async (item) => item);
  let item: { id: number; isLocked: boolean; status: InventoryStatus };
  beforeAll(async () => {
    const manager = {
      transaction: async (callback) =>
        callback({
          getRepository: () => ({
            save,
            createQueryBuilder: () => {
              let owner: number;
              let id: number;
              const query = {
                setLock: () => query,
                where: (_sql, params) => {
                  id = params.inventoryItemId;
                  return query;
                },
                andWhere: (_sql, params) => {
                  owner = params.userId;
                  return query;
                },
                getOne: async () => (owner === 10 && id === 7 ? item : null),
              };
              return query;
            },
          }),
        }),
    };
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [InventoryController],
      providers: [
        InventoryService,
        JwtAuthGuard,
        JwtStrategy,
        {provide:getRepositoryToken(User),useValue:{findOne:async({where}:any)=>({id:where.id,email:"http@example.invalid",authVersion:0})}},
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        { provide: getRepositoryToken(InventoryItem), useValue: { manager } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  beforeEach(() => {
    save.mockClear();
    item = { id: 7, isLocked: false, status: InventoryStatus.STORED };
  });
  afterAll(async () => {
    await app.close();
  });
  const token = (sub: number) => jwt.sign({ sub, email: 'test@example.test' });
  it('requires a valid bearer token', async () => {
    await request(app.getHttpServer())
      .put('/inventory/7/lock')
      .send({ locked: true })
      .expect(401);
    expect(save).not.toHaveBeenCalled();
  });
  it('returns 404 for another owner without writing', async () => {
    await request(app.getHttpServer())
      .put('/inventory/7/lock')
      .set('Authorization', `Bearer ${token(11)}`)
      .send({ locked: true })
      .expect(404);
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects string booleans instead of coercing false into true', async () => {
    await request(app.getHttpServer())
      .put('/inventory/7/lock')
      .set('Authorization', `Bearer ${token(10)}`)
      .send({ locked: 'false' })
      .expect(400);
    expect(save).not.toHaveBeenCalled();
  });
  it('repeated PUT sets the same state and returns the persisted value', async () => {
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .put('/inventory/7/lock')
        .set('Authorization', `Bearer ${token(10)}`)
        .send({ locked: true })
        .expect(200, { inventoryItemId: 7, isLocked: true, status: 'STORED' });
    }
    expect(save).toHaveBeenCalledTimes(1);
  });
});
