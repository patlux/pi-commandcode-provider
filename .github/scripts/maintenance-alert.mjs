const tracked = new Map([
  [
    "Command Code catalog sync",
    {
      key: "catalog",
      title: "Maintenance: repeated catalog sync failures",
      action:
        "Inspect the catalog/parser and pricing reports separately. Reproduce with npm run check:commandcode-catalog and npm run check:commandcode-pricing. Review CLI schema changes and official pricing; never automatically copy or zero unknown prices.",
    },
  ],
  [
    "Latest host compatibility",
    {
      key: "hosts",
      title: "Maintenance: repeated latest-host compatibility failures",
      action:
        "Inspect the recorded Pi/OMP versions and failing mock suite. Reproduce with those exact hosts, compare the pinned CI baseline, and add a regression test before changing the supported pins.",
    },
  ],
])

/** Uses only trusted workflow identity/conclusions, never logs or artifact text. */
export async function maintainAlert({ github, context }) {
  const run = context.payload.workflow_run
  const repo = context.repo
  const defaultBranch = context.payload.repository.default_branch
  const config = tracked.get(run?.name)
  if (
    !config ||
    run.status !== "completed" ||
    run.head_branch !== defaultBranch ||
    run.repository?.full_name !== `${repo.owner}/${repo.repo}` ||
    run.head_repository?.full_name !== `${repo.owner}/${repo.repo}` ||
    !["schedule", "workflow_dispatch"].includes(run.event)
  )
    return "ignored"
  const marker = `<!-- commandcode-maintenance:${config.key} -->`
  const recent = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: run.workflow_id,
    branch: defaultBranch,
    status: "completed",
    per_page: 100,
  })
  const eligible = recent
    .filter(
      (item) =>
        item.run_number <= run.run_number &&
        ["schedule", "workflow_dispatch"].includes(item.event) &&
        item.head_repository?.full_name === `${repo.owner}/${repo.repo}`,
    )
    .sort((a, b) => b.run_number - a.run_number)
  // An older completion/rerun must not overwrite a newer incident or recovery.
  if (
    recent.some(
      (item) =>
        item.run_number > run.run_number && ["schedule", "workflow_dispatch"].includes(item.event),
    )
  )
    return "stale"
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: "all",
    creator: "github-actions[bot]",
    per_page: 100,
  })
  const issue = issues.find(
    (item) =>
      !item.pull_request &&
      item.body?.startsWith(marker) &&
      item.user?.login === "github-actions[bot]",
  )
  if (run.conclusion === "success") {
    if (issue?.state === "open") {
      await github.rest.issues.update({
        ...repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: "completed",
        body: `${marker}\n\nRecovered in [run ${run.run_number}](https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}).\n\n${config.action}`,
      })
      return "closed"
    }
    return "healthy"
  }
  const failed = (item) => ["failure", "timed_out"].includes(item?.conclusion)
  if (!failed(run) || eligible.length < 2 || !failed(eligible[0]) || !failed(eligible[1]))
    return "below-threshold"
  const body = `${marker}\n\nTwo consecutive scheduled/manual default-branch runs failed.\n\n- Latest: [run ${run.run_number}](https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id})\n- Previous: [run ${eligible[1].run_number}](https://github.com/${repo.owner}/${repo.repo}/actions/runs/${eligible[1].id})\n\n${config.action}\n\nThis issue is updated rather than duplicated and closes after a successful run. No logs, payloads or credentials are copied here. This alert does not authorize a release.`
  if (issue) {
    await github.rest.issues.update({
      ...repo,
      issue_number: issue.number,
      state: "open",
      title: config.title,
      body,
    })
    return "updated"
  }
  await github.rest.issues.create({ ...repo, title: config.title, body, assignees: [repo.owner] })
  return "created"
}
