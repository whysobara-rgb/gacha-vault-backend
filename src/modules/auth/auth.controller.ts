import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { SocialLoginDto } from './dto/social-login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '회원가입',
    description: '이메일/비밀번호/닉네임으로 신규 계정을 생성합니다.',
  })
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '로그인',
    description: '이메일/비밀번호로 로그인하고 JWT 액세스 토큰을 발급받습니다.',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('providers')
  @ApiOperation({
    summary: '사용 가능한 소셜 로그인',
    description:
      '서버가 토큰을 검증할 수 있도록 설정된 소셜 로그인 제공자 목록입니다.',
  })
  getProviders() {
    return this.authService.getProviders();
  }

  @Post('social-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '소셜 로그인 (카카오/구글/네이버/애플)',
    description:
      '제공자 SDK가 발급한 토큰을 서버가 제공자에게 직접 검증해 로그인합니다. ' +
      '신규 가입이면 필수 약관 동의가 필요하며(없으면 10010), ' +
      '같은 이메일이 다른 방법으로 가입돼 있으면 10011을 반환합니다.',
  })
  socialLogin(@Body() dto: SocialLoginDto) {
    return this.authService.socialLogin(dto);
  }

  /**
   * Sign in with Apple on Android/web: Apple POSTs the result here
   * (form_post), and we hand it back to the app through the intent URL the
   * sign_in_with_apple plugin listens for. The identity token is still
   * verified by POST /auth/social-login like any other.
   */
  @Post('apple/callback')
  @ApiExcludeEndpoint()
  appleCallback(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const pkg =
      this.configService.get<string>('APPLE_ANDROID_PACKAGE') ??
      'com.gachavault.gacha';
    const params = new URLSearchParams();
    for (const key of ['code', 'id_token', 'state', 'user']) {
      const value = body?.[key];
      if (typeof value === 'string' && value.length <= 8192) {
        params.set(key, value);
      }
    }
    res.redirect(
      307,
      `intent://callback?${params.toString()}#Intent;package=${pkg};scheme=signinwithapple;end`,
    );
  }
}
