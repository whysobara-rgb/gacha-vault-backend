import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RewardsService } from './rewards.service';

@ApiTags('rewards')
@ApiBearerAuth('access-token')
@Controller('rewards')
@UseGuards(JwtAuthGuard)
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Get('attendance')
  @ApiOperation({
    summary: '출석체크 현황',
    description:
      '오늘(KST) 출석 여부, 연속 출석 일차, 다음 보상과 7일 보상표를 반환합니다.',
  })
  getAttendance(@CurrentUser() user: AuthenticatedUser) {
    return this.rewardsService.getAttendance(user.userId);
  }

  @Post('attendance')
  @ApiOperation({
    summary: '출석체크',
    description:
      '오늘(KST) 출석하고 연속 일차에 따른 GP를 지급합니다. 하루 1회만 가능합니다.',
  })
  checkIn(@CurrentUser() user: AuthenticatedUser) {
    return this.rewardsService.checkIn(user.userId);
  }
}
