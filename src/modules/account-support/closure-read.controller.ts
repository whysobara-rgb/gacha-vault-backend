import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { fail } from './account-support.policy';

/** Read an existing receipt, including cancellations made on another device.
 * No account deletion, cancellation or password verification is performed here.
 */
@ApiTags('account-support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('account/closure-requests')
export class ClosureReadController {
  constructor(private readonly db: DataSource) {}

  @Get(':id')
  async receipt(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      const [user] = await m.query(
        'SELECT id FROM users WHERE id=$1 AND auth_version=$2',
        [actor.userId, actor.authVersion ?? 0],
      );
      if (!user) throw fail('다시 로그인해주세요', 401);
      const [row] = await m.query(
        `SELECT id AS "requestId",status,reason,summary,
          created_at AS "createdAt",cancelled_at AS "cancelledAt"
         FROM account_closure_requests WHERE id=$1 AND user_id=$2`,
        [id, actor.userId],
      );
      if (!row) throw fail('탈퇴 요청을 찾을 수 없습니다', 404);
      return { ...row, accountDeleted: false };
    });
  }
}
