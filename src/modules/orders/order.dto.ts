import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
export class CreateGpOrderDto {
  @Matches(/^[a-f0-9]{64}$/) expectedProbabilityVersion: string;
  @IsInt() @Min(1) @Max(2147483647) gachaId: number;
  @IsInt() @Min(1) @Max(100) quantity: number;
  // User's displayed quote, never used as the authoritative charge.
  @IsInt() @Min(1) @Max(2147483647) expectedUnitPrice: number;
}
export class ListCapsulesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
