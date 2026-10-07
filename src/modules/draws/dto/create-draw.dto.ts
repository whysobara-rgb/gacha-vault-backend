import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

export class CreateDrawDto {
  @ApiProperty({ example: 3, description: '뽑을 가차의 ID' })
  @IsInt()
  @Min(1)
  gachaId: number;

  @ApiPropertyOptional({
    example: 1,
    description:
      '1회 요청으로 결제할 뽑기 횟수 (1~100). 생략 시 1회. 10회마다 1회 무료 보너스 뽑기가 추가됩니다.',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  count?: number;
}
