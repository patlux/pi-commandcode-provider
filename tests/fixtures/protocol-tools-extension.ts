/** Deterministic test tools. No filesystem or network access. */
interface FixtureTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (
    id: string,
    args: { image?: string | null },
  ) => Promise<{
    content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]
    details: undefined
  }>
}
interface FixtureApi {
  registerTool(tool: FixtureTool): void
}

export default function (pi: FixtureApi) {
  pi.registerTool({
    name: "contract_read",
    label: "Contract read",
    description: "Return a synthetic image and text for protocol contract tests",
    parameters: {
      type: "object",
      properties: { image: { type: ["string", "null"] } },
      required: ["image"],
    },
    async execute(_id, args) {
      return {
        content: [
          { type: "text", text: `contract-result-${args.image}` },
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            mimeType: "image/png",
          },
        ],
        details: undefined,
      }
    },
  })
}
