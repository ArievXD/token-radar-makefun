// Token Radar's entrypoint (Node 22, standard library only).
//
// The program reads the sealed snapshot (from /input/snapshot.json, or --input <file|dir>), scores
// every pre-token protocol with the radar-2 model in lib/model.ts, writes the ranked board to
// /output/board.json, writes the dashboard's data beside the page as /output/data.js, and copies this
// repository's dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json, the
// summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board. The page
// recomputes every row's implied value and regenerates its farm plan from the same model, so the
// screenshots and the board's data are visibly the same arithmetic.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// What one run writes, in order. board.json is the ranked board (rows, strongest implied value
// first). data.js is the dashboard's dataset, the same rows in compact form, written beside the
// page so the dashboard needs no network. dashboard/ is this repository's dashboard copied
// whole (index.html, app.css, app.js — at least three files, or the run refuses). screenshots/
// is this repository's screenshots copied whole (three images: the board, a detail view, a
// filtered view, each under the size cap, or the run refuses). dossier.json is written last,
// because the scorer rebuilds it from this /output and compares bytes: anything written after
// it would make the dossier stale. The run prints two lines to stdout — the counts, then the
// list of files written — and nothing else on a normal run.
//
// The run refuses, with a message on stderr and exit code 1, when the snapshot is missing, when
// the model writes a board the gate will not take (boardIssue, then validateBoard), when the
// dashboard or the screenshots are short, when a screenshot's name is not a safe filename, or
// when a screenshot is over the 512 KiB cap. --help prints usage and exits 0 without reading
// anything. The only environment variable the program reads is MAKEFUN_OUTPUT_DIR, which sets
// the output directory when --output is not given.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { validateBoard } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// The caps are the gate's, not the program's: the dossier's text is capped at 64 KiB, the
// screenshots at four images of 512 KiB each, and a screenshot's name must be a safe filename
// (letters, digits and . _ -, 1 to 128 characters, starting with a letter, digit or underscore).
// The program checks them before writing the dossier, because the dossier is built from this
// /output and a file that breaks the cap would make the dossier disagree with the gate.
/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** Refuse with a message and a non-zero exit. */
function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

// --help (or -h) prints usage and exits 0, before anything is read: a reader checking how to
// run the program should not need a snapshot on disk. The usage names every flag, the default
// input and output, and what the run writes, so it is the whole manual in one screen.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'token radar: rank pre-token protocols by implied value\n' +
      'usage: node main.ts --input <snapshot.json|directory> [--output <dir>]\n' +
      '  --input   snapshot file, or a directory holding snapshot.json (default /input)\n' +
      '  --output  where to write board.json, data.js, dashboard/, screenshots/ and dossier.json\n' +
      '            (default /output, or MAKEFUN_OUTPUT_DIR when set)\n' +
      '  --help    print this usage and exit\n' +
      'reads the sealed snapshot, scores every pre-token protocol with the radar-2 model,\n' +
      'writes the ranked board, the dashboard data, copies dashboard/ and screenshots/,\n' +
      'and writes the dossier the judge reads.\n',
  );
  process.exit(0);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

// validateBoard collects every problem, where boardIssue stops at the first: a board that fails
// both is reported in full, so one fix does not hide the next failure behind it. An empty list
// means the board is clean, and the run goes on to write it.
const problems = validateBoard(board, snapshot.watchlist);
if (problems.length > 0) {
  fail(`the model wrote a board the gate refuses:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
if (dashboardFiles.length < 3) fail(`dashboard/ holds ${dashboardFiles.length} files: hand in index.html, app.css and app.js`);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  const size = statSync(join(out, 'screenshots', name)).size;
  if (size > SCREENSHOT_CAPS.max_bytes) fail(`screenshots/${name} is ${size} bytes: the cap is ${SCREENSHOT_CAPS.max_bytes}`);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
// A file written after the dossier would make the dossier stale, and a dossier written before
// the dashboard or the screenshots would describe files that are not there yet. So the order is
// board, data, dashboard, screenshots, dossier — and the dossier is the last write of the run.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashboardFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
