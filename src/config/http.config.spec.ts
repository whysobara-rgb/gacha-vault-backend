import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PaymentReturnController } from '../modules/commerce/commerce.controller';
import { configureHttp, HttpEnvironment, readHttpPolicy } from './http.config';

@Controller()
class ProbeController {
  @Get('probe') probe() {
    return { ok: true };
  }
  @Get('docs-evil') lookalike() {
    return { ok: true };
  }
}

describe('HTTP boundary configuration', () => {
  let app: INestApplication;
  async function start(env: HttpEnvironment) {
    const module = await Test.createTestingModule({
      controllers: [ProbeController, PaymentReturnController],
    }).compile();
    app = module.createNestApplication({ logger: false });
    configureHttp(app, env);
    await app.init();
    return app.getHttpServer();
  }
  afterEach(async () => {
    await app?.close();
  });

  it('permits only the exact configured origin and administrator preflight headers', async () => {
    const server = await start({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://admin.example.test',
    });
    const response = await request(server)
      .options('/probe')
      .set('Origin', 'https://admin.example.test')
      .set('Access-Control-Request-Method', 'PATCH')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,idempotency-key,x-admin-session,x-admin-action',
      )
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://admin.example.test',
    );
    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
    expect(response.headers.vary).toContain('Origin');
    const headers = response.headers['access-control-allow-headers']
      .toLowerCase()
      .split(',');
    for (const name of [
      'authorization',
      'content-type',
      'idempotency-key',
      'x-admin-session',
      'x-admin-action',
    ]) {
      expect(headers).toContain(name);
    }
    expect(response.headers['access-control-allow-methods']).toContain('PATCH');
    const get = await request(server)
      .get('/probe')
      .set('Origin', 'https://admin.example.test')
      .expect(200);
    expect(get.headers['access-control-allow-origin']).toBe(
      'https://admin.example.test',
    );
  });

  it.each([
    'https://attacker.test',
    'https://admin.example.test.attacker.test',
    'https://other.admin.example.test',
    'http://admin.example.test',
    'https://admin.example.test:444',
    'null',
  ])('does not grant browser access to %s', async (origin) => {
    const server = await start({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://admin.example.test',
    });
    for (const method of ['get', 'options'] as const) {
      const response = await request(server)
        [method]('/probe')
        .set('Origin', origin);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(
        response.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    }
  });

  it('defaults to no cross-origin permission while preserving native/no-Origin requests', async () => {
    const server = await start({ NODE_ENV: 'production' });
    await request(server).get('/probe').expect(200);
    const response = await request(server)
      .get('/probe')
      .set('Origin', 'https://admin.example.test')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
  });

  it.each(['production', 'staging', undefined])(
    'never registers docs in %s even when enabled',
    async (NODE_ENV) => {
      const server = await start({ NODE_ENV, ENABLE_API_DOCS: 'true' });
      for (const path of [
        '/docs',
        '/docs/',
        '/docs-json',
        '/docs-yaml',
        '/docs/swagger-ui-init.js',
      ]) {
        const response = await request(server).get(path).expect(404);
        expect(response.headers['content-security-policy']).toContain(
          "script-src 'self';",
        );
      }
    },
  );

  it('requires explicit opt-in for development API documents', async () => {
    const server = await start({ NODE_ENV: 'development' });
    await request(server).get('/docs').expect(404);
    await request(server).get('/docs-json').expect(404);
  });

  it('serves opted-in local Swagger with a CSP exception confined to its route segment', async () => {
    const server = await start({
      NODE_ENV: 'development',
      ENABLE_API_DOCS: 'true',
    });
    const docs = await request(server).get('/docs/').expect(200);
    expect(docs.headers['content-security-policy']).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(docs.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(docs.headers['x-content-type-options']).toBe('nosniff');
    const api = await request(server).get('/docs-json').expect(200);
    expect(api.body.openapi).toBeDefined();
    for (const path of ['/docs-json', '/probe', '/docs-evil']) {
      const response = await request(server).get(path).expect(200);
      expect(response.headers['content-security-policy']).toContain(
        "script-src 'self';",
      );
    }
  });

  it('preserves the real PG form-return redirect for an unlisted Origin', async () => {
    const server = await start({ NODE_ENV: 'production' });
    const response = await request(server)
      .post('/payments/return')
      .set('Origin', 'https://pg.example.test')
      .type('form')
      .send({ orderId: '11111111-1111-4111-8111-111111111111', code: '0000' })
      .expect(303);
    expect(response.headers.location).toContain(
      '/#payment-return/11111111-1111-4111-8111-111111111111',
    );
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'self';",
    );
  });

  it.each([
    '*',
    'null',
    'https://*.example.test',
    'https://admin.test/path',
    'https://admin.test/',
    'https://admin.test?token=secret',
    'https://admin.test#x',
    'https://private:secret@admin.test',
    'https://admin.test,',
    'http://admin.test',
  ])(
    'rejects malformed/unsafe production allowlists without echoing secrets: %s',
    (CORS_ALLOWED_ORIGINS) => {
      expect(() =>
        readHttpPolicy({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS }),
      ).toThrow('CORS_ALLOWED_ORIGINS');
      try {
        readHttpPolicy({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS });
      } catch (error) {
        expect(String(error)).not.toMatch(/private|secret/);
      }
    },
  );

  it('accepts multiple exact origins, and local HTTP only in explicit development/test', () => {
    const env = {
      NODE_ENV: 'test',
      CORS_ALLOWED_ORIGINS:
        'http://localhost:5173, https://admin.test,https://admin.test',
    };
    expect([...readHttpPolicy(env).origins]).toEqual([
      'http://localhost:5173',
      'https://admin.test',
    ]);
    expect(() => readHttpPolicy({ ...env, NODE_ENV: undefined })).toThrow();
    expect(() =>
      readHttpPolicy({ NODE_ENV: 'test', ENABLE_API_DOCS: 'yes' }),
    ).toThrow('ENABLE_API_DOCS');
  });
});
