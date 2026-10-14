import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { configureHttp } from './config/http.config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  let docsEnabled = false;
  try {
    ({ docsEnabled } = configureHttp(app, {
      NODE_ENV: config.get<string>('NODE_ENV'),
      CORS_ALLOWED_ORIGINS: config.get<string>('CORS_ALLOWED_ORIGINS'),
      ENABLE_API_DOCS: config.get<string>('ENABLE_API_DOCS'),
    }));
  } catch (error) {
    await app.close();
    throw error;
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`🚀 Gacha Vault API is running on port ${port}`);
  if (docsEnabled) {
    // eslint-disable-next-line no-console
    console.log(`📖 Swagger docs available at /docs`);
  }
}
bootstrap();
