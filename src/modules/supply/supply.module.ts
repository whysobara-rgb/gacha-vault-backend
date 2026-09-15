import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperationsModule } from '../operations/operations.module';
import { SupplyService } from './supply.service';
import { SupplyController } from './supply.controller';
@Module({
  imports: [AuthModule, OperationsModule],
  providers: [SupplyService],
  controllers: [SupplyController],
})
export class SupplyModule {}
