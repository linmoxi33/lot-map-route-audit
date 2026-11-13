#!/usr/bin/env node
// Audit Claude Code hook events against lot-map's real classifier.
// Zero dependencies. Node >= 22.18 (native TypeScript type stripping).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const VERSION = '1.0.0'
const DEFAULT_CLASSIFIER = fileURLToPath(new URL('../vendor/lot-map-classify.ts', import.meta.url))
const EXIT_OK = 0
const EXIT_FINDINGS = 1
const EXIT_USAGE = 2

function usage() {
  return `lot-map-route-audit ${VERSION}

Usage:
  lot-map-route-audit --events <file|-> [--classify <classify.ts>] [--json]

Options:
  --events <path>      JSONL of Claude Code hook events (or "-" for stdin).
  --classify <path>    lot-map hooks/classify.ts to execute (default: vendored
                       snapshot pinned to upstream commit d3102bf).
  --json               Print one JSON report on stdout.
  -h, --help           Show this help.
  -V, --version        Show version.

Exit codes: 0 no silent fallback, 1 silent fallback found, 2 usage/input error.
`
}

function parseArgs(argv) {
  const out = { events: null, classify: DEFAULT_CLASSIFIER, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--events' || a === '--classify') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      if (a === '--events') out.events = v
      else out.classify = v
    } else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else if (a === '-V' || a === '--version') out.version = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

function makeSetup() {
  // lot-map's own default Setup, with every user option unset. `t` only
  // feeds labels and is never printed by this audit.
  const t = new Proxy({}, { get: (_target, key) => String(key) })
  return {
    t,
    memoryServers: new Set(),
    memoryCommands: [],
    memorySubcommands: new Set(),
    memoryPaths: [],
    memoryLabels: new Map(),
  }
}

function loadEvents(text) {
  const events = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch (err) {
      throw new Error(`line ${i + 1}: invalid JSON (${err.message})`)
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`line ${i + 1}: event must be a JSON object`)
    }
    if (typeof obj.tool_name !== 'string' || obj.tool_name === '') {
      throw new Error(`line ${i + 1}: missing non-empty tool_name`)
    }
    const input = obj.tool_input === undefined ? {} : obj.tool_input
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`line ${i + 1}: tool_input must be an object`)
    }
    const seen = obj.timestamp ?? obj.ts ?? null
    events.push({
      tool: obj.tool_name,
      input,
      seen: typeof seen === 'string' ? seen : null,
    })
  }
  return events
}

// A silent fallback is the one path in lot-map's classify() that returns
// `{ station: 'shell', label: <the tool name> }` without reading input.
// Running the same tool with `{}` gives the identical answer, which is the
// fingerprint: no field was consulted, so no rule matched.
function isSilentFallback(classify, setup, tool, input) {
  const actual = classify(tool, input, setup)
  if (actual.station !== 'shell' || actual.label !== tool) return null
  const empty = classify(tool, {}, setup)
  if (empty.station !== 'shell' || empty.label !== tool) return null
  return { station: actual.station, label: actual.label }
}

// Greedy key removal: the surviving object is a 1-minimal witness for the
// fallback (removing any remaining key cannot keep it a fallback, because
// no key is read at all). This is a real minimisation, not a sample.
function minimizeWitness(classify, setup, tool, input) {
  const witness = { ...input }
  for (const key of Object.keys(witness)) {
    const next = { ...witness }
    delete next[key]
    if (isSilentFallback(classify, setup, tool, next) !== null) delete witness[key]
  }
  return witness
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`)
    return EXIT_USAGE
  }
  if (args.help) {
    process.stdout.write(usage())
    return EXIT_OK
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return EXIT_OK
  }
  if (args.events === null) {
    process.stderr.write('error: --events is required\n')
    return EXIT_USAGE
  }

  const classifierPath = String(args.classify)
  let classify
  try {
    const mod = await import(pathToFileURL(resolve(classifierPath)).href)
    if (typeof mod.classify !== 'function') throw new Error('module has no exported classify()')
    classify = mod.classify
  } catch (err) {
    process.stderr.write(`error: cannot load classifier ${classifierPath}: ${err.message}\n`)
    return EXIT_USAGE
  }

  let text
  try {
    text = args.events === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(args.events), 'utf8')
  } catch (err) {
    process.stderr.write(`error: cannot read events: ${err.message}\n`)
    return EXIT_USAGE
  }

  let events
  try {
    events = loadEvents(text)
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`)
    return EXIT_USAGE
  }

  const setup = makeSetup()
  const stations = {}
  const byTool = new Map()
  let fallbackEvents = 0

  for (const ev of events) {
    const cls = classify(ev.tool, ev.input, setup)
    stations[cls.station] = (stations[cls.station] ?? 0) + 1
    const fb = isSilentFallback(classify, setup, ev.tool, ev.input)
    if (fb === null) continue
    fallbackEvents++
    const row = byTool.get(ev.tool) ?? { tool: ev.tool, calls: 0, first_seen: null, last_seen: null }
    row.calls++
    if (ev.seen !== null) {
      if (row.first_seen === null || ev.seen < row.first_seen) row.first_seen = ev.seen
      if (row.last_seen === null || ev.seen > row.last_seen) row.last_seen = ev.seen
    }
    // Keep one witness per tool: the first event that reproduced the fallback.
    if (row.witness === undefined) {
      row.witness = minimizeWitness(classify, setup, ev.tool, ev.input)
      row.station = fb.station
    }
    byTool.set(ev.tool, row)
  }

  const findings = [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool))
  for (const f of findings) f.witness_keys = Object.keys(f.witness).sort()

  const report = {
    schema_version: 1,
    tool: 'lot-map-route-audit',
    tool_version: VERSION,
    classifier: {
      file: basename(classifierPath),
      sha256: hashFile(classifierPath),
    },
    totals: {
      events: events.length,
      stations,
      silent_fallback_events: fallbackEvents,
      tools_with_silent_fallback: findings.length,
    },
    findings,
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    if (events.length === 0) process.stdout.write('No events.\n')
    for (const f of findings) {
      const seen = f.first_seen === null ? '' : ` first=${f.first_seen} last=${f.last_seen}`
      process.stdout.write(
        `SILENT_FALLBACK ${f.tool}  calls=${f.calls} station=${f.station} witness=${JSON.stringify(f.witness)}${seen}\n`,
      )
    }
    const st = Object.entries(stations).sort().map(([k, v]) => `${k}=${v}`).join(' ')
    process.stdout.write(
      `events=${events.length} fallback=${fallbackEvents} tools=${findings.length} stations: ${st || '(none)'}\n`,
    )
  }
  return findings.length > 0 ? EXIT_FINDINGS : EXIT_OK
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { process.stderr.write(`error: ${err.stack ?? err.message}\n`); process.exitCode = EXIT_USAGE },
)
