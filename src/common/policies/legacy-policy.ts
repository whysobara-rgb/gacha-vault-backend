import { HttpStatus } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception';
import { ResponseCode } from '../constants/response-code.constant';

type Environment = Record<string, string | undefined>;

/** Only isolated development/test databases may execute the old API. */
export function assertLegacyTransactionsAllowed(
  env: Environment = process.env,
): void {
  if (
    !['development', 'test'].includes(env.NODE_ENV ?? '') ||
    env.ENABLE_LEGACY_TRANSACTIONS !== 'true'
  ) {
    throw new BusinessException(
      ResponseCode.FORBIDDEN,
      '기존 거래 API는 비활성 상태입니다',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** Run before connecting: this seed overwrites sample history and balances. */
export function assertDemoSeedAllowed(env: Environment = process.env): void {
  if (
    !['development', 'test'].includes(env.NODE_ENV ?? '') ||
    env.ALLOW_DEMO_SEED !== 'true' ||
    !/(_demo|_test)$/.test(env.DB_DATABASE ?? '')
  ) {
    throw new Error(
      'Demo seed requires development/test, ALLOW_DEMO_SEED=true and a database ending in _demo or _test',
    );
  }
}
