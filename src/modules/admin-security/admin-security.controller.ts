import { Body, Controller, Delete, Get, Header, Headers, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { IsObject, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminSecurityService } from './admin-security.service';
import { AdminAction } from './admin-security.policy';
class Credentials {
  @IsString() @MinLength(1) @MaxLength(64) password: string;
  @IsString() @Length(6,6) otp: string;
}
class ActionCredentials extends Credentials { @IsObject() action: AdminAction; }
@Controller('admin-security')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class AdminSecurityController {
  constructor(private readonly security: AdminSecurityService) {}
  @Get('capabilities') @Header('Cache-Control', 'no-store') capabilities(@CurrentUser() a: AuthenticatedUser) { return this.security.capabilities(a); }
  @Post('session') @Header('Cache-Control', 'no-store') session(@CurrentUser() a: AuthenticatedUser, @Headers('authorization') authorization: string, @Body() d: Credentials) { return this.security.issue(a, authorization, d.password, d.otp); }
  @Post('authorize') @Header('Cache-Control', 'no-store') action(@CurrentUser() a: AuthenticatedUser, @Headers('authorization') authorization: string, @Headers('x-admin-session') session: string, @Body() d: ActionCredentials) { return this.security.issue(a, authorization, d.password, d.otp, session, d.action); }
  @Delete('session') @Header('Cache-Control', 'no-store') revoke(@CurrentUser() a: AuthenticatedUser, @Headers('authorization') authorization: string, @Headers('x-admin-session') session: string) { return this.security.revoke(a, authorization, session); }
}
