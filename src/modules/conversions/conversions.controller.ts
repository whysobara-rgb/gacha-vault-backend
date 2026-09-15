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
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListCapsulesDto } from '../orders/order.dto';
import { ConversionQuoteDto, ConvertInventoryDto } from './conversion.dto';
import { ConversionsService } from './conversions.service';
@ApiTags('inventory-conversions')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('inventory-conversions')
export class ConversionsController {
  constructor(private readonly service: ConversionsService) {}
  @Get('capabilities') capabilities() {
    return this.service.capabilities();
  }
  @Post('quote') quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: ConversionQuoteDto,
  ) {
    return this.service.quote(user.userId, dto.inventoryItemIds);
  }
  @Post() convert(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: ConvertInventoryDto,
  ) {
    return this.service.convert(user.userId, key, dto);
  }
  @Get() list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: ListCapsulesDto,
  ) {
    return this.service.list(user.userId, q.page, q.limit);
  }
  @Get(':id') findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.findOne(user.userId, id);
  }
  @Post(':id/restore') restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.restore(user.userId, id);
  }
}
