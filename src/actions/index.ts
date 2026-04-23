import { CalendarEventGet } from './Calendar/CalendarEventGet.js'
import { CalendarEventList } from './Calendar/CalendarEventList.js'
import { EventPullTranscripts } from './Event/EventPullTranscripts.js'
import { EventSubscriptionCreate } from './Event/EventSubscriptionCreate.js'
import { EventSubscriptionCreateForUser } from './Event/EventSubscriptionCreateForUser.js'
import { EventSubscriptionDelete } from './Event/EventSubscriptionDelete.js'
import { EventSubscriptionList } from './Event/EventSubscriptionList.js'
import { McpStatus } from './Mcp/McpStatus.js'
import { MeetConferenceGet } from './Meet/MeetConferenceGet.js'
import { MeetConferenceList } from './Meet/MeetConferenceList.js'
import { MeetParticipantList } from './Meet/MeetParticipantList.js'
import { MeetRecordingList } from './Meet/MeetRecordingList.js'
import { MeetSpaceGet } from './Meet/MeetSpaceGet.js'
import { MeetTranscriptGet } from './Meet/MeetTranscriptGet.js'
import { MeetTranscriptList } from './Meet/MeetTranscriptList.js'
import { TranscriptWatchStart } from './Transcript/TranscriptWatchStart.js'
import { TranscriptWatchStatus } from './Transcript/TranscriptWatchStatus.js'
import { TranscriptWatchStop } from './Transcript/TranscriptWatchStop.js'

export const actions = [
  CalendarEventGet,
  CalendarEventList,
  EventPullTranscripts,
  EventSubscriptionCreate,
  EventSubscriptionCreateForUser,
  EventSubscriptionDelete,
  EventSubscriptionList,
  McpStatus,
  MeetConferenceGet,
  MeetConferenceList,
  MeetParticipantList,
  MeetRecordingList,
  MeetSpaceGet,
  MeetTranscriptGet,
  MeetTranscriptList,
  TranscriptWatchStart,
  TranscriptWatchStatus,
  TranscriptWatchStop
]

export const mcpActions = [
  McpStatus,
  MeetTranscriptGet,
  MeetTranscriptList
]
