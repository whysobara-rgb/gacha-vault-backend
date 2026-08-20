import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Gacha, GachaItem, Item, Draw } from '../../entities';
import { GachaController } from './gacha.controller';
import { GachaService } from './gacha.service';

@Module({
  imports: [TypeOrmModule.forFeature([Gacha, GachaItem, Item, Draw])],
  controllers: [GachaController],
  providers: [GachaService],
  exports: [GachaService],
})
export class GachaModule {}
