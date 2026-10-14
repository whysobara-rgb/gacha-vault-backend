import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Matches,
  Max,
  Min,
} from 'class-validator';
export class ConversionQuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  inventoryItemIds: number[];
}
export class ConvertInventoryDto extends ConversionQuoteDto {
  @Matches(/^[a-f0-9]{64}$/) expectedQuoteVersion: string;
  @IsInt() @Min(1) @Max(2147483647) expectedTotalGP: number;
}
