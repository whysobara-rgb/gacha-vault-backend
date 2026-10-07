import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AuthProvider } from '../../../entities';
import { AgreementsDto } from './agreements.dto';

const SOCIAL_PROVIDERS = [
  AuthProvider.KAKAO,
  AuthProvider.GOOGLE,
  AuthProvider.NAVER,
  AuthProvider.APPLE,
];

export class SocialLoginDto extends AgreementsDto {
  @ApiProperty({ enum: SOCIAL_PROVIDERS, example: AuthProvider.KAKAO })
  @IsEnum(AuthProvider)
  @IsIn(SOCIAL_PROVIDERS)
  provider: AuthProvider;

  @ApiProperty({
    description:
      'KAKAO/NAVER: SDK가 발급한 access token. GOOGLE: ID token. APPLE: identity token. ' +
      '서버가 제공자에게 직접 검증하며, 사용자 ID/이메일은 이 토큰에서만 얻습니다.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  token: string;

  @ApiPropertyOptional({
    example: '가치유저',
    description: '최초 가입 시 사용할 닉네임 (없으면 제공자 프로필 이름 사용)',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  nickname?: string;
}
