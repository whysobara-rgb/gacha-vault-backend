import { RecoveryModule } from './modules/account-recovery/recovery.module';
import { OwnerModule } from './modules/owner/owner.module';
import { SupplyModule } from './modules/supply/supply.module';
import { CommerceModule } from './modules/commerce/commerce.module';
import { FulfillmentsModule } from './modules/fulfillments/fulfillments.module';
import { ConversionsModule } from './modules/conversions/conversions.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { buildTypeOrmConfig } from './config/typeorm.config';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { GachaModule } from './modules/gacha/gacha.module';
import { DrawsModule } from './modules/draws/draws.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { RankingsModule } from './modules/rankings/rankings.module';

import { OrdersModule } from './modules/orders/orders.module';
import { AccountSupportModule } from './modules/account-support/account-support.module';
import { OperationsModule } from './modules/operations/operations.module';

@Module({
  imports: [
    OwnerModule,
    OperationsModule,
    SupplyModule,
    RecoveryModule,
    AccountSupportModule,
    CommerceModule,
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildTypeOrmConfig,
    }),
    AuthModule,
    UsersModule,
    GachaModule,
    DrawsModule,
    InventoryModule,
    ShippingModule,
    WalletModule,
    RankingsModule,
    OrdersModule,
    ConversionsModule,
    FulfillmentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
