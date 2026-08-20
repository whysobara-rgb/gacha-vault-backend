import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Draw, Gacha, GachaItem, InventoryItem, User } from '../../entities';
import { AuthModule } from '../auth/auth.module';
import { DrawsController } from './draws.controller';
import { DrawsService } from './draws.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Draw, Gacha, GachaItem, InventoryItem, User]),
    AuthModule,
  ],
  controllers: [DrawsController],
  providers: [DrawsService],
})
export class DrawsModule {}
