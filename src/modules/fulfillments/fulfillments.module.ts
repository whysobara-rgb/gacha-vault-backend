import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FulfillmentsController } from './fulfillments.controller';
import { FulfillmentsService } from './fulfillments.service';
@Module({
  imports: [AuthModule],
  controllers: [FulfillmentsController],
  providers: [FulfillmentsService],
})
export class FulfillmentsModule {}
