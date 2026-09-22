import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RefundsService } from './refunds.service';

export class OperatorRefundQuoteDto {
  @IsUUID('4') orderId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('4', { each: true }) capsuleIds: string[];
}
export class SubmitOperatorRefundDto extends OperatorRefundQuoteDto {
  @IsInt() @Min(1) @Max(2147483647) expectedAmount: number;
  @IsIn(['GP', 'KRW']) expectedCurrency: 'GP' | 'KRW';
  // Customer-visible refund reason. Internal notes/credentials are not accepted.
  @IsString() @MinLength(1) @MaxLength(255) reason: string;
}
@Controller('owner/refunds')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class OperatorRefundsController {
  constructor(private readonly refunds: RefundsService) {}
  @Get('capabilities') capabilities(@CurrentUser() a: AuthenticatedUser) {
    return this.refunds.operatorCapabilities(a);
  }
  @Post('quotes') quote(@CurrentUser() a: AuthenticatedUser, @Body() d: OperatorRefundQuoteDto) {
    return this.refunds.operatorQuote(a, d.orderId, d.capsuleIds);
  }
  @Post() submit(@CurrentUser() a: AuthenticatedUser, @Headers('idempotency-key') key: string,
    @Body() d: SubmitOperatorRefundDto) {
    return this.refunds.operatorRefund(a, d.orderId, key, d);
  }
  @Get('by-request/:key') byRequest(@CurrentUser() a: AuthenticatedUser,
    @Param('key', new ParseUUIDPipe({ version: '4' })) key: string) {
    return this.refunds.operatorByRequest(a, key);
  }
  @Get(':id') find(@CurrentUser() a: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.refunds.operatorFindOne(a, id);
  }
}
