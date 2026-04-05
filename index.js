import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled, createLiveMessage } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo, getTokenHolders } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

const TP_PCT = config.management.takeProfitFeePct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
// ─── Meteora DLMM Pool Detection ──────────────────────────────────────────
// Strategy: get all DLMM pool addresses for a token directly from Meteora API.
// Each holder address is then checked against this set — no tag dependency.
// Fallback: if Meteora API fails, check each unknown holder address individually
// via pool_address= filter (verifies if an address is a valid DLMM pool).
const _dlmmPoolAddressCache = new Map(); // mint → { addresses: Set, meta: Map<addr,{bin_step,fee_pct,name}>, expiresAt: number }
const _dlmmAddrVerifyCache = new Map();  // address → { isDlmm: boolean, expiresAt: number }
const DLMM_POOL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch all Meteora DLMM pool addresses for a specific token mint.
// Returns a Set of pool addresses (empty if API unavailable).
// Also caches pool metadata (bin_step, fee_pct, name) for readable log output.
async function getMeteoraDlmmPoolAddresses(mint, label = null) {
  const now = Date.now();
  const cached = _dlmmPoolAddressCache.get(mint);
  if (cached && now < cached.expiresAt) return cached.addresses;

  const displayName = label || mint?.slice(0, 8);
  try {
    // Use DLMM search API — pool-discovery API does NOT support filter_by=base_token_mint
    // dlmm.datapi.meteora.ag accepts mint address as query and returns all pools for that token
    const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    // Filter to only pools where this mint is actually token_x or token_y
    const pools = (Array.isArray(data?.data) ? data.data : [])
      .filter(p => p?.token_x?.address === mint || p?.token_y?.address === mint);
    const addresses = new Set(pools.map(p => p.address).filter(Boolean));
    // Store pool metadata keyed by address for readable log labels
    const meta = new Map(pools.map(p => {
      const rawFee = p.base_fee_percentage ?? p.fee_pct ?? p.base_fee_rate;
      return [
        p.address,
        {
          bin_step: p.bin_step ?? p.dlmm_params?.bin_step ?? null,
          fee_pct:  rawFee != null ? Number(rawFee) : null,
          name:     p.name || null,
        }
      ];
    }));
    _dlmmPoolAddressCache.set(mint, { addresses, meta, expiresAt: now + DLMM_POOL_CACHE_TTL_MS });
    log("screening", `Meteora DLMM pool list for ${displayName}: ${addresses.size} pool(s)`);
    return addresses;
  } catch (e) {
    log("screening_warn", `Meteora pool list unavailable for ${displayName}: ${e.message}`);
    return new Set();
  }
}

// Get a human-readable label for a DLMM pool address using cached metadata.
// Returns e.g. "100/3" instead of raw address slice.
function getDlmmPoolLabel(address, mint) {
  const cached = mint ? _dlmmPoolAddressCache.get(mint) : null;
  const meta = cached?.meta?.get(address);
  if (meta) {
    const parts = [];
    if (meta.bin_step != null) parts.push(meta.bin_step);
    if (meta.fee_pct != null)  parts.push(`${meta.fee_pct}%`); // Tambahkan simbol %
    if (parts.length > 0) return parts.join("/");
    return meta.name || address.slice(0, 8);
  }
  return address.slice(0, 8);
}

// Verify if a single address is a Meteora DLMM pool via pool_address= filter.
// Used as fallback when the mint-based fetch fails or returns 0 results.
async function isMeteoraDlmmPool(address) {
  const now = Date.now();
  const cached = _dlmmAddrVerifyCache.get(address);
  if (cached && now < cached.expiresAt) return cached.isDlmm;

  try {
    const url = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&timeframe=5m&filter_by=${encodeURIComponent(`pool_address=${address}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) { _dlmmAddrVerifyCache.set(address, { isDlmm: false, expiresAt: now + DLMM_POOL_CACHE_TTL_MS }); return false; }
    const data = await res.json();
    const isDlmm = (data.data || []).length > 0;
    _dlmmAddrVerifyCache.set(address, { isDlmm, expiresAt: now + DLMM_POOL_CACHE_TTL_MS });
    return isDlmm;
  } catch {
    return false;
  }
}

// Compute total DLMM supply % held by ALL Meteora DLMM pools in holder list.
// knownDlmmAddresses: Set from getMeteoraDlmmPoolAddresses (may be empty if API failed).
// knownPoolAddr: the specific pool we're evaluating/holding (always include this one).
function computeDlmmSupplyPct(holders, knownDlmmAddresses, knownPoolAddr = null) {
  const dlmmHolders = holders.filter(h => {
    // Primary: exact match against Meteora-verified pool address list
    if (knownDlmmAddresses.has(h.address)) return true;
    // Always include the specific pool address we know about (100% reliable)
    if (knownPoolAddr && h.address === knownPoolAddr) return true;
    // Do NOT include holders we can't verify — avoids false positives from
    // Raydium/Orca/PumpAMM pools that may have is_pool=true but are not DLMM
    return false;
  });

  const totalPct = Math.round(
    dlmmHolders.reduce((sum, h) => sum + (h.pct ?? h.percent ?? 0), 0) * 100
  ) / 100;
  const sorted = [...dlmmHolders].sort((a, b) => (b.pct ?? b.percent ?? 0) - (a.pct ?? a.percent ?? 0));
  const method = knownDlmmAddresses.size > 0 ? "meteora-api" : knownPoolAddr ? "pool-addr-only" : "none";

  return {
    pct: totalPct,
    poolCount: dlmmHolders.length,
    topHolder: sorted[0] ?? null,
    allHolders: dlmmHolders,
    detectionMethod: method,
  };
}

// For holders with is_pool=true that are NOT in knownDlmmAddresses,
// verify them individually against Meteora API (parallel, best-effort).
// Returns updated knownDlmmAddresses with any confirmed DLMM pools added.
async function verifyUnknownPoolHolders(holders, knownDlmmAddresses) {
  const unknownPools = holders.filter(h =>
    h.is_pool === true && !knownDlmmAddresses.has(h.address)
  );
  if (unknownPools.length === 0) return knownDlmmAddresses;

  const results = await Promise.allSettled(
    unknownPools.map(h => isMeteoraDlmmPool(h.address))
  );
  const verified = new Set(knownDlmmAddresses);
  unknownPools.forEach((h, i) => {
    if (results[i].status === "fulfilled" && results[i].value === true) {
      verified.add(h.address);
    }
  });
  return verified;
}


let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      // Gunakan pnl_true_pct untuk konfirmasi peak — konsisten dengan saat queue.
      // pnl_true_pct dihitung dari initial_value_usd tracked saat deploy, bukan all-time API.
      const pnlForResolve = position?.pnl_true_pct ?? position?.pnl_pct ?? null;
      resolvePendingPeak(positionAddress, pnlForResolve, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Fetch DLMM supply concentration per position (parallel, best-effort)
    // Check if Meteora DLMM pool has become a top holder since deploy
    const dlmmSupplyMap = new Map(); // position → { pct, isTopHolder }
    await Promise.allSettled(
      positions.map(async (p) => {
        const mint = p.base_mint;
        const poolAddr = p.pool;
        if (!mint || !poolAddr) return;
        try {
          const holderRes = await getTokenHolders({ mint, limit: 30 });
          const holders = holderRes?.holders ?? [];
          // Two-layer detection: Meteora API (primary) + tag fallback
          let knownAddrs = await getMeteoraDlmmPoolAddresses(mint, p.pair);
          // Verify any is_pool=true holders not in our known set (catches unlisted pools)
          knownAddrs = await verifyUnknownPoolHolders(holders, knownAddrs);
          const dlmmResult = computeDlmmSupplyPct(holders, knownAddrs, poolAddr);
          // Rank of our specific pool among all holders (for display)
          const allSorted = [...holders].sort((a, b) => (b.pct ?? b.percent ?? 0) - (a.pct ?? a.percent ?? 0));
          const rank = allSorted.findIndex(h => h.address === poolAddr);
          dlmmSupplyMap.set(p.position, {
            pct: dlmmResult.pct,
            poolCount: dlmmResult.poolCount,
            topHolder: dlmmResult.topHolder,
            rank: rank >= 0 ? rank + 1 : null,
            detectionMethod: dlmmResult.detectionMethod,
          });
          if (dlmmResult.pct > 0) {
            const topLabel = dlmmResult.topHolder
              ? `${getDlmmPoolLabel(dlmmResult.topHolder.address, mint)} @${dlmmResult.topHolder.pct ?? dlmmResult.topHolder.percent ?? "?"}%`
              : null;
            log("cron", `DLMM supply for ${p.pair}: ${dlmmResult.pct}% supply across ${dlmmResult.poolCount} pool(s) [${dlmmResult.detectionMethod}]${topLabel ? ` | largest: ${topLabel}` : ""}`);
          }
        } catch { /* best-effort — don't block management */ }
      })
    );

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      // Enrich with OOR direction before snapshotting — pool memory needs this context
      // so screener can distinguish pump (price above range) from dump (price below range)
      const enriched = { ...p };
      if (!p.in_range && p.active_bin != null && p.upper_bin != null && p.lower_bin != null) {
        if (p.active_bin > p.upper_bin) {
          enriched.oor_direction = "pump"; // price pumped above range — bullish signal
        } else if (p.active_bin < p.lower_bin) {
          enriched.oor_direction = "dump"; // price dumped below range — bearish signal
        }
      } else {
        enriched.oor_direction = null;
      }
      recordPositionSnapshot(p.pool, enriched);
      return { ...enriched, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      // Pakai pnl_true_pct untuk trailing TP — dihitung dari initial_value_usd tracked
      // saat deploy. Meteora pnlPctChange bisa inflated karena all-time pool deposits
      // atau fee claims sebelumnya dari posisi lain di pool yang sama.
      const pnlForTrailing = p.pnl_true_pct ?? p.pnl_pct;
      if (queuePeakConfirmation(p.position, pnlForTrailing)) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, { ...p, pnl_pct: pnlForTrailing }, config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      // Sanity-check PnL against tracked initial deposit — API sometimes returns bad data
      // giving -99% PnL which would incorrectly trigger stop loss
      const tracked = getTrackedPosition(p.position);
      const pnlSuspect = (() => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false; // only flag extreme negatives
        // Cross-check: if we have a tracked deposit and current value isn't near zero, it's bad data
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log("cron_warn", `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value — skipping PnL rules`);
          return true;
        }
        return false;
      })();

      // Rule 1: stop loss
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) {
        actionMap.set(p.position, { action: "CLOSE", rule: 1, reason: "stop loss" });
        continue;
      }
      // Rule 2: take profit
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
        actionMap.set(p.position, { action: "CLOSE", rule: 2, reason: "take profit" });
        continue;
      }
      // Rule 3: pumped far above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: "pumped far above range" });
        continue;
      }
      // Rule 4: stale above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin &&
          (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
        actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: "OOR" });
        continue;
      }
      // Rule 5: fee yield too low
      if (p.fee_per_tvl_24h != null &&
          p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
          (p.age_minutes ?? 0) >= 60) {
        actionMap.set(p.position, { action: "CLOSE", rule: 5, reason: "low yield" });
        continue;
      }
      // Rule 6: Meteora DLMM pool became top holder since deploy
      // If the pool holding our liquidity is now a major token holder,
      // supply is trapped in LP → dump risk. Close and cooldown pool.
      const dlmmData = dlmmSupplyMap.get(p.position);
      const maxDlmmPct = config.screening.maxDlmmSupplyPct ?? 2;
      if (dlmmData && dlmmData.pct > maxDlmmPct) {
        const rankStr = dlmmData.rank != null ? ` (rank #${dlmmData.rank} holder)` : "";
        actionMap.set(p.position, {
          action: "CLOSE",
          rule: 6,
          reason: `${dlmmData.poolCount ?? 1} Meteora DLMM pool(s) hold ${dlmmData.pct}% of supply combined${rankStr} — supply trapped in LP [detected via: ${dlmmData.detectionMethod ?? "tag"}]`,
        });
        log("cron", `Rule 6 triggered for ${p.pair}: ${dlmmData.poolCount ?? 1} DLMM pool(s) hold ${dlmmData.pct}% of supply combined${rankStr}`);
        continue;
      }

      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      const dlmmInfo = dlmmSupplyMap.get(p.position);
      const dlmmLine = dlmmInfo?.pct > 0 ? ` | DLMM: ${dlmmInfo.pct}%×${dlmmInfo.poolCount ?? 1}pool${dlmmInfo.rank ? ` (our pool #${dlmmInfo.rank})` : ""}` : "";
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange}${dlmmLine} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          (() => { const d = dlmmSupplyMap.get(p.position); return d?.pct > 0 ? `  dlmm_supply: ${d.pct}% held by ${d.poolCount ?? 1} Meteora DLMM pool(s) combined${d.rank ? ` (our pool rank #${d.rank})` : ""} — threshold: ${config.screening.maxDlmmSupplyPct ?? 2}%` : null; })(),
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  let _didDeploy = false; // hoisted so finally block can check
  let allCandidates = [];
  let agentMessages = [];
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo, holderData] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        mint ? getTokenHolders({ mint, limit: 30 }) : Promise.resolve(null),
      ]);
      // ── Meteora DLMM supply concentration (ALL pools for this token) ─────
      // Two-layer detection:
      //   1. Primary: Meteora Pool Discovery API → get exact pool addresses for this mint
      //   2. Fallback: tag-based detection if API unavailable (less reliable for new pools)
      const rawHolders = holderData.status === "fulfilled" ? (holderData.value?.holders ?? []) : [];
      // Fetch all DLMM pool addresses for this mint from Meteora API (cached 5min)
      // Done in parallel with other fetches via holderData — this is a separate fast call
      let knownDlmmAddrs = mint ? await getMeteoraDlmmPoolAddresses(mint, pool.name) : new Set();
      // Verify any is_pool=true holders not already in our known set (catches unlisted pools)
      knownDlmmAddrs = await verifyUnknownPoolHolders(rawHolders, knownDlmmAddrs);
      // Enrich cache with this pool's own metadata (bin_step, fee_pct) so getDlmmPoolLabel
      // can produce readable labels (e.g. "bin100/0.25%fee") even when the Meteora API
      // returned 0 results for this mint (happens with newer/lower-volume tokens).
      if (mint && pool.pool && pool.bin_step != null) {
        const feeNum = parseFloat(String(pool.fee_pct || "0").replace("%", ""));
        const existingCacheEntry = _dlmmPoolAddressCache.get(mint);
        if (existingCacheEntry) {
          existingCacheEntry.addresses.add(pool.pool);
          // Selalu update / timpa data cache dengan data screener yang sudah PASTI punya bin_step & fee
          existingCacheEntry.meta.set(pool.pool, { bin_step: pool.bin_step, fee_pct: isNaN(feeNum) ? null : feeNum, name: pool.name });
          knownDlmmAddrs = existingCacheEntry.addresses;
        } else {
          const seedMeta = new Map([[pool.pool, { bin_step: pool.bin_step, fee_pct: isNaN(feeNum) ? null : feeNum, name: pool.name }]]);
          _dlmmPoolAddressCache.set(mint, { addresses: new Set([pool.pool]), meta: seedMeta, expiresAt: Date.now() + DLMM_POOL_CACHE_TTL_MS });
          knownDlmmAddrs = new Set([pool.pool]);
        }
      }
      const dlmmResult = computeDlmmSupplyPct(rawHolders, knownDlmmAddrs, pool.pool);
      const dlmmSupplyPct = dlmmResult.pct;
      const topDlmmHolder = dlmmResult.topHolder;
      const dlmmPoolCount = dlmmResult.poolCount;
      const dlmmTopLabel = topDlmmHolder
        ? `${getDlmmPoolLabel(topDlmmHolder.address, mint)} @${topDlmmHolder.pct ?? topDlmmHolder.percent ?? "?"}%`
        : null;
      if (dlmmSupplyPct > 0) {
        log("screening", `DLMM supply for ${pool.name}: ${dlmmSupplyPct}% supply across ${dlmmPoolCount} pool(s) [${dlmmResult.detectionMethod}]${dlmmTopLabel ? ` | largest: ${dlmmTopLabel}` : ""}`);
      }

      allCandidates.push({
        pool,
        mint,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
        dlmmSupplyPct,
        dlmmPoolCount,
        topDlmmHolder,
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const passing = allCandidates.filter(({ pool, mint, ti, dlmmSupplyPct, dlmmPoolCount, topDlmmHolder }) => {
      // Hard filter: Meteora DLMM pool holds significant supply → dump risk
      const maxDlmmSupplyPct = config.screening.maxDlmmSupplyPct ?? 2;
      if (dlmmSupplyPct > maxDlmmSupplyPct) {
        const topLabel = topDlmmHolder
          ? `${getDlmmPoolLabel(topDlmmHolder.address, mint)} @${topDlmmHolder.pct ?? topDlmmHolder.percent ?? "?"}%`
          : null;
        log("screening", `DLMM supply filter: ${pool.name} — ${dlmmPoolCount} pool(s) hold ${dlmmSupplyPct}% supply (max: ${maxDlmmSupplyPct}%)${topLabel ? ` | largest: ${topLabel}` : ""}`);
        return false;
      }

      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      screenReport = `No candidates available (all filtered by launchpad / holder-quality rules).`;
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, mint, sw, n, ti, mem, dlmmSupplyPct, dlmmPoolCount, topDlmmHolder }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
      const dlmmTopLabel = topDlmmHolder
        ? `${getDlmmPoolLabel(topDlmmHolder.address, mint)} @${topDlmmHolder.pct ?? topDlmmHolder.percent ?? "?"}%`
        : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        dlmmSupplyPct > 0
          ? `  dlmm_supply: ${dlmmSupplyPct}% held by ${dlmmPoolCount} Meteora DLMM pool(s)${dlmmTopLabel ? ` (largest: ${dlmmTopLabel})` : ""}${dlmmSupplyPct >= 1 ? " ⚠️ approaching limit" : ""}`
          : null,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
        `  chart: call get_price_analysis(pool_address="${pool.pool}", pool_name="${pool.name}", bin_step=${pool.bin_step}) before deploying — use result to set bins_below and adjust strategy`,
        mem ? `  memory: ${mem}` : null,
        mem && mem.includes("all pump") ? `  ⚠️ NOTE: Past OOR in this pool was due to PUMP (price rose above range) — not a loss signal. Token was bullish.` : null,
        mem && mem.includes("all dump") ? `  ⚠️ NOTE: Past OOR in this pool was due to DUMP (price fell below range) — genuine bearish signal.` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        stageSignals(pool.pool, {
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    const agentResult = await agentLoop(`
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call get_price_analysis for the chosen pool (pool_address, pool_name=<pool name>, bin_step from metrics, timeframe="15m", candle_count=100).
   Use the result to:
   - Set bins_below: prefer degen_play.bins_below if available, else use round(35 + (volatility/5)*55) clamped to [35,90]
   - If dump_signals.is_dump=true → skip this pool and pick the next best candidate instead
   - If trend=downtrend AND confidence=high → increase bins_below by 20% for wider downside buffer
   - If good_entry=false → note it in the report but still deploy unless dump signals present
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Downside buffer: <negative %>

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   CHART
   Trend: <trend> (<confidence>) | Change: <period_change_pct>%
   EMA8: <ema8_last> | EMA21: <ema21_last> | Above EMA21 (last 10): <above_ema21_last10>/10
   Support: <support[0].price> (<strength>) | Resistance: <resistance[0].price>
   <If more support/resistance levels exist, list up to 2 each>
   <If dump signals: ⚠️ DUMP: <signals list> | Drawdown from peak: <drawdown_from_peak>%>
   Range: <lower_pct>% → 0% | Bins: <bins_below> | Entry: <good_entry> | Risk: <risk_level>
   <entry_note from degen_play>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });
    const { content, didDeploy, messages: loopMessages } = agentResult;
    _didDeploy = didDeploy;
    agentMessages = loopMessages || [];

    // ── Verify deploy via state.json — avoids API indexing race condition ──────
    // didDeploy is only true when deploy_position returned success=true (checked in agent.js).
    // A failed tx (simulation error, insufficient funds, etc.) sets didDeploy=false,
    // so we never trigger a false hallucination warning for genuine tx failures.
    //
    // We still verify against state.json as a secondary guard against edge cases where
    // the tool returned success=true but trackPosition() somehow wasn't called.
    if (didDeploy) {
      // Extract position address from successful tool result (already guaranteed by agent.js)
      const deployedPositionId = (() => {
        for (const m of (agentMessages || [])) {
          if (m.role === "tool" && m.content) {
            try {
              const r = JSON.parse(m.content);
              if (r.success === true && r.position && r.pool) return r.position;
            } catch {}
          }
        }
        return null;
      })();

      const confirmedInState = deployedPositionId
        ? !!getTrackedPosition(deployedPositionId)
        : false;

      if (!confirmedInState) {
        // deploy_position returned success=true but position not in state — edge case/bug
        log("cron_warn", `Deploy confirmed by tool but position ${deployedPositionId ?? "unknown"} not found in state.json — possible trackPosition failure.`);
        screenReport = `⚠️ Screening warning: deploy succeeded on-chain but position not confirmed in state. Check logs.`;
      } else {
        // Confirmed real deploy — send separate deploy notification immediately
        screenReport = content;
        if (!silent && telegramEnabled()) {
          sendMessage(`✅ Deployed\n\n${stripThink(content)}`).catch(() => {});
        }
      }
    } else {
      screenReport = content;
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
          const isWarning = _didDeploy && screenReport && screenReport.startsWith("⚠️");
          
          let candSummary = "";
          if (_didDeploy && !isWarning && allCandidates.length > 0) {
             const list = allCandidates.map(c => {
                let isWinner = false;
                for (const m of agentMessages) {
                   if (m.role === "assistant" && m.tool_calls) {
                      for (const tc of m.tool_calls) {
                         if (tc.function.name === "deploy_position") {
                            try {
                               const args = JSON.parse(tc.function.arguments);
                               if (args.pool_address === c.pool.pool || args.pool_name === c.pool.name) {
                                  isWinner = true;
                               }
                            } catch(e) {}
                         }
                      }
                   }
                }
                
                const volRaw = c.pool.volume_window || 0;
                const vol = volRaw >= 1000 ? (volRaw/1000).toFixed(1) + "k" : Math.round(volRaw);
                const feeTvl = c.pool.fee_active_tvl_ratio || 0;
                
                return `• ${c.pool.name || "Unknown"} (Org: ${c.pool.organic_score ?? 0}, Vol: $${vol}, Yield: ${feeTvl}%) — ${isWinner ? "✅ DEPLOYED" : "❌ SKIPPED"}`;
             }).join("\n");
             
             candSummary = `\n\nTop Candidates Evaluated:\n${list}\n\n💡 Note: SKIPPED candidates above all passed system thresholds. They were bypassed because the AI selected the single best pool based on narrative and overall conviction.`;
          }

          const telegramText = isWarning
            ? screenReport  
            : (_didDeploy ? `✅ Deploy confirmed — see report below.${candSummary}` : stripThink(screenReport));
            
          if (telegramText) {
          if (liveMessage) await liveMessage.finalize(telegramText).catch(() => {});
          else sendMessage(`🔍 Screening Cycle\n\n${telegramText}`).catch(() => { });
        } else if (liveMessage) {
          await liveMessage.finalize("🔍 Screening complete.").catch(() => {});
        }
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

// Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        const pnlForTrailingPoll = p.pnl_true_pct ?? p.pnl_pct;
        if (queuePeakConfirmation(p.position, pnlForTrailingPoll)) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, { ...p, pnl_pct: pnlForTrailingPoll }, config.management);
        if (exit) {
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

// Telegram bot — queue messages received while busy, drain after each task
async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(text) {
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(text);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => { });
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => { });
  } finally {
    busy = false;
    if (typeof rl !== "undefined") {
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
    drainTelegramQueue().catch(() => {});
  }
}



if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  // Startup deploy: run full runScreeningCycle() so chart.js pre-fetch,
  // DLMM supply checks, and all recon are included — same as cron screening.
  // Balance/position guards are already inside runScreeningCycle itself.
  runScreeningCycle({ silent: false }).catch(e => log("startup_error", e.message));
}