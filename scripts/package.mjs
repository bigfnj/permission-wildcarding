#!/usr/bin/env node
// Build the Permission Wildcarding VSIX reproducibly (used by CI and locally).
//
//   node scripts/package.mjs            # version from vscode-extension/package.json
//   node scripts/package.mjs 1.2.0      # override version (e.g. from a release tag)
//   node scripts/package.mjs v1.2.0     # leading "v" is stripped
//
// Output: permission-wildcarding-<version>.vsix in the repo root.

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'vscode-extension');

// 1. Sync the shared logic (single source of truth lives at repo-root src/).
const extensionSrc = join(ext, 'src');
rmSync(extensionSrc, { recursive: true, force: true });
mkdirSync(extensionSrc, { recursive: true });
for (const entry of readdirSync(join(root, 'src'), { withFileTypes: true })
  .filter((item) => item.isFile() && item.name.endsWith('.js'))
  .sort((left, right) => left.name.localeCompare(right.name))) {
  cpSync(join(root, 'src', entry.name), join(extensionSrc, entry.name));
}

// 1b. Bundle the memory recall script + its vocab, so an installed VSIX resolves
// recall.py without a checkout on disk. The 32MB model stays a download: a versioned
// extension dir would re-fetch it on every upgrade, so the extension keeps it in
// ~/.claude/wildcarding/models instead.
const extMemory = join(ext, 'memory');
rmSync(extMemory, { recursive: true, force: true });
mkdirSync(join(extMemory, 'models'), { recursive: true });
cpSync(join(root, 'memory', 'recall.py'), join(extMemory, 'recall.py'));
cpSync(join(root, 'memory', 'models', 'bge-small.vocab.txt'),
  join(extMemory, 'models', 'bge-small.vocab.txt'));

// 2. Optional version override (release tag).
const override = process.argv[2]?.replace(/^v/, '').trim();
const pkgPath = join(ext, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (override && override !== pkg.version) {
  pkg.version = override;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`version set to ${override}`);
}

// 3. Package.
const out = join(root, `permission-wildcarding-${pkg.version}.vsix`);
execSync(`npx --yes @vscode/vsce package --no-dependencies -o "${out}"`, {
  cwd: ext,
  stdio: 'inherit',
});
console.log(`\nPackaged ${out}`);
