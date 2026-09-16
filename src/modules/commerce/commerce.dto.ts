import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
export class RefundQuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  capsuleIds: string[];
}
export class RequestRefundDto extends RefundQuoteDto {
  @IsInt() @Min(1) @Max(2147483647) expectedAmount: number;
  @IsString() @MinLength(1) @MaxLength(255) reason: string;
}
export class ConfirmPaymentDto {
  @Matches(/^[A-Za-z0-9_-]{1,32}$/) transactionId: string;
  @IsInt() @Min(100) @Max(2147483647) amount: number;
}
