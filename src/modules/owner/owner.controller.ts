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
} from '@nestjs/common';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerService } from './owner.service';
import {
  CampaignDto,
  CampaignStateDto,
  EditCampaignDto,
  OwnerPageDto,
  PauseSalesDto,
  ProcurementChangeDto,
  ProcurementDto,
} from './owner.dto';
const uuid = new ParseUUIDPipe({ version: '4' });
@Controller('owner')
@UseGuards(JwtAuthGuard)
export class OwnerController {
  constructor(private readonly s: OwnerService) {}
  @Get('capabilities') capabilities(@CurrentUser() a: AuthenticatedUser) {
    return this.s.capabilities(a);
  }
  @Get('overview') overview(@CurrentUser() a: AuthenticatedUser) {
    return this.s.overview(a);
  }
  @Get('orders') orders(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: OwnerPageDto,
  ) {
    return this.s.orders(a, q);
  }
  @Get('finance') finance(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: OwnerPageDto,
  ) {
    return this.s.finance(a, q);
  }
  @Get('audit') audit(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: OwnerPageDto,
  ) {
    return this.s.audit(a, q);
  }
  @Get('procurements') procurements(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: OwnerPageDto,
  ) {
    return this.s.procurements(a, q);
  }
  @Post('procurements') createProcurement(
    @CurrentUser() a: AuthenticatedUser,
    @Headers('idempotency-key') k: string,
    @Body() d: ProcurementDto,
  ) {
    return this.s.createProcurement(a, k, d);
  }
  @Post('procurements/:id/status') changeProcurement(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: ProcurementChangeDto,
  ) {
    return this.s.changeProcurement(a, id, k, d);
  }
  @Get('campaigns') campaigns(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: OwnerPageDto,
  ) {
    return this.s.campaigns(a, q);
  }
  @Post('campaigns') createCampaign(
    @CurrentUser() a: AuthenticatedUser,
    @Headers('idempotency-key') k: string,
    @Body() d: CampaignDto,
  ) {
    return this.s.saveCampaign(a, null, k, d);
  }
  @Post('campaigns/:id/draft') saveCampaign(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: EditCampaignDto,
  ) {
    return this.s.saveCampaign(a, id, k, d);
  }
  @Post('campaigns/:id/status') campaignState(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: CampaignStateDto,
  ) {
    return this.s.campaignState(a, id, k, d);
  }
  @Post('pause-sales') pause(
    @CurrentUser() a: AuthenticatedUser,
    @Headers('idempotency-key') k: string,
    @Body() d: PauseSalesDto,
  ) {
    return this.s.pauseSales(a, k, d);
  }
}
@Controller('campaigns')
export class PublicCampaignController {
  constructor(private readonly s: OwnerService) {}
  @Get() list() {
    return this.s.publicCampaigns();
  }
}
