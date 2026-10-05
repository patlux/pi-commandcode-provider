/**
 * Normalizes Command Code's non-standard Responses reasoning deltas.
 *
 * Command Code emits `response.reasoning.delta` while a reasoning item is still
 * streaming, but pi-ai 1.0.3 only understands the canonical
 * `response.reasoning_text.delta`. Without translation the deltas are dropped
 * and the reasoning text only appears at `response.output_item.done`. Rewriting
 * the frame in flight restores incremental thinking without touching any other
 * Responses event.
 */

const SSE_MIME_TYPE = "text/event-stream"
const REASONING_DELTA_EVENT = "response.reasoning.delta"
const REASONING_TEXT_DELTA_EVENT = "response.reasoning_text.delta"

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
function normalizeResponsesSseFrame(frame: string): string {
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
  if (typeof payload.delta !== "string") return frame
  if (!Number.isInteger(payload.output_index) || (payload.output_index as number) < 0) return frame

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

/** Stateful splitter that emits one normalized frame per SSE event. */
class ResponsesSseNormalizer {
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true })
  private readonly encoder = new TextEncoder()
  private buffer = ""
  private scanIndex = 0
  private lineStart = 0

  push(text: string, emit: (frame: string) => void, flush: boolean): void {
    this.buffer += text
    this.process(emit, flush)
  }

  finish(emit: (frame: string) => void): void {
    if (this.buffer.length === 0) return
    emit(this.buffer)
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
      emit(normalizeResponsesSseFrame(frame))
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
 * Wraps a Command Code Responses HTTP response so streaming reasoning deltas
 * reach pi-ai. Returns the original response when it cannot be an SSE stream.
 */
export function normalizeCommandCodeResponsesResponse(response: Response): Response {
  if (!response.ok) return response
  if (response.body === null) return response
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (mimeType !== SSE_MIME_TYPE) return response

  const normalizer = new ResponsesSseNormalizer()
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
