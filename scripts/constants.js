/**
 * Common constants used across the action scripts
 */

// Comment prefix used to identify Claude review summary comments (first line of the comment)
const REVIEW_COMMENT_PREFIX = "Claude review done up to commit: ";

// Separator for the summary section in review comments
const SUMMARY_SEPARATOR = "\n\n### Claude Review Summary:\n";

// Maximum size of the review rules file (in bytes)
const MAX_RULES_BYTES = 16 * 1024;

// Maximum characters of a single file patch embedded in the prompt
const MAX_PATCH_CHARS = 15_000;

// Maximum characters of all patches embedded in the prompt
const MAX_TOTAL_PATCH_CHARS = 60_000;

// The prompt reaches claude-code-action as an input, i.e. an environment variable, and Linux
// limits a single environment string to 128KB (MAX_ARG_STRLEN), so stay well below that.
const MAX_PROMPT_BYTES = 100 * 1024;

// GitHub's "List pull request files" API returns at most this many files
const MAX_PR_FILES = 3000;

// GitHub's "Compare two commits" API lists at most this many changed files
const MAX_COMPARE_FILES = 300;

// Hidden marker in the "PR too large" comment, so it is posted only once per PR
const TOO_LARGE_COMMENT_MARKER = "<!-- claude-auto-code-review:too-large -->";

// Login that posts comments when the action runs with the default GITHUB_TOKEN
const DEFAULT_BOT_LOGIN = "github-actions[bot]";

module.exports = {
    REVIEW_COMMENT_PREFIX,
    SUMMARY_SEPARATOR,
    MAX_RULES_BYTES,
    MAX_PATCH_CHARS,
    MAX_TOTAL_PATCH_CHARS,
    MAX_PROMPT_BYTES,
    MAX_PR_FILES,
    MAX_COMPARE_FILES,
    TOO_LARGE_COMMENT_MARKER,
    DEFAULT_BOT_LOGIN
};
