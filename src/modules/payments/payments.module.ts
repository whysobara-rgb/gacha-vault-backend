import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { TossPaymentsClient } from './toss-payments.client';

@Module({
  imports: [AuthModule, WalletModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, TossPaymentsClient],
})
export class PaymentsModule {}
