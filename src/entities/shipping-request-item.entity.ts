import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ShippingRequest } from './shipping-request.entity';
import { InventoryItem } from './inventory-item.entity';

/**
 * Pivot entity linking a ShippingRequest to the one or more InventoryItems
 * the user is requesting to have shipped.
 */
@Entity('shipping_request_items')
export class ShippingRequestItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ShippingRequest, (sr) => sr.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shipping_request_id' })
  shippingRequest: ShippingRequest;

  @Column({ name: 'shipping_request_id' })
  shippingRequestId: number;

  @ManyToOne(() => InventoryItem, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'inventory_item_id' })
  inventoryItem: InventoryItem;

  @Column({ name: 'inventory_item_id' })
  inventoryItemId: number;
}
