import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'demo@gachivault.com' })
  @IsEmail({}, { message: 'email must be an email' })
  email: string;

  @ApiProperty({ example: 'Password1' })
  @IsString()
  @MinLength(8, { message: 'password must be longer than or equal to 8 characters' })
  password: string;
}
