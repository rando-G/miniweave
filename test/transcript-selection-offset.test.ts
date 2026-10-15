import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ttyAppModulePromise = import('../src/tty-app.ts')

type OffsetState = Parameters<
  (typeof import('../src/tty-app.ts'))['screenToAbsoluteLineIndex']
>[0]

function makeState(transcriptBodyStartY: number): OffsetState {
  return {
    transcript: [{ id: 1, kind: 'user', body: 'l1\nl2\nl3\nl4\nl5\nl6' }],
    transcriptBodyStartY,
    transcriptBodyLines: 4,
    transcriptScrollOffset: 0,
  } as unknown as OffsetState
}

describe('transcript selection vertical offset', () => {
  it('maps the first body row to the first visible transcript line', async () => {
    const { resolveTranscriptBodyStartY, screenToAbsoluteLineIndex } = await ttyAppModulePromise
    // Header panel (4 lines) + spacer = 5 frame lines above the body.
    const bodyStartY = resolveTranscriptBodyStartY(5)
    assert.equal(bodyStartY, 6)

    const state = makeState(bodyStartY)
    // 7 rendered lines, window of 4 -> visible slice starts at line index 3.
    assert.equal(screenToAbsoluteLineIndex(state, bodyStartY), 3)
    assert.equal(screenToAbsoluteLineIndex(state, bodyStartY + 2), 5)
  })

  it('would be off by two rows with the old magic offset', async () => {
    const { screenToAbsoluteLineIndex } = await ttyAppModulePromise
    const headerLines = 4
    const oldBodyStartY = headerLines + 4
    const state = makeState(oldBodyStartY)

    // Clicking the very first body row (header + spacer + 1) landed above the
    // body and was dropped entirely.
    assert.equal(screenToAbsoluteLineIndex(state, headerLines + 2), -1)
    // The row two below the top selected the first visible line instead, so the
    // highlight appeared two rows above the cursor.
    assert.equal(screenToAbsoluteLineIndex(state, headerLines + 4), 3)
    assert.equal(screenToAbsoluteLineIndex(state, headerLines + 6), 5)
  })
})
