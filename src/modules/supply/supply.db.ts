import { EntityManager } from 'typeorm';
import { conversionError as fail } from '../conversions/conversion.policy';
export async function notify(
  m: EntityManager,
  userId: number,
  source: string,
  kind: 'SHIPMENT_UPDATE' | 'SUPPORT_REPLY',
  targetId: string,
  title: string,
  body: string,
) {
  await m.query(
    'INSERT INTO app_notifications(user_id,source_key,kind,target_id,title,body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,source_key) DO NOTHING',
    [userId, source, kind, targetId, title, body],
  );
}
export async function move(
  m: EntityManager,
  sku: any,
  actor: number,
  kind: string,
  source: string,
  onHand: number,
  reserved: number,
  reason: string,
) {
  const hand = sku.on_hand + onHand,
    held = sku.reserved + reserved;
  if (hand < 0 || hand > 10000000 || held < 0 || held > hand)
    throw fail('실물 재고가 부족하거나 예약 수량보다 줄일 수 없습니다');
  await m.query(
    'UPDATE warehouse_skus SET on_hand=$2,reserved=$3,version=version+1 WHERE id=$1',
    [sku.id, hand, held],
  );
  await m.query(
    'INSERT INTO warehouse_movements(sku_id,actor_id,kind,source_key,delta_on_hand,delta_reserved,on_hand_after,reserved_after,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [sku.id, actor, kind, source, onHand, reserved, hand, held, reason],
  );
}
export async function allocate(m: EntityManager, id: string, actor: number) {
  const old = await m.query(
    'SELECT * FROM warehouse_allocations WHERE fulfillment_id=$1 ORDER BY sku_id FOR UPDATE',
    [id],
  );
  if (old.length) {
    if (old.some((x) => x.state !== 'RESERVED'))
      throw fail('이미 종료된 출고 예약입니다');
    return;
  }
  const rows = await m.query(
    `SELECT p.id,p.warehouse_sku_id FROM fulfillment_order_items x JOIN inventory_items i ON i.id=x.inventory_item_id JOIN items p ON p.id=i.item_id WHERE x.fulfillment_id=$1 AND x.active=true ORDER BY p.id FOR SHARE OF p`,
    [id],
  );
  if (!rows.length || rows.some((r) => !r.warehouse_sku_id))
    throw fail('모든 배송 상품에 실물 재고 코드를 연결해주세요');
  const counts = new Map<number, number>();
  for (const r of rows)
    counts.set(r.warehouse_sku_id, (counts.get(r.warehouse_sku_id) || 0) + 1);
  const skus = await m.query(
    'SELECT * FROM warehouse_skus WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',
    [[...counts.keys()]],
  );
  if (
    skus.length !== counts.size ||
    skus.some((s) => s.on_hand - s.reserved < counts.get(s.id))
  )
    throw fail('출고 가능한 실물 재고가 부족합니다. 입고 후 다시 준비해주세요');
  for (const sku of skus) {
    const q = counts.get(sku.id);
    await m.query(
      `INSERT INTO warehouse_allocations(fulfillment_id,sku_id,quantity,state) VALUES($1,$2,$3,'RESERVED')`,
      [id, sku.id, q],
    );
    await move(
      m,
      sku,
      actor,
      'RESERVE',
      id + ':reserve',
      0,
      q,
      '배송 준비 재고 예약',
    );
  }
}
export async function settleAllocation(
  m: EntityManager,
  id: string,
  actor: number,
  consume: boolean,
) {
  const rows = await m.query(
    'SELECT * FROM warehouse_allocations WHERE fulfillment_id=$1 ORDER BY sku_id FOR UPDATE',
    [id],
  );
  if (!rows.length) {
    if (consume)
      throw fail('실물 재고 예약이 없습니다. 재고 예약 후 집화해주세요');
    return;
  }
  if (rows.every((r) => r.state === (consume ? 'CONSUMED' : 'RELEASED')))
    return;
  if (rows.some((r) => r.state !== 'RESERVED'))
    throw fail('출고 예약 상태를 확인해주세요');
  const skus = await m.query(
    'SELECT * FROM warehouse_skus WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',
    [rows.map((r) => r.sku_id)],
  );
  for (const sku of skus) {
    const q = rows.find((r) => r.sku_id === sku.id).quantity;
    await move(
      m,
      sku,
      actor,
      consume ? 'DISPATCH' : 'RELEASE',
      id + (consume ? ':dispatch' : ':release'),
      consume ? -q : 0,
      -q,
      consume ? '택배 집화 출고' : '배송 취소 예약 해제',
    );
  }
  await m.query(
    'UPDATE warehouse_allocations SET state=$2,updated_at=clock_timestamp() WHERE fulfillment_id=$1',
    [id, consume ? 'CONSUMED' : 'RELEASED'],
  );
}
