import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
import { RecoveryMailer } from './recovery.mailer';
@Module({
  imports: [AuthModule],
  controllers: [RecoveryController],
  providers: [RecoveryService, RecoveryMailer],
})
export class RecoveryModule {}
