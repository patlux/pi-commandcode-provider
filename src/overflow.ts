const COMMAND_CODE_PROVIDER = "commandcode"
const CONTEXT_OVERFLOW_PREFIX = "context_length_exceeded:"

const COMMAND_CODE_OVERFLOW_PATTERNS = [
  /\b(?:context[_\s-]*(?:length|window)|model[_\s-]*context[_\s-]*window)[_\s-]*(?:exceeded|overflow(?:ed)?|too[_\s-]*(?:large|long))\b/i,
  /\b(?:context|prompt|input)[_\s-]*(?:length|window|size|tokens?|limit|maximum)\b[\s\S]{0,120}\b(?:exceed(?:ed|s)?|overflow(?:ed|s)?|too\s+(?:large|long)|(?:maximum|limit)\s+(?:reached|exceeded|hit))\b/i,
  /\b(?:exceed(?:ed|s)?|overflow(?:ed|s)?|too\s+(?:large|long))\b[\s\S]{0,120}\b(?:context|prompt|input)[_\s-]*(?:length|window|size|tokens?|limit|maximum)\b/i,
  /\b(?:prompt|input|context)\b[\s\S]{0,32}\btoo\s+(?:large|long)\b/i,
  /\b(?:prompt|input)[_\s-]*too[_\s-]*(?:large|long)\b/i,
  /\b(?:prompt|input)[_\s-]*tokens?[_\s-]*(?:limit|maximum|max)[_\s-]*(?:exceeded|reached)\b/i,
  /\b(?:prompt|input)[_\s-]*(?:tokens?|length|size)\b[\s\S]{0,120}\b(?:limit|maximum)\b[\s\S]{0,40}\b(?:exceed(?:ed|s)?|reached|hit)\b/i,
  /\b(?:maximum|limit)[_\s-]+(?:allowed[_\s-]+)?(?:context|prompt|input)[_\s-]*(?:length|window|size|tokens?)\b/i,
]

const NON_OVERFLOW_PATTERNS = [
  /\brate[_\s-]*limit\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\b(?:capacity|quota|throttl(?:e|ed|ing)?|concurren(?:cy|t)|overloaded)\b/i,
  /\b(?:service|temporarily)\s+unavailable\b/i,
  /\bstatus(?:[_\s-]*code)?\s*[:=]\s*429\b/i,
]

const CONTEXT_OVERFLOW_PREFIX_PATTERN = /context_length_exceeded/i

const HTTP_RATE_LIMIT_STATUS_PATTERNS = [
  /\b(?:api\s+error|http|status(?:[_\s-]*code)?|status[_\s-]*code)\s*[:(]?\s*429\b/i,
  /["']?(?:status|status[_\s-]*code)["']?\s*:\s*429\b/i,
]

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const CREDENTIAL_PATTERN =
  /\b(?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization)\s*[=:]\s*[^\s,;)]+/gi
const USER_TOKEN_PATTERN = /\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b/gi
const QUERY_SECRET_PATTERN =
  /([?&](?:api[-_ ]?key|apikey|access_token|refresh_token|token|secret|password)=)[^&#\s]+/gi
const STANDALONE_SECRET_PATTERN =
  /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

export function redactCommandCodeErrorText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(CREDENTIAL_PATTERN, (match) => {
      const separatorIndex = match.search(/[=:]/)
      return separatorIndex < 0 ? "[redacted]" : `${match.slice(0, separatorIndex + 1)}[redacted]`
    })
    .replace(USER_TOKEN_PATTERN, "[redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(STANDALONE_SECRET_PATTERN, "[redacted]")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export interface CommandCodeMessageLike {
  role: string
  provider: string
  stopReason: string
  errorMessage?: string
}

export function commandCodeErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return redactCommandCodeErrorText(value)
  if (!isRecord(value)) return undefined

  const record = value
  const parts: string[] = []
  for (const key of [
    "message",
    "errorMessage",
    "error",
    "detail",
    "details",
    "code",
    "type",
    "reason",
  ]) {
    const part = commandCodeErrorMessage(record[key])
    if (part && !parts.includes(part)) parts.push(part)
  }

  for (const key of ["status", "statusCode", "httpStatus"]) {
    const status = record[key]
    if (typeof status === "string" || typeof status === "number") {
      const statusPart = `status: ${status}`
      if (!parts.includes(statusPart)) parts.push(statusPart)
    }
  }

  return parts.length > 0 ? redactCommandCodeErrorText(parts.join(": ")) : undefined
}

export function normalizeCommandCodeErrorMessage(
  errorMessage: string | undefined,
): string | undefined {
  if (!errorMessage) return undefined
  if (CONTEXT_OVERFLOW_PREFIX_PATTERN.test(errorMessage)) return undefined
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return undefined
  if (HTTP_RATE_LIMIT_STATUS_PATTERNS.some((pattern) => pattern.test(errorMessage)))
    return undefined
  if (!COMMAND_CODE_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage)))
    return undefined

  return `${CONTEXT_OVERFLOW_PREFIX} ${redactCommandCodeErrorText(errorMessage)}`
}

export function normalizeCommandCodeMessage<T extends CommandCodeMessageLike>(
  message: T,
  modelProvider?: string,
): { message: T & { errorMessage: string } } | undefined {
  if (message.role !== "assistant" || message.stopReason !== "error") return undefined
  if (message.provider !== COMMAND_CODE_PROVIDER && modelProvider !== COMMAND_CODE_PROVIDER) {
    return undefined
  }

  const errorMessage = normalizeCommandCodeErrorMessage(message.errorMessage)
  if (!errorMessage) return undefined

  return { message: { ...message, errorMessage } }
}
