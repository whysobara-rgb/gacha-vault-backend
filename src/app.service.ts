import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { releaseIdentity } from './config/release-identity';

@Injectable()
export class AppService {
  private readonly release = releaseIdentity();
  constructor(private readonly database: DataSource) {}

  getHealth() {
    return {
      status: 'ok',
      service: 'gacha-vault-api',
      timestamp: new Date().toISOString(),
      release: { ...this.release },
    };
  }

  /** Read-only deployment gate; it neither migrates nor changes user data. */
  async getReadiness() {
    try {
      if (!this.database.isInitialized || !this.database.migrations.length)
        throw new Error('Database or migration manifest unavailable');
      const expected = this.database.migrations.map(
        (m) => m.name || m.constructor.name,
      );
      const applied: { name: string }[] = await this.database.query(
        'SELECT name FROM migrations',
      );
      const names = new Set(applied.map((m) => m.name));
      if (names.size !== expected.length || expected.some((n) => !names.has(n)))
        throw new Error('Build and database migration versions differ');
      return {
        ...this.getHealth(),
        status: 'ready',
        database: 'connected',
        schema: 'current',
      };
    } catch {
      throw new ServiceUnavailableException('서비스 준비 상태를 확인 중입니다');
    }
  }
}
