import {
  Body,
  Controller,
  Get,
  Post,
  Headers,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ValidationPipe,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateGpOrderDto, ListCapsulesDto } from '../orders/order.dto';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { HistoryService } from './history.service';
import {
  ConfirmPaymentDto,
  RefundQuoteDto,
  RequestRefundDto,
} from './commerce.dto';
const strict = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
  uuid = new ParseUUIDPipe({ version: '4' });
@ApiTags('commerce')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class CommerceController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly history: HistoryService,
  ) {}
  @Get('payments/capabilities') paymentCapabilities() {
    return this.payments.capabilities();
  }
  @Post('payments') prepare(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body(strict) d: CreateGpOrderDto,
  ) {
    return this.payments.prepare(u.userId, key, d);
  }
  @Get('payments/by-request/:key') byKey(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', uuid) key: string,
  ) {
    return this.payments.byRequest(u.userId, key);
  }
  @Get('payments') listPayments(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListCapsulesDto,
  ) {
    return this.payments.list(u.userId, q.page, q.limit);
  }
  @Get('payments/:id/checkout') checkout(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.payments.checkout(u.userId, id);
  }
  @Get('payments/:id') payment(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.payments.findOne(u.userId, id);
  }
  @Post('payments/:id/confirm') confirm(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body(strict) d: ConfirmPaymentDto,
  ) {
    return this.payments.confirm(u.userId, id, d.transactionId, d.amount);
  }
  @Post('payments/:id/cancel') cancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.payments.cancelPrepared(u.userId, id);
  }
  @Get('order-refunds/capabilities') refundCapabilities() {
    return this.refunds.capabilities();
  }
  @Post('orders/:id/refund-quote') refundQuote(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body(strict) d: RefundQuoteDto,
  ) {
    return this.refunds.quote(u.userId, id, d.capsuleIds);
  }
  @Post('orders/:id/refunds') refund(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') key: string,
    @Body(strict) d: RequestRefundDto,
  ) {
    return this.refunds.refund(u.userId, id, key, d);
  }
  @Get('order-refunds/by-request/:key') refundKey(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', uuid) key: string,
  ) {
    return this.refunds.byRequest(u.userId, key);
  }
  @Get('order-refunds/:id') refundOne(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.refunds.findOne(u.userId, id);
  }
  @Get('order-refunds') listRefunds(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListCapsulesDto,
  ) {
    return this.refunds.list(u.userId, q.page, q.limit);
  }
  @Get('transactions/capabilities') historyCapabilities() {
    return this.history.capabilities();
  }
  @Get('transactions/orders') orders(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListCapsulesDto,
  ) {
    return this.history.orders(u.userId, q.page, q.limit);
  }
  @Get('transactions/openings') openings(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListCapsulesDto,
  ) {
    return this.history.openings(u.userId, q.page, q.limit);
  }
}
// PG browser return is untrusted: only redirect bounded values. It never approves,
// cancels, grants capsules, or mutates database state without the user's JWT.
@Controller('payments/return')
export class PaymentReturnController {
  private target(data: any) {
    const id = typeof data?.orderId === 'string' ? data.orderId : '';
    if (!/^[a-f0-9-]{36}$/i.test(id))
      throw new BadRequestException('결제 주문번호를 확인해주세요');
    const base = 'https://gachigacha-studio-preview.bara3840.chatgpt.site';
    const params = new URLSearchParams();
    for (const k of ['code', 'transactionId', 'amount', 'method'])
      if (typeof data[k] === 'string' && data[k].length <= 64)
        params.set(k, data[k]);
    return base + '/#payment-return/' + id + '?' + params.toString();
  }
  @Get() get(@Query() q: any, @Res() res: Response) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, this.target(q));
  }
  @Post() post(@Body() b: any, @Res() res: Response) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, this.target(b));
  }
}
