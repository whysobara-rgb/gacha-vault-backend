import { OwnerReviewService } from './owner-review.service';
import { OwnerReviewController } from './owner-review.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperationsModule } from '../operations/operations.module';
import { OwnerController, PublicCampaignController } from './owner.controller';
import { OwnerService } from './owner.service';
@Module({
  imports: [AuthModule, OperationsModule],
  controllers: [
    OwnerReviewController,
    OwnerController,
    PublicCampaignController,
  ],
  providers: [OwnerReviewService, OwnerService],
})
export class OwnerModule {}
