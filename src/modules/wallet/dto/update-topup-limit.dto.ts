import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

export class UpdateTopupLimitDto {
  @ApiProperty({
    example: 300000,
    nullable: true,
    description:
      '월 충전 한도(GP). null이면 한도 해제. 낮추면 즉시 적용, 높이거나 해제하면 7일 후 적용됩니다.',
  })
  // The field is required; only an explicit null skips the number checks.
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  monthlyLimit: number | null;
}
