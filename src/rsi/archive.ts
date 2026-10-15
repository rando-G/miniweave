import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EvaluationRecord } from './types.js'
import { isEnoentError } from '../utils/errors.js'

export type ArchiveRecord = EvaluationRecord & {
  campaignId: string
  branch: string | null
  bestScoreAfter: number
}

/**
 * Append-only lineage log, written as JSONL like the session store so a partial
 * file is still readable. It is the durable record of what the campaign tried,
 * what it measured, and what it kept.
 */
export class Archive {
  private records: ArchiveRecord[] = []

  constructor(private readonly filePath?: string) {}

  get all(): readonly ArchiveRecord[] {
    return this.records
  }

  async load(): Promise<readonly ArchiveRecord[]> {
    if (!this.filePath) return this.records
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed: ArchiveRecord[] = []
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          parsed.push(JSON.parse(trimmed) as ArchiveRecord)
        } catch {
          // A torn final line is expected with append-only hand-off; skip it.
        }
      }
      this.records = parsed
    } catch (error) {
      if (!isEnoentError(error)) throw error
      this.records = []
    }
    return this.records
  }

  async append(record: ArchiveRecord): Promise<void> {
    this.records.push(record)
    if (!this.filePath) return
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
  }
}
