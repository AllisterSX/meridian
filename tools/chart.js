/**
 * tools/chart.js
 * Price analysis using GeckoTerminal OHLCV API.
 *
 * Free, no API key required. Rate limit: 10 calls/min.
 * Endpoint: GET https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool_address}/ohlcv/{timeframe}
 *   timeframe: "minute" | "hour" | "day"
 *   aggregate:  1, 5, 15 (minutes); 1, 4 (hours); 1 (day)
 *   limit:      max 1000 candles
 *   currency:   "usd" (price in USD) or "token" (price in quote token)
 *   token:      "base" | "quote"
 *
 * Response: { data: { attributes: { ohlcv_list: [[ts_sec, o, h, l, c, v], ...] } } }
 */

import { log } from "../logger.js";

const GT_BASE    = "https://api.geckoterminal.com/api/v2";
const GT_TIMEOUT = 8_000;
const GT_HEADERS = {
  "Accept":     "application/json;version=20230302",
  "User-Agent": "Meridian/1.0",
};

// ─── Timeframe mapping ─────────────────────────────────────────────────────

// Maps friendly TF strings → GeckoTerminal {timeframe, aggregate} params
const TF_MAP = {
  "1m":  { timeframe: "minute", aggregate: 1  },
  "5m":  { timeframe: "minute", aggregate: 5  },
  "15m": { timeframe: "minute", aggregate: 15 },
  "30m": { timeframe: "minute", aggregate: 30 },
  "1h":  { timeframe: "hour",   aggregate: 1  },
  "4h":  { timeframe: "hour",   aggregate: 4  },
  "1d":  { timeframe: "day",    aggregate: 1  },
};

// ─── Candle fetch ──────────────────────────────────────────────────────────

/**
 * Fetch OHLCV candles from GeckoTerminal.
 * @param {string} poolAddress - Meteora/Solana pool address
 * @param {string} resolution  - "1m"|"5m"|"15m"|"30m"|"1h"|"4h"|"1d"
 * @param {number} limit       - Number of candles (max 1000)
 * @param {number} [beforeTs]  - Optional: fetch candles before this Unix timestamp (seconds)
 */
async function fetchCandles(poolAddress, resolution = "5m", limit = 100, beforeTs = null) {
  const tf = TF_MAP[resolution] || TF_MAP["5m"];

  const params = new URLSearchParams({
    aggregate: String(tf.aggregate),
    limit:     String(Math.min(limit, 1000)),
    currency:  "usd",
    token:     "base",
  });
  if (beforeTs) params.set("before_timestamp", String(beforeTs));

  const url = `${GT_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${tf.timeframe}?${params}`;

  const res = await fetch(url, {
    headers: GT_HEADERS,
    signal:  AbortSignal.timeout(GT_TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(`GeckoTerminal OHLCV HTTP ${res.status} for ${poolAddress.slice(0, 8)}`);
  }

  const json = await res.json();
  const raw  = json?.data?.attributes?.ohlcv_list;

  if (!Array.isArray(raw) || raw.length === 0) return [];

  // GeckoTerminal returns newest first — reverse to oldest first
  return raw
    .map(([ts, o, h, l, c, v]) => ({
      ts:     ts * 1000,             // convert seconds → ms
      open:   parseFloat(o)  || 0,
      high:   parseFloat(h)  || 0,
      low:    parseFloat(l)  || 0,
      close:  parseFloat(c)  || 0,
      volume: parseFloat(v)  || 0,   // volume in USD
    }))
    .filter(c => c.close > 0 && c.high > 0 && c.low > 0)
    .reverse()  // oldest → newest
    .sort((a, b) => a.ts - b.ts);
}

// ─── Analysis functions ────────────────────────────────────────────────────

/**
 * Detect support/resistance via pivot point method.
 * A candle is a pivot high if its high is highest among [pivotWindow] candles on each side.
 */
function detectSupportResistance(candles, pivotWindow = 3, maxLevels = 4) {
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const n     = candles.length;

  const pivotHighs = [];
  const pivotLows  = [];

  for (let i = pivotWindow; i < n - pivotWindow; i++) {
    const wH = highs.slice(i - pivotWindow, i + pivotWindow + 1);
    const wL = lows.slice(i - pivotWindow,  i + pivotWindow + 1);
    if (highs[i] === Math.max(...wH)) pivotHighs.push(highs[i]);
    if (lows[i]  === Math.min(...wL)) pivotLows.push(lows[i]);
  }

  function clusterLevels(levels) {
    if (levels.length === 0) return [];
    const sorted   = [...levels].sort((a, b) => a - b);
    const clusters = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const last = clusters[clusters.length - 1];
      const avg  = last.reduce((s, v) => s + v, 0) / last.length;
      if (Math.abs(sorted[i] - avg) / avg < 0.015) {
        last.push(sorted[i]);
      } else {
        clusters.push([sorted[i]]);
      }
    }
    return clusters
      .map(c => ({
        price:    c.reduce((s, v) => s + v, 0) / c.length,
        touches:  c.length,
        strength: c.length >= 3 ? "strong" : c.length >= 2 ? "moderate" : "weak",
      }))
      .sort((a, b) => b.touches - a.touches)
      .slice(0, maxLevels);
  }

  return {
    resistance: clusterLevels(pivotHighs).sort((a, b) => a.price - b.price),
    support:    clusterLevels(pivotLows).sort((a, b) => b.price - a.price),
  };
}

/**
 * Analyze trend using EMA crossover (EMA-8 / EMA-21).
 */
function analyzeTrend(candles) {
  if (candles.length < 21) return { trend: "insufficient_data", confidence: "low" };

  const closes = candles.map(c => c.close);

  function ema(data, period) {
    const k = 2 / (period + 1);
    const r = [data[0]];
    for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
    return r;
  }

  const ema8      = ema(closes, 8);
  const ema21     = ema(closes, 21);
  const lastPrice = closes[closes.length - 1];
  const lastE8    = ema8[ema8.length - 1];
  const lastE21   = ema21[ema21.length - 1];

  const recent    = closes.slice(-10);
  const recentE21 = ema21.slice(-10);
  const aboveEma  = recent.filter((c, i) => c > recentE21[i]).length;

  const last20     = candles.slice(-20);
  const rangeHigh  = Math.max(...last20.map(c => c.high));
  const rangeLow   = Math.min(...last20.map(c => c.low));
  const rangeWidth = (rangeHigh - rangeLow) / rangeLow * 100;

  let trend, confidence;
  if (lastE8 > lastE21 && lastPrice > lastE21 && aboveEma >= 7) {
    trend = "uptrend"; confidence = aboveEma >= 9 ? "high" : "moderate";
  } else if (lastE8 < lastE21 && lastPrice < lastE21 && aboveEma <= 3) {
    trend = "downtrend"; confidence = aboveEma <= 1 ? "high" : "moderate";
  } else if (rangeWidth < 8) {
    trend = "ranging_tight"; confidence = "moderate";
  } else {
    trend = "ranging"; confidence = "low";
  }

  const periodChangePct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;

  return {
    trend,
    confidence,
    ema8_last:          parseFloat(lastE8.toFixed(10)),
    ema21_last:         parseFloat(lastE21.toFixed(10)),
    current_price:      parseFloat(lastPrice.toFixed(10)),
    period_change_pct:  parseFloat(periodChangePct.toFixed(2)),
    above_ema21_last10: aboveEma,
    range_width_pct:    parseFloat(rangeWidth.toFixed(2)),
  };
}

/**
 * Detect dump signals: drawdown from peak, volume spike on red candles, red streak.
 */
function detectDumpSignals(candles) {
  if (candles.length < 5) return { is_dump: false, signals: [] };

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const last    = closes[closes.length - 1];
  const peak    = Math.max(...closes);
  const peakIdx = closes.lastIndexOf(peak);

  const drawdownFromPeak = ((last - peak) / peak) * 100;

  const last5      = candles.slice(-5);
  const avgVol     = volumes.slice(0, -5).reduce((s, v) => s + v, 0) / Math.max(volumes.length - 5, 1);
  const downVols   = last5.filter(c => c.close < c.open).map(c => c.volume);
  const avgDownVol = downVols.length > 0 ? downVols.reduce((s, v) => s + v, 0) / downVols.length : 0;
  const volSpikeOnDump = avgVol > 0 && avgDownVol > avgVol * 2.5;

  let redStreak = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) redStreak++;
    else break;
  }

  const signals = [];
  if (drawdownFromPeak < -25)            signals.push(`drawdown_from_peak=${drawdownFromPeak.toFixed(1)}%`);
  if (volSpikeOnDump)                    signals.push("volume_spike_on_down_candles");
  if (redStreak >= 4)                    signals.push(`consecutive_red_candles=${redStreak}`);
  if (peakIdx > candles.length * 0.8 && drawdownFromPeak < -15) signals.push("fresh_dump_from_recent_peak");

  return {
    is_dump:              signals.length >= 2,
    dump_confidence:      signals.length >= 3 ? "high" : signals.length >= 2 ? "moderate" : "low",
    drawdown_from_peak:   parseFloat(drawdownFromPeak.toFixed(2)),
    volume_spike_on_dump: volSpikeOnDump,
    red_streak:           redStreak,
    signals,
  };
}

/**
 * Generate degen play range recommendation using S/R + volatility.
 */
function generateDegenPlay(candles, levels, trend, binStep, tokenAgeHours = null) {
  if (candles.length === 0) return null;

  const currentPrice = candles[candles.length - 1].close;
  const last20       = candles.slice(-20);
  const high20       = Math.max(...last20.map(c => c.high));
  const low20        = Math.min(...last20.map(c => c.low));
  const volatility20 = ((high20 - low20) / low20) * 100;

  const nearestSupport    = levels.support.find(s => s.price < currentPrice * 0.995);
  const nearestResistance = levels.resistance.find(r => r.price > currentPrice * 1.005);

  let lowerPct;
  if (nearestSupport && nearestSupport.touches >= 2 && nearestSupport.price > currentPrice * 0.70) {
    lowerPct = ((nearestSupport.price * 0.98 - currentPrice) / currentPrice) * 100;
  } else {
    lowerPct = -(volatility20 * 1.5);
    lowerPct = Math.max(lowerPct, -70);
    lowerPct = Math.min(lowerPct, -25);
  }

  const binsBelow = Math.ceil(
    Math.log(1 + Math.abs(lowerPct) / 100) /
    Math.log(1 + (binStep || 100) / 10000)
  );

  const isNewToken     = tokenAgeHours !== null && tokenAgeHours < 6;
  const finalBinsBelow = isNewToken ? Math.max(binsBelow, 125) : Math.max(binsBelow, 60);

  const risk = trend.trend === "downtrend" ? "HIGH"
    : (trend.trend === "uptrend" && trend.confidence === "high") ? "LOW"
    : "MEDIUM";

  const goodEntry = trend.trend !== "downtrend" && !isNewToken;

  return {
    strategy:           "bid_ask",
    current_price:      parseFloat(currentPrice.toFixed(10)),
    lower_price:        parseFloat((currentPrice * (1 + lowerPct / 100)).toFixed(10)),
    upper_price:        currentPrice,
    lower_pct:          parseFloat(lowerPct.toFixed(1)),
    upper_pct:          0,
    bins_below:         finalBinsBelow,
    bins_above:         0,
    range_width_pct:    parseFloat(Math.abs(lowerPct).toFixed(1)),
    nearest_support:    nearestSupport ? {
      price: parseFloat(nearestSupport.price.toFixed(10)), touches: nearestSupport.touches, strength: nearestSupport.strength,
    } : null,
    nearest_resistance: nearestResistance ? {
      price: parseFloat(nearestResistance.price.toFixed(10)), touches: nearestResistance.touches, strength: nearestResistance.strength,
    } : null,
    risk_level: risk,
    good_entry: goodEntry,
    entry_note: goodEntry
      ? "Price near support, in-range entry looks valid"
      : "Entry risky — trend is down or token too new to have reliable S/R",
  };
}

// ─── Public exports ────────────────────────────────────────────────────────

/**
 * Main tool: get_price_analysis
 *
 * Uses GeckoTerminal OHLCV API — free, no API key, uses pool address.
 *
 * @param {string} pool_address    - Meteora pool address (required)
 * @param {string} [base_mint]     - Ignored (kept for compat, GT uses pool address)
 * @param {string} [timeframe]     - "1m"|"5m"|"15m"|"30m"|"1h"|"4h" (default: "5m")
 * @param {number} [candle_count]  - Number of candles (default: 100, max: 1000)
 * @param {number} [bin_step]      - Pool bin step for range calc (default: 100)
 * @param {number} [token_age_hours] - Token age for new token detection
 */
export async function getPriceAnalysis({
  pool_address,
  base_mint,
  pool_name = null,
  timeframe = "5m",
  candle_count = 100,
  bin_step = 100,
  token_age_hours = null,
} = {}) {
  const addr = pool_address || base_mint;
  const label = pool_name || addr?.slice(0, 8) || "unknown";
  if (!addr) throw new Error("pool_address is required");

  const VALID_TF = Object.keys(TF_MAP);
  const tf  = VALID_TF.includes(timeframe) ? timeframe : "5m";
  const lim = Math.min(Math.max(candle_count, 30), 1000);

  let candles;
  try {
    candles = await fetchCandles(addr, tf, lim);
    log("chart", `GeckoTerminal OHLCV: ${candles.length} candles (${tf}) for ${label}`);
  } catch (e) {
    log("chart_warn", `GeckoTerminal OHLCV failed for ${label}: ${e.message}`);
    return {
      pool_address: addr,
      error: e.message,
      candles: 0,
      _summary: `Price analysis unavailable: ${e.message}. Proceed without chart data.`,
      trend: { trend: "unknown", confidence: "none" },
      dump_signals: { is_dump: false, signals: [] },
      support_resistance: { resistance: [], support: [] },
      degen_play: null,
    };
  }

  if (!candles || candles.length < 10) {
    return {
      pool_address: addr,
      error: "Insufficient candle data (< 10 candles). Pool may be too new or inactive on GeckoTerminal.",
      candles: candles?.length ?? 0,
      _summary: "Price analysis unavailable: not enough candle data. Proceed without chart data.",
      trend: { trend: "unknown", confidence: "none" },
      dump_signals: { is_dump: false, signals: [] },
      support_resistance: { resistance: [], support: [] },
      degen_play: null,
    };
  }

  const levels    = detectSupportResistance(candles);
  const trend     = analyzeTrend(candles);
  const dump      = detectDumpSignals(candles);
  const degenPlay = generateDegenPlay(candles, levels, trend, bin_step, token_age_hours);

  const last5 = candles.slice(-5).map(c => ({
    time:   new Date(c.ts).toISOString().slice(11, 16),
    open:   parseFloat(c.open.toFixed(8)),
    close:  parseFloat(c.close.toFixed(8)),
    volume: Math.round(c.volume),
    dir:    c.close >= c.open ? "▲" : "▼",
  }));

  return {
    pool_address: addr,
    timeframe:    tf,
    candles_analyzed: candles.length,
    period_start: new Date(candles[0].ts).toISOString(),
    period_end:   new Date(candles[candles.length - 1].ts).toISOString(),

    trend,
    dump_signals: dump,
    support_resistance: { resistance: levels.resistance, support: levels.support },
    degen_play:     degenPlay,
    last_5_candles: last5,

    _summary: [
      `Trend: ${trend.trend} (${trend.confidence} confidence)`,
      `Period change: ${trend.period_change_pct}%`,
      dump.is_dump ? `⚠️ DUMP SIGNALS: ${dump.signals.join(", ")}` : "No dump signals",
      levels.support.length    > 0 ? `Support: $${levels.support[0].price.toFixed(8)} (${levels.support[0].strength})` : "No clear support",
      levels.resistance.length > 0 ? `Resistance: $${levels.resistance[0].price.toFixed(8)} (${levels.resistance[0].strength})` : "No clear resistance",
      degenPlay ? `Degen range: ${degenPlay.lower_pct}% to 0% | ${degenPlay.bins_below} bins below | Risk: ${degenPlay.risk_level}` : "",
    ].filter(Boolean).join(" | "),
  };
}