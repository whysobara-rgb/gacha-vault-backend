import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { ConfirmPaymentDto, CreatePaymentOrderDto } from './dto/payment.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('config')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '충전 설정',
    description:
      '결제 사용 가능 여부, 토스 clientKey/customerKey, 충전 패키지와 첫 충전 보너스 대상 여부를 반환합니다.',
  })
  getConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.getConfig(user.userId);
  }

  @Post('orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '충전 주문 생성',
    description:
      '패키지로 주문을 만들고 토스 결제위젯에 넘길 orderId/amount/orderName을 반환합니다. 월 충전 한도를 넘으면 10007.',
  })
  createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentOrderDto,
  ) {
    return this.paymentsService.createOrder(user.userId, dto);
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '결제 승인',
    description:
      '결제위젯 성공 후 호출합니다. 주문 금액 검증 → 토스 승인 → GP 지급(첫 충전 보너스 포함). ' +
      '10015(확인 중)이면 같은 값으로 다시 호출하면 됩니다. 이미 승인된 주문은 같은 결과를 반환합니다.',
  })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmPaymentDto,
  ) {
    return this.paymentsService.confirm(user.userId, dto);
  }

  @Get('orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '내 결제 내역' })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listMine(user.userId);
  }

  /** Toss → server only (configure in the Toss developer console). */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  webhook(@Body() body: unknown) {
    return this.paymentsService.handleWebhook(body);
  }
}
