import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'email must be an email' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'password must be longer than or equal to 8 characters' })
  password: string;
}
