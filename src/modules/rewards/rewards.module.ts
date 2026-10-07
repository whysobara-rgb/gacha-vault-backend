import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceCheckin, User, WalletTransaction } from '../../entities';
import { AuthModule } from '../auth/auth.module';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttendanceCheckin, User, WalletTransaction]),
    AuthModule,
  ],
  controllers: [RewardsController],
  providers: [RewardsService],
})
export class RewardsModule {}
