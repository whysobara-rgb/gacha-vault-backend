import { IsInt, Min } from 'class-validator';

export class CreateDrawDto {
  @IsInt()
  @Min(1)
  gachaId: number;
}
