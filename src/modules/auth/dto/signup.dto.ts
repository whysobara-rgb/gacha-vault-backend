import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SignupDto {
  @IsEmail({}, { message: 'email must be an email' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'password must be longer than or equal to 8 characters' })
  @MaxLength(64, { message: 'password must be shorter than or equal to 64 characters' })
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'password must contain at least one letter and one number',
  })
  password: string;

  @IsString()
  @MinLength(2, { message: 'nickname must be longer than or equal to 2 characters' })
  @MaxLength(20, { message: 'nickname must be shorter than or equal to 20 characters' })
  nickname: string;
}
