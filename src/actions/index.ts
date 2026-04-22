import { CalendarEventGet } from './Calendar/CalendarEventGet.js'
import { CalendarEventList } from './Calendar/CalendarEventList.js'
import { EventPullTranscripts } from './Event/EventPullTranscripts.js'
import { EventSubscriptionCreate } from './Event/EventSubscriptionCreate.js'
import { EventSubscriptionCreateForUser } from './Event/EventSubscriptionCreateForUser.js'
import { EventSubscriptionDelete } from './Event/EventSubscriptionDelete.js'
import { EventSubscriptionList } from './Event/EventSubscriptionList.js'
import { GoogleAuthorize } from './Google/GoogleAuthorize.js'
import { GoogleGetToken } from './Google/GoogleGetToken.js'
import { GoogleGetUser } from './Google/GoogleGetUser.js'
import { McpHealth } from './Mcp/McpHealth.js'
import { McpRestart } from './Mcp/McpRestart.js'
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
  GoogleAuthorize,
  GoogleGetToken,
  GoogleGetUser,
  McpHealth,
  McpRestart,
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
