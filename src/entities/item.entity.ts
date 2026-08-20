import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GachaItem } from './gacha-item.entity';
import { InventoryItem } from './inventory-item.entity';

export enum ItemRarity {
  N = 'N',
  R = 'R',
  SR = 'SR',
  SSR = 'SSR',
}

@Entity('items')
export class Item {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: ItemRarity, default: ItemRarity.N })
  rarity: ItemRarity;

  @Column({ type: 'int', default: 0 })
  estimatedValue: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string;

  @OneToMany(() => GachaItem, (gachaItem) => gachaItem.item)
  gachaItems: GachaItem[];

  @OneToMany(() => InventoryItem, (inventoryItem) => inventoryItem.item)
  inventoryItems: InventoryItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
