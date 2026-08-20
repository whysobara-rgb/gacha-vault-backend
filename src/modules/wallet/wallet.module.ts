import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User, WalletTransaction } from '../../entities';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([User, WalletTransaction]), AuthModule],
  providers: [WalletService],
  controllers: [WalletController],
})
export class WalletModule {}
