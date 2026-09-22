import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
export class RecipientDto {
  @IsString() @MinLength(1) @MaxLength(100) name: string;
  @IsString() @Matches(/^0[0-9-]{8,19}$/) phone: string;
  @IsString() @Matches(/^\d{5}$/) postalCode: string;
  @IsString() @MinLength(5) @MaxLength(180) address1: string;
  @IsString() @MinLength(1) @MaxLength(100) address2: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @Equals('KR') country: 'KR';
}
export class FulfillmentQuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  inventoryItemIds: number[];
  @IsObject()
  @ValidateNested()
  @Type(() => RecipientDto)
  recipient: RecipientDto;
}
export class CreateFulfillmentDto {
  @IsUUID('4') quoteId: string;
}
