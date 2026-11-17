/**
 * Normalizes Command Code's non-standard Responses reasoning frames.
 *
 * Command Code emits `response.reasoning.delta` while a reasoning item is still
 * streaming, but pi-ai 1.0.3 only understands the canonical
 * `response.reasoning_text.delta`. Without translation the deltas are dropped
 * and the reasoning text only appears at `response.output_item.done`. Rewriting
 * the frame in flight restores incremental thinking without touching any other
 * Responses event.
 *
 * Some models stream no reasoning delta at all and report the whole chain of
 * thought as plaintext `encrypted_content` on the completed reasoning item.
 * pi-ai keeps that field only as a replay signature and never renders it, so
 * `plaintextReasoningContent` turns it into the canonical delta just before the
 * item completes. The option is opt-in per model: for OpenAI models the same
 * field holds real ciphertext and must stay invisible.
 */

const SSE_MIME_TYPE = "text/event-stream"
const REASONING_DELTA_EVENT = "response.reasoning.delta"
const REASONING_TEXT_DELTA_EVENT = "response.reasoning_text.delta"
const OUTPUT_ITEM_DONE_EVENT = "response.output_item.done"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface SseLine {
  content: string
  ending: string
}

/** Splits a complete SSE frame into lines, preserving each original ending. */
function splitSseLines(frame: string): SseLine[] {
  const lines: SseLine[] = []
  let start = 0
  let index = 0
  while (index < frame.length) {
    const code = frame.charCodeAt(index)
    if (code === 0x0a) {
      lines.push({ content: frame.slice(start, index), ending: "\n" })
      index += 1
      start = index
    } else if (code === 0x0d) {
      if (index + 1 < frame.length && frame.charCodeAt(index + 1) === 0x0a) {
        lines.push({ content: frame.slice(start, index), ending: "\r\n" })
        index += 2
      } else {
        lines.push({ content: frame.slice(start, index), ending: "\r" })
        index += 1
      }
      start = index
    } else {
      index += 1
    }
  }
  if (start < frame.length) {
    lines.push({ content: frame.slice(start), ending: "" })
  }
  return lines
}

interface SseField {
  field: string
  value: string
}

/** Parses one SSE line. Returns undefined for comments and blank lines. */
function parseSseField(content: string): SseField | undefined {
  if (content.startsWith(":")) return undefined
  const colon = content.indexOf(":")
  if (colon === -1) return { field: content, value: "" }
  const field = content.slice(0, colon)
  let value = content.slice(colon + 1)
  if (value.startsWith(" ")) value = value.slice(1)
  return { field, value }
}

/**
 * Rewrites `response.reasoning.delta` frames as `response.reasoning_text.delta`
 * frames. Everything else, including malformed JSON, is returned unchanged.
 */
function normalizeResponsesSseFrame(frame: string, onSchemaMismatch: () => void): string {
  const lines = splitSseLines(frame)
  const dataValues: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const content = index === 0 ? stripBom(lines[index].content) : lines[index].content
    const parsed = parseSseField(content)
    if (parsed?.field === "data") dataValues.push(parsed.value)
  }
  if (dataValues.length === 0) return frame

  let payload: unknown
  try {
    payload = JSON.parse(dataValues.join("\n"))
  } catch {
    return frame
  }
  if (!isRecord(payload)) return frame
  if (payload.type !== REASONING_DELTA_EVENT) return frame
  if (
    typeof payload.delta !== "string" ||
    !Number.isInteger(payload.output_index) ||
    (payload.output_index as number) < 0
  ) {
    onSchemaMismatch()
    return frame
  }

  const replacement = { ...payload, type: REASONING_TEXT_DELTA_EVENT }
  const replacementLine = `data: ${JSON.stringify(replacement)}`
  const output: string[] = []
  let replacedData = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const content = index === 0 ? stripBom(line.content) : line.content
    const bom = index === 0 && line.content.startsWith("\uFEFF") ? "\uFEFF" : ""
    const parsed = parseSseField(content)
    if (parsed?.field === "data") {
      if (!replacedData) {
        output.push(`${bom}${replacementLine}${line.ending}`)
        replacedData = true
      }
      continue
    }
    if (parsed?.field === "event" && parsed.value === REASONING_DELTA_EVENT) {
      output.push(`${bom}event: ${REASONING_TEXT_DELTA_EVENT}${line.ending}`)
      continue
    }
    output.push(`${line.content}${line.ending}`)
  }
  return output.join("")
}

/** Drops a leading UTF-8 BOM for field recognition only, never from output. */
function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content
}

/** Parses the JSON data of a complete frame, or returns undefined. */
function readDataPayload(frame: string): Record<string, unknown> | undefined {
  const lines = splitSseLines(frame)
  const dataValues: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const content = index === 0 ? stripBom(lines[index].content) : lines[index].content
    const parsed = parseSseField(content)
    if (parsed?.field === "data") dataValues.push(parsed.value)
  }
  if (dataValues.length === 0) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(dataValues.join("\n"))
  } catch {
    return undefined
  }
  return isRecord(payload) ? payload : undefined
}

/** Returns the output index of a frame payload, or undefined when unusable. */
function outputIndexOf(payload: Record<string, unknown>): number | undefined {
  const index = payload.output_index
  if (!Number.isInteger(index) || (index as number) < 0) return undefined
  return index as number
}

/**
 * Returns the plaintext reasoning text an item carries when it has no canonical
 * summary or content, or undefined when the item must stay untouched.
 */
function plaintextReasoningText(item: Record<string, unknown>): string | undefined {
  if (item.type !== "reasoning") return undefined
  if (Array.isArray(item.summary) && item.summary.length > 0) return undefined
  if (Array.isArray(item.content) && item.content.length > 0) return undefined
  const text = item.encrypted_content
  if (typeof text !== "string" || text.length === 0) return undefined
  return text
}

/**
 * Returns a canonical reasoning-text delta frame for a completed reasoning item
 * whose whole chain of thought is plaintext `encrypted_content`, or undefined.
 * The output index is recorded in `seen` so a later frame cannot repeat it.
 */
function injectPlaintextReasoningText(frame: string, seen: Set<number>): string | undefined {
  const payload = readDataPayload(frame)
  if (payload?.type !== OUTPUT_ITEM_DONE_EVENT) return undefined
  if (!isRecord(payload.item)) return undefined
  const outputIndex = outputIndexOf(payload)
  if (outputIndex === undefined || seen.has(outputIndex)) return undefined
  const text = plaintextReasoningText(payload.item)
  if (text === undefined) return undefined

  const delta: Record<string, unknown> = {
    type: REASONING_TEXT_DELTA_EVENT,
    output_index: outputIndex,
    content_index: 0,
    delta: text,
  }
  if (typeof payload.item.id === "string") delta.item_id = payload.item.id
  seen.add(outputIndex)
  const eol = frame.includes("\r\n") ? "\r\n" : "\n"
  return `event: ${REASONING_TEXT_DELTA_EVENT}${eol}data: ${JSON.stringify(delta)}${eol}${eol}`
}

/** Stateful splitter that emits one normalized frame per SSE event. */
class ResponsesSseNormalizer {
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true })
  private readonly encoder = new TextEncoder()
  private buffer = ""
  private scanIndex = 0
  private lineStart = 0
  private warned = false
  /** Output indexes that already carried reasoning text, to avoid duplicates. */
  private readonly reasoningTextIndexes = new Set<number>()

  constructor(
    private readonly onWarning?: (message: string) => void,
    private readonly plaintextReasoningContent = false,
  ) {}

  private normalize(frame: string): string {
    const normalized = normalizeResponsesSseFrame(frame, () => {
      if (this.warned) return
      this.warned = true
      try {
        this.onWarning?.(
          "Unsupported Command Code response.reasoning.delta shape; incremental reasoning may be unavailable. Original events were preserved.",
        )
      } catch {
        // Diagnostics must not interrupt a usable response stream.
      }
    })
    if (!this.plaintextReasoningContent) return normalized
    const payload = readDataPayload(normalized)
    if (payload?.type === REASONING_TEXT_DELTA_EVENT) {
      const index = payload.output_index
      if (Number.isInteger(index) && (index as number) >= 0) {
        this.reasoningTextIndexes.add(index as number)
      }
    }
    const injected = injectPlaintextReasoningText(normalized, this.reasoningTextIndexes)
    return injected === undefined ? normalized : injected + normalized
  }

  push(text: string, emit: (frame: string) => void, flush: boolean): void {
    this.buffer += text
    this.process(emit, flush)
  }

  finish(emit: (frame: string) => void): void {
    if (this.buffer.length === 0) return
    emit(this.normalize(this.buffer))
    this.buffer = ""
    this.scanIndex = 0
    this.lineStart = 0
  }

  private process(emit: (frame: string) => void, flush: boolean): void {
    while (this.scanIndex < this.buffer.length) {
      const code = this.buffer.charCodeAt(this.scanIndex)
      if (code === 0x0a) {
        this.consumeLine(this.scanIndex + 1, this.scanIndex, emit)
      } else if (code === 0x0d) {
        const next = this.scanIndex + 1
        if (next >= this.buffer.length) {
          if (!flush) return
          this.consumeLine(next, this.scanIndex, emit)
        } else if (this.buffer.charCodeAt(next) === 0x0a) {
          this.consumeLine(next + 1, this.scanIndex, emit)
        } else {
          this.consumeLine(next, this.scanIndex, emit)
        }
      } else {
        this.scanIndex += 1
      }
    }
  }

  private consumeLine(end: number, lineEnd: number, emit: (frame: string) => void): void {
    if (lineEnd === this.lineStart) {
      const frame = this.buffer.slice(0, end)
      emit(this.normalize(frame))
      this.buffer = this.buffer.slice(end)
      this.scanIndex = 0
      this.lineStart = 0
      return
    }
    this.lineStart = end
    this.scanIndex = end
  }

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    const text = this.decoder.decode(chunk, { stream: true })
    this.push(text, (frame) => controller.enqueue(this.encoder.encode(frame)), false)
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    this.push(
      this.decoder.decode(),
      (frame) => controller.enqueue(this.encoder.encode(frame)),
      true,
    )
    this.finish((frame) => controller.enqueue(this.encoder.encode(frame)))
  }
}

/**
 * Wraps a Command Code Responses HTTP response so streaming reasoning reaches
 * pi-ai. Returns the original response when it cannot be an SSE stream.
 * `plaintextReasoningContent` is opt-in per model; see the module comment.
 */
export function normalizeCommandCodeResponsesResponse(
  response: Response,
  onWarning?: (message: string) => void,
  options?: { plaintextReasoningContent?: boolean },
): Response {
  if (!response.ok) return response
  if (response.body === null) return response
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (mimeType !== SSE_MIME_TYPE) return response

  const normalizer = new ResponsesSseNormalizer(
    onWarning,
    options?.plaintextReasoningContent === true,
  )
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => normalizer.transform(chunk, controller),
      flush: (controller) => normalizer.flush(controller),
    }),
  )

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
