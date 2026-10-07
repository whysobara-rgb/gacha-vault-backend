import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: '가치유저1', minLength: 2, maxLength: 20 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  nickname?: string;

  @ApiPropertyOptional({ description: '마케팅 정보 수신 동의 여부' })
  @IsOptional()
  @IsBoolean()
  agreeMarketing?: boolean;
}
