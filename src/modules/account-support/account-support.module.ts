import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountService } from './account.service';
import { SupportService } from './support.service';
import { AccountSupportController } from './account-support.controller';
@Module({
  imports: [AuthModule],
  controllers: [AccountSupportController],
  providers: [AccountService, SupportService],
})
export class AccountSupportModule {}
