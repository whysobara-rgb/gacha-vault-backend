import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateShippingRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  recipientName: string;

  @IsString()
  @Matches(/^[0-9-]{9,20}$/, {
    message: 'phone must be a valid phone number',
  })
  phone: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsInt({ each: true })
  inventoryItemIds: number[];
}
