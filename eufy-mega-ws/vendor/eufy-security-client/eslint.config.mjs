import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["build/**", "coverage/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
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
      "no-fallthrough": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  }
);
