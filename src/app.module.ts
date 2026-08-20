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

@Module({
  imports: [
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
