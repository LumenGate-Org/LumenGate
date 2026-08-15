// Single, repo-wide flat config — run via `pnpm lint` (`eslint .`) at the
// root, not per-package. `noUnusedLocals`/`noUnusedParameters` in
// tsconfig.base.json already catch unused-variable cases at the type-check
// step, so this config is deliberately the non-type-checked "recommended"
// preset rather than typescript-eslint's typed/"strict" variants — those
// need a per-package `parserOptions.project` wired up across 5 differently
// -configured packages, real added complexity for a first pass. Tightening
// to typed linting is a reasonable next step, not done here.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/coverage/**",
      "**/*.wasm",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Contract/protocol boundary code sometimes needs a deliberate
      // escape hatch (e.g. parsing an untyped DB row) — already flagged
      // at those exact spots with a targeted inline suppression comment,
      // so this stays "warn" rather than "error": a warning still shows
      // up, but doesn't fail CI for an already-reviewed, intentional case.
      "@typescript-eslint/no-explicit-any": "warn",
      // Matches this codebase's existing convention (and TypeScript's own
      // noUnusedParameters exemption) for a parameter that must exist to
      // satisfy an interface signature but isn't used by a particular
      // implementation — prefixed with `_`, not deleted or worked around.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
