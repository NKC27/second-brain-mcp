/**
 * Runs the skill's behavioural scenarios against a real Claude session, with and without the skill installed.
 *
 *   npm run eval:skill                 all scenarios, skill vs control
 *   npm run eval:skill -- --only ambiguous-todo --model opus
 *   npm run eval:skill -- --no-control --keep
 *   npm run eval:skill -- --variant lite=skill/second-brain --variant pro=../second-brain-skill-pro/second-brain-pro
 *
 * Each run uses a throwaway vault and a strict MCP config, so nothing here touches your real notes.
 * Requires the `claude` CLI to be logged in, and `npm run build` to have been run.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scenarios, type Scenario, type VaultFiles } from "../skill/evals/scenarios.js";
import { parseTranscript, type Transcript } from "../skill/evals/transcript.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const model = option("--model") ?? "sonnet";
const only = option("--only");
const withControl = !args.includes("--no-control");

/** Skill variants to compare: repeat `--variant label=path`; defaults to the public skill. */
const variants: { label: string; dir: string }[] = args
  .flatMap((a, i) => (a === "--variant" && args[i + 1] ? [args[i + 1]!] : []))
  .map((spec) => {
    const [label, dir] = spec.split("=");
    if (!label || !dir) throw new Error(`--variant expects label=path, got "${spec}"`);
    return { label, dir: path.resolve(dir) };
  });
if (variants.length === 0) variants.push({ label: "skill", dir: path.join(root, "skill", "second-brain") });
const keep = args.includes("--keep");
const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const timeoutMs = Number(option("--timeout") ?? 240) * 1000;

type Mode = string;

interface Outcome {
  mode: Mode;
  failures: string[];
  /** The session itself failed (login expired, CLI missing); the model was never really tested. */
  sessionError?: string;
  dir: string;
}

async function snapshot(vaultDir: string): Promise<VaultFiles> {
  const files: VaultFiles = new Map();
  for (const sub of ["notes", "journal"]) {
    const names = await fs.readdir(path.join(vaultDir, sub)).catch(() => [] as string[]);
    for (const name of names) {
      files.set(`${sub}/${name}`, await fs.readFile(path.join(vaultDir, sub, name), "utf-8"));
    }
  }
  return files;
}

function runClaude(prompt: string, cwd: string, mcpConfig: string): Promise<string> {
  const cliArgs = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--model",
    model,
    "--allowedTools",
    "mcp__second-brain__*",
    "Skill",
    "Read",
  ];
  return new Promise((resolve) => {
    execFile(claudeBin, cliArgs, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => {
      // A non-zero exit still leaves useful events on stdout; fall back to stderr when there are none.
      resolve(stdout || JSON.stringify({ type: "result", is_error: true, result: stderr || "no output from claude" }));
    });
  });
}

async function runOne(s: Scenario, mode: Mode): Promise<Outcome> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sb-eval-${s.id}-${mode}-`));
  const vaultDir = path.join(dir, "vault");
  const project = path.join(dir, "project");
  await fs.mkdir(path.join(vaultDir, "notes"), { recursive: true });
  await fs.mkdir(path.join(vaultDir, "journal"), { recursive: true });
  await fs.mkdir(project, { recursive: true });

  for (const [rel, text] of Object.entries(s.seed)) await fs.writeFile(path.join(vaultDir, rel), text);
  const variant = variants.find((v) => v.label === mode);
  if (variant) {
    const dest = path.join(project, ".claude", "skills", path.basename(variant.dir));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(variant.dir, dest, { recursive: true });
  }

  const mcpConfig = path.join(dir, "mcp.json");
  await fs.writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        "second-brain": {
          command: process.execPath,
          args: [path.join(root, "dist", "index.js")],
          env: { VAULT_PATH: vaultDir },
        },
      },
    })
  );

  const transcript: Transcript = parseTranscript(await runClaude(s.prompt, project, mcpConfig));
  const outcome: Outcome = { mode, failures: [], dir };
  if (transcript.failed) outcome.sessionError = transcript.failed;
  else outcome.failures = s.check(transcript, await snapshot(vaultDir));

  if (!keep) await fs.rm(dir, { recursive: true, force: true });
  return outcome;
}

async function main(): Promise<number> {
  await fs.access(path.join(root, "dist", "index.js")).catch(() => {
    throw new Error("dist/index.js not found. Run `npm run build` first.");
  });

  const selected = scenarios.filter((s) => !only || s.id === only);
  if (selected.length === 0)
    throw new Error(`No scenario called "${only}". Available: ${scenarios.map((s) => s.id).join(", ")}`);
  const modes: Mode[] = [...variants.map((v) => v.label), ...(withControl ? ["control"] : [])];

  console.log(`Model: ${model}   Scenarios: ${selected.length}   Modes: ${modes.join(", ")}\n`);

  const tally: Record<Mode, { pass: number; total: number }> = Object.fromEntries(
    modes.map((m) => [m, { pass: 0, total: 0 }])
  );
  let sessionErrors = 0;

  for (const s of selected) {
    console.log(`${s.id}\n  expect: ${s.expect}`);
    for (const mode of modes) {
      const out = await runOne(s, mode);
      const label = mode.padEnd(10);
      if (out.sessionError) {
        sessionErrors++;
        console.log(`  ${label} COULD NOT RUN: ${out.sessionError}`);
      } else {
        tally[mode].total++;
        if (out.failures.length === 0) {
          tally[mode].pass++;
          console.log(`  ${label} pass`);
        } else {
          console.log(`  ${label} FAIL`);
          for (const f of out.failures) console.log(`            - ${f}`);
        }
      }
      if (keep) console.log(`            kept: ${out.dir}`);
    }
    console.log();
  }

  if (sessionErrors > 0) {
    console.log(
      `${sessionErrors} run(s) could not start, so this is not a result. If the message mentions authentication, run \`claude\` once interactively to log in.`
    );
    return 2;
  }
  for (const mode of modes) console.log(`${mode.padEnd(10)} passed ${tally[mode].pass}/${tally[mode].total}`);
  // The control is expected to do worse; only the skill variants decide the exit code.
  return variants.every((v) => tally[v.label]!.pass === tally[v.label]!.total) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
);
