/**
 * IPv6 egress rotation
 * ====================
 *
 * YouTube classifies egress by *address class*, not by a per-request counter:
 * `/youtubei/v1/player` refuses datacenter addresses while `/browse` answers from
 * the same IP. A single static IPv6 is treated the same way. What does work is
 * presenting a **different address from a routed /64**, which is the method
 * Invidious documents for escaping YouTube blocking ("Rotate your IPv6 address
 * for escaping YouTube blocking").
 *
 * Requirements and caveats, all of which matter:
 *
 *  - The host must have a **fully routed /64** (or larger). Most VPS providers do;
 *    AWS/GCP/Oracle typically require manual assignment and do *not* let you
 *    address arbitrarily within the prefix.
 *  - The address must be bound to the interface before use. Either run a rotator
 *    (`ip -6 addr add`) or rely on the whole /64 already being routed to the box —
 *    the latter is the common case and needs no root.
 *  - **One address per playback session.** The googlevideo media URL is signed and
 *    carries `ip=`; negotiating on one address and fetching media from another
 *    yields a silent media-only 403. So an address is pinned for the lifetime of a
 *    track, and rotation only happens between sessions or when a block is seen.
 *
 * When no /64 is configured this module is inert and the process egresses normally.
 */

import { Agent, Dispatcher, setGlobalDispatcher } from 'undici';
import { AsyncLocalStorage } from 'node:async_hooks';

interface Lease {
  address: string;
  dispatcher: Dispatcher;
  /** Sessions currently pinned to this address. */
  inUse: number;
  /** Incremented whenever this address produced a block. */
  failures: number;
  createdAt: number;
}

const leases = new Map<string, Lease>();
let prefix: string | null = null;
let poolSize = 0;
let rotationMs = 6 * 60 * 60 * 1000; // re-lease an address every 6h by default

/* ------------------------------ helpers -------------------------------- */

/**
 * Expand an IPv6 prefix into concrete addresses.
 * Accepts a /64 (or shorter) written as `2001:db8:1234:5678::/64` and randomises
 * the lower 64 bits. A bare address without `/` is treated as a single address.
 */
export function configureIpv6Pool(raw: string | undefined, size: number, rotateHours: number): void {
  if (!raw) return;
  const [addr, bitsRaw] = raw.split('/');
  const bits = bitsRaw ? parseInt(bitsRaw, 10) : 128;
  if (!addr.includes(':')) return;

  if (bits >= 128) {
    // A single address: usable, but there is nothing to rotate.
    prefix = addr;
    poolSize = 1;
  } else if (bits <= 64) {
    // Keep the network part, randomise the interface part.
    const head = addr.replace(/::?$/, '').split(':').filter(Boolean) as string[];
    prefix = `${head.join(':')}::`;
    poolSize = Math.max(1, size);
  } else {
    console.warn(`[egress] IPv6 prefix /${bits} is too small to rotate within; ignoring`);
    return;
  }
  rotationMs = Math.max(1, rotateHours) * 60 * 60 * 1000;
  console.log(`[egress] IPv6 pool configured: prefix=${prefix} size=${poolSize} rotate=${rotateHours}h`);
}

export function ipv6PoolStatus() {
  return {
    configured: !!prefix,
    prefix,
    poolSize,
    leases: [...leases.values()].map((l) => ({
      address: l.address,
      inUse: l.inUse,
      failures: l.failures,
      ageMin: Math.round((Date.now() - l.createdAt) / 60000),
    })),
  };
}

/** Random lower-64-bit address inside the configured prefix. */
function randomAddress(): string {
  if (!prefix) throw new Error('no IPv6 prefix configured');
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) groups.push(Math.floor(Math.random() * 0x10000).toString(16));
  return `${prefix}${groups.join(':')}`;
}

function makeDispatcher(address: string): Dispatcher {
  return new Agent({
    localAddress: address,
    connect: { timeout: 20_000 },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
}

/* ------------------------------- leasing -------------------------------- */

/**
 * Lease an address for a playback session.
 *
 * Prefers an address that is not currently in use and has no recorded failures,
 * so concurrent tracks do not share an egress address (which would make one
 * track's block affect another).
 */
export function leaseAddress(): Lease | null {
  if (!prefix) return null;
  const now = Date.now();
  for (const lease of leases.values()) {
    if (lease.inUse === 0 && lease.failures === 0 && now - lease.createdAt < rotationMs) {
      lease.inUse++;
      return lease;
    }
  }
  // Retire expired or repeatedly-failing addresses, then mint a fresh one.
  if (leases.size >= Math.max(poolSize, 2)) {
    const stale = [...leases.values()]
      .filter((l) => l.inUse === 0)
      .sort((a, b) => b.failures - a.failures || a.createdAt - b.createdAt)[0];
    if (stale) {
      void stale.dispatcher.close().catch(() => {});
      leases.delete(stale.address);
    }
  }
  const address = randomAddress();
  const lease: Lease = { address, dispatcher: makeDispatcher(address), inUse: 1, failures: 0, createdAt: now };
  leases.set(address, lease);
  return lease;
}

export function releaseAddress(lease: Lease | null): void {
  if (!lease) return;
  lease.inUse = Math.max(0, lease.inUse - 1);
}

/** Report that an address was refused, so it is not reused. */
export function markAddressBlocked(lease: Lease | null): void {
  if (!lease) return;
  lease.failures++;
  console.warn(`[egress] address ${lease.address} refused (failures=${lease.failures}); rotating`);
}

/** Run `fn` with a pinned address, releasing it afterwards. */
export async function withAddress<T>(fn: (lease: Lease | null) => Promise<T>): Promise<T> {
  const lease = leaseAddress();
  try {
    return await fn(lease);
  } finally {
    releaseAddress(lease);
  }
}

/* --------------------------- request routing ---------------------------- */

/**
 * Routes each connection to the source address of whichever playback session is
 * currently executing.
 *
 * A single global dispatcher cannot express "address per concurrent session", and
 * all requests in a session must share one address. AsyncLocalStorage gives each
 * session its own context without threading parameters through youtubei.js,
 * googlevideo and BotGuard.
 */
class RoutingDispatcher extends Dispatcher {
  constructor(private readonly store: AsyncLocalStorage<Lease>) {
    super();
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const lease = this.store.getStore();
    // Fall back to the default global agent when no lease is active.
    const target = lease ? lease.dispatcher : defaultDispatcher;
    return target.dispatch(opts, handler);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

const leaseStore = new AsyncLocalStorage<Lease>();
let defaultDispatcher: Dispatcher = new Agent();
let routingInstalled = false;

/** Install the routing dispatcher. No-op unless a pool is configured. */
export function installAddressRouting(): void {
  if (routingInstalled || !prefix) return;
  routingInstalled = true;
  setGlobalDispatcher(new RoutingDispatcher(leaseStore));
  console.log('[egress] per-session IPv6 routing active');
}

/** Run a playback session inside its own egress address. */
export function runWithAddress<T>(fn: () => Promise<T>): Promise<T> {
  if (!prefix) return fn();
  const lease = leaseAddress();
  if (!lease) return fn();
  return leaseStore.run(lease, async () => {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // A refusal here means this address is burned; do not reuse it.
      if (/LOGIN_REQUIRED|403|UNPLAYABLE/i.test(msg)) markAddressBlocked(lease);
      throw err;
    } finally {
      releaseAddress(lease);
    }
  });
}

/**
 * Point the global dispatcher at a lease.
 *
 * Everything outbound must leave from the same address during a session —
 * youtubei.js uses `Platform.shim.fetch`, and googlevideo/BotGuard use the global
 * fetch — so a single global dispatcher swap is the simplest way to guarantee
 * that. Callers restore the previous dispatcher when the session ends.
 */
export function activateLease(lease: Lease | null): Dispatcher | null {
  if (!lease) return null;
  setGlobalDispatcher(lease.dispatcher);
  return lease.dispatcher;
}

/** Periodic maintenance: drop idle, failed or expired addresses. */
export function reapLeases(): void {
  const now = Date.now();
  for (const [address, lease] of leases) {
    const expired = now - lease.createdAt > rotationMs;
    if (lease.inUse === 0 && (expired || lease.failures > 2)) {
      void lease.dispatcher.close().catch(() => {});
      leases.delete(address);
    }
  }
}
