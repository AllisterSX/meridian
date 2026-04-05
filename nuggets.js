/**
 * nuggets.js — Simple key-value memory store with hit tracking.
 * Replaces the missing HRR-based nuggets library.
 * Data is persisted as JSON files in saveDir.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Nugget (single named store) ────────────────────────────────
class Nugget {
  constructor(name, { maxFacts = 100 } = {}) {
    this.name = name;
    this.maxFacts = maxFacts;
    this._facts = []; // [{ key, value, hits, last_hit_session, created_at }]
  }

  /**
   * Store or update a fact. If key exists, update value + bump hits.
   */
  remember(key, value) {
    const existing = this._facts.find(f => f.key === key);
    if (existing) {
      existing.value = value;
      existing.hits = (existing.hits || 0) + 1;
    } else {
      // Evict oldest (lowest hits) if at capacity
      if (this._facts.length >= this.maxFacts) {
        this._facts.sort((a, b) => (a.hits || 0) - (b.hits || 0));
        this._facts.shift();
      }
      this._facts.push({
        key,
        value,
        hits: 0,
        last_hit_session: null,
        created_at: new Date().toISOString(),
      });
    }
  }

  /**
   * Recall a fact by key. Returns { found, key, answer, confidence }.
   * Also increments hit count and records session.
   */
  recall(key, sessionId) {
    const fact = this._facts.find(f => f.key === key);
    if (!fact) {
      return { found: false, key, answer: null, confidence: 0 };
    }
    fact.hits = (fact.hits || 0) + 1;
    if (sessionId) fact.last_hit_session = sessionId;
    // Confidence: sigmoid-like based on hits (asymptotes to 1.0)
    const confidence = Math.min(0.99, 0.4 + fact.hits * 0.06);
    return { found: true, key: fact.key, answer: fact.value, confidence };
  }

  /**
   * Remove a fact by key.
   */
  forget(key) {
    const idx = this._facts.findIndex(f => f.key === key);
    if (idx !== -1) this._facts.splice(idx, 1);
  }

  /**
   * Return all facts sorted by hits descending.
   */
  facts() {
    return [...this._facts].sort((a, b) => (b.hits || 0) - (a.hits || 0));
  }

  /**
   * Capacity status.
   */
  status() {
    return {
      fact_count: this._facts.length,
      max_facts: this.maxFacts,
      capacity_used_pct: Math.round((this._facts.length / this.maxFacts) * 100),
    };
  }

  toJSON() {
    return { facts: this._facts };
  }

  fromJSON(data) {
    if (Array.isArray(data?.facts)) {
      this._facts = data.facts;
    }
    return this;
  }
}

// ─── NuggetShelf (collection of named Nuggets) ───────────────────
export class NuggetShelf {
  constructor({ saveDir, autoSave = true } = {}) {
    this.saveDir = saveDir;
    this.autoSave = autoSave;
    this._nuggets = new Map(); // name → Nugget
  }

  get size() {
    return this._nuggets.size;
  }

  /**
   * Get or create a nugget by name.
   */
  getOrCreate(name, options = {}) {
    if (!this._nuggets.has(name)) {
      this._nuggets.set(name, new Nugget(name, options));
    }
    return this._nuggets.get(name);
  }

  /**
   * Get an existing nugget (throws if not found).
   */
  get(name) {
    if (!this._nuggets.has(name)) {
      throw new Error(`Nugget "${name}" not found`);
    }
    return this._nuggets.get(name);
  }

  /**
   * List all nugget names.
   */
  list() {
    return [...this._nuggets.keys()].map(name => ({ name }));
  }

  /**
   * Remember a fact in a named nugget.
   */
  remember(nuggetName, key, value) {
    const nugget = this.getOrCreate(nuggetName);
    nugget.remember(key, value);
    if (this.autoSave) this._save(nuggetName);
  }

  /**
   * Recall a fact from a named nugget.
   */
  recall(key, nuggetName, sessionId) {
    if (!nuggetName || !this._nuggets.has(nuggetName)) {
      return { found: false, key, answer: null, confidence: 0 };
    }
    const result = this._nuggets.get(nuggetName).recall(key, sessionId);
    if (result.found && this.autoSave) this._save(nuggetName);
    return result;
  }

  /**
   * Forget a fact from a named nugget.
   */
  forget(nuggetName, key) {
    if (!this._nuggets.has(nuggetName)) return;
    this._nuggets.get(nuggetName).forget(key);
    if (this.autoSave) this._save(nuggetName);
  }

  /**
   * Load all nugget JSON files from saveDir.
   * Pass an optional factLimits map { nuggetName: maxFacts } to enforce
   * per-nugget caps after loading (e.g. { pools: 150, strategies: 80 }).
   */
  loadAll(factLimits = {}) {
    if (!this.saveDir) return;
    try {
      if (!fs.existsSync(this.saveDir)) {
        fs.mkdirSync(this.saveDir, { recursive: true });
        return;
      }
      const files = fs.readdirSync(this.saveDir).filter(f => f.endsWith(".nugget.json"));
      for (const file of files) {
        const name = file.replace(".nugget.json", "");
        const filePath = path.join(this.saveDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
          // Apply caller-specified maxFacts if provided, otherwise use saved count or default 100
          const max = factLimits[name] ?? 100;
          const nugget = new Nugget(name, { maxFacts: max });
          nugget.fromJSON(data);
          this._nuggets.set(name, nugget);
        } catch { /* skip corrupt files */ }
      }
    } catch { /* ignore */ }
  }

  /**
   * Save a single nugget to disk.
   */
  _save(nuggetName) {
    if (!this.saveDir) return;
    try {
      if (!fs.existsSync(this.saveDir)) {
        fs.mkdirSync(this.saveDir, { recursive: true });
      }
      const nugget = this._nuggets.get(nuggetName);
      if (!nugget) return;
      const filePath = path.join(this.saveDir, `${nuggetName}.nugget.json`);
      fs.writeFileSync(filePath, JSON.stringify(nugget.toJSON(), null, 2));
    } catch { /* ignore */ }
  }

  /**
   * Save all nuggets to disk.
   */
  saveAll() {
    for (const name of this._nuggets.keys()) {
      this._save(name);
    }
  }
}

// ─── promoteFacts ────────────────────────────────────────────────
const MEMORY_MD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "MEMORY.md"
);
const PROMOTE_THRESHOLD = 5; // hits >= this → promote to MEMORY.md

/**
 * Promote high-hit facts from all nuggets to MEMORY.md.
 * Returns count of promoted facts.
 */
export function promoteFacts(shelf) {
  const lines = ["# MEMORY — Auto-promoted facts\n"];
  let count = 0;

  for (const { name } of shelf.list()) {
    try {
      const nugget = shelf.get(name);
      const topFacts = nugget.facts().filter(f => (f.hits || 0) >= PROMOTE_THRESHOLD);
      if (topFacts.length === 0) continue;
      lines.push(`## ${name}`);
      for (const f of topFacts.slice(0, 20)) {
        lines.push(`- **${f.key}**: ${f.value} (hits: ${f.hits})`);
        count++;
      }
      lines.push("");
    } catch { continue; }
  }

  if (count > 0) {
    try {
      fs.writeFileSync(MEMORY_MD_PATH, lines.join("\n"), "utf8");
    } catch { /* ignore */ }
  }

  return count;
}
