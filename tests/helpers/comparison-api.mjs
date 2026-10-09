import { createServer } from "node:http"

/** Deterministic shared wire fixture for real Pi/PiG comparison and benchmarks. */
export async function comparisonAPI() {
  const requests = []
  let route = "provider"
  let toolPath
  let generateEvents
  let signed = false
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url === "/provider/v1/models") {
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4.1", name: "GPT", context_length: 128000 },
            { id: "claude-sonnet-4-6", name: "Claude", context_length: 200000 },
          ],
        }),
      )
      return
    }
    const raw = Buffer.concat(chunks).toString()
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) })
    if (route === "upgrade" && req.url !== "/alpha/generate") {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { code: "upgrade_required" } }))
      return
    }
    if (req.url === "/alpha/generate" && generateEvents) {
      const events = generateEvents
      generateEvents = undefined
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
      return
    }
    if (toolPath) {
      const path = toolPath
      toolPath = undefined
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const events =
        req.url === "/alpha/generate"
          ? [
              { type: "tool-input-start", id: "comparison-read", toolName: "read" },
              { type: "tool-input-delta", id: "comparison-read", delta: JSON.stringify({ path }) },
              // The terminal may omit input/name: streamed arguments are final.
              { type: "tool-call", toolCallId: "comparison-read" },
              // Repeated terminal events must not execute the tool again.
              {
                type: "tool-call",
                toolCallId: "comparison-read",
                toolName: "read",
                input: { path },
              },
              { type: "finish", finishReason: "tool-calls" },
            ]
          : [
              {
                id: "tool",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "comparison-read",
                          type: "function",
                          function: { name: "read", arguments: JSON.stringify({ path }) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { id: "tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            ]
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
      return
    }
    if (req.url === "/alpha/generate") {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const event of [
        { type: "reasoning-delta", text: "comparison thought" },
        { type: "reasoning-end" },
        { type: "text-delta", text: "comparison-ok" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 11, outputTokens: 4 } },
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
      return
    }
    if (new URL(req.url, "http://127.0.0.1").pathname === "/provider/v1/messages") {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "comparison",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [],
            usage: { input_tokens: 11, output_tokens: 0 },
          },
        },
        ...(signed
          ? [
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: "comparison thought" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "signature_delta", signature: "comparison-signature" },
              },
              { type: "content_block_stop", index: 0 },
            ]
          : []),
        {
          type: "content_block_start",
          index: signed ? 1 : 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: signed ? 1 : 0,
          delta: { type: "text_delta", text: "comparison-ok" },
        },
        { type: "content_block_stop", index: signed ? 1 : 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
      return
    }
    if (req.url !== "/provider/v1/chat/completions") {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const send = (delta, finishReason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "comparison",
          object: "chat.completion.chunk",
          model: "gpt-4.1",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason
            ? { usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }
            : {}),
        })}\n\n`,
      )
    send({ role: "assistant", content: "comparison-" })
    send({ content: "ok" })
    send({}, "stop")
    res.end("data: [DONE]\n\n")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}/provider/v1`
  return {
    requests,
    base,
    setRoute(next) {
      route = next
    },
    nextTool(path) {
      toolPath = path
    },
    nextGenerateEvents(events) {
      generateEvents = events
    },
    signedThinking(enabled) {
      signed = enabled
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
