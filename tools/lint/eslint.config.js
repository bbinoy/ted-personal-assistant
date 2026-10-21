// ESLint, focused: the promise rules that catch real bugs in an async codebase (a forgotten await is a silent failure) plus ESLint's
// recommended basics. No style rules and no formatter: the compiler (`npx tsc`) already owns types and unused names.
// Run from the repository root with `npm run lint`; type information comes from the root tsconfig.json.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default tseslint.config(
  { ignores: [".claude/**", "**/node_modules/**", "tools/**", "scripts/**","state/**", "logs/**", "memory/**", "dist/**", "**/dist/**"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: "./tsconfig.json", tsconfigRootDir: root } },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // node:test's test/describe/it return a promise the runner owns; nobody awaits them
      "@typescript-eslint/no-floating-promises": ["error", { allowForKnownSafeCalls: ["test", "describe", "it", "suite", "before", "after", "beforeEach", "afterEach"].map((name) => ({ from: "package", package: "node:test", name })) }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }], // (a promise handed to a void callback is the house style for handlers that catch inside)
      "@typescript-eslint/await-thenable": "error",
      // The compiler checks these (noUnusedLocals in CONTRIBUTING, and TypeScript knows globals and types); the core rules only add false hits.
      "no-undef": "off",
      "no-unused-vars": "off",
      // Deliberate here (sanitisers match control and odd characters on purpose, empty test generators, regexes kept as written); not worth the churn.
      "no-control-regex": "off", "no-irregular-whitespace": "off", "no-misleading-character-class": "off", "no-useless-backreference": "off",
      "no-regex-spaces": "off", "no-useless-escape": "off", "require-yield": "off", "no-loss-of-precision": "off", "no-useless-assignment": "off", "preserve-caught-error": "off",
    },
  },
);
