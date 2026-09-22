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
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SupplyService } from './supply.service';
import {
  AnnouncementDto,
  AnnouncementStateDto,
  CreateSkuDto,
  EditAnnouncementDto,
  LinkSkuDto,
  NotificationReadDto,
  ReserveDto,
  StockMovementDto,
  SupplyListDto,
} from './supply.dto';
const uuid = new ParseUUIDPipe({ version: '4' });
@Controller()
@UseGuards(JwtAuthGuard)
export class SupplyController {
  constructor(private readonly s: SupplyService) {}
  @Get('ops/catalog-skus') catalogSkus(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: SupplyListDto,
  ) {
    return this.s.skus(a, q, true);
  }
  @Get('ops/warehouse/skus') skus(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: SupplyListDto,
  ) {
    return this.s.skus(a, q);
  }
  @Get('ops/warehouse/skus/:id') sku(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.s.sku(a, id);
  }
  @Post('ops/warehouse/skus') create(
    @CurrentUser() a: AuthenticatedUser,
    @Headers('idempotency-key') k: string,
    @Body() d: CreateSkuDto,
  ) {
    return this.s.createSku(a, k, d);
  }
  @Post('ops/warehouse/skus/:id/movements') movement(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Headers('idempotency-key') k: string,
    @Body() d: StockMovementDto,
  ) {
    return this.s.movement(a, id, k, d);
  }
  @Get('ops/warehouse/items') items(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: SupplyListDto,
  ) {
    return this.s.items(a, q);
  }
  @Post('ops/warehouse/items/:id/link') link(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Headers('idempotency-key') k: string,
    @Body() d: LinkSkuDto,
  ) {
    return this.s.link(a, id, k, d);
  }
  @Post('ops/warehouse/fulfillments/:id/reserve') reserve(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: ReserveDto,
  ) {
    return this.s.reserve(a, id, k, d.expectedVersion);
  }
  @Get('notifications/capabilities') capabilities(
    @CurrentUser() a: AuthenticatedUser,
  ) {
    return this.s.capabilities(a);
  }
  @Get('notifications/summary') summary(@CurrentUser() a: AuthenticatedUser) {
    return this.s.summary(a);
  }
  @Get('notifications') notifications(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: SupplyListDto,
  ) {
    return this.s.notifications(a, q);
  }
  @Post('notifications/read') read(
    @CurrentUser() a: AuthenticatedUser,
    @Body() d: NotificationReadDto,
  ) {
    return this.s.read(a, d.throughId);
  }
  @Get('announcements') notices(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: SupplyListDto,
  ) {
    return this.s.announcements(a, q);
  }
  @Get('announcements/:id') notice(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.s.announcement(a, id);
  }
  @Post('announcements/:id/read') noticeRead(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.s.readAnnouncement(a, id);
  }
  @Get('ops/announcements') opsNotices(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: SupplyListDto,
  ) {
    return this.s.announcements(a, q, true);
  }
  @Get('ops/announcements/:id') opsNotice(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.s.announcement(a, id, true);
  }
  @Post('ops/announcements') createNotice(
    @CurrentUser() a: AuthenticatedUser,
    @Headers('idempotency-key') k: string,
    @Body() d: AnnouncementDto,
  ) {
    return this.s.saveAnnouncement(a, null, k, d);
  }
  @Post('ops/announcements/:id/draft') saveNotice(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: EditAnnouncementDto,
  ) {
    return this.s.saveAnnouncement(a, id, k, d);
  }
  @Post('ops/announcements/:id/status') status(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: AnnouncementStateDto,
  ) {
    return this.s.announcementStatus(a, id, k, d);
  }
}
