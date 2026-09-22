import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';

describe('deployment readiness HTTP gate', () => {
  let app: INestApplication;
  const database = {
    isInitialized: true,
    migrations: [{ name: 'First' }, { name: 'Second' }],
    query: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: DataSource, useValue: database }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  beforeEach(() => {
    database.isInitialized = true;
    database.migrations = [{ name: 'First' }, { name: 'Second' }];
    database.query.mockReset().mockResolvedValue(database.migrations);
  });
  afterAll(async () => app.close());

  it('marks only a connected database with the exact migration set ready', async () => {
    const r = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.data).toMatchObject({ status: 'ready', schema: 'current' });
    expect(database.query).toHaveBeenCalledWith('SELECT name FROM migrations');
  });
  it('rejects a partially migrated database', async () => {
    database.query.mockResolvedValue([{ name: 'First' }]);
    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });
  it('rejects a schema newer than a rolled-back application build', async () => {
    database.query.mockResolvedValue([
      ...database.migrations,
      { name: 'Third' },
    ]);
    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });
  it('does not disclose driver errors or credentials when the DB is unavailable', async () => {
    database.query.mockRejectedValue(
      new Error('postgres://private:secret@db/users'),
    );
    const r = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(r.body.message).toBe('서비스 준비 상태를 확인 중입니다');
    expect(JSON.stringify(r.body)).not.toMatch(/private|secret|postgres/);
  });
  it('requires a loaded migration manifest and initialized connection', async () => {
    database.isInitialized = false;
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    database.isInitialized = true;
    database.migrations = [];
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(database.query).not.toHaveBeenCalled();
  });
  it('keeps liveness independent of DB readiness', async () => {
    database.isInitialized = false;
    const r = await request(app.getHttpServer()).get('/health').expect(200);
    expect(r.body.data.status).toBe('ok');
    expect(database.query).not.toHaveBeenCalled();
  });
});
