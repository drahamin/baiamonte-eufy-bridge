import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const buildRoot = fileURLToPath(new URL("../build/", import.meta.url));
const copiedExtensions = new Set([".crt", ".proto"]);

async function copyAssets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) {
      await copyAssets(source);
      continue;
    }
    if (!entry.isFile() || !copiedExtensions.has(extname(entry.name))) continue;

    const destination = join(buildRoot, relative(sourceRoot, source));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

await copyAssets(sourceRoot);
