// Shields.io endpoint badges from what CI measured on this commit.
//
// Usage (CI runs it after the tests; see .github/workflows/ci.yml):
//   node scripts/badges.mjs --out <dir> --tests <log of `pnpm test`>
//
// Each badge is one JSON file, {"schemaVersion":1,"label","message","color"},
// which CI commits to the `badges` branch for img.shields.io/endpoint to
// read. A value that cannot be read, or a run that did not pass, stops the
// script with an error: a badge is never written from a guess. No
// dependencies: Node 18 or later.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

class BadgeError extends Error {}
const fail = (message) => {
  throw new BadgeError(message);
};

const read = (path) => {
  try {
    return readFileSync(path);
  } catch (e) {
    return fail(`cannot read ${path}: ${e.message}`);
  }
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const SUMMARY = (name) => new RegExp(`^\\s*${name}\\s+(.+?)\\s+\\((\\d+)\\)\\s*$`);

/** The counts on one Vitest summary line ("Test Files" or "Tests"); there
 * must be exactly one, and its parts must add up to its total. */
function vitestLine(lines, name, kinds) {
  const re = SUMMARY(name);
  const found = lines.filter((l) => re.test(l));
  if (found.length !== 1) fail(`expected one Vitest "${name}" summary in the test log, found ${found.length}`);
  const [, parts, total] = re.exec(found[0]);
  const counts = Object.fromEntries(kinds.map((k) => [k, 0]));
  for (const part of parts.split("|")) {
    const p = new RegExp(`^\\s*(\\d+) (${kinds.join("|")})\\s*$`).exec(part);
    if (!p) fail(`unrecognised Vitest summary: "${found[0].trim()}"`);
    counts[p[2]] += Number(p[1]);
  }
  if (Object.values(counts).reduce((a, b) => a + b, 0) !== Number(total)) fail(`Vitest summary does not add up: "${found[0].trim()}"`);
  return counts;
}

/** Counts from the one Vitest summary in the output of `pnpm test`. A test
 * file that failed to load counts as a failure even when no test in it
 * ran. */
export function parseVitest(text) {
  const lines = text.replace(ANSI, "").split(/\r?\n/);
  const files = vitestLine(lines, "Test Files", ["passed", "failed", "skipped"]);
  if (files.failed > 0) fail(`${files.failed} test file(s) failed`);
  const counts = vitestLine(lines, "Tests", ["passed", "failed", "skipped", "todo"]);
  if (counts.failed > 0) fail(`${counts.failed} test(s) failed`);
  if (counts.passed === 0) fail("no test passed");
  return { passed: counts.passed, skipped: counts.skipped + counts.todo };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) fail(`expected --name value pairs, got "${argv.slice(i).join(" ")}"`);
    args[key] = argv[i + 1];
  }
  for (const key of ["out", "tests"]) if (!args[key]) fail(`--${key} is required`);
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const tests = parseVitest(read(args.tests).toString("utf8"));
    const badges = {
      tests: { label: "tests", message: `${tests.passed} passed${tests.skipped ? `, ${tests.skipped} skipped` : ""}`, color: "brightgreen" },
    };
    mkdirSync(args.out, { recursive: true });
    for (const [name, { label, message, color }] of Object.entries(badges)) {
      const json = `${JSON.stringify({ schemaVersion: 1, label, message, color })}\n`;
      writeFileSync(join(args.out, `${name}.json`), json);
      process.stdout.write(`${name}.json ${json}`);
    }
  } catch (e) {
    if (!(e instanceof BadgeError)) throw e;
    console.error(`badges: ${e.message}`);
    process.exit(1);
  }
}
