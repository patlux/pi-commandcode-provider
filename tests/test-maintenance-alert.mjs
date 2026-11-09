import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import prettier from "prettier"
import * as alertModule from "../.github/scripts/maintenance-alert.mjs"

const { maintainAlert } = alertModule
const marker = "<!-- commandcode-maintenance:catalog -->"
const bot = { login: "github-actions[bot]" }
const incident = {
  number: 42,
  state: "open",
  body: `${marker}\n\nFailing evidence: /actions/runs/110`,
  user: bot,
}
const apiError = (status) => Object.assign(new Error(`Synthetic API error ${status}`), { status })

function fixture({
  conclusion = "failure",
  previous = "failure",
  issues = [],
  filterIssueLabels = false,
} = {}) {
  const repository = { full_name: "patlux/pi-commandcode-provider" }
  const run = {
    name: "Command Code catalog sync",
    path: ".github/workflows/model-metadata.yml",
    status: "completed",
    conclusion,
    head_branch: "main",
    repository,
    head_repository: repository,
    event: "schedule",
    workflow_id: 7,
    run_number: 12,
    run_attempt: 1,
    id: 120,
  }
  const f = {
    writes: [],
    calls: [],
    run,
    current: structuredClone(run),
    runs: [structuredClone(run), { ...run, run_number: 11, id: 110, conclusion: previous }],
    issues: structuredClone(issues),
    comments: [],
    label: true,
    failClose: false,
    beforeRead: () => {},
  }
  const read = (name, fn) => async (params) => {
    f.calls.push({ name, params })
    f.beforeRead(name, params)
    return { data: structuredClone(await fn(params)) }
  }
  const write =
    (name, fn = async () => {}) =>
    async (params) => {
      f.writes.push({ ...params, name })
      await fn(params)
      return { data: {} }
    }
  const page = (items, params) =>
    items.slice((params.page - 1) * params.per_page, params.page * params.per_page)
  f.github = {
    rest: {
      actions: {
        getWorkflowRun: read("getWorkflowRun", () => f.current),
        listWorkflowRuns: read("listWorkflowRuns", (params) => ({
          workflow_runs: page(
            f.runs.filter((item) => item.event === params.event),
            params,
          ),
        })),
      },
      issues: {
        // Other fixtures deliberately return out-of-contract items to exercise
        // ownership guards. Label-loss scenarios opt into the server's filter.
        listForRepo: read("listForRepo", (params) =>
          page(
            f.issues.filter(
              (item) =>
                !filterIssueLabels || !params.labels || item.labels?.includes(params.labels),
            ),
            params,
          ),
        ),
        listComments: read("listComments", (params) => page(f.comments, params)),
        getLabel: read("getLabel", () => {
          if (!f.label) throw apiError(404)
          return { name: "maintenance-alert" }
        }),
        createLabel: write("createLabel", (params) => {
          assert.equal(params.name, "maintenance-alert")
          f.label = true
        }),
        create: write("create", (params) => {
          f.issues.push({ ...params, number: 43, state: "open", user: bot })
        }),
        update: write("update", (params) => {
          if (f.failClose && params.state === "closed") throw apiError(503)
          Object.assign(
            f.issues.find((item) => item.number === params.issue_number),
            params,
          )
        }),
        createComment: write("createComment", (params) => {
          f.comments.push({ ...params, user: bot })
        }),
      },
    },
    // Compatibility for red/green replays against #163's original implementation.
    paginate: async (method) =>
      method === f.github.rest.actions.listWorkflowRuns ? f.runs : f.issues,
  }
  f.context = {
    repo: { owner: "patlux", repo: "pi-commandcode-provider" },
    payload: { workflow_run: run, repository: { default_branch: "main" } },
  }
  return f
}
const updates = (f) => f.writes.filter((item) => item.name === "update")

// R1: three separate regressions from the audit, not just the normal listed-head case.
test("second failure alerts with only the predecessor in the listing", async () => {
  const f = fixture()
  f.runs = [f.runs[1]]
  assert.equal(await maintainAlert(f), "created")
  assert.match(f.writes.at(-1).body, /Previous: \[run 11, attempt 1\].*runs\/110/)
})
test("second failure alerts when an earlier success follows the unlisted head", async () => {
  const f = fixture()
  f.runs = [f.runs[1], { ...f.run, id: 100, run_number: 10, conclusion: "success" }]
  assert.equal(await maintainAlert(f), "created")
})
test("links the immediate predecessor, not the second listed older failure", async () => {
  const f = fixture()
  f.runs = [f.runs[1], { ...f.run, id: 100, run_number: 10 }]
  assert.equal(await maintainAlert(f), "created")
  assert.match(f.writes.at(-1).body, /Previous: \[run 11, attempt 1\].*runs\/110/)
  assert.doesNotMatch(f.writes.at(-1).body, /runs\/100/)
})
test("creates a labeled, bot-owned actionable incident, without raw payload text", async () => {
  const f = fixture()
  f.run.logs = "SYNTHETIC_SECRET_DO_NOT_COPY"
  f.run.display_title = "SYNTHETIC_SECRET_DO_NOT_COPY"
  assert.equal(await maintainAlert(f), "created")
  const created = f.writes.at(-1)
  assert.ok(created.body.startsWith(marker))
  assert.match(created.body, /official pricing/)
  assert.match(created.body, /does not authorize a release/)
  assert.doesNotMatch(created.body, /SYNTHETIC_SECRET_DO_NOT_COPY/)
  assert.deepEqual(created.labels, ["maintenance-alert"])
  assert.deepEqual(created.assignees, ["patlux"])
})
test("updates and reopens the same owned issue without comments on failures", async () => {
  for (const state of ["open", "closed"]) {
    const f = fixture({ issues: [{ ...incident, state }] })
    assert.equal(await maintainAlert(f), "updated")
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].issue_number, 42)
    assert.equal(f.writes[0].state, "open")
  }
})
test("no incident on one failure, cancellation, neutral result or missing predecessor", async () => {
  for (const previous of ["success", "cancelled", "neutral", "skipped", "action_required"]) {
    const f = fixture({ previous })
    assert.equal(await maintainAlert(f), "below-threshold")
    assert.equal(f.writes.length, 0)
  }
  for (const conclusion of ["cancelled", "neutral", "skipped", "action_required"]) {
    const f = fixture({ conclusion })
    assert.equal(await maintainAlert(f), "below-threshold")
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  f.runs = []
  assert.equal(await maintainAlert(f), "below-threshold")
  assert.equal(f.writes.length, 0)
})
test("schedule/manual share a streak, timeout counts as a failure", async () => {
  const f = fixture({ conclusion: "timed_out", previous: "timed_out" })
  f.runs[1].event = "workflow_dispatch"
  assert.equal(await maintainAlert(f), "created")
})
test("uses latest predecessor across events, pages and unordered rerun results", async () => {
  const f = fixture()
  f.runs = Array.from({ length: 100 }, (_, n) => ({ ...f.run, id: 1000 + n, run_number: n + 1 }))
  f.run.run_number = 200
  f.current.run_number = 200
  f.runs.push({
    ...f.run,
    id: 1990,
    run_number: 199,
    conclusion: "success",
    event: "workflow_dispatch",
  })
  assert.equal(await maintainAlert(f), "below-threshold")
  assert.equal(f.writes.length, 0)
  assert.ok(f.calls.some((item) => item.name === "listWorkflowRuns" && item.params.page === 2))
  f.runs.at(-1).conclusion = "failure"
  assert.equal(await maintainAlert(f), "created")
  assert.match(f.writes.at(-1).body, /Previous: \[run 199/)
})
test("chooses the newest attempt of a predecessor instead of an older failure", async () => {
  const f = fixture()
  f.runs.push({ ...f.runs[1], run_attempt: 2, conclusion: "success" })
  f.runs.reverse()
  assert.equal(await maintainAlert(f), "below-threshold")
  assert.equal(f.writes.length, 0)
})

// R2: same run_number is not the same run attempt.
test("late attempt events cannot overwrite a newer attempt, in either direction", async () => {
  for (const conclusion of ["failure", "success"]) {
    for (const status of ["completed", "in_progress", "queued"]) {
      const f = fixture({ conclusion, issues: [incident] })
      f.current.run_attempt = 2
      f.current.status = status
      assert.equal(await maintainAlert(f), "stale")
      assert.equal(f.writes.length, 0)
    }
  }
})
test("a newer attempt in the listing protects against a lagging run GET", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  f.runs[0].run_attempt = 2
  f.runs[0].conclusion = "failure"
  assert.equal(await maintainAlert(f), "stale")
  assert.equal(f.writes.length, 0)
})
test("event stays authoritative when listing and GET lag behind its attempt/conclusion", async () => {
  for (const conclusion of ["failure", "success"]) {
    const f = fixture({ conclusion, issues: [incident] })
    f.run.run_attempt = 2
    f.current.conclusion = conclusion === "failure" ? "success" : "failure"
    assert.equal(await maintainAlert(f), conclusion === "success" ? "closed" : "updated")
  }
})
test("rejects a rerun that appears during the read phase before mutation", async () => {
  const f = fixture({ issues: [incident] })
  f.beforeRead = (name) => {
    if (name === "listForRepo") f.current.run_attempt = 2
  }
  assert.equal(await maintainAlert(f), "stale")
  assert.equal(f.writes.length, 0)
})
test("newer eligible completed run makes older success and failure events stale", async () => {
  for (const conclusion of ["success", "failure"]) {
    const f = fixture({ conclusion, issues: [incident] })
    f.runs.push({ ...f.run, run_number: 13, id: 130, event: "workflow_dispatch" })
    assert.equal(await maintainAlert(f), "stale")
    assert.equal(f.writes.length, 0)
  }
})

// Review P2: characterize accepted limits without changing the alert policy.
test("delayed recovery stays open after an isolated failure until a later success is processed", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  const nextFailure = {
    ...f.run,
    id: 130,
    run_number: 13,
    event: "workflow_dispatch",
    conclusion: "failure",
  }
  f.runs.unshift(nextFailure)
  assert.equal(await maintainAlert(f), "stale")
  f.context.payload.workflow_run = nextFailure
  f.current = structuredClone(nextFailure)
  assert.equal(await maintainAlert(f), "below-threshold")
  assert.equal(f.issues[0].state, "open")
  assert.equal(f.issues[0].body, incident.body)
  assert.equal(f.writes.length, 0)
  assert.equal(f.comments.length, 0)
  assert.ok(!f.calls.some((item) => item.name === "listForRepo"))

  // No deadline guarantees recovery: only a later processed success closes it.
  const laterSuccess = { ...nextFailure, id: 140, run_number: 14, conclusion: "success" }
  f.runs.unshift(laterSuccess)
  f.context.payload.workflow_run = laterSuccess
  f.current = structuredClone(laterSuccess)
  assert.equal(await maintainAlert(f), "closed")
  assert.equal(f.issues[0].state, "closed")
  assert.equal(f.issues[0].body, incident.body)
  assert.equal(f.comments.length, 1)
  assert.match(f.comments[0].body, /recovered:140:1/)
  assert.deepEqual(
    f.writes.map((item) => item.name),
    ["createComment", "update"],
  )
  assert.equal(updates(f)[0].issue_number, 42)
  assert.equal(updates(f)[0].body, undefined)
})
test("losing the reserved label permits a duplicate and hides the original from recovery", async () => {
  // Both deleting the label definition and merely removing it from the issue
  // violate the reserved-label contract. Recreating the definition is not enough.
  for (const labelPresent of [false, true]) {
    const f = fixture({
      issues: [{ ...incident, labels: [] }],
      filterIssueLabels: true,
    })
    f.label = labelPresent
    assert.equal(await maintainAlert(f), "created")
    assert.equal(f.label, true)
    assert.equal(f.issues.length, 2)
    assert.equal(f.issues[0].number, 42)
    assert.equal(f.issues[0].state, "open")
    assert.equal(f.issues[0].body, incident.body)
    assert.deepEqual(f.issues[0].labels, [])
    assert.equal(f.issues[1].number, 43)
    assert.deepEqual(f.issues[1].labels, ["maintenance-alert"])
    assert.deepEqual(
      f.writes.map((item) => item.name),
      labelPresent ? ["create"] : ["createLabel", "create"],
    )
    assert.equal(
      f.calls.find((item) => item.name === "listForRepo").params.labels,
      "maintenance-alert",
    )

    const recovery = { ...f.run, id: 130, run_number: 13, conclusion: "success" }
    f.runs.unshift(recovery)
    f.context.payload.workflow_run = recovery
    f.current = structuredClone(recovery)
    assert.equal(await maintainAlert(f), "closed")
    assert.equal(f.issues[1].state, "closed")
    assert.equal(f.issues[0].state, "open")
    assert.equal(f.issues[0].body, incident.body)
    assert.deepEqual(
      updates(f).map((item) => item.issue_number),
      [43],
    )
    assert.equal(f.comments[0].issue_number, 43)
  }
})

// R3: preserve evidence and survive partial comment/close failure without spam.
test("recovery comments once and closes without replacing failing-run body", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  assert.equal(await maintainAlert(f), "closed")
  assert.deepEqual(
    f.writes.map((item) => item.name),
    ["createComment", "update"],
  )
  assert.match(f.comments[0].body, /recovered:120:1/)
  assert.match(f.comments[0].body, /runs\/120\/attempts\/1/)
  assert.equal(updates(f)[0].body, undefined)
  assert.equal(f.issues[0].body, incident.body)
  f.writes = []
  assert.equal(await maintainAlert(f), "healthy")
  assert.equal(f.writes.length, 0)
})
test("retry after failed close reuses the recovery comment instead of duplicating", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  f.failClose = true
  await assert.rejects(maintainAlert(f), /Synthetic API error 503/)
  assert.equal(f.comments.length, 1)
  assert.equal(f.issues[0].state, "open")
  f.failClose = false
  assert.equal(await maintainAlert(f), "closed")
  assert.equal(f.comments.length, 1)
  assert.equal(f.issues[0].body, incident.body)
})
test("user-authored recovery marker cannot suppress the bot comment", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  f.comments = [
    { body: "<!-- commandcode-maintenance:catalog:recovered:120:1 -->", user: { login: "human" } },
  ]
  assert.equal(await maintainAlert(f), "closed")
  assert.equal(f.comments.length, 2)
})
test("healthy runs do not create labels, issues or comments", async () => {
  for (const issues of [[], [{ ...incident, state: "closed" }]]) {
    const f = fixture({ conclusion: "success", issues })
    f.label = false
    assert.equal(await maintainAlert(f), "healthy")
    assert.equal(f.writes.length, 0)
  }
})
test("reads later issue/comment pages and only early-stops on a recovery marker", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  f.issues.unshift(
    ...Array.from({ length: 100 }, (_, n) => ({ number: n + 100, body: "other", user: bot })),
  )
  f.comments = Array.from({ length: 100 }, () => ({ body: "other", user: bot }))
  f.comments.push({ body: "<!-- commandcode-maintenance:catalog:recovered:120:1 -->", user: bot })
  assert.equal(await maintainAlert(f), "closed")
  assert.equal(f.writes.length, 1)
  assert.ok(f.calls.some((item) => item.name === "listForRepo" && item.params.page === 2))
  assert.ok(f.calls.some((item) => item.name === "listComments" && item.params.page === 2))
})

test("untrusted triggers and malformed identities are rejected before API access", async () => {
  for (const override of [
    { name: "Latest host compatibility" },
    { path: ".github/workflows/untrusted.yml" },
    { status: "in_progress" },
    { event: "pull_request" },
    { event: "pull_request_target" },
    { event: "push" },
    { head_branch: "feature" },
    { repository: { full_name: "fork/repo" } },
    { head_repository: { full_name: "fork/repo" } },
    { id: 0 },
    { workflow_id: undefined },
    { run_number: "12" },
    { run_attempt: undefined },
  ]) {
    const f = fixture()
    Object.assign(f.run, override)
    assert.equal(await maintainAlert(f), "ignored")
    assert.equal(f.calls.length, 0)
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  f.context.repo.owner = "fork"
  assert.equal(await maintainAlert(f), "ignored")
  assert.equal(f.calls.length, 0)
})
test("per-item guards ignore foreign predecessors and foreign newer runs", async () => {
  for (const override of [
    { head_branch: "feature" },
    { head_repository: { full_name: "fork/repo" } },
    { repository: { full_name: "fork/repo" } },
    { workflow_id: 99 },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress" },
  ]) {
    const f = fixture()
    Object.assign(f.runs[1], override)
    assert.equal(await maintainAlert(f), "below-threshold")
    assert.equal(f.writes.length, 0)
    f.runs[1] = { ...f.run, id: 110, run_number: 11 }
    f.runs.push({ ...f.run, id: 130, run_number: 13, ...override })
    assert.equal(await maintainAlert(f), "created")
  }
})
test("fresh run identity failure or unavailable API fails closed", async () => {
  const f = fixture()
  f.current.id = 999
  await assert.rejects(maintainAlert(f), /run identity/)
  assert.equal(f.writes.length, 0)
  f.github.rest.actions.getWorkflowRun = async () => {
    throw apiError(403)
  }
  await assert.rejects(maintainAlert(f), /403/)
  assert.equal(f.writes.length, 0)
})
test("never edits human issues, PRs, misplaced markers or another incident type", async () => {
  const f = fixture({
    issues: [
      { ...incident, user: { login: "human" } },
      { ...incident, pull_request: {} },
      { ...incident, body: `prefix ${marker}` },
      { ...incident, body: "<!-- commandcode-maintenance:hosts -->" },
    ],
  })
  assert.equal(await maintainAlert(f), "created")
  assert.equal(updates(f).length, 0)
})
test("ambiguous bot-owned incidents require manual reconciliation", async () => {
  const f = fixture({ issues: [incident, { ...incident, number: 43 }] })
  await assert.rejects(maintainAlert(f), /Multiple maintenance incidents/)
  assert.equal(f.writes.length, 0)
})
test("API queries enforce workflow/event/branch and label/creator filters", async () => {
  const f = fixture()
  await maintainAlert(f)
  for (const { params } of f.calls.filter((item) => item.name === "listWorkflowRuns")) {
    assert.equal(params.workflow_id, 7)
    assert.equal(params.branch, "main")
    assert.equal(params.status, "completed")
    assert.ok(["schedule", "workflow_dispatch"].includes(params.event))
    assert.equal(params.per_page, 100)
  }
  const issueQuery = f.calls.find((item) => item.name === "listForRepo").params
  assert.equal(issueQuery.labels, "maintenance-alert")
  assert.equal(issueQuery.creator, bot.login)
  assert.equal(issueQuery.state, "all")
})
test("creates the reserved label only when the first incident needs it", async () => {
  const f = fixture()
  f.label = false
  assert.equal(await maintainAlert(f), "created")
  assert.deepEqual(
    f.writes.map((item) => item.name),
    ["createLabel", "create"],
  )
  assert.equal(f.writes[0].name === "createLabel" && f.writes[0].color, "d93f0b")
})
test("label creation race is tolerated only after confirming label exists", async () => {
  const f = fixture()
  f.label = false
  f.github.rest.issues.createLabel = async () => {
    f.label = true
    throw apiError(422)
  }
  assert.equal(await maintainAlert(f), "created")
  const broken = fixture()
  broken.label = false
  broken.github.rest.issues.createLabel = async () => {
    throw apiError(422)
  }
  await assert.rejects(maintainAlert(broken), /404/)
  assert.equal(broken.writes.length, 0)
})
test("label permission errors are not treated as missing labels", async () => {
  const f = fixture()
  f.github.rest.issues.getLabel = async () => {
    throw apiError(403)
  }
  await assert.rejects(maintainAlert(f), /403/)
  assert.equal(f.writes.length, 0)
})
test("bounded run/issue/comment scans fail closed on full limits", async () => {
  for (const target of ["runs", "issues", "comments"]) {
    const f = fixture({
      conclusion: target === "comments" ? "success" : "failure",
      issues: [incident],
    })
    if (target === "runs") f.runs = Array.from({ length: 1000 }, () => ({ ...f.runs[1] }))
    if (target === "issues")
      f.issues = Array.from({ length: 1000 }, () => ({ ...incident, body: "other" }))
    if (target === "comments")
      f.comments = Array.from({ length: 1000 }, () => ({ body: "other", user: bot }))
    await assert.rejects(maintainAlert(f), /pagination limit/)
    assert.equal(f.writes.length, 0)
    assert.ok(f.calls.every((item) => !item.params.page || item.params.page <= 10))
  }
})
test("stale evidence can safely stop an otherwise oversized history scan", async () => {
  const f = fixture()
  f.runs = Array.from({ length: 1000 }, () => ({ ...f.run, id: 130, run_number: 13 }))
  assert.equal(await maintainAlert(f), "stale")
  assert.equal(f.calls.filter((item) => item.name === "listWorkflowRuns").length, 1)
  assert.equal(f.writes.length, 0)
})

test("tracked identity, trigger, trusted checkout, permissions and test gate stay wired", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/maintenance-alert.yml", import.meta.url),
    "utf8",
  )
  const metadata = await readFile(
    new URL("../.github/workflows/model-metadata.yml", import.meta.url),
    "utf8",
  )
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(alertModule.catalogWorkflow?.name, metadata.match(/^name: (.+)$/m)?.[1])
  assert.equal(alertModule.catalogWorkflow?.path, ".github/workflows/model-metadata.yml")
  assert.equal(workflow.match(/workflows: \[(.+)\]/)?.[1], alertModule.catalogWorkflow.name)
  assert.match(workflow, /types: \[completed\]/)
  assert.match(workflow, /ref: \$\{\{ github.event.repository.default_branch \}\}/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /contents: read\n  actions: read\n  issues: write/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /github.repository == 'patlux\/pi-commandcode-provider'/)
  assert.match(workflow, /head_branch ==\s+github.event.repository.default_branch/)
  assert.match(workflow, /head_repository.full_name ==\s+github.repository/)
  assert.match(workflow, /event == 'schedule'/)
  assert.match(workflow, /event == 'workflow_dispatch'/)
  assert.equal([...workflow.matchAll(/uses: ([^\s]+)/g)].length, 2)
  for (const [, ref] of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(ref, /@[0-9a-f]{40}$/)
  assert.doesNotMatch(workflow, /npm |npx |download-artifact|workflow_run.head_sha|Latest host/)
  assert.match(pkg.scripts.test, /node --test [^&]*tests\/test-maintenance-alert.mjs/)
  for (const kept of [
    "test:diagnostics",
    "test:routing",
    "test-host-protocols.mjs",
    "test-endpoint-routing.mjs",
  ]) {
    assert.ok(pkg.scripts.test.includes(kept))
  }
})
test(
  "catalog pipes keep separate stderr reports, guard missing files and scope formatting",
  { skip: process.platform === "win32" ? "Workflow bash runs on ubuntu-latest" : false },
  async () => {
    const metadata = await readFile(
      new URL("../.github/workflows/model-metadata.yml", import.meta.url),
      "utf8",
    )
    const pipelines = [
      ...metadata.matchAll(
        /^\s+run: (npm run --silent .+ \| tee (commandcode-(?:catalog|pricing)-report.md))$/gm,
      ),
    ]
    assert.equal(pipelines.length, 4)
    assert.equal([...metadata.matchAll(/if \[ -f commandcode-catalog-report.md \]/g)].length, 2)
    assert.equal([...metadata.matchAll(/if \[ -f commandcode-pricing-report.md \]/g)].length, 2)
    assert.match(
      metadata,
      /npx --no-install prettier --write src\/commandcode-catalog.ts src\/commandcode-catalog-overrides.ts README.md/,
    )
    assert.doesNotMatch(metadata, /npm run format --/)
    // The narrowed --write above only rewrites sources, while `format:check` still globs
    // every markdown file: the generated reports must stay outside Prettier, otherwise the
    // sync job fails before it can open its pull request.
    const ignorePath = fileURLToPath(new URL("../.prettierignore", import.meta.url))
    for (const [, , report] of pipelines) {
      const info = await prettier.getFileInfo(
        fileURLToPath(new URL(`../${report}`, import.meta.url)),
        { ignorePath },
      )
      assert.equal(info.ignored, true, `${report} must stay outside the format checks`)
    }
    const sourceFile = await prettier.getFileInfo(
      fileURLToPath(new URL("../src/pricing.ts", import.meta.url)),
      { ignorePath },
    )
    assert.equal(sourceFile.ignored, false, "tracked sources must stay formatted")
    const directory = await mkdtemp(join(tmpdir(), "cc-alert-report-test-"))
    try {
      // Execute the exact workflow pipelines, but replace npm with a local function.
      for (const [, command, report] of pipelines) {
        const result = spawnSync(
          "bash",
          [
            "-eo",
            "pipefail",
            "-c",
            `npm() { printf '# Synthetic report\\n'; printf 'SYNTHETIC_STDERR\\n' >&2; return 2; }; ${command}`,
          ],
          { cwd: directory, encoding: "utf8" },
        )
        assert.equal(result.status, 2)
        const text = await readFile(join(directory, report), "utf8")
        assert.match(text, /# Synthetic report/)
        assert.match(text, /SYNTHETIC_STDERR/)
      }
      for (const [, guard] of metadata.matchAll(
        /^\s+(if \[ -f commandcode-(?:catalog|pricing)-report.md \]; then .+; fi)$/gm,
      )) {
        await rm(join(directory, "commandcode-catalog-report.md"), { force: true })
        await rm(join(directory, "commandcode-pricing-report.md"), { force: true })
        const summary = join(directory, "summary.md")
        await writeFile(summary, "")
        const result = spawnSync("bash", ["-eo", "pipefail", "-c", guard], {
          cwd: directory,
          env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
          encoding: "utf8",
        })
        assert.equal(result.status, 0)
        assert.equal(await readFile(summary, "utf8"), "")
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
