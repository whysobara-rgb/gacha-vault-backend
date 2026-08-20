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
import { Gacha, CurrencyType } from './gacha.entity';
import { InventoryItem } from './inventory-item.entity';

@Entity('draws')
export class Draw {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.draws, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => Gacha, (gacha) => gacha.draws, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gacha_id' })
  gacha: Gacha;

  @Column({ name: 'gacha_id' })
  gachaId: number;

  @Column({ type: 'int' })
  spent: number;

  @Column({ type: 'enum', enum: CurrencyType, default: CurrencyType.COIN })
  currency: CurrencyType;

  @OneToOne(() => InventoryItem, (inventoryItem) => inventoryItem.draw)
  inventoryItem: InventoryItem;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
