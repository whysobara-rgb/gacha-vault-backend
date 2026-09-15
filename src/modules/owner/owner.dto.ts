import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
export class OwnerPageDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class ProcurementDto {
  @IsInt() @Min(1) skuId: number;
  @IsString() @MinLength(1) @MaxLength(120) supplier: string;
  @IsString() @MaxLength(120) reference: string;
  @IsInt() @Min(1) @Max(100000) quantity: number;
  @IsInt() @Min(0) @Max(100000000) unitCostKRW: number;
  @IsISO8601({ strict: true }) expectedAt: string;
}
export class ProcurementChangeDto {
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
  @IsIn(['ORDERED', 'RECEIVE', 'CANCELLED']) action: string;
  @IsOptional() @IsInt() @Min(1) @Max(100000) quantity?: number;
  @IsString() @MinLength(1) @MaxLength(200) reason: string;
  @Equals(true) confirmed: boolean;
}
export class CampaignDto {
  @IsString() @MinLength(2) @MaxLength(120) title: string;
  @IsString() @MinLength(1) @MaxLength(3000) body: string;
  @IsIn(['SHOWCASE', 'NOTICE']) kind: string;
  @IsOptional() @IsInt() @Min(1) gachaId?: number | null;
  @IsISO8601({ strict: true }) startsAt: string;
  @IsISO8601({ strict: true }) endsAt: string;
  @IsInt() @Min(0) @Max(100000000) budgetKRW: number;
}
export class EditCampaignDto extends CampaignDto {
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
}
export class CampaignStateDto {
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
  @IsIn(['PUBLISHED', 'PAUSED', 'ARCHIVED']) status: string;
  @Equals(true) confirmed: boolean;
}
export class PauseSalesDto {
  @Equals('전체 신규 판매 중지') confirmation: string;
  @IsString() @MinLength(2) @MaxLength(200) reason: string;
}
