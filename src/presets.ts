/**
 * Ready-made strategy presets (data only, so config.ts can use them without import cycles).
 * A strategy never touches the user's money settings (SOL per buy, total exposure, daily loss
 * limit, reserve) or the safety checks; it only changes HOW the bot trades.
 */
import type { Config } from './config';

export type Patch = {
  buy?: Partial<Pick<Config['buy'], 'minTargetBuySol'>>;
  sell?: Partial<Config['sell']>;
  risk?: Partial<Pick<Config['risk'], 'stopLossPct' | 'takeProfitPct' | 'maxPriceDriftPct' | 'maxSignalAgeSec'>>;
  exits?: Partial<Config['exits']>;
  filters?: Partial<Config['filters']>;
  protect?: Partial<Config['protect']>;
};

export type Strategy = { id: string; name: string; tagline: string; bestFor: string; risk: 'Lower' | 'Medium' | 'Higher'; patch: Patch };

export const STRATEGIES: Strategy[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    tagline: "Copybot's standard settings: take your cost back at 2x, take profits in steps, trailing stop.",
    bestFor: 'Most people, and a good starting point.',
    risk: 'Medium',
    patch: {
      buy: { minTargetBuySol: 0.2 },
      sell: { copySells: true },
      risk: { stopLossPct: 40, takeProfitPct: 0, maxPriceDriftPct: 15, maxSignalAgeSec: 30 },
      exits: { recoverCostAtPct: 100, tp1AtPct: 300, tp1SellPct: 50, tp2AtPct: 900, tp2SellPct: 50, trailingAfterPct: 50, trailingStopPct: 30 },
      filters: { minLiquidityUsd: 10_000, maxTradePctOfLiquidity: 2, minMarketCapUsd: 0, maxMarketCapUsd: 0, minTokenAgeMin: 0, maxTopHolderPct: 15, maxTop10HoldersPct: 50 },
      protect: { liquidityDropPct: 50, crashPct: 35, crashWindowMin: 5, maxSellBuyRatio: 3 },
    },
  },
  {
    id: 'sniper',
    name: 'Sniper',
    tagline: 'Gets in early, takes profit fast, cuts losses quickly. Many small wins.',
    bestFor: 'Copying fast traders on brand-new tokens.',
    risk: 'Higher',
    patch: {
      buy: { minTargetBuySol: 0.2 },
      sell: { copySells: true },
      risk: { stopLossPct: 25, takeProfitPct: 0, maxPriceDriftPct: 8, maxSignalAgeSec: 15 },
      exits: { recoverCostAtPct: 0, tp1AtPct: 40, tp1SellPct: 60, tp2AtPct: 80, tp2SellPct: 100, trailingAfterPct: 20, trailingStopPct: 12 },
      filters: { minLiquidityUsd: 5_000, maxTradePctOfLiquidity: 3, minMarketCapUsd: 0, maxMarketCapUsd: 2_000_000, minTokenAgeMin: 0, maxTopHolderPct: 20, maxTop10HoldersPct: 60 },
      protect: { liquidityDropPct: 40, crashPct: 25, crashWindowMin: 3, maxSellBuyRatio: 2.5 },
    },
  },
  {
    id: 'whale',
    name: 'Whale follower',
    tagline: 'Only copies big buys, gives trades room and rides the winners longer.',
    bestFor: 'Copying large, patient wallets.',
    risk: 'Medium',
    patch: {
      buy: { minTargetBuySol: 5 },
      sell: { copySells: true },
      risk: { stopLossPct: 45, takeProfitPct: 0, maxPriceDriftPct: 20, maxSignalAgeSec: 60 },
      exits: { recoverCostAtPct: 100, tp1AtPct: 300, tp1SellPct: 40, tp2AtPct: 1000, tp2SellPct: 50, trailingAfterPct: 100, trailingStopPct: 35 },
      filters: { minLiquidityUsd: 50_000, maxTradePctOfLiquidity: 2, minMarketCapUsd: 0, maxMarketCapUsd: 0, minTokenAgeMin: 60, maxTopHolderPct: 15, maxTop10HoldersPct: 50 },
      protect: { liquidityDropPct: 60, crashPct: 45, crashWindowMin: 10, maxSellBuyRatio: 4 },
    },
  },
  {
    id: 'momentum',
    name: 'Momentum',
    tagline: 'Copies into tokens that are already moving, takes profits in steps on the way up.',
    bestFor: 'Busy markets with lots of trending tokens.',
    risk: 'Higher',
    patch: {
      buy: { minTargetBuySol: 0.5 },
      sell: { copySells: true },
      risk: { stopLossPct: 35, takeProfitPct: 0, maxPriceDriftPct: 25, maxSignalAgeSec: 30 },
      exits: { recoverCostAtPct: 50, tp1AtPct: 200, tp1SellPct: 50, tp2AtPct: 500, tp2SellPct: 50, trailingAfterPct: 50, trailingStopPct: 25 },
      filters: { minLiquidityUsd: 20_000, maxTradePctOfLiquidity: 2, minMarketCapUsd: 0, maxMarketCapUsd: 0, minTokenAgeMin: 30, maxTopHolderPct: 15, maxTop10HoldersPct: 50 },
      protect: { liquidityDropPct: 50, crashPct: 30, crashWindowMin: 5, maxSellBuyRatio: 3 },
    },
  },
  {
    id: 'conservative',
    name: 'Conservative',
    tagline: 'Strict filters, a tight stop-loss, and your cost back early. Fewer trades, smaller losses.',
    bestFor: 'Going live for the first time, or protecting gains.',
    risk: 'Lower',
    patch: {
      buy: { minTargetBuySol: 1 },
      sell: { copySells: true },
      risk: { stopLossPct: 20, takeProfitPct: 0, maxPriceDriftPct: 10, maxSignalAgeSec: 20 },
      exits: { recoverCostAtPct: 50, tp1AtPct: 150, tp1SellPct: 50, tp2AtPct: 400, tp2SellPct: 100, trailingAfterPct: 40, trailingStopPct: 20 },
      filters: { minLiquidityUsd: 75_000, maxTradePctOfLiquidity: 1, minMarketCapUsd: 0, maxMarketCapUsd: 0, minTokenAgeMin: 360, maxTopHolderPct: 10, maxTop10HoldersPct: 40 },
      protect: { liquidityDropPct: 35, crashPct: 25, crashWindowMin: 5, maxSellBuyRatio: 2.5 },
    },
  },
];

export const strategyById = (id: unknown) => STRATEGIES.find((s) => s.id === id) ?? null;

