import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class AppService {
  constructor(private readonly database: DataSource) {}

  getHealth() {
    return {
      status: 'ok',
      service: 'gacha-vault-api',
      timestamp: new Date().toISOString(),
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
      // Both missing and unknown migrations mean this build/schema pair has
      // not been validated. This also prevents marking an old rollback ready.
      if (names.size !== expected.length || expected.some((n) => !names.has(n)))
        throw new Error('Build and database migration versions differ');
      return {
        ...this.getHealth(),
        status: 'ready',
        database: 'connected',
        schema: 'current',
      };
    } catch {
      // Never disclose connection strings, driver errors, or schema details.
      throw new ServiceUnavailableException('서비스 준비 상태를 확인 중입니다');
    }
  }
}
