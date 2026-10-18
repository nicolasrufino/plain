#!/usr/bin/env node
// plain's command line: `plain [ref] [--asked "..."]`, `plain recap`, and the Claude Code hooks (`--hook`).
import { readFileSync, existsSync } from 'node:fs'
import { report, snapshot } from './plain.ts'
import { onPrompt, onStop, recapCli } from './session.ts'

// Last real user prompt from a Claude Code transcript (JSONL).
function lastPrompt(transcriptPath: string): string | undefined {
  let last: string | undefined
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user') continue
      const c = e.message?.content
      const text = typeof c === 'string' ? c : c?.find?.((x: any) => x.type === 'text')?.text
      if (text && !text.startsWith('<')) last = text
    } catch { /* partial line */ }
  }
  return last
}

{
  const args = process.argv.slice(2)
  const cwd = process.cwd()
  const i = args.indexOf('--asked')
  let asked = i >= 0 ? args[i + 1] : undefined
  const ref = args.find((a, j) => !a.startsWith('--') && (i < 0 || j !== i + 1)) ?? 'HEAD'
  if (args[0] === 'recap') {
    console.log(recapCli(cwd, args.slice(1), process.stdout.isTTY && !process.env.NO_COLOR))
  } else if (args.includes('--hook')) {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    if (input.hook_event_name === 'UserPromptSubmit') { onPrompt(cwd, input); process.exit(0) }
    const step = onStop(cwd, input)
    if (!step && input.transcript_path && existsSync(input.transcript_path)) asked ??= lastPrompt(input.transcript_path)
    const from = step?.before ?? ref
    const text = report(snapshot(cwd, from), snapshot(cwd, null), { ref: step ? 'your last message' : ref, asked: step?.prompt ?? asked })
    if (!text.endsWith('Nothing about the app changed.')) console.log(JSON.stringify({ systemMessage: text }))
  } else {
    console.log(report(snapshot(cwd, ref), snapshot(cwd, null), { ref, asked, color: process.stdout.isTTY && !process.env.NO_COLOR }))
  }
}
