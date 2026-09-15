import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  CommerceController,
  PaymentReturnController,
} from './commerce.controller';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { HistoryService } from './history.service';
import { DanalProvider } from './danal.provider';
@Module({
  imports: [AuthModule],
  controllers: [PaymentReturnController, CommerceController],
  providers: [PaymentsService, RefundsService, HistoryService, DanalProvider],
})
export class CommerceModule {}
