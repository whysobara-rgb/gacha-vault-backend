import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

export interface HttpEnvironment {
  NODE_ENV?: string;
  CORS_ALLOWED_ORIGINS?: string;
  ENABLE_API_DOCS?: string;
}

export function readHttpPolicy(env: HttpEnvironment) {
  const local = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const raw = env.CORS_ALLOWED_ORIGINS?.trim();
  const origins = raw ? raw.split(',').map((entry) => entry.trim()) : [];
  for (const origin of origins) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid =
        origin === url.origin &&
        !origin.includes('*') &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' || (local && url.protocol === 'http:'));
    } catch {
      // Keep raw values, including accidentally pasted credentials, out of logs.
    }
    if (!valid) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS must contain exact HTTPS origins without paths or credentials; HTTP is allowed only in development/test',
      );
    }
  }
  if (
    env.ENABLE_API_DOCS !== undefined &&
    !['true', 'false'].includes(env.ENABLE_API_DOCS)
  ) {
    throw new Error('ENABLE_API_DOCS must be true or false');
  }
  return {
    origins: new Set(origins),
    // Production and unknown environments cannot expose docs by opting in.
    docsEnabled: local && env.ENABLE_API_DOCS === 'true',
  };
}

/** Call after ConfigModule has loaded the application's environment. */
export function configureHttp(app: INestApplication, env: HttpEnvironment) {
  const policy = readHttpPolicy(env);
  const standardHeaders = helmet();
  const docsHeaders = helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // Local Swagger assets must remain usable on an HTTP dev server.
        upgradeInsecureRequests: null,
      },
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path.toLowerCase();
    const isDocs = path === '/docs' || path.startsWith('/docs/');
    return (policy.docsEnabled && isDocs ? docsHeaders : standardHeaders)(
      req,
      res,
      next,
    );
  });
  app.enableCors({
    origin: (origin, callback) => {
      // No Origin is normal for native clients and health probes. CORS is
      // browser response permission, not authentication or a PG callback gate.
      callback(null, origin === undefined || policy.origins.has(origin));
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Admin-Session',
      'X-Admin-Action',
    ],
    maxAge: 600,
  });

  if (policy.docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('가치가차 (Gacha Vault) API')
      .setDescription(
        '가치가차 앱 REST API 문서. 모든 성공 응답은 ' +
          '{ statusCode: 10000, message: "success", data } 형태로 감싸지며, ' +
          '에러 응답은 { statusCode, message, errors[], url } 형태입니다. ' +
          'JWT 인증이 필요한 엔드포인트는 상단 Authorize 버튼으로 Bearer 토큰을 설정하세요.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      .addTag('auth', '회원가입/로그인')
      .addTag('users', '사용자 프로필')
      .addTag('gachas', '가차(랜덤박스) 목록')
      .addTag('draws', '가차 뽑기')
      .addTag('inventory', '인벤토리(보관함)')
      .addTag('shipping-requests', '배송 신청')
      .addTag('wallet', '지갑(GP)/포인트 내역')
      .addTag('rankings', '랭킹(유저/인기박스/실시간당첨)')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }
  return policy;
}
