/**
 * Seed script — loads the launch catalog (launch-catalog.ts) and demo data:
 *   - 8 launch boxes. Drop weights are solved per box for its target payout
 *     ratio (pity included); items in the same tier share the tier's odds.
 *     Boxes that are not in the catalog are deactivated (kept for history).
 *   - Launch banners pointing at real mechanics.
 *   - Demo accounts: demo@gachivault.com / Password1 (GP for testing).
 *   - soldCount recomputed from the draws actually made.
 *
 * Never run against production: it creates demo accounts and resets odds.
 * Usage: npm run seed (after npm run migration:run)
 */
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import {
  User,
  Gacha,
  Item,
  GachaItem,
  Draw,
  InventoryItem,
  ShippingRequest,
  ShippingRequestItem,
  WalletTransaction,
  GachaPityCounter,
  AttendanceCheckin,
  Banner,
  CurrencyType,
  ItemRarity,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import {
  solveTierWeights,
  summarizeEconomy,
} from '../../modules/gacha/gacha-economy';
import { TARGET_PAYOUT_RATIO } from '../../common/constants/economy.constant';
import { CatalogBox, LAUNCH_BANNERS, LAUNCH_CATALOG } from './launch-catalog';

dotenv.config();

const DEMO_BALANCE = 100000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BalancedItem {
  name: string;
  rarity: ItemRarity;
  value: number;
  weight: number;
}

/**
 * Solves tier weights for the box's target payout ratio, then splits each
 * tier's weight evenly across its items (remainder to the first ones).
 * Refuses a box whose draw → 포인트 전환 loop would return >= 100%.
 */
function balanceBox(box: CatalogBox): BalancedItem[] {
  const tiers = new Map<ItemRarity, CatalogBox['items']>();
  for (const item of box.items) {
    tiers.set(item.rarity, [...(tiers.get(item.rarity) ?? []), item]);
  }
  for (const rarity of Object.values(ItemRarity)) {
    if (!tiers.get(rarity)?.length) {
      throw new Error(`${box.title}: no ${rarity} item`);
    }
  }
  const average = (rarity: ItemRarity) => {
    const items = tiers.get(rarity)!;
    return items.reduce((sum, i) => sum + i.value, 0) / items.length;
  };
  const tierWeights = solveTierWeights({
    values: {
      SSR: average(ItemRarity.SSR),
      SR: average(ItemRarity.SR),
      R: average(ItemRarity.R),
      N: average(ItemRarity.N),
    },
    price: box.price,
    targetPayoutRatio: box.targetPayoutRatio ?? TARGET_PAYOUT_RATIO,
    pityThreshold: box.pityThreshold,
  });

  const balanced: BalancedItem[] = [];
  for (const [rarity, items] of tiers) {
    const share = Math.floor(tierWeights[rarity] / items.length);
    const remainder = tierWeights[rarity] - share * items.length;
    items.forEach((item, i) =>
      balanced.push({ ...item, weight: share + (i < remainder ? 1 : 0) }),
    );
  }

  const entries = balanced.map((item) => ({
    rarity: item.rarity,
    weight: item.weight,
    estimatedValue: item.value,
  }));
  const summary = summarizeEconomy(entries, box.price, box.pityThreshold);
  if (summary.exchangeReturnRatio >= 1) {
    throw new Error(
      `${box.title}: exchange return ${summary.exchangeReturnRatio} >= 1 (arbitrage)`,
    );
  }
  const pct = (ratio: number, digits = 2) =>
    `${(ratio * 100).toFixed(digits)}%`;
  console.log(
    `⚖️  ${box.title} (${box.price.toLocaleString()}원): ` +
      `SSR ${pct(tierWeights.SSR / 1_000_000, 3)} ` +
      `(천장 포함 ${pct(summary.pity.effectiveTopTierRate, 3)}), ` +
      `환급률 ${pct(summary.payoutRatio, 1)} / 10+1 ${pct(summary.multiDrawPayoutRatio, 1)}`,
  );
  return balanced;
}

async function run() {
  const balancedBoxes = LAUNCH_CATALOG.map((box) => ({
    box,
    items: balanceBox(box),
  }));

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [
      User,
      Gacha,
      Item,
      GachaItem,
      Draw,
      InventoryItem,
      ShippingRequest,
      ShippingRequestItem,
      WalletTransaction,
      GachaPityCounter,
      AttendanceCheckin,
      Banner,
    ],
    synchronize: false,
  });

  await dataSource.initialize();
  console.log('📦 Database connected. Seeding...');

  const userRepo = dataSource.getRepository(User);
  const gachaRepo = dataSource.getRepository(Gacha);
  const itemRepo = dataSource.getRepository(Item);
  const gachaItemRepo = dataSource.getRepository(GachaItem);
  const walletRepo = dataSource.getRepository(WalletTransaction);
  const bannerRepo = dataSource.getRepository(Banner);

  // --- Demo account ---------------------------------------------------
  let demoUser = await userRepo.findOne({
    where: { email: 'demo@gachivault.com' },
  });
  if (!demoUser) {
    demoUser = await userRepo.save(
      userRepo.create({
        email: 'demo@gachivault.com',
        password: await bcrypt.hash('Password1', 10),
        nickname: '가치유저1',
        coinBalance: DEMO_BALANCE,
      }),
    );
    await walletRepo.save(
      walletRepo.create({
        userId: demoUser.id,
        type: WalletTransactionType.EARN,
        reason: WalletTransactionReason.ADJUSTMENT,
        amount: DEMO_BALANCE,
        description: '테스트용 GP 지급',
        balanceAfter: DEMO_BALANCE,
      }),
    );
    console.log('👤 Created demo user: demo@gachivault.com / Password1');
  } else if (Number(demoUser.coinBalance) < DEMO_BALANCE / 2) {
    const refill = DEMO_BALANCE - Number(demoUser.coinBalance);
    demoUser.coinBalance = DEMO_BALANCE;
    await userRepo.save(demoUser);
    await walletRepo.save(
      walletRepo.create({
        userId: demoUser.id,
        type: WalletTransactionType.EARN,
        reason: WalletTransactionReason.ADJUSTMENT,
        amount: refill,
        description: '테스트용 GP 재지급',
        balanceAfter: DEMO_BALANCE,
      }),
    );
    console.log(`👤 Demo balance refilled to ${DEMO_BALANCE}.`);
  }

  // Earlier versions of this seed created display-only accounts
  // (*@demo.gachivault.com, no password) with synthetic draw history that
  // showed up in rankings and the live win feed as if it were real. Their
  // draws, items and ledger rows go with them (ON DELETE CASCADE).
  const removed = await userRepo
    .createQueryBuilder()
    .delete()
    .where('email LIKE :domain', { domain: '%@demo.gachivault.com' })
    .andWhere('password IS NULL')
    .execute();
  if (removed.affected) {
    console.log(`🧹 Removed ${removed.affected} synthetic ranking accounts.`);
  }

  // --- Boxes and drop pools --------------------------------------------
  const boxIdByKey = new Map<string, number>();
  for (const { box, items } of balancedBoxes) {
    let gacha = await gachaRepo.findOne({ where: { title: box.title } });
    const fields = {
      title: box.title,
      description: box.description,
      price: box.price,
      currency: CurrencyType.GP,
      active: true,
      tagline: box.tagline,
      iconName: box.iconName,
      badgeLabel: box.badgeLabel,
      accentColorHex: box.accentColorHex,
      imageUrl: box.imageUrl,
      totalStock: box.totalStock,
      pityThreshold: box.pityThreshold,
    };
    gacha = await gachaRepo.save(
      gacha ? Object.assign(gacha, fields) : gachaRepo.create(fields),
    );
    boxIdByKey.set(box.key, gacha.id);

    const keepItemIds: number[] = [];
    for (const def of items) {
      // An item row is one product at one rarity; the same product can
      // appear at different rarities in different boxes.
      let item = await itemRepo.findOne({
        where: { name: def.name, rarity: def.rarity },
      });
      item = await itemRepo.save(
        item
          ? Object.assign(item, { estimatedValue: def.value })
          : itemRepo.create({
              name: def.name,
              rarity: def.rarity,
              estimatedValue: def.value,
              imageUrl: null,
            }),
      );
      keepItemIds.push(item.id);

      const entry = await gachaItemRepo.findOne({
        where: { gachaId: gacha.id, itemId: item.id },
      });
      await gachaItemRepo.save(
        entry
          ? Object.assign(entry, { weight: def.weight })
          : gachaItemRepo.create({
              gachaId: gacha.id,
              itemId: item.id,
              weight: def.weight,
            }),
      );
    }
    await gachaItemRepo
      .createQueryBuilder()
      .delete()
      .where('gachaId = :gachaId', { gachaId: gacha.id })
      .andWhere('itemId NOT IN (:...ids)', { ids: keepItemIds })
      .execute();
  }
  console.log(`🎰 Seeded ${LAUNCH_CATALOG.length} launch boxes.`);

  // Boxes from earlier catalogs stay in the DB for draw history but are
  // taken off sale.
  const retired = await gachaRepo
    .createQueryBuilder()
    .update(Gacha)
    .set({ active: false })
    .where('active = true')
    .andWhere('title NOT IN (:...titles)', {
      titles: LAUNCH_CATALOG.map((box) => box.title),
    })
    .execute();
  if (retired.affected) {
    console.log(`📦 Retired ${retired.affected} boxes not in the catalog.`);
  }

  // --- Banners -----------------------------------------------------------
  const now = new Date();
  for (const def of LAUNCH_BANNERS) {
    const linkTarget = def.linkBoxKey
      ? String(boxIdByKey.get(def.linkBoxKey))
      : null;
    const existing = await bannerRepo.findOne({ where: { title: def.title } });
    const fields = {
      title: def.title,
      subtitle: def.subtitle,
      badge: def.badge,
      accentColorHex: def.accentColorHex,
      linkType: def.linkType,
      linkTarget,
      priority: def.priority,
      active: true,
    };
    if (existing) {
      // Keep the original schedule on re-runs.
      await bannerRepo.save(Object.assign(existing, fields));
    } else {
      await bannerRepo.save(
        bannerRepo.create({
          ...fields,
          startsAt: now,
          endsAt: def.durationDays
            ? new Date(now.getTime() + def.durationDays * DAY_MS)
            : null,
        }),
      );
    }
  }
  console.log(`🪧 Seeded ${LAUNCH_BANNERS.length} banners.`);

  // soldCount must equal the boxes actually opened (no baseline padding).
  await dataSource.query(
    `UPDATE "gachas" g SET "soldCount" =
       (SELECT COUNT(*) FROM "draws" d WHERE d."gacha_id" = g."id")`,
  );

  await dataSource.destroy();
  console.log('✅ Seeding complete.');
}

run().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
