import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Gacha, GachaItem, GachaPityCounter, Item } from '../../entities';
import { AuthModule } from '../auth/auth.module';
import { GachaController } from './gacha.controller';
import { GachaService } from './gacha.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Gacha, GachaItem, GachaPityCounter, Item]),
    AuthModule,
  ],
  controllers: [GachaController],
  providers: [GachaService],
  exports: [GachaService],
})
export class GachaModule {}
