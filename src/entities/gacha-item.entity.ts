import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Gacha } from './gacha.entity';
import { Item } from './item.entity';

/**
 * Pivot entity that defines the draw pool for a Gacha:
 * which Items can be drawn from a given Gacha, and their relative weight
 * (probability) within that pool.
 */
@Entity('gacha_items')
export class GachaItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Gacha, (gacha) => gacha.gachaItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gacha_id' })
  gacha: Gacha;

  @Column({ name: 'gacha_id' })
  gachaId: number;

  @ManyToOne(() => Item, (item) => item.gachaItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item: Item;

  @Column({ name: 'item_id' })
  itemId: number;

  // Relative weight used for weighted-random draw selection.
  @Column({ type: 'int', default: 1 })
  weight: number;
}
