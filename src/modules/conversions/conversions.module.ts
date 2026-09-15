import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';
@Module({
  imports: [AuthModule],
  controllers: [ConversionsController],
  providers: [ConversionsService],
})
export class ConversionsModule {}
