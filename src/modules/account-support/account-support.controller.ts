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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccountService } from './account.service';
import { SupportService } from './support.service';
import {
  ChangePasswordDto,
  ClosureDto,
  MessageDto,
  MessagePageDto,
  PasswordCheckDto,
  ReadTicketDto,
  TicketDto,
  TicketListDto,
  TicketStatusDto,
} from './account-support.dto';
const uuid = new ParseUUIDPipe({ version: '4' });
@ApiTags('account-support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class AccountSupportController {
  constructor(
    private readonly accounts: AccountService,
    private readonly support: SupportService,
  ) {}
  @Get('account/capabilities') capabilities(
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return this.accounts.capabilities(u.userId);
  }
  @Post('account/password') password(
    @CurrentUser() u: AuthenticatedUser,
    @Body() d: ChangePasswordDto,
  ) {
    return this.accounts.changePassword(u, d.currentPassword, d.newPassword);
  }
  @Post('account/revoke-sessions') sessions(
    @CurrentUser() u: AuthenticatedUser,
    @Body() d: PasswordCheckDto,
  ) {
    return this.accounts.revokeSessions(u, d.currentPassword);
  }
  @Get('account/closure-check') closureCheck(
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return this.accounts.closureCheck(u);
  }
  @Post('account/closure-requests') closure(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() d: ClosureDto,
  ) {
    return this.accounts.requestClosure(u, key, d);
  }
  @Get('account/closure-requests/by-request/:key') closureKey(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', uuid) key: string,
  ) {
    return this.accounts.closureByKey(u.userId, key);
  }
  @Post('account/closure-requests/:id/cancel') cancelClosure(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ) {
    return this.accounts.cancelClosure(u, id);
  }
  @Post('support/tickets') create(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() d: TicketDto,
  ) {
    return this.support.create(u, key, d);
  }
  @Get('support/tickets/by-request/:key') ticketKey(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', uuid) key: string,
  ) {
    return this.support.byKey(u.userId, key);
  }
  @Get('support/messages/by-request/:key') messageKey(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', uuid) key: string,
  ) {
    return this.support.messageByKey(u, key);
  }
  @Get('support/tickets') list(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: TicketListDto,
  ) {
    return this.support.list(u, q);
  }
  @Get('support/tickets/:id') detail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Query() q: MessagePageDto,
  ) {
    return this.support.detail(u, id, q.after);
  }
  @Post('support/tickets/:id/messages') reply(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') key: string,
    @Body() d: MessageDto,
  ) {
    return this.support.reply(u, id, key, d.body);
  }
  @Post('support/tickets/:id/status') status(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() d: TicketStatusDto,
  ) {
    return this.support.status(u, id, d);
  }
  @Post('support/tickets/:id/read') read(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() d: ReadTicketDto,
  ) {
    return this.support.markRead(u, id, d.throughSequence);
  }
  @Get('staff/support/tickets') staffList(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: TicketListDto,
  ) {
    return this.support.list(u, q, true);
  }
  @Get('staff/support/tickets/:id') staffDetail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Query() q: MessagePageDto,
  ) {
    return this.support.detail(u, id, q.after, true);
  }
  @Post('staff/support/tickets/:id/messages') staffReply(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') key: string,
    @Body() d: MessageDto,
  ) {
    return this.support.reply(u, id, key, d.body, true);
  }
  @Post('staff/support/tickets/:id/status') staffStatus(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() d: TicketStatusDto,
  ) {
    return this.support.status(u, id, d, true);
  }
  @Get('staff/support/messages/by-request/:key') staffMessageKey(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key', uuid) key: string,
  ) {
    return this.support.messageByKey(u, key, true);
  }
  @Get('staff/account-closure-requests') staffClosures(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: TicketListDto,
  ) {
    return this.support.closures(u, q);
  }
}
