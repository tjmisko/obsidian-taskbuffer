import { defineConfig } from "vitest/config";

// Unit tests cover the pure-logic modules (parse, frontmatter, horizon, render).
// These modules must NOT import "obsidian" so they run under Node without a stub.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
