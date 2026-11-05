// Carries the maintenance-alert contribution by Patrick Wozniak (@patlux), PR #163.
// Keep this identity in sync with both workflow YAML files; tested by test-maintenance-alert.
export const catalogWorkflow = Object.freeze({
  name: "Command Code catalog sync",
  path: ".github/workflows/model-metadata.yml",
  key: "catalog",
  title: "Maintenance: repeated catalog sync failures",
  action:
    "Inspect the catalog/parser and pricing reports separately. Reproduce with npm run check:commandcode-catalog and npm run check:commandcode-pricing. Review CLI schema changes and official pricing; never automatically copy or zero unknown prices.",
})

const LABEL = "maintenance-alert"
const BOT = "github-actions[bot]"
const MAX_PAGES = 10
const PER_PAGE = 100
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const failed = (run) => ["failure", "timed_out"].includes(run.conclusion)
const botOwned = (item, marker) =>
  !item.pull_request && item.user?.login === BOT && item.body?.startsWith(marker)

// Explicit bounds fail closed rather than making a decision from truncated history.
// Do not assume API page order is run_number order (notably after reruns).
async function listBounded(method, params, select, visit = () => false) {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await method({ ...params, per_page: PER_PAGE, page })
    const batch = select(data)
    if (!Array.isArray(batch)) throw new Error("Unexpected maintenance API response")
    items.push(...batch)
    if (visit(batch)) return items
    if (batch.length < PER_PAGE) return items
  }
  throw new Error("Maintenance history exceeds the safe pagination limit; investigate manually")
}

async function ensureLabel(github, repo) {
  try {
    await github.rest.issues.getLabel({ ...repo, name: LABEL })
  } catch (error) {
    if (error.status !== 404) throw error
    try {
      await github.rest.issues.createLabel({
        ...repo,
        name: LABEL,
        color: "d93f0b",
        description: "Deduplicated automated maintenance incidents",
      })
    } catch (creationError) {
      // A concurrent creator may have won. Other validation/errors still fail closed.
      if (creationError.status !== 422) throw creationError
      await github.rest.issues.getLabel({ ...repo, name: LABEL })
    }
  }
}

/** Uses only trusted workflow identity/conclusions, never logs or artifact text. */
export async function maintainAlert({ github, context }) {
  const run = context.payload.workflow_run
  const repo = context.repo
  const fullName = `${repo.owner}/${repo.repo}`
  const defaultBranch = context.payload.repository?.default_branch
  const trusted = (item) =>
    item?.name === catalogWorkflow.name &&
    item.path === catalogWorkflow.path &&
    item.head_branch === defaultBranch &&
    item.repository?.full_name === fullName &&
    item.head_repository?.full_name === fullName &&
    ["schedule", "workflow_dispatch"].includes(item.event) &&
    positiveInteger(item.id) &&
    positiveInteger(item.workflow_id) &&
    positiveInteger(item.run_number) &&
    positiveInteger(item.run_attempt)
  if (
    fullName !== "patlux/pi-commandcode-provider" ||
    !defaultBranch ||
    !trusted(run) ||
    run.status !== "completed"
  )
    return "ignored"
  if (run.conclusion !== "success" && !failed(run)) return "below-threshold"

  const eligible = (item) =>
    trusted(item) && item.workflow_id === run.workflow_id && item.status === "completed"
  const newer = (item) =>
    eligible(item) &&
    (item.run_number > run.run_number || (item.id === run.id && item.run_attempt > run.run_attempt))
  const staleAttempt = async () => {
    const { data: current } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })
    if (
      !trusted(current) ||
      current.id !== run.id ||
      current.workflow_id !== run.workflow_id ||
      current.run_number !== run.run_number
    )
      throw new Error("Could not verify the triggering maintenance run identity")
    // The event remains authoritative if GET/listing is behind. A later attempt,
    // including an in-progress rerun, must never be overwritten by an old event.
    return current.run_attempt > run.run_attempt
  }
  if (await staleAttempt()) return "stale"

  let previous
  for (const event of ["schedule", "workflow_dispatch"]) {
    const recent = await listBounded(
      github.rest.actions.listWorkflowRuns,
      { ...repo, workflow_id: run.workflow_id, branch: defaultBranch, status: "completed", event },
      (data) => data.workflow_runs,
      (batch) => batch.some(newer),
    )
    if (recent.some(newer)) return "stale"
    for (const item of recent) {
      if (!eligible(item) || item.run_number >= run.run_number) continue
      if (
        !previous ||
        item.run_number > previous.run_number ||
        (item.run_number === previous.run_number && item.run_attempt > previous.run_attempt)
      )
        previous = item
    }
  }
  // The payload is the head even when the listing has not caught up yet.
  if (failed(run) && (!previous || !failed(previous))) return "below-threshold"

  const marker = `<!-- commandcode-maintenance:${catalogWorkflow.key} -->`
  const issues = await listBounded(
    github.rest.issues.listForRepo,
    { ...repo, state: "all", creator: BOT, labels: LABEL },
    (data) => data,
  )
  const owned = issues.filter((item) => botOwned(item, marker))
  if (owned.length > 1) throw new Error("Multiple maintenance incidents match; reconcile manually")
  const issue = owned[0]
  if (run.conclusion === "success" && issue?.state !== "open") return "healthy"
  // Recheck after the read phase, before any label/comment/issue mutation.
  if (await staleAttempt()) return "stale"
  const link = (item) =>
    `[run ${item.run_number}, attempt ${item.run_attempt}](https://github.com/${fullName}/actions/runs/${item.id}/attempts/${item.run_attempt})`
  if (run.conclusion === "success") {
    const recoveryMarker = `<!-- commandcode-maintenance:${catalogWorkflow.key}:recovered:${run.id}:${run.run_attempt} -->`
    const comments = await listBounded(
      github.rest.issues.listComments,
      { ...repo, issue_number: issue.number },
      (data) => data,
      (batch) => batch.some((item) => botOwned(item, recoveryMarker)),
    )
    if (!comments.some((item) => botOwned(item, recoveryMarker))) {
      await github.rest.issues.createComment({
        ...repo,
        issue_number: issue.number,
        body: `${recoveryMarker}\n\nRecovered in ${link(run)}.`,
      })
    }
    // Keep the failing-run links in the incident body. If close fails after the
    // comment succeeds, a retry finds the marker instead of posting it twice.
    await github.rest.issues.update({
      ...repo,
      issue_number: issue.number,
      state: "closed",
      state_reason: "completed",
    })
    return "closed"
  }
  const body = `${marker}\n\nTwo consecutive scheduled/manual default-branch runs failed.\n\n- Latest: ${link(run)}\n- Previous: ${link(previous)}\n\n${catalogWorkflow.action}\n\nThis issue is updated rather than duplicated and closes after a successful run. No logs, payloads or credentials are copied here. This alert does not authorize a release.`
  if (issue) {
    await github.rest.issues.update({
      ...repo,
      issue_number: issue.number,
      state: "open",
      title: catalogWorkflow.title,
      body,
    })
    return "updated"
  }
  await ensureLabel(github, repo)
  await github.rest.issues.create({
    ...repo,
    title: catalogWorkflow.title,
    body,
    labels: [LABEL],
    assignees: [repo.owner],
  })
  return "created"
}
