// deploy.mjs — copy the built plugin into the local Obsidian vault, where
// Obsidian Sync ("Installed community plugins") propagates it to other devices,
// including mobile. Override the vault with OBSIDIAN_VAULT=/path/to/vault.
import { access, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const vault = process.env.OBSIDIAN_VAULT ?? join(homedir(), "Notes");
const dest = join(vault, ".obsidian", "plugins", "taskbuffer");

try {
	await access("main.js");
} catch {
	console.error("main.js not found — run `npm run deploy` (it builds first).");
	process.exit(1);
}

// Obsidian Sync does not sync symlinked plugin folders (and a repo symlink
// would make "deploy" copy files onto themselves), so insist on a real dir.
const existing = await lstat(dest).catch(() => null);
if (existing?.isSymbolicLink()) {
	await rm(dest);
	console.log(`Replaced symlink ${dest} with a real directory (Obsidian Sync skips symlinks).`);
}

await mkdir(dest, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	await copyFile(file, join(dest, file));
}
console.log(`Deployed main.js, manifest.json, styles.css → ${dest}`);
