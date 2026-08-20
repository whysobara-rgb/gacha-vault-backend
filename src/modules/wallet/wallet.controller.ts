import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { ListPointHistoryQueryDto } from './dto/list-point-history.query.dto';
import { TopupDto } from './dto/topup.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('balance')
  @ApiOperation({ summary: '현재 GP 잔액 조회' })
  getBalance(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getBalance(user.userId);
  }

  @Get('point-history')
  @ApiOperation({
    summary: '포인트(GP) 내역 조회',
    description: '지급(EARN)/사용(USE)/소멸(EXPIRE) 내역을 페이지네이션하여 반환합니다.',
  })
  getPointHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPointHistoryQueryDto,
  ) {
    return this.walletService.getPointHistory(user.userId, query);
  }

  @Post('topup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'GP 충전 (데모용)',
    description:
      '실제 결제 연동 전까지 사용하는 데모/테스트용 충전 엔드포인트입니다. ' +
      '실제 서비스에서는 결제 게이트웨이 웹훅으로 대체되어야 합니다.',
  })
  topup(@CurrentUser() user: AuthenticatedUser, @Body() dto: TopupDto) {
    return this.walletService.topup(user.userId, dto);
  }
}
