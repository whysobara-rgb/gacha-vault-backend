import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignupDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'email must be an email' })
  email: string;

  @ApiProperty({
    example: 'Password1',
    description: '8-64자, 영문+숫자 최소 1개 이상 포함',
  })
  @IsString()
  @MinLength(8, { message: 'password must be longer than or equal to 8 characters' })
  @MaxLength(64, { message: 'password must be shorter than or equal to 64 characters' })
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'password must contain at least one letter and one number',
  })
  password: string;

  @ApiProperty({ example: '가치유저1', minLength: 2, maxLength: 20 })
  @IsString()
  @MinLength(2, { message: 'nickname must be longer than or equal to 2 characters' })
  @MaxLength(20, { message: 'nickname must be shorter than or equal to 20 characters' })
  nickname: string;
}
