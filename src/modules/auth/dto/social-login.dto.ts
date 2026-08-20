import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthProvider } from '../../../entities';

export class SocialLoginDto {
  @ApiProperty({
    enum: [AuthProvider.KAKAO, AuthProvider.GOOGLE, AuthProvider.NAVER, AuthProvider.APPLE],
    example: AuthProvider.KAKAO,
    description: '소셜 로그인 제공자',
  })
  @IsEnum(AuthProvider, { message: 'provider must be one of KAKAO, GOOGLE, NAVER, APPLE' })
  provider: AuthProvider;

  @ApiProperty({
    example: '3827162094',
    description: '제공자가 발급한 사용자 고유 ID (Kakao id / Google sub / Naver id / Apple sub)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  providerId: string;

  @ApiProperty({
    example: 'user@kakao.example.com',
    description: '제공자로부터 전달받은 이메일. 최초 가입 시에만 사용되며, 이미 가입된 유저는 무시됩니다.',
  })
  @IsEmail({}, { message: 'email must be an email' })
  email: string;

  @ApiProperty({
    example: '카카오유저',
    description: '제공자로부터 전달받은 닉네임/표시이름. 최초 가입 시 사용됩니다.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  nickname?: string;
}
