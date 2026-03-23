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
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";

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
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening

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

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    timers.managementLastRun = Date.now();
    log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
    let mgmtReport = null;
    let positions = [];
    try {
      // Pre-load all positions + PnL in parallel — force fresh to avoid stale cache
      const livePositions = await getMyPositions({ force: true }).catch(() => null);
      positions = livePositions?.positions || [];

      if (positions.length === 0) {
        log("cron", "No open positions — triggering screening cycle");
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
        return;
      }

      // Enforce management interval based on most volatile open position
      const maxVolatility = positions.reduce((max, p) => {
        const tracked = getTrackedPosition(p.position);
        return Math.max(max, tracked?.volatility ?? 0);
      }, 0);
      const targetInterval = maxVolatility >= 5 ? 3 : maxVolatility >= 2 ? 5 : 10;
      if (config.schedule.managementIntervalMin !== targetInterval) {
        config.schedule.managementIntervalMin = targetInterval;
        log("cron", `Management interval adjusted to ${targetInterval}m (max volatility: ${maxVolatility}) — takes effect next restart`);
      }

      // Snapshot positions + load pool memory (PnL already included in getMyPositions)
      const positionData = positions.map((p) => {
        recordPositionSnapshot(p.pool, p);
        return { ...p, recall: recallForPool(p.pool) };
      });

      // Build pre-loaded position blocks for the LLM
      const positionBlocks = positionData.map((p) => {
        const lines = [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  age: ${p.age_minutes ?? "?"}m | in_range: ${p.in_range} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          `  pnl_pct: ${p.pnl_pct}% | pnl_usd: $${p.pnl_usd} | unclaimed_fees: $${p.unclaimed_fees_usd} | claimed_fees: $${p.collected_fees_usd} | value: $${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
          p.recall ? `  memory: ${p.recall}` : null,
        ].filter(Boolean);
        return lines.join("\n");
      }).join("\n\n");

      const screeningCooldownMs = 5 * 60 * 1000;

      // JS trailing TP check — deterministic, no LLM needed to decide
      const exitAlerts = [];
      for (const p of positionData) {
        if (p.pnl_pct == null) continue;
        const exit = updatePnlAndCheckExits(p.position, p.pnl_pct, config.management);
        if (exit) {
          exitAlerts.push(`⚡ HARD EXIT — ${p.pair} (${p.position}): ${exit.reason}`);
          log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
        }
      }

      const { content } = await agentLoop(`
MANAGEMENT CYCLE — ${positions.length} position(s)

PRE-LOADED POSITION DATA (no fetching needed):
${positionBlocks}
${exitAlerts.length > 0 ? `
HARD EXIT ALERTS (trailing TP triggered — close these immediately, no exceptions):
${exitAlerts.join("\n")}
` : ""}
INSTRUCTION OVERRIDE (check first, before any rule):
- If a position has an instruction set → it OVERRIDES all rules below. HOLD unless the instruction condition is explicitly met. Do NOT apply rules 1-5 to positions with an instruction.

CLOSE RULES (only for positions with NO instruction and no exit alert):
1. pnl_pct <= ${config.management.emergencyPriceDropPct}% → CLOSE (stop loss)
2. pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)
3. active_bin > upper_bin + ${config.management.outOfRangeBinsToClose} → CLOSE (pumped far above range)
4. active_bin > upper_bin AND oor_minutes >= ${config.management.outOfRangeWaitMinutes} → CLOSE (stale above range)
5. fee_per_tvl_24h < ${config.management.minFeePerTvl24h} AND age_minutes >= 60 → CLOSE (fee yield too low)

CLAIM RULE: If unclaimed_fee_usd >= ${config.management.minClaimAmount}, call claim_fees. Do not use any other threshold.

INSTRUCTIONS:
All data is pre-loaded above — do NOT call get_my_positions or get_position_pnl.
Only call tools if a position needs to be CLOSED or fees need to be CLAIMED.
If all positions STAY and no fees to claim, just write the report with no tool calls.
Write ONLY the report below. No preamble, no reasoning, no explanation.

REPORT FORMAT (one per position):
**[PAIR]** | Age: [X]m | Unclaimed: $[X] | PnL: [X]% | 🟢 IN / 🔴 OOR [X]m | [STAY/CLOSE]
If instruction set: Note: "[instruction text]"
If close rule triggered: Rule [N]: [reason]

Summary: 💼 [N] positions | $[total_value] | fees: $[sum_unclaimed] | [action or "no action"]
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 4096);
      mgmtReport = content;

      // Trigger screening AFTER management completes — uses fresh count so we don't race with a close
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
      if (telegramEnabled()) {
        if (mgmtReport) sendMessage(`🔄 Management Cycle\n\n${mgmtReport}`).catch(() => { });
        for (const p of positions) {
          if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
            notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
          }
        }
      }
    }
  });

  async function runScreeningCycle() {
    if (_screeningBusy) {
      log("cron", "Screening skipped — previous cycle still running");
      return;
    }
    _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
    _screeningLastTriggered = Date.now();

    // Hard guards — don't even run the agent if preconditions aren't met
    let prePositions, preBalance;
    try {
      [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
      if (prePositions.total_positions >= config.risk.maxPositions) {
        log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
        _screeningBusy = false;
        return;
      }
      const minRequired = config.management.deployAmountSol + config.management.gasReserve;
      if (preBalance.sol < minRequired) {
        log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
        _screeningBusy = false;
        return;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${e.message}`);
      _screeningBusy = false;
      return;
    }
    timers.screeningLastRun = Date.now();
    log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
    let screenReport = null;
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

      // Fetch top candidates + all recon data fully in parallel
      const topCandidates = await getTopCandidates({ limit: 5 }).catch(() => null);
      const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 5);

      const reconResults = await Promise.allSettled(
        candidates.map(async (pool) => {
          const mint = pool.base?.mint;
          const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
            checkSmartWalletsOnPool({ pool_address: pool.pool }),
            mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
          ]);
          return {
            pool,
            sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
            n: narrative.status === "fulfilled" ? narrative.value : null,
            ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
            mem: recallForPool(pool.pool),
          };
        })
      );

      const allCandidates = reconResults.filter(r => r.status === "fulfilled").map(r => r.value);

      // JS hard filters — no LLM needed for binary rule violations
      const skipReasons = [];
      const passing = allCandidates.filter(({ pool, ti }) => {
        const launchpad = ti?.launchpad ?? null;
        const feesSol = ti?.global_fees_sol;
        const top10Pct = ti?.audit?.top_holders_pct;
        const botPct = ti?.audit?.bot_holders_pct;

        if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
          skipReasons.push(`${pool.name}: blocked launchpad (${launchpad})`);
          return false;
        }
        if (feesSol != null && feesSol < config.screening.minTokenFeesSol) {
          skipReasons.push(`${pool.name}: fees ${feesSol} SOL < ${config.screening.minTokenFeesSol}`);
          return false;
        }
        if (top10Pct != null && top10Pct > config.screening.maxTop10Pct) {
          skipReasons.push(`${pool.name}: top10 ${top10Pct}% > ${config.screening.maxTop10Pct}%`);
          return false;
        }
        if (botPct != null && botPct > config.screening.maxBundlersPct) {
          skipReasons.push(`${pool.name}: bots ${botPct}% > ${config.screening.maxBundlersPct}%`);
          return false;
        }
        return true;
      });

      if (skipReasons.length > 0) log("screening", `Hard-filtered: ${skipReasons.join(" | ")}`);

      if (passing.length === 0) {
        screenReport = `No candidates passed hard filters:\n${skipReasons.map(r => `- ${r}`).join("\n")}`;
        return;
      }

      // Pre-fetch active_bin for passing candidates (removes one LLM tool-call step)
      const activeBinResults = await Promise.allSettled(
        passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
      );

      // Build compact candidate blocks
      const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
        const botPct = ti?.audit?.bot_holders_pct ?? "?";
        const top10Pct = ti?.audit?.top_holders_pct ?? "?";
        const feesSol = ti?.global_fees_sol ?? "?";
        const launchpad = ti?.launchpad ?? null;
        const priceChange = ti?.stats_1h?.price_change;
        const netBuyers = ti?.stats_1h?.net_buyers;
        const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

        return [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
          mem ? `  memory: ${mem}` : null,
        ].filter(Boolean).join("\n");
      });

      const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} passed hard filters):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(35 + (volatility/5)*34) clamped to [35,69].
3. Report result.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048);
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      _screeningBusy = false;
      if (telegramEnabled()) {
        if (screenReport) sendMessage(`🔍 Screening Cycle\n\n${screenReport}`).catch(() => { });
      }
    }
  }

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
      const result = await getMyPositions({ force: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (p.pnl_pct == null) continue;
        const exit = updatePnlAndCheckExits(p.position, p.pnl_pct, config.management);
        if (exit) log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason}`);
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
    const vol = `$${((p.volume_24h || 0) / 1000).toFixed(1)}k`.padStart(8);
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
        const lines = positions.map((p, i) => {
          const pnl = p.pnl_usd >= 0 ? `+$${p.pnl_usd}` : `-$${Math.abs(p.pnl_usd)}`;
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const oor = !p.in_range ? " ⚠️OOR" : "";
          return `${i + 1}. ${p.pair} | $${p.total_value_usd} | PnL: ${pnl} | fees: $${p.unclaimed_fees_usd} | ${age}${oor}`;
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
          await sendMessage(`✅ Closed ${pos.pair}\nPnL: $${result.pnl_usd ?? "?"} | txs: ${result.txs?.join(", ")}`);
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
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, config.llm.generalModel);
      appendHistory(text, content);
      await sendMessage(content);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => { });
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
      drainTelegramQueue().catch(() => {});
    }
  }

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
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
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
      console.log(`  maxBundlersPct:       ${s.maxBundlersPct}`);
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
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
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
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
