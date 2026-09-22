import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AvailabilityDto,
  CreateCatalogDto,
  DispatchDto,
  OperationsListDto,
  PublishCatalogDto,
  SaveCatalogDto,
} from './operations.dto';
import { OperationsService } from './operations.service';
@Controller('ops')
@UseGuards(JwtAuthGuard)
@ApiTags('operations')
@ApiBearerAuth('access-token')
export class OperationsController {
  constructor(private readonly s: OperationsService) {}
  @Get('capabilities') capabilities(@CurrentUser() u: AuthenticatedUser) {
    return this.s.capabilities(u);
  }
  @Get('requests/:key') request(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', new ParseUUIDPipe({ version: '4' })) key: string,
  ) {
    return this.s.byRequest(u, key);
  }
  @Get('catalog') list(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: OperationsListDto,
  ) {
    return this.s.catalog(u, q);
  }
  @Get('catalog/:id') detail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.s.catalogDetail(u, id);
  }
  @Post('catalog') create(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() d: CreateCatalogDto,
  ) {
    return this.s.create(u, key, d.config);
  }
  @Post('catalog/:id/draft') draft(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: SaveCatalogDto,
  ) {
    return this.s.save(u, id, key, d);
  }
  @Post('catalog/:id/publish') publish(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: PublishCatalogDto,
  ) {
    return this.s.publish(u, id, key, d);
  }
  @Post('catalog/:id/availability') availability(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: AvailabilityDto,
  ) {
    return this.s.availability(u, id, key, d);
  }
  @Get('fulfillments') shipments(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: OperationsListDto,
  ) {
    return this.s.shipments(u, q);
  }
  @Get('fulfillments/:id') shipment(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.s.shipment(u, id);
  }
  @Post('fulfillments/:id/status') dispatch(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() d: DispatchDto,
  ) {
    return this.s.dispatch(u, id, key, d);
  }
}
