import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

/** One 출석체크 per user per KST calendar day. */
@Entity('attendance_checkins')
@Unique(['userId', 'checkinDate'])
export class AttendanceCheckin {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  /** KST calendar date, 'YYYY-MM-DD'. */
  @Column({ type: 'date' })
  checkinDate: string;

  /** Position in the 7-day reward cycle (1..7). */
  @Column({ type: 'int' })
  streakDay: number;

  @Column({ type: 'int' })
  reward: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
