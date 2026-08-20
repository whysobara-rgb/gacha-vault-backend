import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Item } from './item.entity';
import { Draw } from './draw.entity';

export enum InventoryStatus {
  STORED = 'STORED',
  SHIPPING_REQUESTED = 'SHIPPING_REQUESTED',
  SHIPPING = 'SHIPPING',
  DELIVERED = 'DELIVERED',
}

@Entity('inventory_items')
export class InventoryItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.inventoryItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => Item, (item) => item.inventoryItems, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item: Item;

  @Column({ name: 'item_id' })
  itemId: number;

  @OneToOne(() => Draw, (draw) => draw.inventoryItem, { nullable: true })
  @JoinColumn({ name: 'draw_id' })
  draw: Draw;

  @Column({ name: 'draw_id', nullable: true })
  drawId: number;

  @Column({ type: 'enum', enum: InventoryStatus, default: InventoryStatus.STORED })
  status: InventoryStatus;

  @Column({ type: 'boolean', default: false })
  isLocked: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
