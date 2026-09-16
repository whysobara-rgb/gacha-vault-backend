import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { OperationsService } from '../operations/operations.service';
import { assessSupply, SupplyItem, SupplySku, SupplyAllocation, SupplyPool } from './supply-readiness';
const LIMIT = 2000;
const bounded = <T>(rows: T[]): T[] => {
  if (rows.length > LIMIT) throw new ServiceUnavailableException('재고 진단 범위를 초과했습니다. 별도 전체 검수가 필요합니다');
  return rows;
};
@Injectable()
export class SupplyReadinessService {
  constructor(private readonly db: DataSource, private readonly ops: OperationsService) {}
  async report(actor: AuthenticatedUser) {
    return this.db.transaction('REPEATABLE READ', async m => {
      await m.query('SET TRANSACTION READ ONLY');
      await m.query("SET LOCAL statement_timeout = '5000ms'");
      await this.ops.access(m, actor, 'OWNER');
      // All time windows use one database instant within one MVCC snapshot.
      const [{ asOf }] = await m.query('SELECT transaction_timestamp() AS "asOf"');
      const items = bounded<SupplyItem>(await m.query(`SELECT p.id,p.name,p.fulfillment_type AS kind,p.warehouse_sku_id AS "skuId",
        count(i.id) FILTER(WHERE i.status='STORED')::text AS stored,
        count(i.id) FILTER(WHERE i.status='SHIPPING_REQUESTED')::text AS "shippingRequested",
        count(i.id) FILTER(WHERE i.status='CONVERTED' AND EXISTS(
          SELECT 1 FROM inventory_conversion_items x JOIN inventory_conversions c ON c.id=x.conversion_id
          WHERE x.inventory_item_id=i.id AND c.status='CONVERTED' AND c.restore_until>$1))::text AS "restoreWindow"
        FROM items p LEFT JOIN inventory_items i ON i.item_id=p.id
        GROUP BY p.id ORDER BY p.id LIMIT 2001`, [asOf]));
      const skus = bounded<SupplySku>(await m.query('SELECT id,code,name,on_hand AS "onHand",reserved FROM warehouse_skus ORDER BY id LIMIT 2001'));
      const allocations = bounded<SupplyAllocation>(await m.query(`WITH details AS (
        SELECT a.sku_id,a.quantity,f.status,
          (SELECT count(*) FROM fulfillment_order_items x JOIN inventory_items i ON i.id=x.inventory_item_id JOIN items p ON p.id=i.item_id
           WHERE x.fulfillment_id=a.fulfillment_id AND x.active AND i.status='SHIPPING_REQUESTED'
             AND p.fulfillment_type='PHYSICAL' AND p.warehouse_sku_id=a.sku_id) AS linked
        FROM warehouse_allocations a JOIN fulfillment_orders f ON f.id=a.fulfillment_id WHERE a.state='RESERVED')
        SELECT sku_id AS "skuId",sum(quantity)::text AS quantity,
          sum(CASE WHEN status='PREPARING' AND linked=quantity THEN quantity ELSE 0 END)::text AS matched,
          bool_or(status<>'PREPARING' OR linked<>quantity) AS inconsistent
        FROM details GROUP BY sku_id ORDER BY sku_id LIMIT 2001`));
      const pools = bounded<SupplyPool>(await m.query(`SELECT 'ORDER' AS kind,count(c.id)::text AS quantity,o.probability_snapshot AS snapshot,o.probability_version AS version
        FROM capsule_orders o JOIN owned_capsules c ON c.order_id=o.id
        WHERE c.status IN('UNOPENED','REFUND_PENDING') GROUP BY o.id
        UNION ALL
        SELECT 'CARD' AS kind,p.quantity::text,p.probability_snapshot,p.probability_version FROM payment_intents p
        WHERE p.status IN('CONFIRMING','UNKNOWN','APPROVED') OR (p.status IN('PREPARED','AUTHENTICATED') AND p.expires_at>$1)
        LIMIT 2001`, [asOf]));
      const [{ mode }] = await m.query("SELECT current_setting('transaction_read_only') AS mode");
      return { ...assessSupply(items, skus, allocations, pools), asOf, databaseReadOnly: mode === 'on' };
    });
  }
}
