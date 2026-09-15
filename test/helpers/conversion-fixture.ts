import { randomUUID } from 'crypto';
export async function conversionFixture(
  query: (s: string, p?: any[]) => Promise<any[]>,
  count = 2,
) {
  const [u] = await query(
    `INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'conversion-test',900) RETURNING id`,
    [randomUUID() + '@example.invalid'],
  );
  const [g] = await query(
    `INSERT INTO gachas(title,price,currency,"totalStock") VALUES('conversion-test',100,'GP',10000) RETURNING id`,
  );
  const [w] = await query(
    `INSERT INTO wallet_transactions(user_id,type,amount,description,"balanceAfter") VALUES($1,'USE',$2,'fixture purchase',900) RETURNING id`,
    [u.id, -100 * count],
  );
  const order = randomUUID(),
    capsules = [],
    ids = [];
  await query(
    `INSERT INTO capsule_orders(id,user_id,idempotency_key,gacha_id,title_snapshot,unit_price,quantity,total,currency,status,wallet_transaction_id,balance_after) VALUES($1,$2,$3,$4,'fixture',100,$6,$7,'GP','PAID',$5,900)`,
    [order, u.id, randomUUID(), g.id, w.id, count, 100 * count],
  );
  for (let i = 0; i < count; i++) {
    const premium = i % 2 === 1,
      value = premium ? 1000 : 100,
      amount = premium ? 1000 : 10;
    const [item] = await query(
      `INSERT INTO items(name,rarity,"estimatedValue","isPremium","conversionGP") VALUES($1,$2,$3,$4,$5) RETURNING id`,
      ['prize-' + i, premium ? 'SSR' : 'N', value, premium, amount],
    );
    const [inv] = await query(
      `INSERT INTO inventory_items(user_id,item_id) VALUES($1,$2) RETURNING id`,
      [u.id, item.id],
    );
    const capsule = randomUUID(),
      prize = {
        itemId: item.id,
        name: 'prize-' + i,
        rarity: premium ? 'SSR' : 'N',
        estimatedValue: value,
        isPremium: premium,
        conversionGP: amount,
        imageUrl: null,
        probabilityPpm: 1000000,
      };
    await query(
      `INSERT INTO owned_capsules(id,order_id,sequence,status) VALUES($1,$2,$3,'OPENED')`,
      [capsule, order, i + 1],
    );
    await query(
      `INSERT INTO capsule_openings(capsule_id,inventory_item_id,probability_version,prize,ticket) VALUES($1,$2,$3,$4,0)`,
      [capsule, inv.id, 'a'.repeat(64), JSON.stringify(prize)],
    );
    ids.push(inv.id);
    capsules.push(capsule);
  }
  return { userId: u.id, ids, capsules };
}
