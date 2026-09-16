import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AdminSecurityController } from './admin-security.controller';
import { AdminSecurityService } from './admin-security.service';
import { AdminSecurityInterceptor } from './admin-security.interceptor';
@Module({
  imports: [AuthModule], controllers: [AdminSecurityController],
  providers: [AdminSecurityService, { provide: APP_INTERCEPTOR, useClass: AdminSecurityInterceptor }],
  exports: [AdminSecurityService],
})
export class AdminSecurityModule {}
