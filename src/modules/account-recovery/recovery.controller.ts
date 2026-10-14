import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RecoveryService } from './recovery.service';
export class RecoveryRequestDto {
  @IsEmail() @MaxLength(255) email: string;
}
export class RecoveryTokenDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) token: string;
}
export class ResetPasswordDto extends RecoveryTokenDto {
  @IsString() @MinLength(8) @MaxLength(64) newPassword: string;
}
@Controller()
export class RecoveryController {
  constructor(private readonly s: RecoveryService) {}
  @Get('auth/recovery/capabilities') capabilities() {
    return this.s.capabilities();
  }
  @Post('auth/recovery/request') request(@Body() d: RecoveryRequestDto) {
    return this.s.requestReset(d.email);
  }
  @Post('auth/recovery/reset') reset(@Body() d: ResetPasswordDto) {
    return this.s.complete('RESET', d.token, d.newPassword);
  }
  @Post('auth/recovery/verify') verify(@Body() d: RecoveryTokenDto) {
    return this.s.complete('VERIFY', d.token);
  }
  @Get('account/email') @UseGuards(JwtAuthGuard) status(
    @CurrentUser() a: AuthenticatedUser,
  ) {
    return this.s.status(a);
  }
  @Post('account/email/request') @UseGuards(JwtAuthGuard) requestVerification(
    @CurrentUser() a: AuthenticatedUser,
  ) {
    return this.s.requestVerification(a);
  }
}
