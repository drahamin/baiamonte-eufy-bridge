import { createRequire } from "module";

const require = createRequire(import.meta.url);

export { EufySecurityServer } from "./server.js";
export * from "./state.js";
export * from "./driver/state.js";
export * from "./station/state.js";
export * from "./device/state.js";

export const serverVersion: string = require("../../package.json").version;
