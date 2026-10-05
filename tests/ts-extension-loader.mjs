import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

function isRelativeOrAbsolute(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function hasKnownExtension(specifier) {
  return /\.[cm]?[jt]sx?$/.test(specifier) || /\.json$/.test(specifier) || /\.mjs$/.test(specifier);
}

// `*.spec.ts` files import from `bun:sqlite` and `bun:test`; Node's default ESM
// loader rejects those URLs with a cryptic `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
// Detect `bun:` specifiers here and throw a message that names the right
// runner, so a misrouted command (e.g. `node --test tests/plan-server.spec.ts`
// instead of `bun test tests/plan-server.spec.ts`) fails with a useful error
// instead of the bare URL-scheme stack frame.
function isBunSpecifier(specifier) {
  return /^bun:/i.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  if (isBunSpecifier(specifier)) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : "<entry>";
    const hint = specifier === "bun:test"
      ? "Bun test files (*.spec.ts) must run under `bun test`, not Node. Use `just test-db` or `bun test <file>`."
      : "`bun:sqlite` is only available under Bun. Run this file with `bun test` (see `just test-db`), or import the runtime-agnostic path under Node.";
    throw new Error(
      `Refusing to resolve "${specifier}" from ${parent} under Node. ${hint}`,
    );
  }
  if (isRelativeOrAbsolute(specifier) && !hasKnownExtension(specifier)) {
    const parentDir = context.parentURL?.startsWith("file:") ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const candidatePath = specifier.startsWith("/") ? `${specifier}.ts` : resolvePath(parentDir, `${specifier}.ts`);
    if (existsSync(candidatePath)) {
      return nextResolve(pathToFileURL(candidatePath).href, context);
    }
  }
  return nextResolve(specifier, context);
}
