import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Gacha, GachaItem, InventoryItem, Item, User, Draw } from '../entities';

export const buildTypeOrmConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST'),
  port: Number(configService.get<string>('DB_PORT')),
  username: configService.get<string>('DB_USERNAME'),
  password: configService.get<string>('DB_PASSWORD'),
  database: configService.get<string>('DB_DATABASE'),
  entities: [User, Gacha, Item, GachaItem, Draw, InventoryItem],
  // Auto-sync is acceptable for this development/demo environment.
  // In production, migrations should be used instead.
  synchronize: true,
  logging: false,
});
