// One deadline policy for every request a feature makes against the local
// OpenCode server. The server is in-process or on localhost; anything slower
// than this is wedged, and waiting longer stalls the event fan-out for every
// other feature. Compaction requests, message reads, and provider lookups
// all share it.
export const CLIENT_REQUEST_DEADLINE_MS = 60 * 1000
