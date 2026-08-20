import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  InventoryItem,
  ShippingRequest,
  ShippingRequestItem,
  User,
  WalletTransaction,
} from '../../entities';
import { ShippingService } from './shipping.service';
import { ShippingController } from './shipping.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryItem,
      ShippingRequest,
      ShippingRequestItem,
      User,
      WalletTransaction,
    ]),
    AuthModule,
  ],
  providers: [ShippingService],
  controllers: [ShippingController],
})
export class ShippingModule {}
