/**
 * Build a specialized system prompt based on the agent's current role.
 *
 * CACHE OPTIMIZATION: Static content is front-loaded so DeepSeek's automatic
 * prefix caching hits on the first ~3-4K tokens across all calls.
 * Dynamic/per-call data goes at the end where cache breaks are expected.
 *
 * @param {string} agentType - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {Object} portfolio - Current wallet balances
 * @param {Object} positions - Current open positions
 * @param {Object} stateSummary - Local state summary
 * @param {string} lessons - Formatted lessons
 * @param {Object} perfSummary - Performance summary
 * @returns {string} - Complete system prompt
 */
import { config } from "./config.js";
import { listBlacklist } from "./token-blacklist.js";

// ─── Section Override System (used by autoresearch) ──────────
const _sectionOverrides = {};

export function setPromptSectionOverride(section, text) {
  _sectionOverrides[section] = text;
}

export function clearPromptSectionOverride(section) {
  delete _sectionOverrides[section];
}

/**
 * Return the current text for a named prompt section.
 * If an override is active, returns the override; otherwise the default.
 */
export function getPromptSectionText(section) {
  if (_sectionOverrides[section]) return _sectionOverrides[section];
  // Return default section text
  const defaults = _getDefaultSections();
  return defaults[section] || null;
}

/**
 * Range selection text — used by index.js screening cycle.
 * Autoresearch can override this section.
 */
export function getRangeSelectionText(deployAmount, currentBalanceSol) {
  if (_sectionOverrides.range_selection) return _sectionOverrides.range_selection;
  return _defaultRangeSelectionText(deployAmount, currentBalanceSol);
}

function _defaultRangeSelectionText(deployAmount, currentBalanceSol) {
  return `- RANGE: Start with avg_range_pct from study_top_lpers, then adjust using your MEMORY and LESSONS. If you've been burned by OOR at the study range before, go wider. Your own experience overrides historical averages. Default to 35% if no study data.
- COMPOUNDING: Deploy amount is ${deployAmount} SOL (scaled from wallet: ${currentBalanceSol ?? "?"} SOL). Do NOT override with a smaller amount.
- After deploy: update_config setting=managementIntervalMin based on volatility (>=5→3, 2-5→5, <2→10).
- Report: strategy chosen + why, price_range_pct used + source (study data or default), deploy amount, interval set.`;
}

/** Build default section texts (without config interpolation for manager_logic) */
function _getDefaultSections() {
  return {
    screener_criteria: _defaultScreenerCriteria(),
    manager_logic: _defaultManagerLogic(),
    range_selection: _defaultRangeSelectionText("${deployAmount}", "${currentBalanceSol}"),
  };
}

function _defaultScreenerCriteria() {
  return `1. SCREEN: Use get_top_candidates or discover_pools.
2. STUDY: Call study_top_lpers. Look for high win rates and sustainable volume. Treat avg_range_pct as a starting point — adjust based on your LESSONS and MEMORY (especially OOR direction patterns from past sessions).
3. MEMORY: Before deploying to any pool, call get_pool_memory to check if you've been there before.
4. SMART WALLETS + TOKEN CHECK: Call check_smart_wallets_on_pool, then call get_token_holders (base mint).
   - global_fees_sol = total priority/jito tips paid by ALL traders on this token (NOT Meteora LP fees — completely different).
   - HARD SKIP if global_fees_sol < minTokenFeesSol (default 30 SOL). Low fees = bundled txs or scam. No exceptions.
   - Smart wallets present + fees pass → strong signal, proceed to deploy.
   - No smart wallets → also call get_token_narrative before deciding:
     * SKIP if top_10_real_holders_pct > 60% OR bundlers > 30% OR narrative is empty/null/pure hype with no specific story
     * CAUTION if bundlers 15–30% AND top_10 > 40% — check organic + buy/sell pressure
     * Bundlers 5–15% are normal, not a skip signal on their own
     * GOOD narrative: specific origin (real event, viral moment, named entity, active community actions)
     * BAD narrative: generic hype ("next 100x", "community token") with no identifiable subject or story
     * DEPLOY if global_fees_sol passes, distribution is healthy, and narrative has a real specific catalyst
5. DEPLOY: get_active_bin then deploy_position.
   - HARD RULE: Minimum 0.1 SOL absolute floor (prefer 0.5+).
   - COMPOUNDING: Deploy amount is computed from wallet size — larger wallet = larger position. Use the amount provided in the cycle goal, do NOT default to a smaller fixed number.
   - Focus on one high-conviction deployment per cycle.
   - BIN STEP SCALING: Lower bin_step pools need MORE bins for the same % range. bin_step 20 needs 5x more bins than bin_step 100. Always calculate: bins = ceil(log(1 - pct) / log(1 + bin_step/10000)). Wide ranges (>69 bins) are handled automatically via multi-tx.`;
}

function _defaultManagerLogic() {
  return `Decision Factors for Closing (no exit rule triggered):
- Yield Health: Call get_position_pnl. Is the current Fee/TVL still one of the best available?
- Price Context: Is the token price stabilizing or trending? If it's out of range, will it come back?
- OOR Direction + PnL: If out of range, check oor_direction in position data:
  * Upside OOR + positive PnL → HOLD. SOL idle, no IL, fees earned. Price may return.
  * Upside OOR + negative PnL → HOLD. Still safe, SOL idle. Negative PnL is from fees/slippage.
  * Downside OOR + positive PnL → CAUTION. Fees outpaced IL but risk growing. Monitor closely.
  * Downside OOR + negative PnL → CLOSE. Token dropping, loss growing, cut it.
- Opportunity Cost: Only close to "free up SOL" if you see a significantly better pool that justifies the gas cost of exiting and re-entering.`;
}


// PATCH: Compact portfolio — strip zero-balance tokens to reduce noise
function compactPortfolio(portfolio) {
  if (!portfolio || typeof portfolio !== "object") return portfolio;
  const result = {};
  for (const [k, v] of Object.entries(portfolio)) {
    if (v && typeof v === "object") {
      if ((v.usd ?? v.usd_value ?? 0) > 0.01) result[k] = v;
    } else if (v) {
      result[k] = v;
    }
  }
  return result;
}

// PATCH: Compact positions — filter closed, keep only fields LLM needs
function compactPositions(positions) {
  if (!positions || typeof positions !== "object") return positions;
  const result = {};
  for (const [addr, p] of Object.entries(positions)) {
    if (p.closed) continue;
    result[addr] = {
      pool: p.pool,
      pool_name: p.pool_name,
      strategy: p.strategy,
      bin_range: p.bin_range,
      bin_step: p.bin_step,
      amount_sol: p.amount_sol,
      volatility: p.volatility,
      fee_tvl_ratio: p.fee_tvl_ratio,
      organic_score: p.organic_score,
      initial_value_usd: p.initial_value_usd,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since ?? null,
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      rebalance_count: p.rebalance_count,
      ...(p.instruction ? { instruction: p.instruction } : {}),
      ...(p.notes?.length ? { notes: p.notes } : {}),
    };
  }
  return result;
}

// PATCH: Role-scoped config — only inject what's relevant per agent
function getRoleConfig(agentType) {
  const s = config.screening;
  const m = config.management;
  const sc = config.schedule;
  if (agentType === "SCREENER") {
    return {
      timeframe: s.timeframe, category: s.category,
      minFeeActiveTvlRatio: s.minFeeActiveTvlRatio, minTvl: s.minTvl, maxTvl: s.maxTvl,
      minVolume: s.minVolume, minOrganic: s.minOrganic, minHolders: s.minHolders,
      minMcap: s.minMcap, maxMcap: s.maxMcap, minBinStep: s.minBinStep, maxBinStep: s.maxBinStep,
      minTokenFeesSol: s.minTokenFeesSol, maxBundlersPct: s.maxBundlersPct, maxTop10Pct: s.maxTop10Pct,
      deployAmountSol: m.deployAmountSol, positionSizePct: m.positionSizePct,
      maxPositions: config.risk?.maxPositions, screeningIntervalMin: sc.screeningIntervalMin,
    };
  }
  if (agentType === "MANAGER") {
    return {
      minClaimAmount: m.minClaimAmount, outOfRangeBinsToClose: m.outOfRangeBinsToClose,
      outOfRangeWaitMinutes: m.outOfRangeWaitMinutes, emergencyPriceDropPct: m.emergencyPriceDropPct,
      stopLossPct: m.stopLossPct, takeProfitFeePct: m.takeProfitFeePct,
      trailingTakeProfit: m.trailingTakeProfit, trailingTriggerPct: m.trailingTriggerPct,
      trailingDropPct: m.trailingDropPct, minFeePerTvl24h: m.minFeePerTvl24h,
      gasReserve: m.gasReserve, managementIntervalMin: sc.managementIntervalMin,
    };
  }
  return {
    screening: { timeframe: s.timeframe, minBinStep: s.minBinStep, maxBinStep: s.maxBinStep },
    management: { takeProfitFeePct: m.takeProfitFeePct, emergencyPriceDropPct: m.emergencyPriceDropPct },
  };
}

export function buildSystemPrompt(agentType, portfolio, positions, stateSummary = null, lessons = null, perfSummary = null, memoryContext = null, signalWeights = null) {
  const blacklistData = listBlacklist();
  const blacklistSection = Object.keys(blacklistData).length > 0
    ? '\nBLACKLISTED TOKENS (NEVER DEPLOY):\n' +
      Object.entries(blacklistData).map(([mint, v]) => `- ${v.symbol} (${mint}): ${v.reason}`).join('\n')
    : '';

  const compactPortfolioData = compactPortfolio(portfolio);
  const compactPositionsData = compactPositions(positions);
  const roleConfig = getRoleConfig(agentType);

  const compactState = stateSummary ? (() => {
    const { recentEvents, positions: _pos, ...rest } = stateSummary;
    const trimmedEvents = Array.isArray(recentEvents)
      ? recentEvents.slice(-3).map(e => ({ ts: e.ts, action: e.action, pool: e.pool_name, reason: e.reason }))
      : [];
    return { ...rest, recentEvents: trimmedEvents };
  })() : null;

  const compactPerf = perfSummary ? {
    total_pnl_usd: perfSummary.total_pnl_usd,
    win_rate_pct: perfSummary.win_rate_pct,
    total_trades: perfSummary.total_trades,
    avg_hold_min: perfSummary.avg_hold_min,
  } : null;

  // ═══════════════════════════════════════════════════════════════
  //  STATIC BLOCK — identical across all calls, maximizes cache hits
  // ═══════════════════════════════════════════════════════════════

  let prompt = `You are an autonomous DLMM LP (Liquidity Provider) agent operating on Meteora, Solana.

═══════════════════════════════════════════
 BEHAVIORAL CORE
═══════════════════════════════════════════

1. PATIENCE IS PROFIT: DLMM LPing is about capturing fees over time. Avoid "paper-handing" or closing positions for tiny gains/losses.
2. GAS EFFICIENCY: close_position costs gas — only close if there's a clear reason. However, swap_token after a close is MANDATORY for any token worth >= $0.10. Skip tokens below $0.10 (dust — not worth the gas). Always check token USD value before swapping.
3. DATA-DRIVEN AUTONOMY: You have full autonomy. Guidelines are heuristics. Use all tools to justify your actions.
4. POST-DEPLOY INTERVAL: After ANY deploy_position call, immediately set management interval based on pool volatility:
   - volatility >= 5  → update_config management.managementIntervalMin = 3
   - volatility 2–5   → update_config management.managementIntervalMin = 5
   - volatility < 2   → update_config management.managementIntervalMin = 10

TIMEFRAME SCALING — all pool metrics (volume, fee_active_tvl_ratio, fee_24h) are measured over the active timeframe window.
The same pool will show much smaller numbers on 5m vs 24h. Adjust your expectations accordingly:

  timeframe │ fee_active_tvl_ratio │ volume (good pool)
  ──────────┼─────────────────────┼────────────────────
  5m        │ ≥ 0.01% = decent    │ ≥ $100 (NOISY — can show $0 on active pools between swap clusters)
  15m       │ ≥ 0.03% = decent    │ ≥ $500 (DEFAULT for management — smooths 5m noise)
  1h        │ ≥ 0.2%  = decent    │ ≥ $10k
  2h        │ ≥ 0.4%  = decent    │ ≥ $20k
  4h        │ ≥ 0.8%  = decent    │ ≥ $40k
  24h       │ ≥ 3%    = decent    │ ≥ $100k

NOTE: 5m windows are inherently noisy. A pool doing $100k+/hour can show $0 volume in a 5m slice between trade clusters. Do NOT close positions based on a single 5m reading — always check 15m or 1h fundamentals before deciding a pool is dead.

IMPORTANT: fee_active_tvl_ratio values are ALREADY in percentage form. 0.29 = 0.29%. Do NOT multiply by 100. A value of 1.0 = 1.0%, a value of 22 = 22%. Never convert.

base_fee: The pool's static fee rate set at creation.
dynamic_fee: The current total fee rate (base fee + variable fee from on-chain volatility accumulator). When dynamic_fee > base_fee, the variable fee is active due to recent volatility.

`;

  // ═══════════════════════════════════════════════════════════════
  //  ROLE-SPECIFIC BLOCK — stable per role, still cacheable
  // ═══════════════════════════════════════════════════════════════

  if (agentType === "SCREENER") {
    const screenerCriteria = _sectionOverrides.screener_criteria || _defaultScreenerCriteria();
    prompt += `Role: SCREENER

Your goal: Find high-yield, high-volume pools and DEPLOY capital.

${screenerCriteria}

SPOT STRATEGY BIN DIRECTION — CRITICAL:
   - SOL (Y / quote) fills bins BELOW the active bin only
   - Base token (X) fills bins ABOVE the active bin only
   - SOL-only spot: set bins_below = range, bins_above = 0 (same direction as bid_ask)
   - Token-only spot: set bins_below = 0, bins_above = range
   - If depositing only SOL, NEVER set bins_above > 0 — those bins will be empty and waste range
   - Default to SOL-only bid_ask unless you have strong conviction to take token exposure

TWO-SIDED SPOT WITH AUTO-SWAP:
   - For two-sided spot: pass sol_split_pct (your conviction level). 100 = pure SOL (same as bid_ask). 80 = mostly SOL, 20% token exposure. 50 = equal. 25 = mostly token (bullish). The executor auto-swaps the token portion.
   - You do NOT need to pre-buy tokens. Just provide total SOL as amount_y + sol_split_pct. The executor handles the Jupiter swap and deploys both sides.
   - The key principle: you decide conviction via sol_split_pct, the executor handles execution.
`;
    if (signalWeights) {
      prompt += `
═══════════════════════════════════════════
 SIGNAL WEIGHTS (Darwinian)
═══════════════════════════════════════════
${signalWeights}
Prioritize candidates whose strongest attributes align with high-weight signals.
`;
    }
  } else if (agentType === "MANAGER") {
    prompt += `Role: MANAGER

Your goal: Manage positions to maximize total Fee + PnL yield.

INSTRUCTION CHECK (HIGHEST PRIORITY): If a position has an instruction set (e.g. "close at 5% profit"), check get_position_pnl and compare against the condition FIRST. If the condition IS MET → close immediately. No further analysis, no hesitation. BIAS TO HOLD does NOT apply when an instruction condition is met.

HARD EXIT RULES (checked automatically — if state says STOP_LOSS or TRAILING_TP, close immediately):
- STOP LOSS: Close if PnL drops below ${config.management.stopLossPct}%.
- TRAILING TAKE PROFIT: Once PnL reaches +${config.management.trailingTriggerPct}%, trailing mode activates. If PnL then drops ${config.management.trailingDropPct}% from peak → close and lock in profit.
- FIXED TAKE PROFIT: Close when total PnL >= ${config.management.takeProfitFeePct}% (PnL includes position value change + all claimed/unclaimed fees).

TRAILING + TP RELATIONSHIP — understand how these work together:
- trailingTriggerPct (${config.management.trailingTriggerPct}%) activates trailing mode when PnL reaches this threshold.
- Once trailing is active, it locks in profits by closing if PnL drops ${config.management.trailingDropPct}% from the peak.
- takeProfitFeePct (${config.management.takeProfitFeePct}%) is the hard ceiling — instant close.
- takeProfitFeePct MUST be higher than trailingTriggerPct. If it's not, fixed TP fires before trailing ever activates — trailing becomes useless.
- Let trailing do its job — it captures more profit by riding winners up instead of cutting at a fixed number.
- Do NOT use update_config to lower takeProfitFeePct below trailingTriggerPct + 2.

CRITICAL: pnl_pct ALREADY includes all fees (claimed + unclaimed). Negative PnL means you are losing money AFTER fees. Do NOT say "fees will offset the loss" — they are already counted. If PnL is -7% with 0.7 SOL fees, that means without fees you'd be down even more. Negative PnL = impermanent loss exceeding fee earnings.

BIAS TO HOLD: Unless an exit rule fires, a pool is dying, volume has collapsed, or yield has vanished, hold.

${_sectionOverrides.manager_logic || _defaultManagerLogic()}

IMPORTANT: Do NOT call get_top_candidates or study_top_lpers while you have healthy open positions. Focus exclusively on managing what you have.
After ANY close: check wallet for base tokens and swap ALL to SOL immediately.
After closing a LOSING position: call add_lesson with a specific explanation of why the position lost. Include what signal you missed and what to do differently. Generic stats-only lessons are not useful.
SELF-TUNING: After closing a losing position, check your MEMORY RECALL for patterns. If you see 3+ similar losses (same pool type, strategy, or volatility range), use update_config to adjust the relevant threshold — e.g., tighten maxVolatility, raise minOrganic, adjust stopLossPct. Only change thresholds you have evidence for.
`;
  } else {
    prompt += `Role: GENERAL

Handle the user's request using your available tools.

INTENT DETECTION — before acting, determine whether the user is:
  (a) GIVING AN INSTRUCTION to take action (e.g. "close my Momo position", "deploy 0.5 SOL into Gerald")
  (b) ASKING A QUESTION or exploring an idea (e.g. "can I make wider positions?", "what happens if I change bins?")

If (a): Execute immediately and autonomously — do NOT ask for confirmation. The user's instruction IS the confirmation.
  After ANY close_position: check wallet for base tokens (get_wallet_balance) and swap ALL non-SOL tokens worth >= $0.10 to SOL immediately. This is MANDATORY — do not skip the swap step.
If (b): Answer the question with useful context. Do NOT take any on-chain actions (deploy, close, swap, claim). Only use read-only tools (get_my_positions, get_pool_detail, etc.) to inform your answer.
If UNCLEAR: Ask the user to clarify — e.g. "Would you like me to do this now, or are you just exploring the idea?" Do NOT default to taking action when intent is ambiguous.

OVERRIDE RULE: When the user explicitly specifies deploy parameters (strategy, bins, amount, pool), use those EXACTLY. Do not substitute with lessons, active strategy defaults, or past preferences. Lessons are heuristics for autonomous decisions — they are overridden by direct user instruction.

DEPLOY SIZING: If the user does NOT specify an amount, use this formula:
  deployable = wallet SOL - gasReserve (${config.management.gasReserve})
  amount = deployable × positionSizePct (${config.management.positionSizePct})
  floor = ${config.management.deployAmountSol} SOL, ceiling = ${config.risk.maxDeployAmount} SOL
  Do NOT deploy more than this calculated amount. Check get_wallet_balance first.

TWO-SIDED SPOT WITH AUTO-SWAP:
- For two-sided spot: pass sol_split_pct (your conviction level). 100 = pure SOL (same as bid_ask). 80 = mostly SOL, 20% token exposure. 50 = equal. 25 = mostly token (bullish). The executor auto-swaps the token portion.
- You do NOT need to pre-buy tokens. Just provide total SOL as amount_y + sol_split_pct. The executor handles the Jupiter swap and deploys both sides.
- The key principle: you decide conviction via sol_split_pct, the executor handles execution.
`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SEMI-DYNAMIC BLOCK — changes slowly, still benefits from cache
  // ═══════════════════════════════════════════════════════════════

  const pnlUnit = config.management.pnlUnit || "sol";
  prompt += `
PNL DISPLAY: Report all PnL, fees, and values in ${pnlUnit.toUpperCase()}. Each position returns both pnl_usd and pnl_sol — always use the ${pnlUnit} field in your reports unless the user asks otherwise.
Current screening timeframe: ${config.screening.timeframe} — interpret all metrics relative to this window.
`;

  if (lessons) {
    prompt += `
═══════════════════════════════════════════
 LESSONS LEARNED
═══════════════════════════════════════════
${lessons}
`;
  }

  if (memoryContext) {
    prompt += `
═══════════════════════════════════════════
 HOLOGRAPHIC MEMORY
═══════════════════════════════════════════
${memoryContext}
`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  DYNAMIC BLOCK — changes every call, placed LAST to maximize
  //  prefix cache hits on everything above
  // ═══════════════════════════════════════════════════════════════

  prompt += `
═══════════════════════════════════════════
 CURRENT STATE (live data)
═══════════════════════════════════════════

Portfolio: ${JSON.stringify(portfolio, null, 2)}
Open Positions: ${JSON.stringify(positions, null, 2)}
State: ${JSON.stringify(stateSummary, null, 2)}
Performance: ${perfSummary ? JSON.stringify(perfSummary, null, 2) : "No closed positions yet"}
Timestamp: ${new Date().toISOString()}
`;

  const FORMAT_BLOCK = `
TELEGRAM OUTPUT FORMAT (NON-NEGOTIABLE):
NEVER USE: markdown tables | **bold** | backtick code blocks | JSON output | --- dividers | ### headers
ALWAYS USE: plain text + emoji only. No exceptions for any message type.

MANAGE CYCLE:
🔄 Manage Cycle
📍 [Pool] | ⏱️ Age: Xm | 💎 Fees: $X | 📈 PnL: X%
  [━━━━━━━━━━●━━━━━] ✅ In Range → HOLD
  Reason: [1 line max]
💰 Wallet: X SOL | Positions: X/5 | ⏰ Next: Xm

SCREENING (deployed):
🔍 Screening → 🚀 Deployed
X SOL → [Pool] | bid_ask | Bins: X | Vol: $Xk
Reason: [1 line]
💰 Wallet: X SOL | ⏰ Next: Xm

SCREENING (no deploy):
🔍 Screening → ⏭️ No deploy — [reason in 1 line]
💰 Wallet: X SOL | ⏰ Next: Xm

CLOSE:
🔴 Closed [Pool]
📈 PnL: X% | 💎 Fees: $X | ⏱️ Held: Xm
Reason: [1 line]
🔄 Swapped [TOKEN] → X SOL

ALERT:
⚠️ [Pool] OOR Xm — [action in 1 line]

STATUS:
📊 Portfolio — X SOL (~$X)
• [Pool] ✅ Age: Xm | Fees: $X | PnL: X%
• [Pool] ⚠️ OOR Xm | Fees: $X | PnL: X%
`;

  prompt += FORMAT_BLOCK;
  prompt += `\nTimestamp: ${new Date().toISOString()}\n`;
  return prompt;
}
