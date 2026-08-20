import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GachaItem } from './gacha-item.entity';
import { Draw } from './draw.entity';

export enum CurrencyType {
  COIN = 'COIN',
  GP = 'GP',
}

@Entity('gachas')
export class Gacha {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'int' })
  price: number;

  @Column({ type: 'enum', enum: CurrencyType, default: CurrencyType.COIN })
  currency: CurrencyType;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @OneToMany(() => GachaItem, (gachaItem) => gachaItem.gacha)
  gachaItems: GachaItem[];

  @OneToMany(() => Draw, (draw) => draw.gacha)
  draws: Draw[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
