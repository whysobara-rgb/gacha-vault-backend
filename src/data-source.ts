/**
 * DataSource entry point for the TypeORM CLI (migration:generate / run / revert).
 * Usage:
 *   npm run migration:generate -- src/database/migrations/InitSchema
 *   npm run migration:run
 *   npm run migration:revert
 *
 * IMPORTANT: dotenv.config() MUST run before importing dataSourceOptions,
 * since that module reads process.env.DB_* at import-time (top-level
 * object literal), not lazily inside a function.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line import/first
import { DataSource } from 'typeorm';
// eslint-disable-next-line import/first
import { dataSourceOptions } from './config/typeorm.config';

export default new DataSource(dataSourceOptions);
