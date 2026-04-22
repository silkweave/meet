import { meet_v2 } from 'googleapis'

export type TranscriptEntry = meet_v2.Schema$TranscriptEntry
export type Participant = meet_v2.Schema$Participant

export function participantDisplayName(p: Participant | undefined): string {
  if (!p) { return 'Unknown speaker' }
  if (p.signedinUser?.displayName) { return p.signedinUser.displayName }
  if (p.anonymousUser?.displayName) { return `${p.anonymousUser.displayName} (guest)` }
  if (p.phoneUser?.displayName) { return `${p.phoneUser.displayName} (phone)` }
  return 'Unknown speaker'
}

export function renderTranscriptMarkdown(entries: TranscriptEntry[], participants: Record<string, Participant>): string {
  const lines: string[] = []
  let currentSpeaker: string | null = null
  let buffer: string[] = []

  const flush = (timestamp?: string | null) => {
    if (currentSpeaker && buffer.length > 0) {
      const header = timestamp ? `**${currentSpeaker}** (${timestamp})` : `**${currentSpeaker}**`
      lines.push(`${header}: ${buffer.join(' ')}`)
      lines.push('')
    }
    buffer = []
  }

  let blockStart: string | null | undefined
  for (const entry of entries) {
    const speaker = participantDisplayName(entry.participant ? participants[entry.participant] : undefined)
    if (speaker !== currentSpeaker) {
      flush(blockStart)
      currentSpeaker = speaker
      blockStart = entry.startTime
    }
    if (entry.text) { buffer.push(entry.text.trim()) }
  }
  flush(blockStart)

  return lines.join('\n').trimEnd()
}
