import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';

import { ConvertInventoryDto } from './conversion.dto';
import {
  amountFrom,
  conversionError as fail,
  digest,
  normalizeIds,
  policyFrom,
  previewEnabled,
  requirePreview,
  validKey,
} from './conversion.policy';
@Injectable()
export class ConversionsService {
  constructor(private readonly database: DataSource) {}
  capabilities() {
    let policy = null;
    try {
      policy = policyFrom();
    } catch {}
    return {
      enabled: previewEnabled() && !!policy,
      contract: 'INVENTORY_CONVERSION_V1',
      policy,
    };
  }
  private async user(m: EntityManager, userId: number, lock = true) {
    if (!Number.isSafeInteger(userId) || userId < 1)
      throw fail('계정을 확인해주세요', 400);
    const [u] = await m.query(
      `SELECT id, "coinBalance" AS balance, gp_spend_version AS "spendVersion" FROM users WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [userId],
    );
    if (!u) throw fail('계정을 찾을 수 없습니다', 404);
    if (
      BigInt(u.balance) < 0n ||
      BigInt(u.balance) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw fail('잔액 확인이 필요합니다');
    return u;
  }
  private async makeQuote(
    m: EntityManager,
    userId: number,
    ids: number[],
    lock: boolean,
  ) {
    const policy = policyFrom();
    const items = await m.query(
      `SELECT i.id AS "inventoryItemId",i.status,i."isLocked",o.prize FROM inventory_items i LEFT JOIN capsule_openings o ON o.inventory_item_id=i.id WHERE i.user_id=$1 AND i.id=ANY($2::integer[]) ORDER BY i.id ${lock ? 'FOR UPDATE OF i' : ''}`,
      [userId, ids],
    );
    if (items.length !== ids.length)
      throw fail('선택한 보관함 상품을 찾을 수 없습니다', 404);
    const entries = items.map((i) => {
      if (i.status !== 'STORED' || i.isLocked)
        throw fail('보관중이며 잠금 해제된 상품만 전환할 수 있습니다');
      return {
        inventoryItemId: i.inventoryItemId,
        prize: i.prize,
        amountGP: amountFrom(i.prize),
      };
    });
    const totalGP = entries.reduce((n, e) => n + e.amountGP, 0);
    if (totalGP > 2147483647)
      throw fail('한 번에 전환 가능한 GP를 초과했습니다', 400);
    const restored = await m.query(
      `SELECT x.inventory_item_id, count(*) AS n FROM inventory_conversion_items x JOIN inventory_conversions c ON c.id=x.conversion_id WHERE c.status='RESTORED' AND x.inventory_item_id=ANY($1::integer[]) GROUP BY x.inventory_item_id ORDER BY x.inventory_item_id`,
      [ids],
    );
    const restoreEligible = restored.every(
      (x) => Number(x.n) < policy.maxRestoresPerItem,
    );
    const quoteVersion = digest({ policy, entries, restored });
    return { entries, totalGP, policy, quoteVersion, restoreEligible };
  }
  async quote(userId: number, ids: number[]) {
    requirePreview();
    ids = normalizeIds(ids);
    return this.database.transaction('REPEATABLE READ', async (m) => {
      const u = await this.user(m, userId, false),
        q = await this.makeQuote(m, userId, ids, false);
      return { ...q, balance: Number(u.balance) };
    });
  }
  private async receipt(m: EntityManager, userId: number, id: string) {
    const [r] = await m.query(
      `SELECT * FROM inventory_conversions WHERE user_id=$1 AND id=$2`,
      [userId, id],
    );
    if (!r) throw fail('전환 내역을 찾을 수 없습니다', 404);
    const items = await m.query(
      `SELECT inventory_item_id AS "inventoryItemId",prize,amount_gp AS "amountGP" FROM inventory_conversion_items WHERE conversion_id=$1 ORDER BY inventory_item_id`,
      [id],
    );
    const u = await this.user(m, userId, false);
    const [used] = await m.query(
      `SELECT count(*) AS n FROM inventory_conversion_items x JOIN inventory_conversions c ON c.id=x.conversion_id WHERE x.inventory_item_id=ANY($1::integer[]) AND c.status='RESTORED' GROUP BY x.inventory_item_id ORDER BY n DESC LIMIT 1`,
      [items.map((i) => i.inventoryItemId)],
    );
    let restoreReason: string | null = null;
    if (r.status === 'RESTORED') restoreReason = '이미 복구된 상품입니다';
    else if (new Date(r.restore_until).getTime() <= Date.now())
      restoreReason = '복구 가능 기간이 지났습니다';
    else if (String(u.spendVersion) !== String(r.spend_version))
      restoreReason = '전환 이후 GP 사용 내역이 있어 복구할 수 없습니다';
    else if (Number(used?.n || 0) >= r.policy.maxRestoresPerItem)
      restoreReason = '상품별 복구 가능 횟수를 모두 사용했습니다';
    else if (BigInt(u.balance) < BigInt(r.total_gp))
      restoreReason = '복구에 필요한 GP가 부족합니다';
    return {
      conversionId: r.id,
      status: r.status,
      totalGP: r.total_gp,
      balanceAfter: Number(r.balance_after),
      restoredBalanceAfter:
        r.restored_balance_after === null
          ? null
          : Number(r.restored_balance_after),
      createdAt: r.created_at,
      restoredAt: r.restored_at,
      restoreUntil: r.restore_until,
      policy: r.policy,
      items,
      canRestore: !restoreReason,
      restoreReason,
    };
  }
  async convert(userId: number, key: string, dto: ConvertInventoryDto) {
    requirePreview();
    key = validKey(key);
    const ids = normalizeIds(dto?.inventoryItemIds);
    if (
      !/^[a-f0-9]{64}$/.test(dto.expectedQuoteVersion) ||
      !Number.isInteger(dto.expectedTotalGP) ||
      dto.expectedTotalGP < 1 ||
      dto.expectedTotalGP > 2147483647
    )
      throw fail('전환 견적을 확인해주세요', 400);
    const hash = digest({
      ids,
      total: dto.expectedTotalGP,
      version: dto.expectedQuoteVersion,
    });
    return this.database.transaction(async (m) => {
      const u = await this.user(m, userId),
        [old] = await m.query(
          `SELECT id,request_hash FROM inventory_conversions WHERE user_id=$1 AND idempotency_key=$2`,
          [userId, key],
        );
      if (old) {
        if (old.request_hash !== hash)
          throw fail('같은 요청 번호를 다른 전환에 사용할 수 없습니다');
        return this.receipt(m, userId, old.id);
      }
      const q = await this.makeQuote(m, userId, ids, true);
      if (
        q.quoteVersion !== dto.expectedQuoteVersion ||
        q.totalGP !== dto.expectedTotalGP
      )
        throw fail('전환 금액·정책이 변경되었습니다. 다시 확인해주세요');
      const balance = BigInt(u.balance) + BigInt(q.totalGP);
      if (balance > BigInt(Number.MAX_SAFE_INTEGER))
        throw fail('잔액 한도를 초과했습니다');
      const id = randomUUID();
      await m.query(`UPDATE users SET "coinBalance"=$1 WHERE id=$2`, [
        balance.toString(),
        userId,
      ]);
      const [tx] = await m.query(
        `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",origin,description) VALUES($1,'EARN',$2,$3,'INVENTORY_CONVERSION',$4) RETURNING id`,
        [userId, q.totalGP, balance.toString(), `상품 GP 전환 ${id}`],
      );
      await m.query(
        `INSERT INTO inventory_conversions(id,user_id,idempotency_key,request_hash,total_gp,balance_after,spend_version,policy,status,wallet_transaction_id,restore_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONVERTED',$9,now()+$10*interval '1 hour')`,
        [
          id,
          userId,
          key,
          hash,
          q.totalGP,
          balance.toString(),
          u.spendVersion,
          JSON.stringify(q.policy),
          tx.id,
          q.policy.restoreHours,
        ],
      );
      for (const e of q.entries)
        await m.query(
          `INSERT INTO inventory_conversion_items(conversion_id,inventory_item_id,prize,amount_gp) VALUES($1,$2,$3,$4)`,
          [id, e.inventoryItemId, JSON.stringify(e.prize), e.amountGP],
        );
      await m.query(
        `UPDATE inventory_items SET status='CONVERTED' WHERE id=ANY($1::integer[])`,
        [ids],
      );
      return this.receipt(m, userId, id);
    });
  }
  async byRequest(userId: number, key: string) {
    key = validKey(key);
    return this.database.transaction(async (m) => {
      // Serialize with convert so recovery observes a committed receipt.
      await this.user(m, userId);
      const [row] = await m.query(
        'SELECT id FROM inventory_conversions WHERE user_id=$1 AND idempotency_key=$2',
        [userId, key],
      );
      if (!row) {
        const error = fail('전환 요청 내역을 찾을 수 없습니다', 404);
        error.errors.push('CONVERSION_REQUEST_NOT_FOUND');
        throw error;
      }
      return this.receipt(m, userId, row.id);
    });
  }
  async findOne(userId: number, id: string) {
    validKey(id);
    return this.database.transaction('REPEATABLE READ', (m) =>
      this.receipt(m, userId, id.toLowerCase()),
    );
  }
  async list(userId: number, page = 1, limit = 20) {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw fail('페이지를 확인해주세요', 400);
    return this.database.transaction('REPEATABLE READ', async (m) => {
      await this.user(m, userId, false);
      const [{ n }] = await m.query(
        `SELECT count(*) AS n FROM inventory_conversions WHERE user_id=$1`,
        [userId],
      );
      const rows = await m.query(
        `SELECT id FROM inventory_conversions WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT $3`,
        [userId, (page - 1) * limit, limit],
      );
      const items = [];
      for (const r of rows) items.push(await this.receipt(m, userId, r.id));
      return { items, page, limit, totalCount: Number(n) };
    });
  }
  async restore(userId: number, id: string) {
    requirePreview();
    id = validKey(id);
    return this.database.transaction(async (m) => {
      await this.user(m, userId);
      const r = await this.receipt(m, userId, id);
      if (r.status === 'RESTORED') return r;
      if (!r.canRestore) throw fail(r.restoreReason);
      const ids = r.items.map((i) => i.inventoryItemId),
        rows = await m.query(
          `SELECT id,status FROM inventory_items WHERE user_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR UPDATE`,
          [userId, ids],
        );
      if (
        rows.length !== ids.length ||
        rows.some((i) => i.status !== 'CONVERTED')
      )
        throw fail('상품 상태가 변경되어 복구할 수 없습니다');
      if (new Date(r.restoreUntil).getTime() <= Date.now())
        throw fail('복구 가능 기간이 지났습니다');
      // User lock serializes purchases/conversions/restores; re-read just before debit.
      const u = await this.user(m, userId, false),
        balance = BigInt(u.balance) - BigInt(r.totalGP);
      if (balance < 0n) throw fail('복구에 필요한 GP가 부족합니다');
      await m.query(`UPDATE users SET "coinBalance"=$1 WHERE id=$2`, [
        balance.toString(),
        userId,
      ]);
      const [tx] = await m.query(
        `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",origin,description) VALUES($1,'USE',$2,$3,'INVENTORY_RESTORE',$4) RETURNING id`,
        [userId, -r.totalGP, balance.toString(), `상품 전환 복구 ${id}`],
      );
      await m.query(
        `UPDATE inventory_items SET status='STORED' WHERE id=ANY($1::integer[])`,
        [ids],
      );
      await m.query(
        `UPDATE inventory_conversions SET status='RESTORED',restored_at=now(),restore_wallet_transaction_id=$1,restored_balance_after=$2 WHERE id=$3`,
        [tx.id, balance.toString(), id],
      );
      return this.receipt(m, userId, id);
    });
  }
}
