import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      status: 'ok',
      service: 'gacha-vault-api',
      timestamp: new Date().toISOString(),
    };
  }
}
