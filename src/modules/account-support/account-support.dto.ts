import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
export class PasswordCheckDto {
  @IsString() @MinLength(8) @MaxLength(64) currentPassword: string;
}
export class ChangePasswordDto extends PasswordCheckDto {
  @IsString() @MinLength(8) @MaxLength(64) newPassword: string;
}
export class ClosureDto extends PasswordCheckDto {
  @IsString() @MinLength(1) @MaxLength(255) reason: string;
  @IsIn(['탈퇴 요청']) confirmation: string;
}
export class TicketDto {
  @IsIn(['PAYMENT', 'REFUND', 'SHIPPING', 'ACCOUNT', 'OTHER']) category: string;
  @IsString() @MinLength(2) @MaxLength(100) subject: string;
  @IsString() @MinLength(1) @MaxLength(4000) body: string;
  @IsOptional() @IsUUID('4') orderId?: string;
}
export class MessageDto {
  @IsString() @MinLength(1) @MaxLength(4000) body: string;
}
export class TicketStatusDto {
  @IsIn(['OPEN', 'CLOSED']) status: string;
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
}
export class ReadTicketDto {
  @IsInt() @Min(0) @Max(2147483646) throughSequence: number;
}
export class TicketListDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional() @IsIn(['OPEN', 'ANSWERED', 'CLOSED']) status?: string;
}
export class MessagePageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483646) after = 0;
}
