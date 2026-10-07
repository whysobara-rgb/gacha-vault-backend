import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: '내 프로필 조회',
    description:
      '현재 로그인한 사용자의 프로필/잔액/권한(role)/마케팅 수신 동의 여부를 반환합니다.',
  })
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getProfile(user.userId);
  }

  @Patch('me')
  @ApiOperation({
    summary: '프로필 수정',
    description: '닉네임, 마케팅 수신 동의를 변경합니다.',
  })
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.userId, dto);
  }

  @Delete('me')
  @ApiOperation({
    summary: '회원 탈퇴',
    description:
      '개인정보를 삭제하고 로그인을 막습니다. 남은 GP와 보관함 아이템은 소멸합니다. ' +
      '배송 준비/배송 중인 신청이 있으면 10013을 반환합니다.',
  })
  deleteMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.deleteAccount(user.userId);
  }
}
