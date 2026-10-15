import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderTerminalFrame, resetTerminalFrame } from '../src/tui/screen.ts'

type Writable = { write: (chunk: string) => boolean }

function captureWrites(run: () => void): string[] {
  const stream = process.stdout as unknown as Writable
  const original = stream.write
  const writes: string[] = []
  stream.write = (chunk: string) => {
    writes.push(String(chunk))
    return true
  }
  try {
    run()
  } finally {
    stream.write = original
  }
  return writes
}

describe('renderTerminalFrame cursor', () => {
  it('writes the frame and the cursor placement in a single chunk', () => {
    resetTerminalFrame()
    const writes = captureWrites(() => {
      renderTerminalFrame('line1\nline2', { row: 2, column: 5 })
    })

    assert.equal(writes.length, 1)
    assert.ok(writes[0]!.includes('line2'))
    // The cursor move and the cursor-show escape must travel with the frame, so
    // an IME never observes the cursor parked at the end of the frame.
    assert.ok(writes[0]!.endsWith('\u001b[2;5H\u001b[?25h'))
  })

  it('does not reposition the cursor when none is requested', () => {
    resetTerminalFrame()
    const writes = captureWrites(() => {
      renderTerminalFrame('only line')
    })
    assert.equal(writes.length, 1)
    assert.equal(writes[0]!.includes('\u001b[?25h'), false)
  })
})
