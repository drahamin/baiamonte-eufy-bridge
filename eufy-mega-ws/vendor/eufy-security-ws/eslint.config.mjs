import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-duplicate-enum-values": "error",
      "no-constant-condition": "error",
      "no-debugger": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  },
);
