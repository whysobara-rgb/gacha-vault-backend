import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SupplyReadinessService } from './supply-readiness.service';
@Controller('owner')
@UseGuards(JwtAuthGuard)
export class SupplyReadinessController {
  constructor(private readonly service: SupplyReadinessService) {}
  @Get('supply-readiness')
  @Header('Cache-Control', 'no-store')
  report(@CurrentUser() actor: AuthenticatedUser) { return this.service.report(actor); }
}
