// Test runner: no framework, real subprocesses, real exit codes.
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'lot-map-route-audit.mjs')
const vendor = join(root, 'vendor', 'lot-map-classify.ts')
const tmp = mkdtempSync(join(tmpdir(), 'lmra-test-'))
let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`ok ${passed} - ${name}\n`)
  } catch (err) {
    failures.push({ name, err })
    process.stdout.write(`not ok - ${name}: ${err.message}\n`)
  }
}

function eq(actual, expected, what = 'value') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

function run(args, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 30000,
  })
}

function jsonOut(r) {
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`stdout is not JSON: ${r.stdout.slice(0, 200)}`)
  }
}

function tmpFile(name, text) {
  const p = join(tmp, name)
  writeFileSync(p, text)
  return p
}

// 1. Syntax of the shipped CLI.
test('CLI parses (node --check)', () => {
  const r = spawnSync(process.execPath, ['--check', bin], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
})

// 2. Vendored classifier is the pinned upstream file, byte for byte.
test('vendored classifier hash is pinned', () => {
  const h = createHash('sha256').update(readFileSync(vendor)).digest('hex')
  eq(h, '5325119d8de9840377cbf84ae03565d0eb5c5335b77cf8b2212603342804dfc8', 'sha256')
})

// 3. Behaviour: the shipped example flags exactly two tools and exits 1.
test('example session: exit 1, two silent fallbacks', () => {
  const r = run(['--events', 'examples/in/session.jsonl', '--json'])
  eq(r.status, 1, 'exit code')
  const d = jsonOut(r)
  eq(d.findings.map(f => f.tool), ['EnterPlanMode', 'TaskCreate'], 'findings')
  eq(d.totals.silent_fallback_events, 3, 'fallback events')
})

// 4. Behaviour: expected output file matches a fresh run byte for byte.
test('example report is reproducible', () => {
  const r = run(['--events', 'examples/in/session.jsonl', '--json'])
  eq(r.stdout, readFileSync(join(root, 'examples/out/report.json'), 'utf8'), 'report')
})

// 5. Behaviour: a session with only routed tools exits 0.
test('clean session exits 0', () => {
  const p = tmpFile('clean.jsonl', [
    '{"tool_name":"Bash","tool_input":{"command":"ls -la","description":"list"}}',
    '{"tool_name":"Read","tool_input":{"file_path":"/a/b.txt"}}',
    '{"tool_name":"WebFetch","tool_input":{"url":"https://example.com/x"}}',
    '{"tool_name":"Skill","tool_input":{"skill":"pdf"}}',
    '{"tool_name":"mcp__github__search_code","tool_input":{"query":"x"}}',
  ].join('\n'))
  const r = run(['--events', p, '--json'])
  eq(r.status, 0, 'exit code')
  eq(jsonOut(r).findings, [], 'findings')
})

// 6. Behaviour: task tools from issue #51 are all flagged on real upstream code.
test('issue #51 names: 33/33 hit the default branch', () => {
  const r = run(['--events', 'examples/in/issue51-names.jsonl', '--json'])
  eq(r.status, 1, 'exit code')
  const d = jsonOut(r)
  eq(d.totals.events, 33, 'events')
  eq(d.totals.tools_with_silent_fallback, 33, 'flagged tools')
})

// 7. Behaviour: witness is 1-minimal - keys that are read survive, others vanish.
test('witness minimisation drops every unread key', () => {
  const p = tmpFile('witness.jsonl', '{"tool_name":"TaskCreate","tool_input":{"subject":"s","description":"d","nested":{"x":1}}}')
  const d = jsonOut(run(['--events', p, '--json']))
  eq(d.findings[0].witness, {}, 'witness')
  eq(d.findings[0].witness_keys, [], 'witness keys')
})

// 8. Behaviour: repeated tool calls aggregate, first/last seen are real event values.
test('calls aggregate with first/last timestamps', () => {
  const d = jsonOut(run(['--events', 'examples/in/session.jsonl', '--json']))
  const task = d.findings.find(f => f.tool === 'TaskCreate')
  eq(task.calls, 2, 'calls')
  eq(task.first_seen, '2026-11-13T10:00:04Z', 'first_seen')
  eq(task.last_seen, '2026-11-13T10:00:06Z', 'last_seen')
})

// 9. Behaviour: station counts sum to the number of events.
test('station counts sum to total events', () => {
  const d = jsonOut(run(['--events', 'examples/in/session.jsonl', '--json']))
  const sum = Object.values(d.totals.stations).reduce((a, b) => a + b, 0)
  eq(sum, d.totals.events, 'station sum')
})

// 10. Behaviour: stdin ("-") is accepted.
test('reads events from stdin', () => {
  const line = '{"tool_name":"TaskList","tool_input":{}}\n'
  const r = run(['--events', '-', '--json'], line)
  eq(r.status, 1, 'exit code')
  eq(jsonOut(r).findings[0].tool, 'TaskList', 'tool')
})

// 11. Usage error: missing --events.
test('missing --events is exit 2', () => {
  eq(run(['--json']).status, 2, 'exit code')
})

// 12. Input error: unreadable file is exit 2.
test('missing events file is exit 2', () => {
  eq(run(['--events', join(tmp, 'nope.jsonl'), '--json']).status, 2, 'exit code')
})

// 13. Input error: malformed JSON line is exit 2, not a silent skip.
test('malformed JSON line is exit 2', () => {
  const p = tmpFile('bad.jsonl', '{"tool_name":"Bash"}\nnot json\n')
  eq(run(['--events', p, '--json']).status, 2, 'exit code')
})

// 14. Input error: event without tool_name is exit 2.
test('event without tool_name is exit 2', () => {
  const p = tmpFile('noname.jsonl', '{"tool_input":{}}\n')
  eq(run(['--events', p, '--json']).status, 2, 'exit code')
})

// 15. Input error: unknown flag is exit 2.
test('unknown flag is exit 2', () => {
  eq(run(['--events', 'x', '--nope']).status, 2, 'exit code')
})

// 16. Behaviour: --classify runs a caller-supplied module, not a hardcoded table.
test('--classify executes the supplied module', () => {
  const mod = tmpFile('custom.mjs', "export function classify() { return { station: 'files', label: 'X' } }\n")
  const p = tmpFile('custom-events.jsonl', '{"tool_name":"X","tool_input":{"a":1}}\n')
  const r = run(['--events', p, '--classify', mod, '--json'])
  eq(r.status, 0, 'exit code')
  eq(jsonOut(r).totals.stations.files, 1, 'stations')
})

// 17. Determinism: two runs produce identical bytes.
test('two runs are byte-identical', () => {
  const a = run(['--events', 'examples/in/session.jsonl', '--json']).stdout
  const b = run(['--events', 'examples/in/session.jsonl', '--json']).stdout
  eq(a, b, 'stdout')
})

rmSync(tmp, { recursive: true, force: true })

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`${f.name}: ${f.err.stack}\n`)
  process.exitCode = 1
}
