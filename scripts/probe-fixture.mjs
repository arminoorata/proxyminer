import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

function parseArgs(argv) {
  const args = {
    context: 220,
    maxBytes: 8 * 1024 * 1024,
    maxMatches: 8,
    regex: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--company") {
      args.company = value;
      i += 1;
    } else if (arg === "--filing") {
      args.filing = value;
      i += 1;
    } else if (arg === "--file") {
      args.file = value;
      i += 1;
    } else if (arg === "--pattern") {
      args.pattern = value;
      i += 1;
    } else if (arg === "--context") {
      args.context = parsePositiveInt(value, args.context);
      i += 1;
    } else if (arg === "--max-matches") {
      args.maxMatches = parsePositiveInt(value, args.maxMatches);
      i += 1;
    } else if (arg === "--max-bytes") {
      args.maxBytes = parsePositiveInt(value, args.maxBytes);
      i += 1;
    } else if (arg === "--regex") {
      args.regex = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage() {
  console.log(`Usage:
  npm run probe:fixture -- --file .fixtures/by-filing/crm/000110852425000009/source.html --pattern "CEO Pay Ratio"
  npm run probe:fixture -- --company crm --filing 000110852425000009 --pattern "CEO Pay Ratio"

Options:
  --pattern <text>       Literal text by default. Add --regex to treat it as a RegExp.
  --context <chars>      Characters around each match. Default: 220.
  --max-matches <n>      Max snippets to print. Default: 8.
  --max-bytes <n>        Refuse larger source files. Default: 8388608.
`);
}

function resolveFixturePath(args) {
  if (args.file) return args.file;
  if (!args.company || !args.filing) {
    throw new Error("Provide --file or both --company and --filing.");
  }
  return join(FIXTURES_ROOT, args.company, args.filing, "source.html");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSnippet(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pattern) {
    printUsage();
    throw new Error("Missing --pattern.");
  }

  const filePath = resolveFixturePath(args);
  if (!existsSync(filePath)) {
    throw new Error(`Missing fixture file: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size > args.maxBytes) {
    throw new Error(`Refusing to read ${filePath}: ${stat.size} bytes exceeds --max-bytes ${args.maxBytes}.`);
  }

  const source = readFileSync(filePath, "utf8");
  const pattern = args.regex ? args.pattern : escapeRegExp(args.pattern);
  const re = new RegExp(pattern, "giu");
  let count = 0;
  let match = null;
  while ((match = re.exec(source)) && count < args.maxMatches) {
    const start = Math.max(0, match.index - args.context);
    const end = Math.min(source.length, match.index + match[0].length + args.context);
    count += 1;
    console.log(`--- match ${count} @ ${match.index} ---`);
    console.log(normalizeSnippet(source.slice(start, end)));
    if (match[0].length === 0) re.lastIndex += 1;
  }
  if (count === 0) {
    console.log("No matches.");
  }
}

main();
