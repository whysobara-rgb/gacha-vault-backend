import {
  assertDemoSeedAllowed,
  assertLegacyTransactionsAllowed,
} from './legacy-policy';

describe('legacy API and destructive demo seed guards', () => {
  it.each([undefined, '', 'production', 'staging', 'prod'])(
    'blocks legacy writes in %s even with opt-in',
    (NODE_ENV) => {
      expect(() =>
        assertLegacyTransactionsAllowed({
          NODE_ENV,
          ENABLE_LEGACY_TRANSACTIONS: 'true',
        }),
      ).toThrow();
    },
  );
  it.each(['development', 'test'])(
    'requires explicit opt-in in %s',
    (NODE_ENV) => {
      expect(() => assertLegacyTransactionsAllowed({ NODE_ENV })).toThrow();
      expect(() =>
        assertLegacyTransactionsAllowed({
          NODE_ENV,
          ENABLE_LEGACY_TRANSACTIONS: 'true',
        }),
      ).not.toThrow();
    },
  );
  it('never permits a production seed or an unmarked database', () => {
    expect(() =>
      assertDemoSeedAllowed({
        NODE_ENV: 'production',
        ALLOW_DEMO_SEED: 'true',
        DB_DATABASE: 'gacha_test',
      }),
    ).toThrow();
    expect(() =>
      assertDemoSeedAllowed({
        NODE_ENV: 'development',
        ALLOW_DEMO_SEED: 'true',
        DB_DATABASE: 'gacha',
      }),
    ).toThrow();
    expect(() =>
      assertDemoSeedAllowed({
        NODE_ENV: 'test',
        ALLOW_DEMO_SEED: 'true',
        DB_DATABASE: 'gacha_test',
      }),
    ).not.toThrow();
  });
});
