/**
 * Kept in its own import-free module so pure logic (economy, draw engine)
 * can use it without loading the circular entity graph.
 */
export enum ItemRarity {
  N = 'N',
  R = 'R',
  SR = 'SR',
  SSR = 'SSR',
}
