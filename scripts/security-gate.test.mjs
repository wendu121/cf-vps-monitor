import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const cleanNpm = { status: 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }), stderr: '' };
const cleanGo = { status: 0, stdout: 'No vulnerabilities found.\n', stderr: '' };
const vulnerableNpm = { status: 1, stdout: JSON.stringify({ auditReportVersion: 2,
  vulnerabilities: { hono: { severity: 'high', via: ['GHSA-synthetic'] } },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } }), stderr: '' };

// Traverse the actual checked-in verification entrypoints. Builds and behavior
// tests pass in this fixture so only the scanner boundary can block publication.
async function fixture({ npm = cleanNpm, go = cleanGo, commands = ['npm run verify'], baselinePath } = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('audit')) return typeof npm === 'function' ? npm(args) : npm;
    if (args.some(arg => arg.includes('govulncheck'))) return go;
    throw new Error(`Unexpected security subprocess: ${command} ${args.join(' ')}`);
  };
  async function execute(command) {
    for (const step of command.split(/\s*&&\s*/)) {
      const npmStep = /^npm (?:run )?([\w:-]+)$/.exec(step.trim());
      if (npmStep) {
        const name = npmStep[1];
        if (['ci', 'lint', 'build', 'test'].includes(name)) continue;
        assert.equal(typeof packageJson.scripts[name], 'string', `npm script ${name} exists`);
        await execute(packageJson.scripts[name]);
        continue;
      }
      const nodeStep = /^node (\S+\.mjs)$/.exec(step.trim());
      assert.ok(nodeStep, `fixture must execute the actual supported command: ${step}`);
      const module = await import(new URL(nodeStep[1], root));
      await module.runSecurityChecks({ run, log() {}, ...(baselinePath ? { baselinePath } : {}) });
    }
  }
  try {
    for (const command of commands) await execute(command);
    return { status: 0, calls };
  } catch (error) {
    return { status: 1, calls, error };
  }
}

test('AUD-20 full verification rejects npm findings even if a scanner incorrectly exits zero', async () => {
  for (const status of [1, 0]) {
    const result = await fixture({ npm: { ...vulnerableNpm, status } });
    assert.equal(result.status, 1, 'a successful build/test cannot bypass vulnerable dependencies');
    assert.ok(result.calls.some(call => call.args.includes('audit')), 'the real npm audit boundary ran');
  }
});

test('AUD-20 security verification includes vulnerable build dependencies even in production environments', async () => {
  const result = await fixture({ npm: args => args.includes('--include=dev') ? vulnerableNpm : cleanNpm });
  assert.equal(result.status, 1, 'NODE_ENV=production must not silently omit the Wrangler/build/test dependency graph');
});

test('AUD-20 an npm-launched gate invokes that npm CLI directly without a Windows shell', async () => {
  const original = process.env.npm_execpath;
  const cli = new URL('synthetic-npm-cli.js', root).pathname;
  process.env.npm_execpath = cli;
  try {
    const result = await fixture();
    assert.equal(result.status, 0, result.error?.stack);
    const npm = result.calls.find(call => call.args.includes('audit'));
    assert.equal(npm.command, process.execPath);
    assert.equal(npm.args[0], cli);
    assert.notEqual(npm.options.shell, true);
  } finally {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  }
});

test('AUD-20 full verification rejects Go findings, including govulncheck JSON exit-zero output', async () => {
  for (const go of [
    { status: 3, stdout: 'Vulnerability #1: GO-2026-SYNTHETIC\nYour code is affected by 1 vulnerability.\n' },
    { status: 0, stdout: '{"finding":{"osv":"GO-2026-SYNTHETIC","trace":[{"function":"Affected"}]}}\n' },
  ]) {
    const result = await fixture({ go });
    assert.equal(result.status, 1, 'Go findings must block verification regardless of the process exit alone');
    assert.ok(result.calls.some(call => call.args.some(arg => arg.includes('govulncheck'))));
  }
});

test('AUD-20 scanner failures and incomplete output fail closed', async () => {
  for (const npm of [
    { status: null, error: new Error('scanner unavailable'), stdout: '' },
    { status: 1, stdout: cleanNpm.stdout, stderr: 'registry unavailable' },
    { status: 0, stdout: '<html>registry unavailable</html>' },
    { status: 0, stdout: '{}' },
    { status: 0, stdout: JSON.stringify({ ...JSON.parse(cleanNpm.stdout), vulnerabilities: { affected: {} } }) },
    { status: 0, stdout: JSON.stringify({ ...JSON.parse(cleanNpm.stdout), metadata: { vulnerabilities: { total: 0 } } }) },
  ]) {
    assert.equal((await fixture({ npm })).status, 1, 'npm must return a complete clean scan');
  }
  for (const go of [
    { status: null, error: new Error('scanner unavailable'), stdout: '' },
    { status: 1, stdout: 'No vulnerabilities found.', stderr: 'incomplete scan' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '{"config":{"scanner_name":"govulncheck"}}\n' },
    { status: 0, stdout: 'Vulnerability #1: GO-2026-SYNTHETIC\nNo vulnerabilities found.\n' },
  ]) {
    assert.equal((await fixture({ go })).status, 1, 'Go must return a complete clean text scan');
  }
});

test('AUD-20 clean scans allow verification only after both npm and the actual Agent toolchain are scanned', async () => {
  const result = await fixture();
  assert.equal(result.status, 0, result.error?.stack);
  assert.equal(result.calls.length, 2, 'both scanners are mandatory');
  const go = result.calls.find(call => call.args.some(arg => arg.includes('govulncheck')));
  assert.ok(go.options.cwd.replaceAll('\\', '/').endsWith('/agent'));
  assert.equal(go.args.includes('-json'), false, 'default text mode preserves govulncheck finding exit semantics');
  assert.ok(go.args.includes('golang.org/x/vuln/cmd/govulncheck@v1.7.0'));
});

test('AUD-20 the reusable CI gate blocks same-checkout Agent publishing when security fails', async () => {
  const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  const release = await readFile(new URL('.github/workflows/release-agent.yml', root), 'utf8');
  const commands = [...ci.matchAll(/^\s+run: (npm (?:run )?[\w:-]+)\s*$/gm)].map(match => match[1]);
  assert.ok(commands.length >= 3, 'exercise the actual CI command chain');
  assert.match(release, /^  verify:\r?\n    uses: \.\/\.github\/workflows\/ci\.yml\s*$/m);
  assert.match(release, /^  release-agent:\r?\n    needs: verify\s*$/m);
  assert.doesNotMatch(release, /^    if:.*always\(\)/m);
  const result = await fixture({ npm: vulnerableNpm, commands });
  const canPublish = result.status === 0;
  assert.equal(canPublish, false, 'the same-checkout reusable CI must fail before release-agent can publish');
  const success = await fixture({ commands });
  assert.equal(success.status, 0, success.error?.stack);
  assert.equal(success.calls.length, 2);
});

// ── 显式基线（scripts/security-baseline.json）───────────────────────────────
// 门禁之所以能在「上游继承漏洞」存在时仍然转绿，是因为放行是**逐 advisory 白名单**，
// 而不是把整道门禁关掉。以下测试锁住这个性质：基线内的放行、基线外的照常阻断、
// 基线丢失时 fail closed。

function advisoryReport(entries) {
  const vulnerabilities = {};
  for (const entry of entries) {
    vulnerabilities[entry.package] = {
      severity: entry.severity ?? 'moderate',
      range: '*',
      via: [{
        source: 1, name: entry.package, dependency: entry.package,
        title: entry.title ?? 'synthetic', url: `https://github.com/advisories/${entry.id}`,
        severity: entry.severity ?? 'moderate', range: '*',
      }],
    };
  }
  const total = entries.length;
  return {
    status: 1,
    stdout: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities,
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: total, high: 0, critical: 0, total } },
    }),
    stderr: '',
  };
}

const baseline = JSON.parse(await readFile(new URL('scripts/security-baseline.json', root), 'utf8'));

test('AUD-20 advisories listed in the baseline are allowed through without downgrading the gate', async () => {
  assert.ok(baseline.npmAdvisories.length > 0, 'the checked-in baseline documents the inherited findings');
  const entries = baseline.npmAdvisories.map(item => ({ package: item.package, id: item.id, severity: item.severity }));
  const result = await fixture({ npm: advisoryReport(entries) });
  assert.equal(result.status, 0, result.error?.stack);
  assert.ok(result.calls.some(call => call.args.includes('audit')));
});

test('AUD-20 an advisory missing from the baseline still blocks even when other findings are baselined', async () => {
  const known = baseline.npmAdvisories[0];
  const result = await fixture({
    npm: advisoryReport([
      { package: known.package, id: known.id, severity: known.severity },
      { package: 'brand-new-pkg', id: 'GHSA-aaaa-bbbb-cccc', severity: 'high' },
    ]),
  });
  assert.equal(result.status, 1, 'a newly disclosed advisory must not ride along with baselined ones');
  assert.match(result.error.message, /GHSA-aaaa-bbbb-cccc/);
});

test('AUD-20 a missing or malformed baseline fails closed instead of silently allowing findings', async () => {
  const cases = [
    { baselinePath: new URL('scripts/security-baseline.does-not-exist.json', root).pathname },
    { baselinePath: new URL('scripts/security-gate.test.mjs', root).pathname },
  ];
  for (const options of cases) {
    const result = await fixture({ npm: advisoryReport([]), ...options });
    assert.equal(result.status, 1, 'the gate must not pass without a readable baseline');
  }
});

test('AUD-20 the reusable CI gate keeps security as a hard step, not continue-on-error', async () => {
  const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  const blocks = ci.split(/^ {6}- name: /m).slice(1);
  const security = blocks.find(block => block.startsWith('Dependency and toolchain security'));
  assert.ok(security, 'the CI security step must exist');
  assert.match(security.split(/^ {6}- name: /m)[0], /run: npm run security:check/);
  assert.doesNotMatch(
    security.split(/^ {6}- name: /m)[0],
    /continue-on-error/,
    'security must stay blocking: a non-blocking step would also let brand-new advisories through, '
    + 'and release-agent.yml reuses this workflow as its only pre-publish gate',
  );
});

test('AUD-20 a baselined advisory whose severity was raised must be re-reviewed, not silently allowed', async () => {
  const known = baseline.npmAdvisories.find(item => item.severity !== 'critical');
  assert.ok(known, 'the baseline carries at least one non-critical entry');
  const result = await fixture({
    npm: advisoryReport([{ package: known.package, id: known.id, severity: 'critical' }]),
  });
  assert.equal(result.status, 1, 'an advisory escalated to critical invalidates the accepted-risk record');
  assert.match(result.error.message, /raised the severity/);
});

test('AUD-20 a report claiming findings but yielding no advisory id fails closed', async () => {
  const unparseable = {
    status: 1,
    stdout: JSON.stringify({
      auditReportVersion: 2,
      // `via` only names an upstream package: nothing here maps to an advisory id.
      vulnerabilities: { leaf: { severity: 'high', range: '*', via: ['upstream-package'] } },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    }),
    stderr: '',
  };
  const result = await fixture({ npm: unparseable });
  assert.equal(result.status, 1, 'an unparseable report must not be treated as clean');
  assert.match(result.error.message, /none could be mapped to an advisory id/);
});

test('AUD-20 govulncheck exiting non-zero with a clean line is still a contradiction', async () => {
  const result = await fixture({ go: { status: 3, stdout: 'No vulnerabilities found.\n', stderr: '' } });
  assert.equal(result.status, 1, 'exit 3 means findings, so a clean line contradicts it');
});

test('AUD-20 one unmappable advisory cannot hide behind baselined neighbours', async () => {
  const known = baseline.npmAdvisories[0];
  // The dangerous shape is *partial* failure: the readable advisory satisfies the
  // baseline, so checking only "total > 0 and nothing mapped" would let the unreadable
  // critical through. Every unparsed `via` must therefore be fatal on its own.
  const mixed = {
    status: 1,
    stdout: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        [known.package]: {
          severity: known.severity, range: '*',
          via: [{ source: 1, name: known.package, dependency: known.package, title: 'baselined',
            url: `https://github.com/advisories/${known.id}`, severity: known.severity, range: '*' }],
        },
        'mystery-pkg': {
          severity: 'critical', range: '*',
          via: [{ source: 1, name: 'mystery-pkg', dependency: 'mystery-pkg', title: 'unmappable critical',
            url: 'https://example.invalid/security/notice-42', severity: 'critical', range: '*' }],
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 1, total: 2 } },
    }),
    stderr: '',
  };
  const result = await fixture({ npm: mixed });
  assert.equal(result.status, 1, 'a readable baselined advisory must not carry an unreadable critical to success');
  assert.match(result.error.message, /could not be mapped to a GHSA\/CVE id/);
  assert.match(result.error.message, /mystery-pkg/);
});

test('AUD-20 a CVE-only advisory is mapped to an id rather than dropped', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'cf-baseline-'));
  const baselinePath = join(dir, 'security-baseline.json');
  await writeFile(baselinePath, JSON.stringify({
    npmAdvisories: [{ id: 'CVE-2026-12345', package: 'legacy-pkg', severity: 'moderate', blockedBy: 'synthetic' }],
    goVulnerabilities: [],
  }));
  const report = {
    status: 1,
    stdout: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        'legacy-pkg': {
          severity: 'moderate', range: '*',
          via: [{ source: 1, name: 'legacy-pkg', dependency: 'legacy-pkg', title: 'cve only',
            url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-12345', severity: 'moderate', range: '*' }],
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } },
    }),
    stderr: '',
  };
  const result = await fixture({ npm: report, baselinePath });
  assert.equal(result.status, 0, result.error?.stack);
});
