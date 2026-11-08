// Headless mode: run the bot in the terminal without the UI (useful on a VPS).
import { BotEngine } from './engine';

const engine = new BotEngine();
engine.start().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
setInterval(() => {
  const s = engine.snapshot();
  engine.log(`${s.positions.length} open, exposure ${s.exposureSol.toFixed(3)} SOL, realized PnL ${s.realizedPnlSol.toFixed(4)} SOL`, 'system');
}, 60_000);
process.on('SIGINT', async () => {
  await engine.stop();
  process.exit(0);
});
