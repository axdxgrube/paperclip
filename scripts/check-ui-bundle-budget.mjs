#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_CHUNK_BUDGETS = [
  {
    label: "App shell chunk",
    pattern: /^index-.*\.js$/,
    maxBytes: 2_150_000,
  },
  {
    label: "Mermaid core chunk",
    pattern: /^mermaid\.core-.*\.js$/,
    maxBytes: 550_000,
  },
  {
    label: "Treemap chunk",
    pattern: /^treemap-.*\.js$/,
    maxBytes: 500_000,
  },
  {
    label: "Cytoscape chunk",
    pattern: /^cytoscape\.esm-.*\.js$/,
    maxBytes: 490_000,
  },
  {
    label: "KaTeX chunk",
    pattern: /^katex-.*\.js$/,
    maxBytes: 290_000,
  },
  {
    label: "Main stylesheet",
    pattern: /^index-.*\.css$/,
    maxBytes: 260_000,
  },
];

const AGGREGATE_BUDGETS = [
  {
    label: "Total JS assets",
    maxBytes: 7_800_000,
    measure(files) {
      return files
        .filter((file) => file.name.endsWith(".js"))
        .reduce((sum, file) => sum + file.size, 0);
    },
  },
  {
    label: "Largest JS asset",
    maxBytes: 2_150_000,
    measure(files) {
      return files
        .filter((file) => file.name.endsWith(".js"))
        .reduce((max, file) => Math.max(max, file.size), 0);
    },
  },
];

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function deltaText(actual, maxBytes) {
  const delta = actual - maxBytes;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatBytes(delta)} (${sign}${((delta / maxBytes) * 100).toFixed(2)}%)`;
}

function loadAssetSizes(distAssetsDir) {
  return readdirSync(distAssetsDir).map((name) => ({
    name,
    size: statSync(resolve(distAssetsDir, name)).size,
  }));
}

function resolveRepoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function run() {
  const repoRoot = resolveRepoRoot();
  const distAssetsDir = resolve(repoRoot, "ui", "dist", "assets");
  if (!existsSync(distAssetsDir)) {
    console.error(`Missing build output at ${distAssetsDir}. Run: pnpm --filter @paperclipai/ui build`);
    process.exit(1);
  }
  const files = loadAssetSizes(distAssetsDir);

  let hasError = false;

  console.log("UI bundle budget report");
  console.log(`- Dist assets: ${distAssetsDir}`);

  for (const budget of REQUIRED_CHUNK_BUDGETS) {
    const matches = files.filter((file) => budget.pattern.test(file.name));
    if (matches.length === 0) {
      hasError = true;
      console.error(`✗ ${budget.label}: no asset matched ${budget.pattern}`);
      continue;
    }
    const largestMatch = matches.reduce((max, file) => (file.size > max.size ? file : max), matches[0]);
    const ok = largestMatch.size <= budget.maxBytes;
    const status = ok ? "✓" : "✗";
    const line =
      `${status} ${budget.label}: ${largestMatch.name} ` +
      `${formatBytes(largestMatch.size)} / limit ${formatBytes(budget.maxBytes)} ` +
      `(${deltaText(largestMatch.size, budget.maxBytes)})`;
    if (ok) {
      console.log(line);
    } else {
      hasError = true;
      console.error(line);
    }
  }

  for (const budget of AGGREGATE_BUDGETS) {
    const value = budget.measure(files);
    const ok = value <= budget.maxBytes;
    const status = ok ? "✓" : "✗";
    const line =
      `${status} ${budget.label}: ${formatBytes(value)} / limit ${formatBytes(budget.maxBytes)} ` +
      `(${deltaText(value, budget.maxBytes)})`;
    if (ok) {
      console.log(line);
    } else {
      hasError = true;
      console.error(line);
    }
  }

  if (hasError) {
    console.error("\nBundle budget check failed. Reduce bundle size or update the explicit budget thresholds.");
    process.exit(1);
  }

  console.log("\nAll bundle budgets passed.");
}

run();
