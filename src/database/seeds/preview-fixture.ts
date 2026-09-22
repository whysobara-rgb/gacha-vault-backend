import { DataSource } from 'typeorm';
import {
  CurrencyType,
  Gacha,
  GachaItem,
  Item,
  ItemRarity,
  User,
  WalletTransaction,
  WalletTransactionType,
} from '../../entities';

export const FIXTURE_TITLE = '[테스트 전용] 구매·개봉 확인 박스 v1';
export const FIXTURE_GRANT =
  'TEST_FIXTURE_V1: 테스트 전용 GP 10000 (현금 가치 없음)';
const prizes = [
  {
    name: '[테스트] 일반 카드',
    rarity: ItemRarity.N,
    probabilityPpm: 900000,
    isPremium: false,
  },
  {
    name: '[테스트] 프리미엄 카드',
    rarity: ItemRarity.SSR,
    probabilityPpm: 100000,
    isPremium: true,
  },
];

export function fixtureEmail(env: NodeJS.ProcessEnv): string {
  if (
    env.NODE_ENV !== 'test' ||
    env.ENABLE_TEST_FIXTURES !== 'true' ||
    env.ENABLE_GP_ORDER_PREVIEW !== 'true' ||
    env.ENABLE_LEGACY_TRANSACTIONS === 'true'
  ) {
    throw new Error(
      'Test fixture requires test environment and explicit preview/fixture opt-in',
    );
  }
  const email = env.TEST_FIXTURE_EMAIL?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'TEST_FIXTURE_EMAIL must identify an existing registered test account',
    );
  }
  return email;
}

/** CLI only. Never exposed as an HTTP top-up or signup bonus. */
export async function preparePreviewFixture(
  db: DataSource,
  env: NodeJS.ProcessEnv,
) {
  const email = fixtureEmail(env);
  return db.transaction(async (manager) => {
    // Serializes fixture creation and grants across concurrent startup processes.
    await manager.query('SELECT pg_advisory_xact_lock(1789392, 1)');
    const user = await manager.findOne(User, {
      where: { email },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user)
      throw new Error(
        'Register the selected test account before preparing fixtures',
      );
    const matches = await manager.find(Gacha, {
      where: { title: FIXTURE_TITLE },
    });
    if (matches.length > 1)
      throw new Error('Ambiguous test fixture; refusing to modify data');
    let gacha = matches[0];
    if (!gacha) {
      gacha = await manager.save(
        Gacha,
        manager.create(Gacha, {
          title: FIXTURE_TITLE,
          description:
            '기능 검증용 가상 상품입니다. 결제·배송·현금 교환 대상이 아닙니다.',
          price: 100,
          currency: CurrencyType.GP,
          active: true,
          totalStock: 10000,
          soldStockBaseline: 0,
          badgeLabel: 'TEST',
          tagline: '테스트 전용 · 일반 90% / 프리미엄 10%',
          iconName: 'inventory_2_rounded',
          accentColorHex: '#F36B45',
        }),
      );
      for (const prize of prizes) {
        const item = await manager.save(
          Item,
          manager.create(Item, {
            name: prize.name,
            rarity: prize.rarity,
            estimatedValue: 0,
            isPremium: prize.isPremium,
            conversionGP: 0,
            imageUrl: null,
          }),
        );
        await manager.save(
          GachaItem,
          manager.create(GachaItem, {
            gachaId: gacha.id,
            itemId: item.id,
            probabilityPpm: prize.probabilityPpm,
            weight: 1,
          }),
        );
      }
    } else {
      const pool = await manager.find(GachaItem, {
        where: { gachaId: gacha.id },
        relations: ['item'],
      });
      if (
        gacha.price !== 100 ||
        gacha.currency !== CurrencyType.GP ||
        !gacha.active ||
        pool.length !== 2 ||
        !prizes.every((p) =>
          pool.some(
            (row) =>
              row.probabilityPpm === p.probabilityPpm &&
              row.item.name === p.name &&
              row.item.rarity === p.rarity &&
              row.item.isPremium === p.isPremium &&
              row.item.estimatedValue === 0 &&
              row.item.conversionGP === 0,
          ),
        )
      ) {
        throw new Error(
          'Test fixture was modified; refusing to overwrite existing odds or prizes',
        );
      }
    }
    const previous = await manager.findOneBy(WalletTransaction, {
      userId: user.id,
      description: FIXTURE_GRANT,
    });
    if (!previous) {
      const balance = Number(user.coinBalance);
      if (
        !Number.isSafeInteger(balance) ||
        balance < 0 ||
        !Number.isSafeInteger(balance + 10000)
      ) {
        throw new Error('Invalid account balance');
      }
      user.coinBalance = balance + 10000;
      await manager.save(User, user);
      await manager.save(
        WalletTransaction,
        manager.create(WalletTransaction, {
          userId: user.id,
          type: WalletTransactionType.EARN,
          amount: 10000,
          balanceAfter: user.coinBalance,
          description: FIXTURE_GRANT,
        }),
      );
    }
    return { gachaId: gacha.id, granted: !previous };
  });
}
