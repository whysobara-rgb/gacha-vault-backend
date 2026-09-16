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
import { OperatorRefundsController } from './operator-refunds.controller';
@Module({
  imports: [AuthModule],
  controllers: [PaymentReturnController, CommerceController, OperatorRefundsController],
  providers: [PaymentsService, RefundsService, HistoryService, DanalProvider],
})
export class CommerceModule {}
