import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
} from 'class-validator';
export class SupplyListDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional() @IsIn(['true', 'false']) unread?: string;
  @IsOptional() @IsIn(['true', 'false']) low?: string;
}
export class CreateSkuDto {
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,39}$/) code: string;
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsInt() @Min(0) @Max(10000000) reorderPoint: number;
}
export class StockMovementDto {
  @IsInt() @Min(1) expectedVersion: number;
  @IsIn(['RECEIVE', 'ADJUST']) kind: string;
  @IsInt() @Min(-10000000) @Max(10000000) quantity: number;
  @IsString() @MinLength(1) @MaxLength(255) reason: string;
}
export class LinkSkuDto {
  @IsInt() @Min(0) expectedVersion: number;
  @IsInt() @Min(1) skuId: number;
}
export class ReserveDto {
  @IsInt() @Min(1) expectedVersion: number;
}
export class NotificationReadDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) throughId: number;
}
export class AnnouncementDto {
  @IsString() @MinLength(1) @MaxLength(120) title: string;
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
  @IsIn(['NOTICE', 'MAINTENANCE']) category: string;
}
export class EditAnnouncementDto extends AnnouncementDto {
  @IsInt() @Min(1) expectedVersion: number;
}
export class AnnouncementStateDto {
  @IsInt() @Min(1) expectedVersion: number;
  @IsIn(['PUBLISHED', 'ARCHIVED']) status: string;
  @IsBoolean() confirmed: boolean;
}
