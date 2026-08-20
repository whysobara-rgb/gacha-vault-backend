import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(
    helmet({
      // Swagger UI needs inline scripts/styles; relax CSP only for /docs.
      contentSecurityPolicy: false,
    }),
  );

  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  // --- Swagger (OpenAPI) docs -------------------------------------------
  const swaggerConfig = new DocumentBuilder()
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
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`🚀 Gacha Vault API is running on port ${port}`);
  // eslint-disable-next-line no-console
  console.log(`📖 Swagger docs available at /docs`);
}
bootstrap();
