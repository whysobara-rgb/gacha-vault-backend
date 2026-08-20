import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Draw } from './draw.entity';
import { InventoryItem } from './inventory-item.entity';

export enum AuthProvider {
  EMAIL = 'EMAIL',
  KAKAO = 'KAKAO',
  GOOGLE = 'GOOGLE',
  NAVER = 'NAVER',
  APPLE = 'APPLE',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  // Nullable because social-login users are provisioned without a local
  // password (they authenticate via the external provider instead).
  @Column({ type: 'varchar', length: 255, select: false, nullable: true })
  password: string | null;

  @Column({ type: 'varchar', length: 100 })
  nickname: string;

  @Column({ type: 'bigint', default: 0 })
  coinBalance: number;

  @Column({
    type: 'enum',
    enum: AuthProvider,
    default: AuthProvider.EMAIL,
  })
  provider: AuthProvider;

  // External provider's unique user id (Kakao/Google/Naver/Apple `sub`/`id`).
  // Null for plain EMAIL accounts.
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerId: string | null;

  @OneToMany(() => Draw, (draw) => draw.user)
  draws: Draw[];

  @OneToMany(() => InventoryItem, (inventoryItem) => inventoryItem.user)
  inventoryItems: InventoryItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
