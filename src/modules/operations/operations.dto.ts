import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
export class OperationsEntryDto {
  @IsOptional() @IsInt() @Min(1) warehouseSkuId?: number | null;
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsIn(['N', 'R', 'SR', 'SSR']) rarity: string;
  @IsOptional() @IsString() @MaxLength(2000) imageUrl: string | null = null;
  @IsInt() @Min(0) @Max(2147483647) estimatedValue: number;
  @IsBoolean() isPremium: boolean;
  @IsInt() @Min(0) @Max(1000000) probabilityPpm: number;
  @IsIn(['PHYSICAL', 'DIGITAL', 'MANUAL']) fulfillmentType: string;
  @IsBoolean() shippingEnabled: boolean;
}
export class CatalogConfigDto {
  @IsString() @MinLength(2) @MaxLength(255) title: string;
  @IsString() @MaxLength(2000) description: string;
  @IsOptional() @IsString() @MaxLength(2000) imageUrl: string | null = null;
  @IsInt() @Min(1) @Max(10000000) price: number;
  @IsInt() @Min(0) @Max(10000000) totalStock: number;
  @IsIn(['STANDARD', 'EVENT']) saleType: 'STANDARD' | 'EVENT';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OperationsEntryDto)
  entries: OperationsEntryDto[];
}
export class CreateCatalogDto {
  @ValidateNested() @Type(() => CatalogConfigDto) config: CatalogConfigDto;
}
export class SaveCatalogDto extends CreateCatalogDto {
  @IsInt() @Min(0) @Max(2147483646) expectedVersion: number;
}
export class PublishCatalogDto {
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
  @Equals('판매 설정 적용') confirmation: string;
}
export class AvailabilityDto {
  @IsInt() @Min(0) @Max(2147483646) expectedVersion: number;
  @IsBoolean() active: boolean;
}
export class DispatchDto {
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
  @IsIn(['PREPARING', 'COLLECTED', 'SHIPPING', 'DELIVERED']) status: string;
  @IsOptional()
  @IsIn(['CJ', 'HANJIN', 'LOTTE', 'POST', 'LOGEN', 'OTHER'])
  carrier?: string;
  @IsOptional() @IsString() @MaxLength(40) trackingNumber?: string;
}
export class OperationsListDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional()
  @IsIn([
    'REQUESTED',
    'PREPARING',
    'COLLECTED',
    'SHIPPING',
    'DELIVERED',
    'CANCELLED',
  ])
  status?: string;
}
