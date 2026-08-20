/**
 * Standalone seed script — populates the database with demo data:
 *   - 8 Gachas, each with a real hero product photo (imageUrl) and a
 *     themed item pool (N/R/SR/SSR) whose items and images actually match
 *     the gacha's category (시계/스마트폰/가방/패션/뷰티/가전/식품/기프티콘).
 *     This keeps the "LUCKY LINEUP" shown in the Flutter detail page
 *     honest: what you see is what can actually drop from that box.
 *   - Realistic totalStock / soldStockBaseline per box so the "실시간 재고"
 *     progress bar isn't a hardcoded constant — actual sold count is
 *     soldStockBaseline + live COUNT(draws) for that gacha (computed in
 *     GachaService.findOne), so it increases in real time as people draw.
 *   - 1 demo user (demo@gachivault.com / Password1) with a GP balance
 *   - An initial WalletTransaction (EARN) recording the starting balance
 *
 * Usage: npm run seed
 */
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import {
  User,
  Gacha,
  Item,
  GachaItem,
  Draw,
  InventoryItem,
  ShippingRequest,
  ShippingRequestItem,
  WalletTransaction,
  CurrencyType,
  ItemRarity,
  WalletTransactionType,
} from '../../entities';

dotenv.config();

const STARTING_BALANCE = 5000;

// ---------------------------------------------------------------------------
// Real (CC/PD-licensed) product photo URLs, grouped per category. Each
// category has a "hero" shot used as the gacha's card/banner image, plus one
// image per rarity tier (N/R/SR/SSR) used on the actual lineup item so the
// "LUCKY LINEUP" always shows real, on-theme pictures instead of generic
// icons.
// ---------------------------------------------------------------------------
const IMG = {
  watch: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=6RuSQ1PGmKymgmJpYjpk0huOgE0HifYnHEdnz3APDvDPPQEXLpytKZY2UppAcf2hGnw9AOigS2%2FSGu%2BzzLjnyf5t%2F77h8GzahnRmn99hMrVWKz%2F7Nne9u7%2FeJORcPVV3BmshggKxmJwgU9%2BzaU77IYsS04vxTiudpSCQWZH3Dy9ksTve3C0jZWqVx3oRhJtbWpvkvPijhOvCqn03nURT&u2=lfYxuXUPZblX6Ymb&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=aT65vaZUOhh5JJbXyWCkom4cXLu%2BA4f3QZ%2FUfnYEGU5bJa6Jn48aiT3JVHhwSoVTwSpNopWCKqUtviwIx6zK3LMfETr7rmZ1Jh03X90%2Fa3hODhXVe2Zlak8pWm%2B%2FBNEpJgpytWpLf7aNLLe%2BO9Md5wwNjMdMm3WuuQ%3D%3D&u2=dDS2zw4E7uyd2SNE&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=mj5wUcWvFo3T%2F1EQy%2FZUzWLmURJx89ldxKtIozOzVCygKZSsqDK3YF6BrL2qRTpsDlx9TERpmctkrHUGxWZa2pBqQ9vD%2BFLnEPLDyVlpE9j6ZQR2l83YslXfcQNtbRUTmMBzpm58RWsu5PTmL1mtZHetAIWn%2BaR7eocL2c8Be7BcbcrLJFs305fDgEUAABUro71AF4r%2BccrARZfeAjOuHMdljaTCTf0edrUmthZVneIyif%2F0qVLNOohi4v5n4K2QJzbosYI%3D&u2=VDpTCBMS7uTl7If4&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=%2BCGxZOb13UOhOyUnud0BH1rXLIErPxkNU1fyhOKHDWIh5GXS6SDB%2Fc%2Fcw5mxTae%2FtD1Sw3KZDqBYT24ru6eoTsNwtlgWRLvtk1NKAe5UlVMnQ%2BMymMsH%2FM9%2BHLi4kpt%2BD3UEUAmxxGNFmkGea99ovvh0RIJeowo22XV%2FcE3aa86QR9vaxomHYfp6Y5WoNoGzGu684OSISr6Fe1rLGpn4IGyJ6FS8BB0hmBN48uiELgGd9y7TivcBzJ4gFL6pM425rPH6d%2FV0BA%3D%3D&u2=85DHFnYDGwmCBbEW&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=Lp26HIHfM%2FjRT27r1z%2F9%2FaKWPt9Tpw3fmP5e4gN2c1BY4tzDuS6MKlv1k5ixoHT3X1lrmEFYYp1QzmbfEmdRr9Zp%2F9yyybTJhRykD9nNx7hCYY%2FxL%2BYbK%2BZ2gQZrtZIJM1KobHsEjMwxQHPoiWSRtS7VGjHYV%2BIOtrflL78rqtNXnH3Ajhm%2BqUYGIsY2Ah1HqXAO%2BIq99VU%3D&u2=lM9UsH%2BNYwmeZDXb&width=2560',
  },
  phone: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=33przEvwgv7f8T86wNlIiCwkncjsLu7d3jV1rnHjU8YqIj9Mq%2F5ZRjDqgdyksyQsecrMCVo1QPnzM5YMQD5fBZFhRmbTfZIvzP2vriVvHOUiO%2FVaDVNRvZmRm1xF81Wbc7XgxxFCVDmtRV8Bil5nCMw9kyP9hXsffzO82A3VCWWpUqBe8orJDFCjI8eiaI9Wao8U44vA1sN0pmvRT2X1YasEoeKBReU1hwcvYd7HKlGT%2BPIbfs8RG7yx%2BjVCpCrRGqUh4p6uiOAIpxXx6IHX9zfKBbxTF8nuDzsGO0ubNNx84ot94CHjRT4jL2fnoBXqISdxcegzUQxKICP%2B4363%2FyfWUNFFDhTlu5pUkjgWcDE%3D&u2=%2BNUeCRcnPRFAD7ey&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=0kZ8GI3AA8xjoXaMhugHga2lh52w7Vm8x2LEySqmFuZPIh9ZPUhpb50W7Vjzd7L4OeILR06PXrRwnnalapqjq9lpMgzi8wypqQj%2F2xiHnggekhrlkEdhNN6313uCNs9W7q4eYfKuBKkhXsjJ9KbEAOOSal%2FQ5%2B4N4BcH8K4I7dyUf6TmNpepMH%2FNIUHSu6BnpL3XJu0os4iLG1jLTg%3D%3D&u2=1Kp8KeqTieDThAlp&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=33przEvwgv7f8T86wNlIiCwkncjsLu7d3jV1rnHjU8YqIj9Mq%2F5ZRjDqgdyksyQsecrMCVo1QPnzM5YMQD5fBZFhRmbTfZIvzP2vriVvHOUiO%2FVaDVNRvZmRm1xF81Wbc7XgxxFCVDmtRV8Bil5nCMw9kyP9hXsffzO82A3VCWWpUqBe8orJDFCjI8eiaI9Wao8U44vA1sN0pmvRT2X1YasEoeKBReU1hwcvYd7HKlGT%2BPIbfs8RG7yx%2BjVCpCrRGqUh4p6uiOAIpxXx6IHX9zfKBbxTF8nuDzsGO0ubNNx84ot94CHjRT4jL2fnoBXqISdxcegzUQxKICP%2B4363%2FyfWUNFFDhTlu5pUkjgWcDE%3D&u2=%2BNUeCRcnPRFAD7ey&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=nFD5Bdit%2BgCkd4SQGxoZDXkTIIgSVmQjFQgEewY5WJlddrRLJ3BU%2F1diQRjeLND%2Bq11SKNlQxH4sr1GGSutaYzjeDzWmHkR0Yda75HFK8zE1TLxRVw%3D%3D&u2=BmLfkLoZaUf1Tw1A&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=0kZ8GI3AA8xjoXaMhugHga2lh52w7Vm8x2LEySqmFuZPIh9ZPUhpb50W7Vjzd7L4OeILR06PXrRwnnalapqjq9lpMgzi8wypqQj%2F2xiHnggekhrlkEdhNN6313uCNs9W7q4eYfKuBKkhXsjJ9KbEAOOSal%2FQ5%2B4N4BcH8K4I7dyUf6TmNpepMH%2FNIUHSu6BnpL3XJu0os4iLG1jLTg%3D%3D&u2=1Kp8KeqTieDThAlp&width=2560',
  },
  bag: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=5abIalUAla9YELlQBnhaHc09OjirX92Jq%2BApL1zcNUCSKEk6kEhq%2BZVuHQppyiwjEqHJ4gu10BG4qI70xH1gkEDasx0HvbJaexfNkPfNoE6zSkZ9Fd08A1QIP2ojBFWZrxnzaQIUJwszcpCH7ayolm1VlPVSmjhKkkWxiU9XCxNc2l%2BikfGqhS86F6BlPrJBNEXDp6eE89C3gNlyqA%3D%3D&u2=43PMQR8wqUA5lsXZ&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=5abIalUAla9YELlQBnhaHc09OjirX92Jq%2BApL1zcNUCSKEk6kEhq%2BZVuHQppyiwjEqHJ4gu10BG4qI70xH1gkEDasx0HvbJaexfNkPfNoE6zSkZ9Fd08A1QIP2ojBFWZrxnzaQIUJwszcpCH7ayolm1VlPVSmjhKkkWxiU9XCxNc2l%2BikfGqhS86F6BlPrJBNEXDp6eE89C3gNlyqA%3D%3D&u2=43PMQR8wqUA5lsXZ&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=eNdT%2Bpy6mBo3kIzWxKPfDq20kUkGsEPgw3pJCo6Ew1fGQLWLXcLW3q3EE0l%2FpMUMPJv9yoyDzKGzZ%2B2ICGnnDHd5x%2F0A9wt42Xdum3r0z%2BVDtNySEG05K9m6FqiojFzGnVz6ANjQHrukwFuKQDF7J8U8OSQ5HB3Y3Jb7vuCuzKeh5Ov973Ss0wWC5eQPdoouaP3vEZrkIcqZxCOlKWs%3D&u2=kX49eouRTaz3%2FNWA&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=Vqe3G4nQXgd1ToZa6IAiRXUiPI7WEvxR1ls7IwSmxWR5AUn8LmSmO38ldTpfkdxIalPkEBF%2FkiAEOzvdAisAjFd0IYbwV%2Be4Gjx1uSXPEjPmJDKDIGoJA2me96Huf9AjEsg7vK2lg2QqfpSJf0jYo8U68ZAsESXADPFockSSKpF3rNxPXfQoPQrpgw%3D%3D&u2=Z6pYrxLD3CuXpsal&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=eTv6AySLkn2p%2BWZPgAQmGyoFmlIcOW%2B6FzpkZaTA4gc7EewPhKFhWJmk1gHK7oRkEgl6ISgq8BMwmFyDGcooFau4IHlAZ4DndHL2PrOOwPO8bZ2iOig5Pj6ultaveBwSJnVPl5BxAGKag%2Fobh8YJPzJMjzbySpPzVWz00nYEwxyuXQAnKlBpEEPFj7nEH1nqBSrZqTgrsz8ZMEZ09C6wSO6TyDyeytlBR%2FWYjnRJty4UBLGGJg%3D%3D&u2=gokPjJjrsRxUNPdu&width=2560',
  },
  fashion: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=SSPGwXzFKTwJH3v7FpHx4eRwhMBHF%2Fsix7cpoRfs24uz0lL1UUzDNtr4gdnQKnD6h%2BJbbU6X6o7n00qzXdnmA6SnkMYCRS0VHeKfhbExcQ%2FLa%2Fjbr2XBWXhJKPVmDrytghWAIMG75fpilYivaFM3Nv75vROPaLgOhQTZsfX%2FICpFLYWml39FimViBkrQc9721pOVD9ohvTpPMGvqNEkA0uF1%2BlY8wNps5hYWQvU%2BWgM%3D&u2=JAUpfpVqxB398BFH&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=SSygsFOZY8QmeMdezf03w2ZRzFWapOMwnNrqJs2N4hsvTJSqmWzXQVREqT8dGGqsb6J5oBsG0R5jNJCEOwifx82Z41o0ghpQFl1m15UNrqYMGNoFGEcVA2joxPz0&u2=yj9pZSTfB%2FVDpvX%2F&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=qRAFb2xCvZnPHUkVPY4XKSAXkTYABlULoxmRrOrAeVC6BbqYp7zFlg3hyX0erzN%2FnPGz26WRP2DXh1v3s%2F7LuWpk4%2BcjEPO9Uj3NQbH%2BM96BMmoknorR15sCCLf%2Fohpuakysd9S%2B7ku6PqTwmz%2B5cKNHP8iA0t1Z%2BUL%2F258qiHN6Ks61E4NeYZrywQIZXU1g%2BoC8KerGcsdTfGfM4vH7kg%3D%3D&u2=hRqXYXnGUvYdUhW7&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=tR7yMj9jEepOcmjvW0hocJ7P%2FCVHKoQ14WAQ%2BGyUFBR4JEaeRXUJ8AFDKvoy%2Fq8IhlKjHipXC%2FWUCD70SWiW6KF30COk%2BpAGXsQUEwFKLpIPwvbxKsYEvRbXLUD%2BP0hZNOSxDQVIYOVpvAZ7PwG5zemnKRFfGFcB1PwRvnneo9Rin3wfIlKyydWlkuzAQKw7ovtEimq%2B7QlapQP6xciaTQ%3D%3D&u2=5azWxZr1lxxFUU%2Bq&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=ojgv6mIG%2BSw214nkWO454xK6bNl7gcdRFNmyEzNkUUuCVh01ggodtNM2IOgVYPe3EwdjmY88UkEYA76%2B3b9fs6IhX3jVv4ZZF7hkO8KEZEj6hTMDA%2FuOucXc05QxcarHb6pw1n%2Fzrp4XRCgJDyPF9p3AjEUg%2BTYtrZMBsapl48jPQzQq5pM31WN0iLOwO4rBOZDEi%2BVmeNBy%2BybYfFo5oqKdkFPIh%2FyYTS6DYT66Mo2riy3K8RRnZR3bw6v%2FwrhkFTa41id112ZOuxDlcRGPnO8siG3KF1KlbP3gq1VEQDAmKmOl9yQ%2FcPG9fWvtulRqa2%2BI4Z5ruSjySOggqDFyUOFdbyqsZiWjzFkCjAkEFgQ%2BsqRY6N%2BQlCxHBORUunQOuOBV%2BFNKdQP%2BkZhS2XdNmtGsFFISUGWh3FQ2btcsL7mJgZSlKxgoN8utzNoyVbwPNtbPvgE5MWWURIBQ5Cov0dgNElXqbWBTzGs1nPbqMVniTQH%2Bb3D3jVE0R9cRXij%2F&u2=ouumxkWD5yJmDHi4&width=2560',
  },
  beauty: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=BiHtzar7kPeytPfreitxHIOJyq4%2BZ46feIH7hJQz296sWFV6XPdItMzgaZIqQtz0Z%2FUIAnX4h2LnVZPuY8BfsS02LPk0mfN%2FpgeDthBJrWuR23qwVbJQvAhdyMFBdAxsaoSSEZAXsgi37PPkY3HNCQs1HLO4mfOl2kuG3hfrAN5HMZkPkTIlXpc%2Fqivh6iYFgdwlq4gI3N4C0gHIWPGwUgZde%2F0e&u2=L%2BydwSaMf7G5daRP&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=fgD%2BFnUKSFUx5%2BSFfysSp7Yv2KZZSLezZzg2gG2tn1r9tiSO7%2BFBJ3TqAb3EGI3ZGKE9ND1D3%2FZTmVCXsny4c1xvgao7n84L%2FhmKJhmZ5SeGy7IKsvrn7wiDbzYuntdNdDkHo3zClnrR&u2=eN82evm5K6tfnChu&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=Cn8mV5dgUcxOOHd48xyoeOXzMzs4iZl2cHwQfTodi%2BqAzCro2HtbzzpA38w%2BnudtPsFhk8kz5666m1dgFEzli%2Fj0yelpYiapex2LzptpmwMCC0dWn4T2vVl99lM0KqTKpzX4k4oE&u2=7R%2BUdQjSre4OaQDP&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=HIp5SjO4SeRjHYUiAB4i2jTHswoh7vXYFZJU5B7QF%2BUHxspx9mOgEhlY3edb3VHEjzY5MfBWx2%2F8SDcKWIE0x48ewrzf%2B9NIcUk6OppvZlLU&u2=rYAY7REqMx18XvNS&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=9KfOFhSE7BaP7ovsjfxSd%2BHSZ1bwAokAmco4UHlg61fisvQHJExz1XD8tA43YlNimNkfSb4imQ3HAOQhX8IWaxJAzjHtsKac4Bf0q24QeGC9&u2=FnlmPgPh5CEdGCaF&width=2560',
  },
  devices: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=%2BB2R4%2FSPtldF6scqy%2F4OaZqdHtdzvx5Riwmuze0G2JmsEeda82Z5e8p0%2Baxk5Nqe6IdhWfBlaDhCajSZUzcal4AXzoknG%2FOEuaJim0DZXwg209s6ar9HVXdXAqnQJuQNLgq8%2Bt6ucnjRtKY%3D&u2=sM3kBUlaj%2F1buJUo&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=ad%2BXZ9QJAgIVJdc54xa3RksRHcEkdTGIYEOG2Wg%2FMGS09Abgb%2FN6u9BQu36d2vJuIqJxDKFXXHXfJY8tLqm4KbW%2FW7qKj0IO91puxLmchvPUSpqp%2FkDhs7cZjNQh%2FSK9B6yfAhsThjQs7A%3D%3D&u2=Dn%2BXnQ1TiwlD3qMf&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=3f1Erp6EDR6gV%2B7yKkjRRVRL3BNNNhP18aOOmiMIWP7y5%2B%2FSNQpjJPoB2fqaqNqd3KmMsYAmJPqQOzwMZiSGVVAUtkHyQD%2B9evVelyz8%2BlJ7vM8k49DzGQ%2F4wDaoYafJPrTSDqN1FVdXCg%3D%3D&u2=ZETBYhSfUyBjf7Am&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=%2BB2R4%2FSPtldF6scqy%2F4OaZqdHtdzvx5Riwmuze0G2JmsEeda82Z5e8p0%2Baxk5Nqe6IdhWfBlaDhCajSZUzcal4AXzoknG%2FOEuaJim0DZXwg209s6ar9HVXdXAqnQJuQNLgq8%2Bt6ucnjRtKY%3D&u2=sM3kBUlaj%2F1buJUo&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=3f1Erp6EDR6gV%2B7yKkjRRVRL3BNNNhP18aOOmiMIWP7y5%2B%2FSNQpjJPoB2fqaqNqd3KmMsYAmJPqQOzwMZiSGVVAUtkHyQD%2B9evVelyz8%2BlJ7vM8k49DzGQ%2F4wDaoYafJPrTSDqN1FVdXCg%3D%3D&u2=ZETBYhSfUyBjf7Am&width=2560',
  },
  food: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=7X1ZjJOwFRPvg5eM3dJ9GAkaHKrNcobyFuM6l0psaLAKwg0cIcF2hscfUa4a%2FlZ3ITKryUUjcmDwz5i81BD88hYT%2BfAcgVJpIHfvjGh6tZiPqf5c%2FBLTGV3BLOD6ELUBQTvgj823Eguch1g8gbgIhP%2FJIQ%3D%3D&u2=Gt34EI5BIOc1c2w3&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=w%2BVi6MqV0n%2BgLhbLT0zGs1v%2BPpYC2YEdw0GwBVxZbPZR%2FEftUAIftXrUY2WRZZJoR3mUnIxjzPS0fprL7lZwFNARPhItM1sozBHJNwRmdw%3D%3D&u2=SddpYgdujxLVcqkk&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=7X1ZjJOwFRPvg5eM3dJ9GAkaHKrNcobyFuM6l0psaLAKwg0cIcF2hscfUa4a%2FlZ3ITKryUUjcmDwz5i81BD88hYT%2BfAcgVJpIHfvjGh6tZiPqf5c%2FBLTGV3BLOD6ELUBQTvgj823Eguch1g8gbgIhP%2FJIQ%3D%3D&u2=Gt34EI5BIOc1c2w3&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=P%2F2BLboFPZ3B6jPVr08c6yJDDknMmEXzuXnWFmdDwhAcaFF7SJzKiBmlatwfCRdrEUSC8LHpSO0wUEDbZFs%2Fb5jleS6oMvN074%2F5TgELLgmHYUEnDLy9%2FE4gZLfB%2FfM1nzSvzwJUkQIbRVvvTXi3ZLiPQbVa&u2=NiRTjtgHKMS6v2et&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=7X1ZjJOwFRPvg5eM3dJ9GAkaHKrNcobyFuM6l0psaLAKwg0cIcF2hscfUa4a%2FlZ3ITKryUUjcmDwz5i81BD88hYT%2BfAcgVJpIHfvjGh6tZiPqf5c%2FBLTGV3BLOD6ELUBQTvgj823Eguch1g8gbgIhP%2FJIQ%3D%3D&u2=Gt34EI5BIOc1c2w3&width=2560',
  },
  gifticon: {
    hero: 'https://sspark.genspark.ai/cfimages?u1=hGi1pTJGBlNn9Ov1ydiyAt1PehD1iT8NOKhDTzXr91v0EOzWcIjCCga2JgbMPDPgEC6yBZE3bowgDr7MhGduCehajSxUgMqgH%2FJ5TYbsHl7BS3xNag%3D%3D&u2=%2B6P9C6PdF9%2FHaMvT&width=2560',
    N: 'https://sspark.genspark.ai/cfimages?u1=ssp%2BBhu53BFoZsllQ5zOQ1itDKtZ4dGGP708oa6XredxCqNVFu9Re5DBtkQaXfd4YVgSaySXmcKUEVmHum0WQMw%3D&u2=B%2Fch1bgZi6hU7esa&width=2560',
    R: 'https://sspark.genspark.ai/cfimages?u1=jVIRXJd3fdGQfZU%2Fd0EUUIsyWwMWPp4YXV4csNKFJ0zgcj%2BNbkYrmIw5gQJPP7NnnVDE2H8yKJkp%2Baj2dcw38RBeyL%2BbgqWmke4qRFImvRWV85KiEcM%3D&u2=un6D8WU1mO17ueVU&width=2560',
    SR: 'https://sspark.genspark.ai/cfimages?u1=5Us%2Fwq5tRdP1dHMyu8WX65teeELfpSbvPolWy%2BrEsI8diey7PB2kt8ZYj69qxrSrhdTPac9bmZ02IcMPohWsJQ5gBZGe&u2=oP0aukcXrrToNe04&width=2560',
    SSR: 'https://sspark.genspark.ai/cfimages?u1=igHGmcyQmqj4j8ct8O5uhi3diQQAdPCrdq0Z4BeADOS4WqoPOmQ78dvOruTpFPewrLsXFExunBi%2BIxOcY8XkWht2D535LD2OdN%2BoYA%3D%3D&u2=gyqmFi6K7fsaWDP9&width=2560',
  },
} as const;

interface ItemDef {
  name: string;
  rarity: ItemRarity;
  estimatedValue: number;
  imageUrl: string;
  weight: number; // relative weight within the gacha's own pool
}

interface GachaDef {
  title: string;
  tagline: string;
  price: number; // GP cost per draw
  iconName: string;
  badgeLabel: string | null;
  accentColorHex: string;
  description: string;
  imageUrl: string;
  totalStock: number;
  soldStockBaseline: number;
  items: ItemDef[];
}

/** Builds a standard 4-tier (N/R/SR/SSR) themed item pool for one category. */
function themedPool(
  images: { N: string; R: string; SR: string; SSR: string },
  names: { N: string; R: string; SR: string; SSR: string },
  values: { N: number; R: number; SR: number; SSR: number },
): ItemDef[] {
  return [
    {
      name: names.N,
      rarity: ItemRarity.N,
      estimatedValue: values.N,
      imageUrl: images.N,
      weight: 600,
    },
    {
      name: names.R,
      rarity: ItemRarity.R,
      estimatedValue: values.R,
      imageUrl: images.R,
      weight: 300,
    },
    {
      name: names.SR,
      rarity: ItemRarity.SR,
      estimatedValue: values.SR,
      imageUrl: images.SR,
      weight: 80,
    },
    {
      name: names.SSR,
      rarity: ItemRarity.SSR,
      estimatedValue: values.SSR,
      imageUrl: images.SSR,
      weight: 20,
    },
  ];
}

const gachaDefs: GachaDef[] = [
  {
    title: '명품 시계 박스',
    tagline: 'PREMIUM HIT!',
    price: 500,
    iconName: 'watch_rounded',
    badgeLabel: 'SPECIAL',
    accentColorHex: '#B8860B',
    description: '스틸 데일리워치부터 스위스 무브먼트 리미티드 워치까지, 시계 마니아를 위한 프리미엄 박스',
    imageUrl: IMG.watch.hero,
    totalStock: 5000,
    soldStockBaseline: 3120,
    items: themedPool(
      IMG.watch,
      {
        N: '데일리 스틸 시계',
        R: '미니멀 가죽밴드 시계',
        SR: '스위스 무브먼트 시계',
        SSR: '리미티드 에디션 워치',
      },
      { N: 80, R: 400, SR: 3000, SSR: 20000 },
    ),
  },
  {
    title: '애플 대란',
    tagline: 'TECH ZONE!',
    price: 500,
    iconName: 'phone_iphone',
    badgeLabel: null,
    accentColorHex: '#3C3C3C',
    description: '보호필름부터 최신형 플래그십 스마트폰까지, 테크 러버를 위한 디지털 기기 박스',
    imageUrl: IMG.phone.hero,
    totalStock: 8000,
    soldStockBaseline: 6420,
    items: themedPool(
      IMG.phone,
      {
        N: '풀커버 강화유리 세트',
        R: '고속충전 어댑터 세트',
        SR: '최신형 스마트폰 128GB',
        SSR: '최신형 스마트폰 1TB + 액세서리 풀세트',
      },
      { N: 50, R: 300, SR: 12000, SSR: 25000 },
    ),
  },
  {
    title: '패션 럭키박스',
    tagline: 'FASHION HIT!',
    price: 500,
    iconName: 'checkroom',
    badgeLabel: 'NEW',
    accentColorHex: '#6A3FBF',
    description: '베이직 캔버스화부터 컬래버 한정판 스니커즈까지, 트렌디한 스트릿 패션 박스',
    imageUrl: IMG.fashion.hero,
    totalStock: 10000,
    soldStockBaseline: 4890,
    items: themedPool(
      IMG.fashion,
      {
        N: '베이직 캔버스화',
        R: '스트릿 하이탑 스니커즈',
        SR: '컬래버레이션 한정판 스니커즈',
        SSR: '프리미엄 레더 스니커즈 풀세트',
      },
      { N: 70, R: 350, SR: 2800, SSR: 18000 },
    ),
  },
  {
    title: '뷰티 럭키박스',
    tagline: 'BEAUTY SPECIAL!',
    price: 500,
    iconName: 'face_retouching_natural',
    badgeLabel: 'SPECIAL',
    accentColorHex: '#D6558C',
    description: '미니 향수부터 프리미엄 뷰티 컬렉션까지, 뷰티 러버를 위한 코스메틱 박스',
    imageUrl: IMG.beauty.hero,
    totalStock: 12000,
    soldStockBaseline: 7010,
    items: themedPool(
      IMG.beauty,
      {
        N: '미니 향수 세트',
        R: '스킨케어 3종 세트',
        SR: '프리미엄 향수 100ml',
        SSR: '리미티드 뷰티 풀 컬렉션',
      },
      { N: 60, R: 350, SR: 2500, SSR: 16000 },
    ),
  },
  {
    title: '명품 가방 박스',
    tagline: 'LUXURY BOX',
    price: 750,
    iconName: 'shopping_bag',
    badgeLabel: null,
    accentColorHex: '#8A6D3B',
    description: '캔버스 파우치부터 리미티드 컬렉션 토트백까지, 명품 가방이 포함된 럭셔리 박스',
    imageUrl: IMG.bag.hero,
    totalStock: 3000,
    soldStockBaseline: 1870,
    items: themedPool(
      IMG.bag,
      {
        N: '캔버스 미니 파우치',
        R: '레더 크로스백',
        SR: '프리미엄 숄더백',
        SSR: '리미티드 컬렉션 토트백',
      },
      { N: 60, R: 500, SR: 3500, SSR: 22000 },
    ),
  },
  {
    title: '가전 프리미엄',
    tagline: 'DIGITAL PRO',
    price: 400,
    iconName: 'devices',
    badgeLabel: 'NEW',
    accentColorHex: '#2A7DAF',
    description: '휴대용 미니 가전부터 프리미엄 가전 풀세트까지, 실속있는 홈 가전 박스',
    imageUrl: IMG.devices.hero,
    totalStock: 6000,
    soldStockBaseline: 2430,
    items: themedPool(
      IMG.devices,
      {
        N: '휴대용 미니 가전',
        R: '프리미엄 토스터기',
        SR: '스마트 홈 가전 세트',
        SSR: '프리미엄 가전 풀세트',
      },
      { N: 90, R: 400, SR: 3200, SSR: 19000 },
    ),
  },
  {
    title: '식품 랜덤박스',
    tagline: 'FOOD LUCKY',
    price: 250,
    iconName: 'restaurant',
    badgeLabel: null,
    accentColorHex: '#4C8C4A',
    description: '미니 간식 세트부터 프리미엄 정찬 코스까지, 맛있는 식품 랜덤박스',
    imageUrl: IMG.food.hero,
    totalStock: 15000,
    soldStockBaseline: 9260,
    items: themedPool(
      IMG.food,
      {
        N: '미니 간식 세트',
        R: '프리미엄 디저트 박스',
        SR: '고급 미식 선물세트',
        SSR: '프리미엄 정찬 코스 세트',
      },
      { N: 40, R: 250, SR: 1800, SSR: 12000 },
    ),
  },
  {
    title: '기프티콘 모음',
    tagline: 'GIFTICON BOX',
    price: 150,
    iconName: 'card_giftcard',
    badgeLabel: null,
    accentColorHex: '#9AA0A6',
    description: '커피 기프티콘부터 백화점 상품권까지, 부담없이 즐기는 기프티콘 박스',
    imageUrl: IMG.gifticon.hero,
    totalStock: 20000,
    soldStockBaseline: 13580,
    items: themedPool(
      IMG.gifticon,
      {
        N: '커피 기프티콘',
        R: '편의점 상품권 세트',
        SR: '백화점 상품권 5만원',
        SSR: '백화점 상품권 30만원',
      },
      { N: 30, R: 150, SR: 900, SSR: 6000 },
    ),
  },
];

async function run() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [
      User,
      Gacha,
      Item,
      GachaItem,
      Draw,
      InventoryItem,
      ShippingRequest,
      ShippingRequestItem,
      WalletTransaction,
    ],
    synchronize: true,
  });

  await dataSource.initialize();
  console.log('📦 Database connected. Seeding...');

  const userRepo = dataSource.getRepository(User);
  const gachaRepo = dataSource.getRepository(Gacha);
  const itemRepo = dataSource.getRepository(Item);
  const gachaItemRepo = dataSource.getRepository(GachaItem);
  const walletRepo = dataSource.getRepository(WalletTransaction);

  // --- Demo user -----------------------------------------------------
  let demoUser = await userRepo.findOne({
    where: { email: 'demo@gachivault.com' },
  });
  if (!demoUser) {
    const hashed = await bcrypt.hash('Password1', 10);
    demoUser = await userRepo.save(
      userRepo.create({
        email: 'demo@gachivault.com',
        password: hashed,
        nickname: '가치유저1',
        coinBalance: STARTING_BALANCE,
      }),
    );
    console.log('👤 Created demo user: demo@gachivault.com / Password1');

    await walletRepo.save(
      walletRepo.create({
        userId: demoUser.id,
        type: WalletTransactionType.EARN,
        amount: STARTING_BALANCE,
        description: '회원가입 축하 GP',
        balanceAfter: STARTING_BALANCE,
      }),
    );
  } else if (Number(demoUser.coinBalance) < 500) {
    const topup = STARTING_BALANCE - Number(demoUser.coinBalance);
    demoUser.coinBalance = STARTING_BALANCE;
    await userRepo.save(demoUser);
    await walletRepo.save(
      walletRepo.create({
        userId: demoUser.id,
        type: WalletTransactionType.EARN,
        amount: topup,
        description: 'GP 충전 (seed 재보충)',
        balanceAfter: STARTING_BALANCE,
      }),
    );
    console.log(`👤 Demo user balance topped back up to ${STARTING_BALANCE}.`);
  } else {
    console.log('👤 Demo user already exists, skipping.');
  }

  // --- A handful of extra "leaderboard" demo users so /rankings/users
  // isn't a single-row list. These are display-only demo accounts
  // (no login flow expected) with pre-seeded lifetime draw stats via
  // synthetic Draw rows below.
  const leaderboardNicknames = [
    '가치왕뽑기',
    '럭키드로우',
    '가차홀릭',
    '박스마스터',
    '한방인생',
    '데일리가차',
    '컬렉터준',
    '골드핸드',
  ];
  const leaderboardUsers: User[] = [];
  for (const nickname of leaderboardNicknames) {
    const email = `${nickname.toLowerCase()}@demo.gachivault.com`;
    let user = await userRepo.findOne({ where: { email } });
    if (!user) {
      user = await userRepo.save(
        userRepo.create({
          email,
          password: null,
          nickname,
          coinBalance: 0,
        }),
      );
    }
    leaderboardUsers.push(user);
  }

  // --- Items -----------------------------------------------------------
  // Build a flat item list per-gacha (thematically distinct pools), keyed
  // by "<gachaTitle>::<rarity>" so seedPool() below can look them up.
  const itemsByKey = new Map<string, Item>();
  for (const def of gachaDefs) {
    for (const itemDef of def.items) {
      const key = `${def.title}::${itemDef.rarity}`;
      let item = await itemRepo.findOne({
        where: { name: itemDef.name, rarity: itemDef.rarity },
      });
      if (!item) {
        item = await itemRepo.save(
          itemRepo.create({
            name: itemDef.name,
            rarity: itemDef.rarity,
            estimatedValue: itemDef.estimatedValue,
            imageUrl: itemDef.imageUrl,
          }),
        );
        console.log(`🎁 Created item: ${itemDef.name}`);
      } else {
        // Keep image/value in sync on repeated seed runs.
        item.imageUrl = itemDef.imageUrl;
        item.estimatedValue = itemDef.estimatedValue;
        await itemRepo.save(item);
      }
      itemsByKey.set(key, item);
    }
  }

  async function seedPool(gacha: Gacha, def: GachaDef) {
    const validItemIds: number[] = [];
    for (const itemDef of def.items) {
      const item = itemsByKey.get(`${def.title}::${itemDef.rarity}`);
      if (!item) continue;
      validItemIds.push(item.id);
      const exists = await gachaItemRepo.findOne({
        where: { gachaId: gacha.id, itemId: item.id },
      });
      if (!exists) {
        await gachaItemRepo.save(
          gachaItemRepo.create({
            gachaId: gacha.id,
            itemId: item.id,
            weight: itemDef.weight,
          }),
        );
      } else {
        exists.weight = itemDef.weight;
        await gachaItemRepo.save(exists);
      }
    }
    // Remove stale pivot rows left over from earlier seed runs / manual
    // testing (e.g. old generic "N 등급 가치 카드" placeholder items that
    // don't belong to this box's themed pool). Without this cleanup, the
    // "LUCKY LINEUP" ends up mixing real themed items with leftover
    // generic placeholders (imageUrl: null) — exactly the mismatch bug
    // reported by the user.
    if (validItemIds.length > 0) {
      await gachaItemRepo
        .createQueryBuilder()
        .delete()
        .where('gachaId = :gachaId', { gachaId: gacha.id })
        .andWhere('itemId NOT IN (:...ids)', { ids: validItemIds })
        .execute();
    }
  }

  const savedGachas: Gacha[] = [];
  for (const def of gachaDefs) {
    let gacha = await gachaRepo.findOne({ where: { title: def.title } });
    if (!gacha) {
      gacha = await gachaRepo.save(
        gachaRepo.create({
          title: def.title,
          description: def.description,
          price: def.price,
          currency: CurrencyType.GP,
          active: true,
          tagline: def.tagline,
          iconName: def.iconName,
          badgeLabel: def.badgeLabel,
          accentColorHex: def.accentColorHex,
          imageUrl: def.imageUrl,
          totalStock: def.totalStock,
          soldStockBaseline: def.soldStockBaseline,
        }),
      );
      console.log(`🎰 Created gacha: ${def.title}`);
    } else {
      // Keep display metadata in sync on repeated seed runs.
      gacha.tagline = def.tagline;
      gacha.iconName = def.iconName;
      gacha.badgeLabel = def.badgeLabel;
      gacha.accentColorHex = def.accentColorHex;
      gacha.price = def.price;
      gacha.currency = CurrencyType.GP;
      gacha.imageUrl = def.imageUrl;
      gacha.totalStock = def.totalStock;
      gacha.soldStockBaseline = def.soldStockBaseline;
      gacha.description = def.description;
      await gachaRepo.save(gacha);
    }
    await seedPool(gacha, def);
    savedGachas.push(gacha);
  }

  // Deactivate the older 스타터/프리미엄 가차 test gachas (kept in DB for
  // historical Draw/InventoryItem foreign-key integrity from earlier
  // manual API testing), so GET /gachas (active-only) returns exactly the
  // 8 gachas the Flutter home screen expects.
  await gachaRepo
    .createQueryBuilder()
    .update(Gacha)
    .set({ active: false })
    .where('title IN (:...titles)', {
      titles: ['스타터 가치가차', '프리미엄 가치가차'],
    })
    .execute();

  console.log('🔗 Linked gacha pools.');

  // --- Synthetic leaderboard draw history --------------------------------
  // Gives /rankings/users something realistic to rank by lifetime draw
  // count & total won value, without requiring real user activity.
  const drawRepo = dataSource.getRepository(Draw);
  const inventoryRepo = dataSource.getRepository(InventoryItem);
  let seededAnyRankingDraws = false;
  for (let i = 0; i < leaderboardUsers.length; i++) {
    const user = leaderboardUsers[i];
    const existingCount = await drawRepo.count({ where: { userId: user.id } });
    if (existingCount > 0) continue; // already seeded previously

    seededAnyRankingDraws = true;
    // Higher-ranked demo users get more draws (descending by index).
    const drawCount = 180 - i * 18; // 180,162,...,54
    const gacha = savedGachas[i % savedGachas.length];
    const pool = await gachaItemRepo.find({
      where: { gachaId: gacha.id },
      relations: ['item'],
    });
    for (let d = 0; d < drawCount; d++) {
      // Weighted-ish pick: mostly N/R, occasionally SR/SSR for realism.
      const roll = Math.random() * 1000;
      let picked = pool[0];
      let cumulative = 0;
      for (const entry of pool) {
        cumulative += entry.weight;
        if (roll <= cumulative) {
          picked = entry;
          break;
        }
      }
      const draw = await drawRepo.save(
        drawRepo.create({
          userId: user.id,
          gachaId: gacha.id,
          spent: gacha.price,
          currency: gacha.currency,
        }),
      );
      await inventoryRepo.save(
        inventoryRepo.create({
          userId: user.id,
          itemId: picked.item.id,
          drawId: draw.id,
        }),
      );
    }
    console.log(`🏆 Seeded ${drawCount} historical draws for ${user.nickname}`);
  }
  if (!seededAnyRankingDraws) {
    console.log('🏆 Leaderboard draw history already seeded, skipping.');
  }

  await dataSource.destroy();
  console.log('✅ Seeding complete.');
}

run().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
