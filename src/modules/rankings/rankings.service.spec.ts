import { DataSource } from 'typeorm';
import { RankingsService } from './rankings.service';

describe('Public ranking request boundaries', () => {
  it.each([0, -1, 101, 1.5, Infinity, NaN])(
    'rejects limit %p without querying the database',
    async (limit) => {
      const query = jest.fn();
      const service = new RankingsService({ query } as unknown as DataSource);
      for (const read of [
        service.getUserRanking.bind(service),
        service.getPopularGachas.bind(service),
        service.getRecentBigWins.bind(service),
      ]) {
        await expect(read(limit)).rejects.toMatchObject({ status: 400 });
      }
      expect(query).not.toHaveBeenCalled();
    },
  );
});
