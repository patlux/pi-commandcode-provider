#!/usr/bin/env -S npx tsx

/**
 * Extract model & provider definitions from the command-code npm package dist file.
 *
 * Usage:
 *   npx tsx scripts/extract-models.ts [path-to-dist/index.mjs]
 *   npx tsx scripts/extract-models.ts (downloads latest from npm)
 *
 * Output: models.json
 *   {
 *     providers: { ... },        // provider key -> value map
 *     providerGroups: { ... },   // provider-group key -> { id, label, providers[] }
 *     models: [ ... ],           // flattened model definitions
 *     pricing: [ ... ]           // pricing entries (per 1M tokens, USD)
 *   }
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Evaluate a JS object literal string safely via Function constructor. */
function parseObjectLiteral(code: string): Record<string, unknown> {
  const fn = new Function(`return (${code})`);
  return fn() as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Step 1: get the dist file
// ---------------------------------------------------------------------------

function ensureDist(srcPath?: string): string {
  if (srcPath) {
    if (!existsSync(srcPath)) throw new Error(`File not found: ${srcPath}`);
    return srcPath;
  }

  // Download latest from npm
  const tmpDir = join(process.cwd(), ".extract-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tgz = execSync(`npm pack command-code --pack-destination "${tmpDir}"`, {
    encoding: "utf8",
  }).trim();
  const tgzPath = join(tmpDir, tgz);
  execSync(`tar xzf "${tgzPath}" -C "${tmpDir}"`, { encoding: "utf8" });
  return join(tmpDir, "package", "dist", "index.mjs");
}

// ---------------------------------------------------------------------------
// Step 2: extract
// ---------------------------------------------------------------------------

interface ModelDef {
  key: string;
  id: string;
  provider: string;
  spec: string;
  label: string;
  name: string;
  description: string;
  reasoning: boolean;
  reasoningEfforts: string[] | null;
  contextWindow: number;
  maxOutputTokens: number;
  vendorLabel: string | null;
}

interface PricingEntry {
  provider: string;
  id: string;
  category: string;
  promptCost: number;
  completionCost: number;
  cacheWrite5mCost: number;
  cacheWrite1hCost: number;
  cacheHitCost: number;
}

interface ProviderGroup {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  providers: string[];
}

function extract(code: string) {
  // --- Wt: provider constants ---
  const wtMatch = code.match(/Wt=\{([^}]+)\}/);
  if (!wtMatch) throw new Error("Cannot find Wt");
  const wtRaw = "{" + wtMatch[1] + "}";
  const wt: Record<string, string> = {};
  for (const m of wtRaw.matchAll(/(\w+):"(\w[-\w]*)"/g)) {
    wt[m[1]] = m[2];
  }
  console.log("Providers:", wt);

  // --- an: model definitions ---
  // an={...}).SONNET
  const anIdx = code.indexOf("an={");
  if (anIdx < 0) throw new Error("Cannot find an");
  const anEndIdx = code.indexOf("}).SONNET", anIdx);
  if (anEndIdx < 0) throw new Error("Cannot find end of an");
  let anCode = code.substring(anIdx + 1, anEndIdx + 2); // "an={...})"
  anCode = anCode.replace(/^\(an=/, "").replace(/\)$/, "");

  // Replace minified JS idioms
  anCode = anCode.replace(/\bQt\b/g, JSON.stringify("vercel-ai-gateway"));
  anCode = anCode.replace(/\bon\b/g, JSON.stringify("chatComplete"));
  anCode = anCode.replace(/\bsn\b/g, JSON.stringify("responses"));
  anCode = anCode.replace(/Wt\.([A-Z_]+)/g, (_, key: string) =>
    JSON.stringify(wt[key]),
  );
  anCode = anCode.replace(/!0/g, "true");
  anCode = anCode.replace(/!1/g, "false");

  const an = parseObjectLiteral(anCode);

  // --- Yt: pricing (provider -> model array) ---
  const ytIdx = code.indexOf("Yt={[");
  if (ytIdx < 0) throw new Error("Cannot find Yt");
  // Find the matching closing brace for Yt
  let depth = 1;
  let ytEndIdx = ytIdx + 4;
  while (depth > 0 && ytEndIdx < code.length) {
    if (code[ytEndIdx] === "{") depth++;
    else if (code[ytEndIdx] === "}") depth--;
    ytEndIdx++;
  }
  let ytCode = code.substring(ytIdx + 3, ytEndIdx); // "{ ... }"
  ytCode = ytCode.replace(/Wt\.([A-Z_]+)/g, (_, key: string) =>
    JSON.stringify(wt[key]),
  );
  ytCode = ytCode.replace(/!0/g, "true");
  ytCode = ytCode.replace(/!1/g, "false");
  const yt = parseObjectLiteral(ytCode);

  // --- pn: provider groups ---
  const pnIdx = code.indexOf('pn={"command-code"');
  if (pnIdx < 0) throw new Error("Cannot find pn");
  const pnEndIdx = code.indexOf(",__name(buildModelGroups", pnIdx);
  if (pnEndIdx < 0) throw new Error("Cannot find end of pn");
  let pnCode = code.substring(pnIdx + 3, pnEndIdx);
  pnCode = pnCode.replace(/Wt\.([A-Z_]+)/g, (_, key: string) =>
    JSON.stringify(wt[key]),
  );
  pnCode = pnCode.replace(/!0/g, "true");
  pnCode = pnCode.replace(/!1/g, "false");
  pnCode = pnCode.replace(/,\s*$/, "");
  const pn = parseObjectLiteral(pnCode);

  // --- Defaults for fields the CLI doesn't provide per-model ---
  // maxOutputTokens: use the minimum across all providers for each model.
  //   Anthropic direct: 64k    OpenAI direct: 128k
  //   DeepSeek (gateway): 384k (known to work)
  //   Other gateway models (Baseten/Vercel/Cloudflare/OpenRouter): 65536
  const CONTEXT_WINDOW_FALLBACKS: Record<string, number> = {
    "gpt-5.5": 256_000,
    "zai-org/GLM-5.1": 200_000,
    "MiniMaxAI/MiniMax-M2.7": 1_048_576,
    "Qwen/Qwen3.6-Max-Preview": 1_000_000,
    "Qwen/Qwen3.6-Plus": 1_000_000,
  };
  const DEFAULT_CONTEXT_WINDOW = 200_000;

  function maxOutputTokensForModel(id: string, provider: string): number {
    if (provider === "anthropic") return 64_000;
    if (provider === "openai") return 128_000;
    if (id.startsWith("deepseek/")) return 384_000;
    // Gateway models — lowest common denominator across Baseten/Vercel/Cloudflare
    return 65_536;
  }

  // --- Build output ---
  const models: ModelDef[] = [];
  for (const [key, obj] of Object.entries(an)) {
    const m = obj as Record<string, unknown>;
    const id = m.id as string;
    const provider = m.provider as string;
    models.push({
      key,
      id,
      provider,
      spec: (m.spec as string) || "chatComplete",
      label: m.label as string,
      name: m.name as string,
      description: m.description as string,
      reasoning: !!(
        m.reasoning ??
        ((m.reasoningEfforts as string[])?.length ?? 0) > 0
      ),
      reasoningEfforts: (m.reasoningEfforts as string[]) || null,
      contextWindow:
        (typeof m.contextWindow === "number" ? m.contextWindow : null) ??
        CONTEXT_WINDOW_FALLBACKS[id] ??
        DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens:
        maxOutputTokensForModel(id, provider),
      vendorLabel: (m.vendorLabel as string) || null,
    });
  }

  const pricing: PricingEntry[] = [];
  for (const [_provider, entries] of Object.entries(yt)) {
    for (const entry of entries as Array<Record<string, unknown>>) {
      pricing.push({
        provider: entry.provider as string,
        id: entry.id as string,
        category: entry.category as string,
        promptCost: entry.promptCost as number,
        completionCost: entry.completionCost as number,
        cacheWrite5mCost: (entry.cacheWrite5mCost as number) || 0,
        cacheWrite1hCost: (entry.cacheWrite1hCost as number) || 0,
        cacheHitCost: (entry.cacheHitCost as number) || 0,
      });
    }
  }

  const providerGroups: ProviderGroup[] = [];
  for (const [key, obj] of Object.entries(pn)) {
    const g = obj as Record<string, unknown>;
    providerGroups.push({
      id: g.id as string,
      label: g.label as string,
      shortLabel: (g.shortLabel as string) || "",
      description: (g.description as string) || "",
      providers: (g.supportedModelProviders as string[]) || [],
    });
  }

  return { providers: wt, providerGroups, models, pricing };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const distPath = ensureDist(process.argv[2]);
console.log("Reading:", distPath);
const code = readFileSync(distPath, "utf8");
const result = extract(code);

const outPath = join(process.cwd(), "models.json");
writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
console.log(
  `Wrote ${result.models.length} models + ${result.pricing.length} pricing entries to ${outPath}`,
);
