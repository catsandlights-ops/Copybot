/**
 * RPC failover. Every HTTP RPC call goes through rpcFetch(), which sends it to the primary RPC
 * or, after repeated failures, to the backup RPC (RPC_URL_BACKUP). After a cool-down it tries the
 * primary again. Websocket subscriptions stay on the primary; the bot's polling loop keeps
 * catching trades over HTTP while the primary is down.
 */
export type RpcState = { active: 'primary' | 'backup'; failures: number; switchedAt: number };

export class RpcFailover {
  state: RpcState = { active: 'primary', failures: 0, switchedAt: 0 };
  constructor(
    private urls: () => { primary: string; backup: string | null },
    private onSwitch: (to: 'primary' | 'backup', why: string) => void = () => {},
    private opts = { failuresToSwitch: 5, retryPrimaryAfterMs: 5 * 60_000 },
    private now: () => number = Date.now,
  ) {}

  /** The URL to use right now. */
  current(): string {
    const { primary, backup } = this.urls();
    if (this.state.active === 'backup') {
      if (!backup) return this.back('backup removed'), primary;
      if (this.now() - this.state.switchedAt >= this.opts.retryPrimaryAfterMs) return this.back('trying the main RPC again'), primary;
      return backup;
    }
    return primary;
  }

  ok(url: string) {
    if (url === this.urls().primary || this.state.active === 'backup') this.state.failures = 0;
  }

  /** Count a failure (rate limit, server error or network error) on `url`. */
  fail(url: string) {
    const { primary, backup } = this.urls();
    if (url !== primary || this.state.active !== 'primary') return;
    this.state.failures++;
    if (backup && this.state.failures >= this.opts.failuresToSwitch) {
      this.state = { active: 'backup', failures: 0, switchedAt: this.now() };
      this.onSwitch('backup', `the main RPC failed ${this.opts.failuresToSwitch} times in a row`);
    }
  }

  private back(why: string) {
    this.state = { active: 'primary', failures: 0, switchedAt: this.now() };
    this.onSwitch('primary', why);
  }
}

/** A fetch() for RPC calls that follows the failover and records how each call went. */
export function failoverFetch(f: RpcFailover, primaryUrl: () => string) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const asked = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Only calls aimed at the primary RPC are redirected; anything else passes through.
    const url = asked === primaryUrl() ? f.current() : asked;
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) f.fail(url);
      else f.ok(url);
      return res;
    } catch (e) {
      f.fail(url);
      throw e;
    }
  };
}
