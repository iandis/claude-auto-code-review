# Claude Auto Code Review

A GitHub Action that reviews pull requests with **Claude Code**, authenticated with your **Claude subscription** (OAuth token) instead of an API key.

- **No GitHub App required.** It reads the PR and posts comments with the workflow's `GITHUB_TOKEN`, so you don't need org admin rights to install the Claude GitHub App.
- **Incremental.** The first run reviews the whole PR diff. Each later push reviews only the PR files touched since the last reviewed commit. Pushing nothing new skips the review.
- **Inline comments + summary.** Claude posts an inline comment for each real bug or security issue, then the action posts a summary comment that records the reviewed commit.
- **Read-only Claude.** Claude can only use `Read`, `Grep`, `Glob` and the inline-comment tool. Bash, file edits and web access are disabled.

It wraps the official [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) and adds file selection, incremental review and summary tracking around it.

## Setup

1. Generate a long-lived token on your machine (needs a Pro, Max, Team or Enterprise plan):
   ```sh
   claude setup-token
   ```
2. In your repository, add it as an Actions secret named `CLAUDE_CODE_OAUTH_TOKEN` (**Settings → Secrets and variables → Actions**).
3. Add `.github/workflows/claude-review.yml`:

```yaml
name: Claude PR review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: claude-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: iandis/claude-auto-code-review@v1.0
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

That's it. You don't need a checkout step; the action does a shallow checkout of the PR head itself.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `claude_code_oauth_token` | yes | | OAuth token from `claude setup-token`. Pass it from a secret. |
| `github_token` | no | `${{ github.token }}` | Token used to read the PR and post comments. |
| `model` | no | `claude-sonnet-5` | Model name or alias, e.g. `claude-opus-5-5`, `sonnet`, `opus`. |
| `effort` | no | model default | Effort level: `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | no | `50` | Max agentic turns per review. |
| `include_extensions` | no | all | Comma-separated extensions to review, e.g. `.py,.js,.html`. |
| `exclude_extensions` | no | none | Comma-separated extensions to skip. |
| `include_paths` | no | all | Comma-separated path prefixes to review, e.g. `src/,app/`. |
| `exclude_paths` | no | none | Comma-separated path prefixes to skip, e.g. `test/,docs/`. |
| `review_rules_file` | no | | Path to a file with extra review rules, added to the prompt. Read from the PR's **base** branch, so a PR can't change the rules it's reviewed with. |
| `fail_action_if_review_failed` | no | `false` | Fail the job when the review can't complete. Otherwise it only warns. |
| `allowed_bots` | no | | Bot accounts whose PRs may be reviewed, e.g. `dependabot[bot]`, or `*`. By default, PRs opened by bots are rejected by the underlying action. |
| `checkout` | no | `true` | Shallow-checkout the PR head so Claude can read surrounding code. Set to `false` if your job already checks out the PR head. |

## Outputs

| Output | Description |
|---|---|
| `skipped` | `true` when there was nothing new to review. |
| `reviewed_commit` | Head commit recorded as reviewed (empty if the review didn't complete). |
| `summary` | The summary posted to the PR. |

## How incremental review works

1. The action lists the PR's changed files through the GitHub API. This is the same diff as the "Files changed" tab, so changes that came in by merging the base branch are excluded.
2. It looks for the newest comment from the action's own account that starts with `Claude review done up to commit: <sha>`.
   - No such comment: review every file in the diff (after filters).
   - `<sha>` is the current head: skip.
   - Otherwise: review only the PR files changed between `<sha>` and the head.
3. After a successful review, it posts a new summary comment with the head commit. If the review fails, no commit is recorded, so the next run retries the same files.

To force a full re-review, delete the summary comments from the PR and re-run the workflow.

## Notes

- **Fork PRs:** GitHub doesn't give secrets to workflows triggered by pull requests from forks, so reviews only run for branches in the same repository.
- **Whose subscription:** the OAuth token belongs to the person who ran `claude setup-token`. Reviews count against that person's plan usage limits. For shared or org-wide use, Anthropic recommends an API key with the official action instead.
- **Timeouts and cost:** use `max_turns`, filters, `timeout-minutes` and `concurrency` (as in the example) to keep runs bounded.

## Troubleshooting

- **"must run on a pull_request event":** trigger the workflow on `pull_request` (or `pull_request_target`).
- **No inline comments appear:** comments must land on lines that are part of the diff. Check the job log for rejected comments. Make sure the workflow has `pull-requests: write`.
- **Authentication errors:** check the token locally with `claude`, then regenerate it with `claude setup-token` if needed.
