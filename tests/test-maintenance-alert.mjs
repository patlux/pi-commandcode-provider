import assert from "node:assert/strict"
import { test } from "node:test"
import { maintainAlert } from "../.github/scripts/maintenance-alert.mjs"

function fixture({
  conclusion = "failure",
  previous = "failure",
  issues = [],
  event = "schedule",
  branch = "main",
  fork = false,
  extra = [],
} = {}) {
  const writes = []
  const repo = { full_name: "patlux/pi-commandcode-provider" }
  const run = {
    name: "Command Code catalog sync",
    status: "completed",
    conclusion,
    head_branch: branch,
    repository: repo,
    head_repository: fork ? { full_name: "fork/repo" } : repo,
    event,
    workflow_id: 7,
    run_number: 12,
    id: 120,
  }
  const methods = {
    actions: { listWorkflowRuns: "runs" },
    issues: {
      listForRepo: "issues",
      create: async (value) => writes.push(value),
      update: async (value) => writes.push(value),
    },
  }
  const github = {
    rest: methods,
    paginate: async (method) =>
      method === "runs"
        ? [run, { ...run, run_number: 11, id: 110, conclusion: previous }, ...extra]
        : issues,
  }
  const context = {
    repo: { owner: "patlux", repo: "pi-commandcode-provider" },
    payload: { workflow_run: run, repository: { default_branch: "main" } },
  }
  return { github, context, writes }
}
const incident = {
  number: 42,
  state: "open",
  body: "<!-- commandcode-maintenance:catalog -->\nold",
  user: { login: "github-actions[bot]" },
}

test("creates an actionable issue after two failures without including raw logs", async () => {
  const f = fixture()
  assert.equal(await maintainAlert(f), "created")
  assert.equal(f.writes.length, 1)
  assert.match(f.writes[0].body, /actions\/runs\/120/)
  assert.match(f.writes[0].body, /official pricing/)
  assert.deepEqual(f.writes[0].assignees, ["patlux"])
})
test("updates/reopens the same bot-owned incident instead of duplicating", async () => {
  for (const state of ["open", "closed"]) {
    const f = fixture({ issues: [{ ...incident, state }] })
    assert.equal(await maintainAlert(f), "updated")
    assert.equal(f.writes[0].issue_number, 42)
    assert.equal(f.writes[0].state, "open")
  }
})
test("closes an incident after recovery", async () => {
  const f = fixture({ conclusion: "success", issues: [incident] })
  assert.equal(await maintainAlert(f), "closed")
  assert.equal(f.writes[0].state, "closed")
})
test("does not notify on a single failure, canceled run, or missing predecessor", async () => {
  for (const settings of [
    { previous: "success" },
    { previous: "cancelled" },
    { conclusion: "cancelled" },
  ]) {
    const f = fixture(settings)
    assert.equal(await maintainAlert(f), "below-threshold")
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  f.github.paginate = async () => []
  assert.equal(await maintainAlert(f), "below-threshold")
})
test("ignores forks, PRs and non-default branches", async () => {
  for (const settings of [{ fork: true }, { event: "pull_request" }, { branch: "feature" }]) {
    const f = fixture(settings)
    assert.equal(await maintainAlert(f), "ignored")
    assert.equal(f.writes.length, 0)
  }
})
test("ignores stale reruns after a newer completed run", async () => {
  const f = fixture({ extra: [{ run_number: 13, event: "schedule", conclusion: "success" }] })
  assert.equal(await maintainAlert(f), "stale")
  assert.equal(f.writes.length, 0)
})
test("does not edit user-authored matching issues or PRs", async () => {
  const f = fixture({
    issues: [
      { ...incident, user: { login: "someone" } },
      { ...incident, pull_request: {} },
    ],
  })
  assert.equal(await maintainAlert(f), "created")
  assert.equal(f.writes[0].issue_number, undefined)
})
test("tracks host failures independently", async () => {
  const f = fixture({ issues: [incident] })
  f.context.payload.workflow_run.name = "Latest host compatibility"
  assert.equal(await maintainAlert(f), "created")
  assert.match(f.writes[0].body, /maintenance:hosts/)
})
