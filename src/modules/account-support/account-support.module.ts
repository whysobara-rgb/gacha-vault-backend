import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountService } from './account.service';
import { SupportService } from './support.service';
import { AccountSupportController } from './account-support.controller';
import { ClosureReadController } from './closure-read.controller';
@Module({
  imports: [AuthModule],
  controllers: [AccountSupportController, ClosureReadController],
  providers: [AccountService, SupportService],
})
export class AccountSupportModule {}
