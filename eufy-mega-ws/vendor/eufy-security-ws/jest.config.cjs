/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        diagnostics: false,
        tsconfig: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "node",
        },
      },
    ],
  },
};
