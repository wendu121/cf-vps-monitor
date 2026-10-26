import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const severityOrder = new Map(severities.map((name, index) => [name, index]));
// Unknown labels rank highest so an unrecognised severity can never be treated as a downgrade.
const severityRank = severity => severityOrder.get(severity) ?? Number.POSITIVE_INFINITY;
const defaultBaselinePath = join(root, 'scripts', 'security-baseline.json');

/**
 * `govulncheck` exits 3 when it finds something. Because the scanner runs through
 * `go run`, that status shows up on stderr while the actual report goes to stdout —
 * keeping only stderr would reduce every finding to a bare "exit status 3".
 * Exits 0 and 3 are accepted so baselined findings can be evaluated; any other exit
 * code stays a hard scanner failure.
 */
function readGoScan(result) {
  const detail = () => [result.error?.message, result.stderr, result.stdout]
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join('\n') || 'scanner did not complete';
  if (result.error || typeof result.stdout !== 'string' || ![0, 3].includes(result.status)) {
    throw new Error(`govulncheck failed (exit ${result.status ?? 'unavailable'}):\n${detail().slice(0, 12000)}`);
  }
  const output = result.stdout.trim();
  if (result.status === 3 && output === 'No vulnerabilities found.') {
    throw new Error('govulncheck exited non-zero yet reported a clean scan; refusing to treat that as success.');
  }
  return output;
}

/**
 * `npm audit` exits 1 whenever it *reports* findings, but still prints a complete
 * report. Treating every non-zero exit as a scanner failure would mean the
 * baseline check could never run, so the exit code is only accepted as
 * "findings reported" when the report actually agrees that something was found.
 * A non-zero exit paired with a clean report is a contradiction and still fails
 * closed, which keeps registry outages indistinguishable from tampering.
 */
function readAuditReport(result) {
  if (result.error || typeof result.stdout !== 'string') {
    const detail = result.error?.message || result.stderr || result.stdout || 'scanner did not complete';
    throw new Error(`npm audit failed (exit ${result.status ?? 'unavailable'}):\n${String(detail).trim().slice(0, 12000)}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    const detail = result.stderr || result.stdout || 'scanner did not complete';
    throw new Error(`npm audit failed (exit ${result.status ?? 'unavailable'}):\n${String(detail).trim().slice(0, 12000)}`);
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error('npm audit returned malformed JSON.'); }
  const counts = report?.metadata?.vulnerabilities;
  if (report?.auditReportVersion !== 2 || report.error || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !counts || ![...severities, 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    || severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
    throw new Error('npm audit returned an incomplete or inconsistent report.');
  }
  const listed = Object.keys(report.vulnerabilities).length;
  if ((listed === 0) !== (counts.total === 0)) {
    throw new Error('npm audit returned an incomplete or inconsistent report.');
  }
  if (result.status === 1 && counts.total === 0 && listed === 0) {
    throw new Error('npm audit exited non-zero yet reported a clean scan; refusing to treat that as success.');
  }
  return report;
}

function loadBaseline(baselinePath = defaultBaselinePath) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(baselinePath, 'utf8')); }
  catch (error) { throw new Error(`security baseline is missing or unreadable (${baselinePath}): ${error.message}`); }
  const npmEntries = parsed?.npmAdvisories;
  const goEntries = parsed?.goVulnerabilities;
  if (!Array.isArray(npmEntries) || !Array.isArray(goEntries)) {
    throw new Error('security baseline must declare `npmAdvisories` and `goVulnerabilities` arrays.');
  }
  const npm = new Map();
  for (const entry of npmEntries) {
    if (!entry || typeof entry.id !== 'string' || !advisoryIdPattern.test(entry.id)) {
      throw new Error(`security baseline has an invalid npm advisory id: ${JSON.stringify(entry?.id)}`);
    }
    if (!severities.includes(entry.severity)) {
      throw new Error(`security baseline advisory ${entry.id} needs a valid severity.`);
    }
    npm.set(entry.id, entry);
  }
  const go = new Map();
  for (const entry of goEntries) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`security baseline has an invalid Go vulnerability id: ${JSON.stringify(entry)}`);
    }
    go.set(id, typeof entry === 'string' ? { id } : entry);
  }
  return { npm, go };
}

const advisoryIdPattern = /^(?:GHSA-[a-z0-9-]+|CVE-\d{4}-\d{4,})$/i;

/**
 * Advisory ids arrive as a `url` on the `via` object. Most are GHSA links, but some
 * are published only against a CVE (NVD link), so both forms are accepted. Anything
 * else yields null and is reported as unmappable rather than dropped — a silently
 * dropped advisory would let the rest of the report carry the gate to success.
 */
function extractAdvisoryId(url) {
  if (typeof url !== 'string') return null;
  const ghsa = url.match(/GHSA-[a-z0-9-]+/i);
  if (ghsa) return ghsa[0];
  const cve = url.match(/CVE-\d{4}-\d{4,}/i);
  return cve ? cve[0] : null;
}

/**
 * Flattens the audit report into advisory ids and, separately, the `via` entries that
 * could not be mapped to one. `via` entries are either advisory objects (this package
 * owns the finding) or plain strings naming an upstream package (the finding belongs
 * to that package and is reported there), so only the former participate in the
 * baseline decision. Unmappable entries are returned instead of discarded so the
 * caller can fail closed; checking only "total > 0 and nothing mapped" would still
 * pass a mixed report that hides one unreadable critical behind readable neighbours.
 */
function collectAdvisories(vulnerabilities) {
  const found = new Map();
  const unmapped = [];
  for (const [name, detail] of Object.entries(vulnerabilities)) {
    for (const via of detail?.via ?? []) {
      if (via && typeof via === 'object') {
        const id = extractAdvisoryId(via.url);
        const entry = {
          package: name,
          severity: via.severity ?? detail.severity,
          title: via.title ?? '',
          url: typeof via.url === 'string' ? via.url : null,
        };
        if (id) found.set(id, entry);
        else unmapped.push(entry);
      } else if (typeof via === 'string' && advisoryIdPattern.test(via)) {
        found.set(via, { package: name, severity: detail.severity, title: '', url: null });
      }
    }
  }
  return { found, unmapped };
}

function describe(entry) {
  return `${entry.package}: ${entry.severity}${entry.title ? ` — ${entry.title}` : ''}`;
}

export function runSecurityChecks({ run = spawnSync, log = console.log, baselinePath = defaultBaselinePath } = {}) {
  const baseline = loadBaseline(baselinePath);

  const npmCli = process.env.npm_execpath;
  const auditArgs = ['audit', '--audit-level=low', '--include=dev', '--json'];
  const npm = run(npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm', npmCli ? [npmCli, ...auditArgs] : auditArgs, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    shell: !npmCli && process.platform === 'win32', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  const report = readAuditReport(npm);
  const { found, unmapped } = collectAdvisories(report.vulnerabilities);
  const npmCounts = report.metadata.vulnerabilities;
  // A report that claims findings but yields no advisory id means the shape we rely on
  // changed (or the output was truncated). Refuse rather than silently allowing it.
  if (npmCounts.total > 0 && found.size === 0) {
    throw new Error(
      `npm audit reported ${npmCounts.total} vulnerabilit(ies) but none could be mapped to an advisory id; `
      + 'refusing to treat an unparseable report as clean.',
    );
  }
  // A *partial* failure is the dangerous case: the readable advisories would satisfy the
  // baseline while an unreadable one (possibly the only critical) rides along unnoticed.
  if (unmapped.length > 0) {
    const lines = unmapped.map(entry => `  ${describe(entry)}${entry.url ? ` (${entry.url})` : ' (no advisory url)'}`).join('\n');
    throw new Error(
      `npm audit reported ${unmapped.length} advisor${unmapped.length === 1 ? 'y' : 'ies'} that could not be mapped to a GHSA/CVE id:\n${lines}\n`
      + 'Refusing to treat a partially unparseable report as clean.',
    );
  }
  const unbaselined = [];
  const escalated = [];
  for (const [id, entry] of found) {
    const baselined = baseline.npm.get(id);
    if (!baselined) { unbaselined.push([id, entry]); continue; }
    // The baseline pins the severity that was accepted. If an advisory is later raised
    // (moderate -> critical) the accepted-risk rationale no longer holds and it must surface.
    if (severityRank(entry.severity) > severityRank(baselined.severity)) {
      escalated.push([id, entry, baselined]);
    }
  }
  if (unbaselined.length > 0) {
    const lines = unbaselined.map(([id, entry]) => `  ${id}  ${describe(entry)}`).join('\n');
    throw new Error(
      `npm audit found ${unbaselined.length} advisory(ies) that are NOT in scripts/security-baseline.json:\n${lines}\n`
      + 'Either upgrade the dependency or, if this is an accepted upstream inheritance, add it to the baseline with a reason.',
    );
  }
  if (escalated.length > 0) {
    const lines = escalated
      .map(([id, entry, baselined]) => `  ${id}  ${describe(entry)} (baseline accepted ${baselined.severity})`)
      .join('\n');
    throw new Error(
      `npm audit raised the severity of ${escalated.length} baselined advisory(ies); the accepted-risk rationale must be re-reviewed:\n${lines}`,
    );
  }
  if (found.size === 0) log('npm audit: no vulnerabilities found.');
  else log(`npm audit: ${npmCounts.total} known finding(s), all covered by the baseline (${found.size} advisory id(s)).`);
  const staleNpm = [...baseline.npm.keys()].filter(id => !found.has(id));
  if (staleNpm.length > 0) {
    log(`npm audit: baseline entries no longer reported, please prune them: ${staleNpm.join(', ')}`);
  }

  // Keep the pinned scanner in default text mode. Its JSON mode can exit zero
  // with findings, so JSON/progress/partial output is not accepted as success.
  const go = run('go', ['run', 'golang.org/x/vuln/cmd/govulncheck@v1.7.0', './...'], {
    cwd: join(root, 'agent'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  const goOutput = readGoScan(go);
  if (goOutput === 'No vulnerabilities found.') {
    log('govulncheck: no vulnerabilities found.');
    if (baseline.go.size > 0) {
      log(`govulncheck: baseline entries no longer reported, please prune them: ${[...baseline.go.keys()].join(', ')}`);
    }
    return 0;
  }
  const reportedIds = new Set([...goOutput.matchAll(/\bGO-\d{4}-\d{4,}\b/g)].map(match => match[0]));
  const unbaselinedGo = [...reportedIds].filter(id => !baseline.go.has(id));
  if (reportedIds.size === 0 || unbaselinedGo.length > 0) {
    throw new Error(`govulncheck did not return a complete clean text scan:\n${goOutput.slice(0, 12000)}`);
  }
  log(`govulncheck: ${reportedIds.size} known finding(s), all covered by the baseline.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runSecurityChecks(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
