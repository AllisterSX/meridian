/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const POOL_MEMORY_FILE = "./pool-memory.json";


const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isDlmmSupplyCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("dlmm") || text.includes("supply trapped") || text.includes("meteora dlmm pool");
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}
function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown for low yield closes
  if (deploy.close_reason === "low yield") {
    const cooldownHours = 4;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  // ── OOR Cooldown — direction-aware ────────────────────────────
  // Pump (OOR upside) 3x in a row → short cooldown (15 min):
  //   Token is trending up, position just keeps getting left behind.
  //   Short cooldown so we can redeploy quickly at new active price.
  // Dump (OOR downside) 1x → long cooldown (4 hours):
  //   Token fell through our range — real downside risk, wait for stability.
  //   Don't redeploy into a token that's actively dumping.
  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const lastDeploy = recentDeploys[recentDeploys.length - 1];
  const lastCloseReason = String(lastDeploy?.close_reason || "").toLowerCase();

  // Detect dump: OOR and direction is "down"/"dump"/"downside" or generic OOR on a losing trade
  const isDump = isOorCloseReason(lastCloseReason) && (
    lastCloseReason.includes("dump") ||
    lastCloseReason.includes("down") ||
    lastCloseReason.includes("downside") ||
    (deploy.pnl_pct != null && deploy.pnl_pct < -2)  // lost >2% = likely dump OOR
  );

  if (isDump) {
    const cooldownHours = 4;
    const reason = "OOR dump — price fell below range";
    const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
    log("pool-memory", `DUMP cooldown: ${entry.name} locked ${cooldownHours}h until ${poolCooldownUntil}`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `DUMP mint cooldown: ${entry.base_mint.slice(0, 8)} locked ${cooldownHours}h`);
    }
  } else {
    // Pump OOR: check if repeated N times
    const repeatedPumpOor =
      recentDeploys.length >= oorTriggerCount &&
      recentDeploys.every((d) => isOorCloseReason(d.close_reason));

    if (repeatedPumpOor) {
      const cooldownMinutes = 15;
      const cooldownHours = cooldownMinutes / 60;
      const reason = `repeated pump OOR (${oorTriggerCount}x) — short cooldown`;
      const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
      const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
      log("pool-memory", `PUMP cooldown: ${entry.name} locked ${cooldownMinutes}m until ${poolCooldownUntil}`);
      if (entry.base_mint && mintCooldownUntil) {
        log("pool-memory", `PUMP mint cooldown: ${entry.base_mint.slice(0, 8)} locked ${cooldownMinutes}m`);
      }
    }
  }

  // ── DLMM Supply Cooldown ──────────────────────────────────────
  // When a position is closed because Meteora DLMM pools hold too much
  // supply (Rule 6), this token is inherently risky — supply is trapped
  // in LP and the token is unlikely to pump. Apply a long cooldown to
  // both this pool AND all pools sharing the same base mint so the
  // screener doesn't redeploy into the same token via a different pool.
  if (isDlmmSupplyCloseReason(deploy.close_reason)) {
    const cooldownHours = 8;
    const reason = `DLMM supply trap — supply concentrated in Meteora LP pools`;
    const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
    log("pool-memory", `DLMM SUPPLY cooldown: ${entry.name} locked ${cooldownHours}h until ${poolCooldownUntil}`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `DLMM SUPPLY mint cooldown: ${entry.base_mint.slice(0, 8)} locked ${cooldownHours}h — applies to ALL pools with this base token`);
    }
    // Also store a persistent note so future screening cycles see this context
    const supplyNote = sanitizeStoredNote(
      `DLMM supply trap detected at close (${new Date().toISOString().slice(0, 10)}): ${deploy.close_reason}`
    );
    if (supplyNote) {
      if (!entry.notes) entry.notes = [];
      entry.notes.push({ note: supplyNote, added_at: new Date().toISOString(), auto: true, tag: "dlmm_supply" });
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
    // OOR direction: "pump" = price above upper range, "dump" = below lower range, null = in-range
    oor_direction: snapshot.in_range === false ? (snapshot.oor_direction ?? null) : null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary — break out pump closes so LLM doesn't misread them as IL risk
  if (entry.total_deploys > 0) {
    const deploys = entry.deploys || [];
    const pumpCloses = deploys.filter(d => (d.close_reason || "").toLowerCase().includes("pump")).length;
    const pumpNote = pumpCloses > 0
      ? `, ${pumpCloses}/${entry.total_deploys} closed due to pump (price rose above range — positive exits)`
      : "";
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}${pumpNote}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorSnaps = snaps.filter(s => s.in_range === false);
    const oorCount = oorSnaps.length;
    const pumpCount = oorSnaps.filter(s => s.oor_direction === "pump").length;
    const dumpCount = oorSnaps.filter(s => s.oor_direction === "dump").length;

    let oorNote = `OOR in ${oorCount}/${snaps.length} cycles`;
    if (oorCount > 0) {
      if (pumpCount > 0 && dumpCount === 0) {
        oorNote += ` (all pump — price rose above range, bullish)`;
      } else if (dumpCount > 0 && pumpCount === 0) {
        oorNote += ` (all dump — price fell below range, bearish)`;
      } else if (pumpCount > 0 || dumpCount > 0) {
        oorNote += ` (${pumpCount} pump, ${dumpCount} dump)`;
      }
    }

    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, ${oorNote}`);
  }

  // DLMM supply warning — shown first and prominently so screener can't miss it
  const dlmmNotes = (entry.notes || []).filter(n => n.tag === "dlmm_supply");
  if (dlmmNotes.length > 0) {
    const last = dlmmNotes[dlmmNotes.length - 1];
    lines.push(`⚠️ DLMM SUPPLY TRAP: ${last.note} — AVOID redeploying into this pool or any pool with the same base token.`);
  }

  // Other notes (non-DLMM)
  const otherNotes = (entry.notes || []).filter(n => n.tag !== "dlmm_supply");
  if (otherNotes.length > 0) {
    const lastNote = otherNotes[otherNotes.length - 1];
    lines.push(`NOTE: ${lastNote.note}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${note}`);
  return { saved: true, pool_address, note };
}