import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import {
  Gacha,
  GachaItem,
  InventoryItem,
  Item,
  User,
  Draw,
  ShippingRequest,
  ShippingRequestItem,
  WalletTransaction,
  CapsuleOrder,
  OwnedCapsule,
} from '../entities';

const entities = [
  User,
  Gacha,
  Item,
  GachaItem,
  Draw,
  InventoryItem,
  ShippingRequest,
  ShippingRequestItem,
  WalletTransaction,
  CapsuleOrder,
  OwnedCapsule,
];

export const buildTypeOrmConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST'),
  port: Number(configService.get<string>('DB_PORT')),
  username: configService.get<string>('DB_USERNAME'),
  password: configService.get<string>('DB_PASSWORD'),
  database: configService.get<string>('DB_DATABASE'),
  entities,
  migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
  // All environments use explicit migrations; startup never changes schema.
  synchronize: false,
  logging: false,
});

/**
 * DataSource options reused by the TypeORM CLI for generating/running
 * migrations (`typeorm migration:generate` / `migration:run`).
 * Kept in sync with buildTypeOrmConfig's connection settings.
 */
export const dataSourceOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  entities,
  migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
  synchronize: false,
};
