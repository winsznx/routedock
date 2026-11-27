import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github/workflows/e2e.yml'), 'utf8');
const providerStep = workflow.split('      - name: Start Providers\n')[1].split('\n      - name:')[0];
const shell = providerStep.split('        run: |\n')[1].split('\n').map((line) => line.slice(10)).join('\n');
const fixtureSecrets = {
  AGENT_SECRET: 'AGENT-[literal].*-$VALUE',
  COMMITMENT_SECRET: 'COMMITMENT-first\r\nCOMMITMENT-last',
  E2E_PAYEE_SECRET: 'PAYEE-"quoted"-\\-secret',
};

function temporaryDirectory(t, beforeRemove = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'routedock-e2e-logs-'));
  t.after(() => {
    beforeRemove(directory);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function assertSanitized(text, secrets = fixtureSecrets) {
  for (const value of Object.values(secrets).filter(Boolean)) {
    for (const part of [value, value.replaceAll('\r\n', '\n'), ...value.split(/\r?\n/)]) {
      if (!part) continue;
      assert.equal(text.includes(part), false, 'raw secret must not be present');
      assert.equal(text.includes(JSON.stringify(part).slice(1, -1)), false, 'quoted secret must not be present');
    }
  }
}

// Fake only the external services. The shell, traps, process groups, sanitizer and files are real.
function runWorkflow(t, scenario, secrets = fixtureSecrets) {
  const directory = temporaryDirectory(t, (directory) => {
    for (const provider of ['provider-a', 'provider-b']) {
      if (!existsSync(join(directory, `${provider}.pids`))) continue;
      for (const pid of readFileSync(join(directory, `${provider}.pids`), 'utf8').split('\n').map(Number)) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
  });
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const fakeCommand = `#!${process.execPath}
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const dir = process.env.RUNNER_TEMP;
const scenario = process.env.SCENARIO;
  if (args[1] === '@routedock/routedock') {
    if (scenario === 'setup') process.exit(19);
    console.log('PUBLIC_KEY');
  } else if (args[1].startsWith('provider-')) {
    const provider = args[1];
    process.on('SIGTERM', () => {
      console.log(provider + ' stopped cleanly');
      process.exit(0);
    });
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    writeFileSync(join(dir, provider + '.pids'), process.pid + '\\n' + child.pid);
    await once(child, 'message');
    console.log(provider + ' startup diagnostic');
    for (let line = 0; line < 205; line++) console.log('filler ' + line);
    console.log(args.join(' '));
    console.log('env.STELLAR_PAYEE_SECRET (' + JSON.stringify(process.env.STELLAR_PAYEE_SECRET) + ')');
    for (const key of ['AGENT_SECRET', 'COMMITMENT_SECRET', 'E2E_PAYEE_SECRET']) {
      console.log(process.env[key]);
      console.log(JSON.stringify(process.env[key]));
    }
    console.log(provider + ' MPP charge failed: HTTP 402');
    console.error(provider + ' stderr diagnostic');
    console.log('::error::untrusted provider output');
    writeFileSync(join(dir, provider + '.ready'), 'ready');
    if (scenario === 'exited') process.exit(23);
    setInterval(() => {}, 1000);
  } else if (args[1] === 'agent') {
    if (scenario === 'sanitizer-error') {
      const { mkdirSync, rmSync } = await import('node:fs');
      rmSync(join(dir, 'provider-b.log'));
      mkdirSync(join(dir, 'provider-b.log'));
    }
    if (scenario === 'signal') process.kill(process.ppid, 'SIGTERM');
    process.exit(scenario === 'success' ? 0 : 42);
  } else process.exit(99);
`;
  writeFileSync(join(bin, 'pnpm'), fakeCommand, { mode: 0o700 });
  const shellCommands = {
    curl: `
      url="\${@: -1}"
      if [[ "$url" == */health ]]; then
        for ((attempt=0; attempt<1000; attempt++)); do
          [[ -f "$RUNNER_TEMP/provider-a.ready" && -f "$RUNNER_TEMP/provider-b.ready" ]] && break
          /usr/bin/sleep 0.005
        done
        [[ "$SCENARIO" == health ]] && exit 22
      else
        [[ "$SCENARIO" == manifest && "$url" == *:8802* ]] && exit 22
        echo '{"signature":"signature"}'
      fi
      exit 0
    `,
    jq: `cat >/dev/null; [[ "$SCENARIO" != signature ]]`,
    sleep: `if [[ "$1" == 1 ]]; then exec /usr/bin/sleep 0.1; else exec /usr/bin/sleep 0.001; fi`,
    // Exercise the actual timeout branch without a two-minute wait.
    seq: `if [[ "$SCENARIO" == health ]]; then echo 60; else echo 1; fi`,
  };
  for (const [command, source] of Object.entries(shellCommands)) {
    writeFileSync(join(bin, command), `#!/usr/bin/env bash\n${source}\n`, { mode: 0o700 });
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
    cwd: root,
    env: { ...process.env, AGENT_SECRET: '', COMMITMENT_SECRET: '', E2E_PAYEE_SECRET: '', STELLAR_PAYEE_SECRET: '', ...secrets, RUNNER_TEMP: directory, SCENARIO: scenario, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, 'workflow must finish without timing out');
  return { ...result, directory, output: result.stdout + result.stderr };
}

const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));

function assertProvidersStopped(directory, { readProcStat = readFileSync, timeoutMs = 500 } = {}) {
  for (const provider of ['provider-a', 'provider-b']) {
    for (const pid of readFileSync(join(directory, `${provider}.pids`), 'utf8').split('\n')) {
      if (!pid) continue;
      // An orphan may briefly remain in kernel teardown (R/S/D after SIGKILL) or as a
      // zombie (Z) until init reaps it. Read once per check and treat ENOENT (reaped
      // before open) or ESRCH (reaped between open and read in Linux procfs) as gone (#724).
      const deadline = Date.now() + timeoutMs;
      while (true) {
        let content;
        try {
          content = readProcStat(`/proc/${pid}/stat`, 'utf8');
        } catch (error) {
          if (error && (error.code === 'ENOENT' || error.code === 'ESRCH')) break;
          throw error;
        }
        if (/^\d+ \(.+\) Z /.test(content)) break;
        if (Date.now() >= deadline) {
          assert.match(content, /^\d+ \(.+\) Z /);
        }
        Atomics.wait(pauseBuffer, 0, 0, 10);
      }
    }
  }
}

test('assertProvidersStopped treats ENOENT and ESRCH as reaped, tolerates brief teardown, accepts zombies, rejects running processes, and rethrows other errors', (t) => {
  // #given: synthetic provider PID files in a temporary directory.
  const directory = temporaryDirectory(t);
  writeFileSync(join(directory, 'provider-a.pids'), '1001\n1002');
  writeFileSync(join(directory, 'provider-b.pids'), '2001\n2002');

  // #when / #then: ENOENT (reaped before open) and ESRCH (reaped between open and read) succeed.
  for (const code of ['ENOENT', 'ESRCH']) {
    assert.doesNotThrow(() =>
      assertProvidersStopped(directory, {
        timeoutMs: 0,
        readProcStat: (procPath) => {
          const err = Object.assign(new Error(`${code}: process vanished for '${procPath}'`), { code });
          throw err;
        },
      }),
    );
  }

  // #when / #then: zombie state passes.
  assert.doesNotThrow(() =>
    assertProvidersStopped(directory, {
      timeoutMs: 0,
      readProcStat: (procPath) => `${procPath.split('/')[2]} (node) Z 1 1 1 0 -1 0\n`,
    }),
  );

  // #when / #then: a process briefly finishing SIGKILL teardown transitions from R to ENOENT and passes.
  const seen = new Set();
  assert.doesNotThrow(() =>
    assertProvidersStopped(directory, {
      timeoutMs: 200,
      readProcStat: (procPath) => {
        if (!seen.has(procPath)) {
          seen.add(procPath);
          return `${procPath.split('/')[2]} (node) R 1 1 1 0 -1 0\n`;
        }
        throw Object.assign(new Error(`ENOENT: reaped '${procPath}'`), { code: 'ENOENT' });
      },
    }),
  );

  // #when / #then: a process that stays running fails the assertion.
  assert.throws(
    () =>
      assertProvidersStopped(directory, {
        timeoutMs: 0,
        readProcStat: (procPath) => `${procPath.split('/')[2]} (node) S 1 1 1 0 -1 0\n`,
      }),
    assert.AssertionError,
  );

  // #when / #then: unexpected filesystem errors are not swallowed.
  assert.throws(
    () =>
      assertProvidersStopped(directory, {
        timeoutMs: 0,
        readProcStat: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      }),
    { code: 'EACCES' },
  );
});

test('secret absence assertions reject known raw log fixtures', () => {
  // #given / #when / #then: positive controls keep an absence check from silently passing.
  for (const value of Object.values(fixtureSecrets)) {
    assert.throws(() => assertSanitized(value));
    assert.throws(() => assertSanitized(JSON.stringify(value)));
  }
});

for (const [scenario, status] of [['test', 42], ['health', 1], ['manifest', 22], ['signature', 1], ['exited', 42], ['signal', 143]]) {
  test(`${scenario} failure preserves status, prints both sanitized tails and retains full sanitized artifacts`, (t) => {
    // #given: real workflow logic with synthetic provider secrets and a failing external command.
    const result = runWorkflow(t, scenario);
    // #when: the shell exits through its real EXIT trap.
    assert.equal(result.status, status);
    assertSanitized(result.output);
    // #then: both streams are useful, shutdown completes and only sanitized files survive.
    for (const provider of ['provider-a', 'provider-b']) {
      const log = readFileSync(join(result.directory, 'e2e-provider-logs', `${provider}.log`), 'utf8');
      assertSanitized(log);
      assert.match(log, new RegExp(`${provider} startup diagnostic`));
      assert.equal(result.output.includes(`${provider} startup diagnostic`), false, 'console is tailed');
      assert.match(result.output, new RegExp(`${provider} MPP charge failed: HTTP 402`));
      assert.match(result.output, new RegExp(`${provider} stderr diagnostic`));
      assert.match(result.output, /\| ::error::untrusted provider output/);
      assert.equal(existsSync(join(result.directory, `${provider}.log`)), false);
      if (scenario !== 'exited') assert.match(log, new RegExp(`${provider} stopped cleanly`));
    }
    assertProvidersStopped(result.directory);
  });
}

test('success adds no provider diagnostics or artifacts and cleans up descendants', (t) => {
  // #given / #when: both providers and tests succeed.
  const result = runWorkflow(t, 'success');
  // #then: ordinary passing runs stay quiet.
  assert.equal(result.status, 0);
  assert.equal(result.output, '');
  assert.equal(existsSync(join(result.directory, 'e2e-provider-logs')), false);
  assertProvidersStopped(result.directory);
});

test('setup failure before provider launch preserves its status without unbound PID errors', (t) => {
  // #given / #when: key derivation fails before either provider exists.
  const result = runWorkflow(t, 'setup');
  // #then: cleanup tolerates no PIDs, and both empty logs are still available.
  assert.equal(result.status, 19);
  assertSanitized(result.output);
  assert.doesNotMatch(result.output, /unbound variable/);
  assert.deepEqual(readdirSync(join(result.directory, 'e2e-provider-logs')).sort(), ['provider-a.log', 'provider-b.log']);
});

test('sanitizer errors fail closed and do not replace the original failure or prevent cleanup', (t) => {
  // #given / #when: an unreadable raw log causes sanitizer preparation to fail.
  const result = runWorkflow(t, 'sanitizer-error');
  // #then: no raw fallback is printed or uploaded.
  assert.equal(result.status, 42);
  assertSanitized(result.output);
  assert.match(result.output, /Unable to prepare sanitized provider logs/);
  assert.equal(existsSync(join(result.directory, 'e2e-provider-logs')), false);
  assertProvidersStopped(result.directory);
});

function collectLogs(t, logs, secrets) {
  const directory = temporaryDirectory(t);
  for (const [provider, log] of Object.entries(logs)) writeFileSync(join(directory, `${provider}.log`), log);
  const result = spawnSync(process.execPath, ['scripts/e2e-provider-logs.mjs'], {
    cwd: root,
    env: { ...process.env, AGENT_SECRET: '', COMMITMENT_SECRET: '', E2E_PAYEE_SECRET: '', STELLAR_PAYEE_SECRET: '', ...secrets, RUNNER_TEMP: directory },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  return { directory, output: result.stdout + result.stderr };
}

test('overlapping secret values are removed as one range without leaving a suffix', (t) => {
  // #given: prefix and partial overlaps, plus an independent payee alias.
  const secrets = { AGENT_SECRET: 'ABCDEF', COMMITMENT_SECRET: 'DEFGHI', E2E_PAYEE_SECRET: 'ABC', STELLAR_PAYEE_SECRET: 'ALIAS' };
  // #when: the same input contains all overlaps.
  const result = collectLogs(t, { 'provider-a': 'before ABCDEFGHI after ALIAS\n' }, secrets);
  // #then: no matched byte survives, and missing provider logs are explained.
  assert.equal(readFileSync(join(result.directory, 'e2e-provider-logs/provider-a.log'), 'utf8'), 'before [REDACTED] after [REDACTED]\n');
  assert.match(result.output, /Provider log was not created/);
});

test('empty secrets leave useful output intact', (t) => {
  // #given / #when: no credentials are configured.
  const result = collectLogs(t, { 'provider-a': 'useful diagnosis\n' }, {});
  // #then: an empty replacement pattern does not corrupt the artifact.
  assert.equal(readFileSync(join(result.directory, 'e2e-provider-logs/provider-a.log'), 'utf8'), 'useful diagnosis\n');
});

test('Wrangler truncated and wrapped binding previews do not expose secret prefixes', (t) => {
  // #given: printBindings quotes plain text, truncates at 37 + "...", and wraps in narrow terminals.
  const value = 'SYNTHETIC-"quoted"-\\-PAYEE-SECRET-'.repeat(3);
  const secrets = { E2E_PAYEE_SECRET: value, COMMITMENT_SECRET: `multiline\n${value}` };
  const previews = [value, JSON.stringify(value), JSON.stringify(value).slice(1, -1), secrets.COMMITMENT_SECRET]
    .map((rendered) => `${rendered.slice(0, 37)}...`);
  const raw = previews.map((preview) => `env.STELLAR_PAYEE_SECRET ("${preview}")\nenv.STELLAR_PAYEE_SECRET    Variable    local\n  "${preview}"\n`).join('');
  // #when: all preview forms pass through the actual sanitizer.
  const result = collectLogs(t, { 'provider-a': raw }, secrets);
  // #then: both console and artifact contents remove even partial credentials.
  const artifact = readFileSync(join(result.directory, 'e2e-provider-logs/provider-a.log'), 'utf8');
  for (const preview of previews) {
    assert.equal(result.output.includes(preview), false);
    assert.equal(artifact.includes(preview), false);
  }
  assert.doesNotMatch(artifact, /SYNTHETIC|multiline/);
});

test('redaction precedes line and character tail bounds and removes terminal styling', (t) => {
  // #given: one secret straddles the 200-line tail and another is inside a very long styled line.
  const secrets = { AGENT_SECRET: 'first-secret\nlast-secret', E2E_PAYEE_SECRET: 'COLORED_SECRET' };
  const longLog = `first-secret\nlast-secret\n${'filler\n'.repeat(199)}${'x'.repeat(40000)}COLORED_\u001b[31mSECRET\u001b[0m\n`;
  // #when: the complete log is sanitized before selecting console output.
  const result = collectLogs(t, { 'provider-a': longLog }, secrets);
  // #then: the full artifact and bounded tail both omit the secrets.
  assertSanitized(result.output, secrets);
  assertSanitized(readFileSync(join(result.directory, 'e2e-provider-logs/provider-a.log'), 'utf8'), secrets);
  assert.ok(result.output.length < 34000);
});

test('workflow uploads only sanitized provider files on failure with short retention and every action is SHA-pinned', () => {
  // #given: the actual upload step and all repository workflows.
  const upload = workflow.split('      - name: Upload provider failure logs\n')[1].split('\n  e2e-skipped:')[0];
  // #when / #then: upload cannot match raw runner files or execute on a successful provider step.
  assert.match(providerStep, /id: provider-tests/);
  assert.match(upload, /if: \$\{\{ failure\(\) && steps\.provider-tests\.outcome == 'failure' \}\}/);
  assert.match(upload, /uses: actions\/upload-artifact@[a-f0-9]{40} # v\d/);
  assert.match(upload, /retention-days: [1-7]\n/);
  const paths = upload.split('          path: |\n')[1].split('          retention-days:')[0].trim().split('\n').map((line) => line.trim());
  assert.deepEqual(paths, ['${{ runner.temp }}/e2e-provider-logs/provider-a.log', '${{ runner.temp }}/e2e-provider-logs/provider-b.log']);
  const isPinned = (action) => /^[\w-]+\/[\w/.-]+@[a-f0-9]{40}$/.test(action);
  assert.equal(isPinned('actions/upload-artifact@v7'), false, 'negative pinning control');
  for (const file of readdirSync(join(root, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name))) {
    const source = readFileSync(join(root, '.github/workflows', file), 'utf8');
    for (const [, action] of source.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)) {
      assert.ok(isPinned(action), `${file}: ${action} must use a full SHA`);
    }
  }
});
