import { existsSync } from "node:fs";
import { readdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function prependEnvPath(name: "DYLD_LIBRARY_PATH" | "DYLD_FALLBACK_LIBRARY_PATH", entry: string): void {
  const existing = process.env[name];
  const parts = existing?.split(":").filter((part) => part.length > 0) ?? [];
  if (parts.includes(entry)) return;
  process.env[name] = [entry, ...parts].join(":");
}

async function ensureDarwinEmbeddedPostgresRuntime(): Promise<void> {
  if (process.platform !== "darwin") return;

  let packageEntryPath: string;
  try {
    packageEntryPath = require.resolve("@embedded-postgres/darwin-arm64");
  } catch {
    return;
  }

  const nativeLibDir = path.resolve(path.dirname(packageEntryPath), "../native/lib");
  prependEnvPath("DYLD_LIBRARY_PATH", nativeLibDir);
  prependEnvPath("DYLD_FALLBACK_LIBRARY_PATH", nativeLibDir);
  const entries = await readdir(nativeLibDir);
  for (const entry of entries) {
    const match = /^(.+?)(\.\d+(?:\.\d+)*)\.dylib$/.exec(entry);
    if (!match) continue;

    const stem = match[1];
    const versionParts = match[2].slice(1).split(".");
    const aliasNames = new Set<string>([`${stem}.dylib`]);
    if (versionParts.length > 0) {
      aliasNames.add(`${stem}.${versionParts[0]}.dylib`);
    }

    for (const aliasName of aliasNames) {
      const aliasPath = path.join(nativeLibDir, aliasName);
      if (aliasName === entry || existsSync(aliasPath)) continue;

      // Some vendored dylibs only ship a fully qualified soname like
      // `libzstd.1.5.7.dylib`, while their peers load either the
      // major-version alias or the unversioned filename.
      await symlink(entry, aliasPath);
    }
  }
}

export async function prepareEmbeddedPostgresRuntime(): Promise<void> {
  await ensureDarwinEmbeddedPostgresRuntime();
}
