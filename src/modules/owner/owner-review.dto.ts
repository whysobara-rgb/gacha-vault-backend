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
import { OwnerPageDto } from './owner.dto';
export class TraceLookupDto {
  @IsIn([
    'order',
    'inventory',
    'shipment',
    'payment',
    'refund',
    'conversion',
    'ticket',
  ])
  kind: string;
  @IsString() @MinLength(1) @MaxLength(64) reference: string;
}
export class CaseListDto extends OwnerPageDto {
  @IsOptional()
  @IsIn(['OPEN', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'CLOSED'])
  status?: string;
}
export class CreateCaseDto {
  @IsUUID('4') orderId: string;
  @IsOptional() @IsUUID('4') ticketId?: string | null;
  @IsIn(['RETURN', 'EXCHANGE', 'MISSING', 'DAMAGE', 'OTHER']) kind: string;
  @IsString() @MinLength(2) @MaxLength(1000) summary: string;
  @IsString() @MaxLength(2000) internalNote: string;
  @IsString() @MaxLength(200) externalReference: string;
}
export class ChangeCaseDto {
  @IsInt() @Min(1) @Max(2147483646) expectedVersion: number;
  @IsIn(['OPEN', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'CLOSED']) status: string;
  @IsString() @MinLength(2) @MaxLength(1000) summary: string;
  @IsString() @MaxLength(2000) internalNote: string;
  @IsString() @MaxLength(200) externalReference: string;
  @IsString() @MinLength(2) @MaxLength(200) reason: string;
}
