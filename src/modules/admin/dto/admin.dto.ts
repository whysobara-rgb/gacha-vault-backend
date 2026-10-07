import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  BannerLinkType,
  PaymentOrderStatus,
  ShippingRequestStatus,
} from '../../../entities';

export class AdminListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 30;
}

export class AdminShippingQueryDto extends AdminListQueryDto {
  @IsOptional()
  @IsEnum(ShippingRequestStatus)
  status?: ShippingRequestStatus;
}

export class UpdateShippingDto {
  @ApiPropertyOptional({ enum: ['SHIPPING', 'DELIVERED'] })
  @IsEnum(ShippingRequestStatus)
  status: ShippingRequestStatus;

  @ApiPropertyOptional({ example: 'CJ대한통운' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  trackingCompany?: string;

  @ApiPropertyOptional({ example: '123456789012' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  trackingNumber?: string;
}

export class UpdateGachaDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: '회차 총 수량. 이미 판매된 수량보다 작을 수 없습니다.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  totalStock?: number;
}

export class AdminPaymentsQueryDto extends AdminListQueryDto {
  @IsOptional()
  @IsEnum(PaymentOrderStatus)
  status?: PaymentOrderStatus;
}

export class SaveBannerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  badge?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^https:\/\//)
  imageUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/)
  accentColorHex?: string | null;

  @IsOptional()
  @IsEnum(BannerLinkType)
  linkType?: BannerLinkType;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  linkTarget?: string | null;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  endsAt?: string | null;
}
