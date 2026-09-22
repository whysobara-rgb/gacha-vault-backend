import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListCapsulesDto } from '../orders/order.dto';
import { CreateFulfillmentDto, FulfillmentQuoteDto } from './fulfillment.dto';
import { FulfillmentsService } from './fulfillments.service';
@ApiTags('fulfillments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('fulfillments')
export class FulfillmentsController {
  constructor(private readonly service: FulfillmentsService) {}
  @Get('capabilities') capabilities() {
    return this.service.capabilities();
  }
  @Post('quotes') quote(
    @CurrentUser() u: AuthenticatedUser,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    d: FulfillmentQuoteDto,
  ) {
    return this.service.quote(u.userId, d);
  }
  @Get('quotes/:id') getQuote(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.getQuote(u.userId, id);
  }
  @Post() create(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    d: CreateFulfillmentDto,
  ) {
    return this.service.create(u.userId, key, d.quoteId);
  }
  @Get('by-request/:key') byRequest(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', new ParseUUIDPipe({ version: '4' })) key: string,
  ) {
    return this.service.byRequest(u.userId, key);
  }
  @Get() list(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListCapsulesDto,
  ) {
    return this.service.list(u.userId, q.page, q.limit);
  }
  @Get(':id') findOne(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.findOne(u.userId, id);
  }
  @Post(':id/cancel') cancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.cancel(u.userId, id);
  }
}
