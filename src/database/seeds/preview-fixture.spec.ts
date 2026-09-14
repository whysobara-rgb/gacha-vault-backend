import { fixtureEmail } from './preview-fixture';
const valid = {
  NODE_ENV: 'test',
  ENABLE_TEST_FIXTURES: 'true',
  ENABLE_GP_ORDER_PREVIEW: 'true',
  TEST_FIXTURE_EMAIL: 'tester@example.invalid',
};
describe('preview fixture opt-in', () => {
  it('accepts an explicit existing-account identifier', () =>
    expect(fixtureEmail(valid)).toBe(valid.TEST_FIXTURE_EMAIL));
  it.each(['production', 'development', ''])(
    'rejects environment %s',
    (NODE_ENV) => expect(() => fixtureEmail({ ...valid, NODE_ENV })).toThrow(),
  );
  it.each([
    'ENABLE_TEST_FIXTURES',
    'ENABLE_GP_ORDER_PREVIEW',
    'TEST_FIXTURE_EMAIL',
  ])('rejects missing %s', (key) =>
    expect(() => fixtureEmail({ ...valid, [key]: '' })).toThrow(),
  );
  it('rejects legacy transaction mode', () =>
    expect(() =>
      fixtureEmail({ ...valid, ENABLE_LEGACY_TRANSACTIONS: 'true' }),
    ).toThrow());
});
