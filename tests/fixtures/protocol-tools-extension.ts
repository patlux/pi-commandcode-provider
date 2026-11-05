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

export default function (pi: FixtureApi, images: Readonly<Record<string, string>>) {
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
      const data = images[args.image ?? ""]
      if (!data) throw new Error(`Unknown contract image: ${args.image}`)
      return {
        content: [
          { type: "text", text: `contract-result-${args.image}` },
          {
            type: "image",
            data,
            mimeType: "image/png",
          },
        ],
        details: undefined,
      }
    },
  })
}
