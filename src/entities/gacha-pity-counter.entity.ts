import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Gacha } from './gacha.entity';

/**
 * Per-user, per-box pity (천장) progress: consecutive draws since the
 * user's last SSR from this gacha. Updated inside the draw transaction
 * while the user row is locked.
 */
@Entity('gacha_pity_counters')
@Unique(['userId', 'gachaId'])
export class GachaPityCounter {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => Gacha, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gacha_id' })
  gacha: Gacha;

  @Column({ name: 'gacha_id' })
  gachaId: number;

  @Column({ type: 'int', default: 0 })
  drawsSinceTopTier: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
