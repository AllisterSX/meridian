/**
 * Autoresearch — automated prompt optimization system inspired by ATLAS.
 *
 * Identifies the worst-performing prompt section, generates a targeted
 * modification via a cheap LLM, tests it over N real closes, and
 * keeps/reverts based on actual PnL improvement.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import {
  getPromptSectionText,
  setPromptSectionOverride,
  clearPromptSectionOverride,
} from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTORESEARCH_FILE = path.join(__dirname, "autoresearch.json");

// ─── Persistence ─────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  experiments: [],       // history of all experiments
  active: null,          // currently running experiment (or null)
  cooldownRemaining: 0,  // closes remaining before next experiment
};

export function loadAutoresearch() {
  if (!fs.existsSync(AUTORESEARCH_FILE)) {
    saveAutoresearch(DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    return JSON.parse(fs.readFileSync(AUTORESEARCH_FILE, "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutoresearch(data) {
  fs.writeFileSync(AUTORESEARCH_FILE, JSON.stringify(data, null, 2));
}

// ─── Startup Restoration ─────────────────────────────────────

/**
 * On module load, restore any active experiment's override into memory.
 * Without this, a restart would lose the in-memory override while
 * autoresearch.json still shows an active experiment.
 */
try {
  const state = loadAutoresearch();
  if (state.active?.modified_text && state.active?.section) {
    setPromptSectionOverride(state.active.section, state.active.modified_text);
    log("autoresearch", `Restored active experiment override: ${state.active.id} (${state.active.section})`);
  }
} catch { /* ignore on first load if file doesn't exist yet */ }

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Called from recordPerformance after each close.
 * Evaluates an active experiment or starts a new one.
 */
export async function maybeRunAutoresearch(perfData, lessons, cfg) {
  if (cfg.autoresearch?.enabled !== true) return;

  const state = loadAutoresearch();

  if (state.active) {
    await evaluateExperiment(perfData, cfg, state);
  } else {
    // Decrement cooldown
    if (state.cooldownRemaining > 0) {
      state.cooldownRemaining--;
      saveAutoresearch(state);
      log("autoresearch", `Cooldown: ${state.cooldownRemaining} closes remaining`);
      return;
    }
    await analyzeAndGenerate(perfData, lessons, cfg, state);
  }
}

// ─── Analyze + Generate Experiment ───────────────────────────

async function analyzeAndGenerate(perfData, lessons, cfg, state) {
  const minCloses = cfg.autoresearch?.minClosesPerTrial ?? 7;

  // Need at least 15 closes to analyze, or at minimum minCloses * 2
  if (perfData.length < Math.max(15, minCloses * 2)) {
    log("autoresearch", `Not enough data (${perfData.length} closes) — skipping`);
    return;
  }

  // 1. Attribute recent losses to prompt sections
  const recent = perfData.slice(-15);
  const sectionLosses = {
    screener_criteria: [],
    manager_logic: [],
    range_selection: [],
  };

  for (const p of recent) {
    if ((p.pnl_usd ?? 0) >= 0) continue; // skip winners

    const reason = (p.close_reason || "").toLowerCase();

    if (reason.includes("stop_loss") || reason.includes("trailing_tp") || reason.includes("oor downside")) {
      sectionLosses.manager_logic.push(p);
    } else if ((p.range_efficiency ?? 100) < 30) {
      sectionLosses.range_selection.push(p);
    } else if (reason.includes("oor upside")) {
      sectionLosses.range_selection.push(p);
    } else {
      sectionLosses.screener_criteria.push(p);
    }
  }

  // 2. Pick the worst section
  let worstSection = "screener_criteria";
  let worstCount = 0;
  for (const [section, losses] of Object.entries(sectionLosses)) {
    if (losses.length > worstCount) {
      worstCount = losses.length;
      worstSection = section;
    }
  }

  if (worstCount === 0) {
    log("autoresearch", "No losses in recent closes — nothing to optimize");
    return;
  }

  log("autoresearch", `Worst section: ${worstSection} (${worstCount} attributed losses)`);

  // 3. Read current prompt text for that section
  const currentText = getPromptSectionText(worstSection);
  if (!currentText) {
    log("autoresearch", `Could not read section text for "${worstSection}" — skipping`);
    return;
  }

  // 4. Generate modification via cheap LLM
  const failures = sectionLosses[worstSection];
  const failureDesc = failures
    .map(f => `- ${f.pool_name || "unknown"}: PnL ${f.pnl_pct}%, reason: ${f.close_reason || "unknown"}`)
    .join("\n");

  const llmModel = cfg.autoresearch?.llmModel ?? "openai/gpt-5.4-nano";
  let hypothesis, modifiedText;

  try {
    const result = await callLLM(llmModel, worstSection, worstCount, currentText, failureDesc);
    hypothesis = result.hypothesis;
    modifiedText = result.modifiedText;
  } catch (e) {
    log("autoresearch", `LLM call failed: ${e.message}`);
    return;
  }

  if (!modifiedText || modifiedText.trim() === currentText.trim()) {
    log("autoresearch", "LLM returned identical or empty text — skipping");
    return;
  }

  // 5. Compute baseline from last N positions
  const baselinePositions = perfData.slice(-minCloses);
  const baselineWins = baselinePositions.filter(p => (p.pnl_usd ?? 0) > 0).length;
  const baselineWR = baselinePositions.length > 0
    ? (baselineWins / baselinePositions.length) * 100
    : 0;
  const baselineAvgPnl = baselinePositions.length > 0
    ? baselinePositions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / baselinePositions.length
    : 0;

  // 6. Create experiment
  const experiment = {
    id: `exp_${Date.now()}`,
    section: worstSection,
    hypothesis: hypothesis || "Targeted modification to reduce losses",
    original_text: currentText,
    modified_text: modifiedText,
    started_at: new Date().toISOString(),
    started_at_position: perfData.length,
    baseline: {
      win_rate: Math.round(baselineWR * 10) / 10,
      avg_pnl_pct: Math.round(baselineAvgPnl * 100) / 100,
      positions: baselinePositions.length,
    },
    trial: {
      win_rate: null,
      avg_pnl_pct: null,
      positions: 0,
    },
    status: "active",
  };

  state.active = experiment;
  saveAutoresearch(state);

  // 7. Activate the override
  setPromptSectionOverride(worstSection, modifiedText);

  log("autoresearch", `Experiment ${experiment.id} started: ${worstSection}`);
  log("autoresearch", `Hypothesis: ${hypothesis}`);
  log("autoresearch", `Baseline WR: ${experiment.baseline.win_rate}%, avg PnL: ${experiment.baseline.avg_pnl_pct}%`);
}

// ─── Evaluate Active Experiment ──────────────────────────────

async function evaluateExperiment(perfData, cfg, state) {
  const experiment = state.active;
  if (!experiment) return;

  const minCloses = cfg.autoresearch?.minClosesPerTrial ?? 7;
  const improvementPct = cfg.autoresearch?.improvementPct ?? 15;
  const declinePct = cfg.autoresearch?.declinePct ?? 15;
  const cooldownCloses = cfg.autoresearch?.cooldownCloses ?? 5;

  // Positions closed since experiment started
  const trialPositions = perfData.slice(experiment.started_at_position);
  const trialCount = trialPositions.length;

  experiment.trial.positions = trialCount;

  // Circuit breaker: if first 3 trial closes are ALL losses, auto-revert
  if (trialCount >= 3 && trialCount < minCloses) {
    const first3 = trialPositions.slice(0, 3);
    const allLosses = first3.every(p => (p.pnl_usd ?? 0) < 0);
    if (allLosses) {
      log("autoresearch", `Circuit breaker: first 3 closes all losses — reverting ${experiment.id}`);
      finishExperiment(state, "reverted_circuit_breaker", cooldownCloses);
      return;
    }
  }

  // Not enough data yet
  if (trialCount < minCloses) {
    saveAutoresearch(state);
    log("autoresearch", `Experiment ${experiment.id}: ${trialCount}/${minCloses} closes`);
    return;
  }

  // Compute trial metrics
  const trialWins = trialPositions.filter(p => (p.pnl_usd ?? 0) > 0).length;
  const trialWR = (trialWins / trialCount) * 100;
  const trialAvgPnl = trialPositions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / trialCount;

  experiment.trial.win_rate = Math.round(trialWR * 10) / 10;
  experiment.trial.avg_pnl_pct = Math.round(trialAvgPnl * 100) / 100;

  // Compare to baseline
  const baselineWR = experiment.baseline.win_rate;
  const improvement = ((trialWR - baselineWR) / Math.max(baselineWR, 1)) * 100;

  log("autoresearch", `Experiment ${experiment.id}: trial WR ${trialWR.toFixed(1)}% vs baseline ${baselineWR.toFixed(1)}% (improvement: ${improvement.toFixed(1)}%)`);

  if (improvement >= improvementPct) {
    // KEEP — the modification helped
    log("autoresearch", `KEEPING experiment ${experiment.id} — ${improvement.toFixed(1)}% improvement`);
    experiment.status = "kept";
    // The override stays active permanently — it's now the new prompt
    // Log as lesson
    logExperimentLesson(experiment, "kept", improvement);
    state.experiments.push(experiment);
    state.active = null;
    state.cooldownRemaining = cooldownCloses;
    saveAutoresearch(state);
  } else if (improvement <= -declinePct) {
    // REVERT — the modification hurt
    log("autoresearch", `REVERTING experiment ${experiment.id} — ${improvement.toFixed(1)}% decline`);
    logExperimentLesson(experiment, "reverted", improvement);
    finishExperiment(state, "reverted", cooldownCloses);
  } else {
    // INCONCLUSIVE — revert to be safe
    log("autoresearch", `DISCARDING experiment ${experiment.id} — inconclusive (${improvement.toFixed(1)}%)`);
    logExperimentLesson(experiment, "inconclusive", improvement);
    finishExperiment(state, "inconclusive", cooldownCloses);
  }
}

function finishExperiment(state, status, cooldownCloses) {
  const experiment = state.active;
  if (!experiment) return;

  experiment.status = status;
  clearPromptSectionOverride(experiment.section);
  state.experiments.push(experiment);
  state.active = null;
  state.cooldownRemaining = cooldownCloses;
  saveAutoresearch(state);
}

function logExperimentLesson(experiment, outcome, improvementPct) {
  try {
    // Dynamic import to avoid circular dependency
    import("./lessons.js").then(({ addLesson }) => {
      const label = outcome === "kept" ? "KEPT" : outcome === "reverted" ? "REVERTED" : "INCONCLUSIVE";
      addLesson(
        `[AUTORESEARCH ${label}] Section "${experiment.section}": ${experiment.hypothesis}. ` +
        `Trial WR: ${experiment.trial.win_rate}% vs baseline ${experiment.baseline.win_rate}% ` +
        `(${improvementPct > 0 ? "+" : ""}${improvementPct.toFixed(1)}%).`,
        ["autoresearch", experiment.section, outcome],
      );
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// ─── LLM Call ────────────────────────────────────────────────

async function callLLM(model, sectionName, lossCount, currentText, failureDesc) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const systemMsg = `You optimize prompts for an autonomous LP (Liquidity Provider) trading agent on Meteora/Solana DLMM. The agent uses these prompts as behavioral instructions. Your goal is to make small, surgical edits that reduce losses.

KEY DOMAIN KNOWLEDGE for your modifications:
- STRATEGIES: The agent can deploy "bid_ask" (single-sided SOL below price — earns fees on sell pressure, safe but goes idle if price pumps UP) or "spot" with sol_split_pct (two-sided, e.g. 80% SOL / 20% token — captures fees in both directions, better for pumping tokens but riskier if token dumps).
- OOR UPSIDE: Price pumped above the position range. For bid_ask, SOL sits idle earning nothing. Spot two-sided would have captured fees on the way up.
- OOR DOWNSIDE: Price dropped below the position range. SOL converted to token, real loss. Wider range helps stay in range longer.
- If failures show repeated "OOR upside" with bid_ask, consider switching to spot with high sol_split_pct (80-90) for those pool types.
- If failures show "OOR downside", consider widening price_range_pct or tightening screening thresholds.
- The agent has signal weights showing which screening signals predict wins (organic_score, fee_tvl_ratio, mcap are strong; holder_count, volume are weak).`;

  const userMsg = `Section "${sectionName}" has caused ${lossCount} recent losses.

Current text:
---
${currentText}
---

Recent failures:
${failureDesc}

Generate exactly ONE small, targeted modification. Change only one instruction or threshold. Do not rewrite the whole section.

Reply with:
HYPOTHESIS: [one sentence explaining what you're changing and why]
MODIFIED_TEXT:
[full section text with your single change applied]`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg },
      ],
      temperature: 0.4,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`OpenRouter returned ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");

  // Parse response
  const hypothesisMatch = content.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
  const modifiedMatch = content.match(/MODIFIED_TEXT:\s*\n([\s\S]+)/i);

  return {
    hypothesis: hypothesisMatch?.[1]?.trim() || "Targeted modification",
    modifiedText: modifiedMatch?.[1]?.trim() || null,
  };
}

// ─── Public Accessors ────────────────────────────────────────

/**
 * Get the currently active experiment, or null.
 */
export function getActiveExperiment() {
  const state = loadAutoresearch();
  return state.active || null;
}

/**
 * Interface for prompt.js — get current text for a section.
 */
export function getPromptSection(sectionName) {
  return getPromptSectionText(sectionName);
}

/**
 * Interface for prompt.js — set override.
 */
export function setPromptOverride(sectionName, text) {
  setPromptSectionOverride(sectionName, text);
}

/**
 * Interface for prompt.js — clear override.
 */
export function clearPromptOverride(sectionName) {
  clearPromptSectionOverride(sectionName);
}
