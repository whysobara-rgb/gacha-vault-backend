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
import { OwnerReviewService } from './owner-review.service';
import {
  CaseListDto,
  ChangeCaseDto,
  CreateCaseDto,
  TraceLookupDto,
} from './owner-review.dto';
import { OwnerPageDto } from './owner.dto';
const uuid = new ParseUUIDPipe({ version: '4' });
@Controller()
@UseGuards(JwtAuthGuard)
export class OwnerReviewController {
  constructor(private readonly s: OwnerReviewService) {}
  @Get('owner/trace') lookup(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: TraceLookupDto,
  ) {
    return this.s.lookup(a, q);
  }
  @Get('owner/orders/:id') order(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.s.order(a, id);
  }
  @Get('owner/cases') cases(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: CaseListDto,
  ) {
    return this.s.cases(a, q);
  }
  @Get('owner/cases/:id') case(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.s.case(a, id);
  }
  @Post('owner/cases') create(
    @CurrentUser() a: AuthenticatedUser,
    @Headers('idempotency-key') k: string,
    @Body() d: CreateCaseDto,
  ) {
    return this.s.createCase(a, k, d);
  }
  @Post('owner/cases/:id') change(
    @CurrentUser() a: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') k: string,
    @Body() d: ChangeCaseDto,
  ) {
    return this.s.changeCase(a, id, k, d);
  }
  @Get('support/cases') customer(
    @CurrentUser() a: AuthenticatedUser,
    @Query() q: OwnerPageDto,
  ) {
    return this.s.customerCases(a, q);
  }
}
