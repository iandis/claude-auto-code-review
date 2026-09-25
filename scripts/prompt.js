const { MAX_PATCH_CHARS, MAX_TOTAL_PATCH_CHARS, MAX_PROMPT_BYTES } = require("./constants");

const TRUNCATED_NOTE = "[patch truncated - read the file for full context]";

class PromptTooLargeError extends Error {
    constructor(fileCount) {
        super(
            `Review prompt is too large (${fileCount} files). ` +
            "Narrow the review with include_extensions, include_paths, exclude_extensions or exclude_paths."
        );
        this.name = "PromptTooLargeError";
        this.fileCount = fileCount;
    }
}

/**
 * Reduces GitHub PR file objects to the fields Claude needs and keeps the embedded patches
 * within the per-file and total budgets. Files whose patch does not fit are marked so Claude
 * reads them from the checkout instead.
 */
function simplifyFiles(files, { maxPatchChars = MAX_PATCH_CHARS, maxTotalChars = MAX_TOTAL_PATCH_CHARS } = {}) {
    let budget = maxTotalChars;

    return files.map(file => {
        let patch = file.patch;
        if (patch === undefined) {
            patch = "[no textual patch - binary file or diff too large]";
        } else if (patch.length > maxPatchChars || patch.length > budget) {
            const keep = Math.max(0, Math.min(maxPatchChars, budget));
            patch = keep > 0 ? `${patch.slice(0, keep)}\n${TRUNCATED_NOTE}` : TRUNCATED_NOTE;
            budget -= keep;
        } else {
            budget -= patch.length;
        }

        return {
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch
        };
    });
}

function renderPrompt({ owner, repo, pullNumber, headSha, baseSha, incrementalSince, fullReview, files, reviewRules }, budgets) {
    const scope = fullReview
        ? "This is a full on-demand review of this pull request. The list below contains every file in the PR diff that needs review, " +
          "regardless of any previous review."
        : incrementalSince
        ? `This is an INCREMENTAL review. A previous review covered the PR up to commit ${incrementalSince}. ` +
          `The list below contains only the PR files that changed since then. The patches still show each file's full PR diff; ` +
          `focus on what changed since ${incrementalSince} and do not repeat issues that were likely already reported.`
        : "This is the first review of this pull request. The list below contains every file in the PR diff that needs review.";

    let prompt = `You are an expert code reviewer analyzing a GitHub pull request as part of an automated CI pipeline. You must work independently without human interaction. Review for logical errors, bugs, and security issues.

<pull_request>
Repository: ${owner}/${repo}
Pull request: #${pullNumber}
Head commit (checked out in the working directory): ${headSha}
Merge base: ${baseSha}
</pull_request>

${scope}

Focus on:
- Real bugs and logic errors (high priority)
- Security vulnerabilities (high priority)
- Typos

Skip and do not comment on (but you can mention these in the summary):
- Formatting and code style preferences (the lowest priority)
- Performance issues
- Code maintainability issues
- Best practices

How to work:
- The PR head is checked out in the current working directory. Use the Read, Grep and Glob tools to examine the changed files and any surrounding code you need for context (callers, definitions, tests). Always base your findings on code you have actually read.
- Only review the files listed below. You may read other files for context, but do not comment on them.
- For each real issue, call mcp__github_inline_comment__create_inline_comment with:
  - path: the file path exactly as listed below
  - line: the line number in the NEW version of the file (for a range, also pass startLine as the first line and line as the last)
  - side: "RIGHT" (use "LEFT" only for issues on deleted lines, with old-file line numbers)
  - body: a specific, actionable description of the problem and how to fix it
  - confirmed: true
  The lines must be part of the diff shown in the patch, otherwise GitHub rejects the comment. Lines are 1-indexed.
- Do not post test or probe comments, and do not comment on trivial issues or style preferences.

When you are done, return the structured output with a "summary" field. The summary should ONLY include:
- A concise overview of what was changed in the code
- The overall quality assessment of the changes
- Any patterns or recurring issues observed
- DO NOT repeat the inline comments one by one
- DO NOT ask questions or request more information in the summary

Be concise but thorough in your review.
=> MODE NO-FALSE-POSITIVES IS ON.

<changed_files count="${files.length}">
${JSON.stringify(simplifyFiles(files, budgets), null, 2)}
</changed_files>`;

    if (reviewRules) {
        prompt += `\n\nAdditionally, adhere to the following custom review rules:\n<review_rules>\n${reviewRules}\n</review_rules>`;
    }

    return prompt;
}

/**
 * Builds the review prompt. If embedding the patches would exceed the prompt size limit, the
 * patches are dropped and Claude reads the files from the checkout instead.
 */
function buildPrompt(params, { maxPromptBytes = MAX_PROMPT_BYTES } = {}) {
    let prompt = renderPrompt(params);
    if (Buffer.byteLength(prompt) <= maxPromptBytes) {
        return prompt;
    }

    prompt = renderPrompt(params, { maxPatchChars: 0, maxTotalChars: 0 });
    if (Buffer.byteLength(prompt) <= maxPromptBytes) {
        return prompt;
    }

    throw new PromptTooLargeError(params.files.length);
}

module.exports = { buildPrompt, simplifyFiles, TRUNCATED_NOTE, PromptTooLargeError };
