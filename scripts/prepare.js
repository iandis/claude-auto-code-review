const path = require("path");

const { buildPrompt } = require("./prompt");
const { REVIEW_COMMENT_PREFIX, MAX_RULES_BYTES, DEFAULT_BOT_LOGIN } = require("./constants");

/* -------------------------------------------------------------------------- */
/*                               Sanitizers                                   */
/* -------------------------------------------------------------------------- */

function sanitizeString(value, { maxLen = 10_000 } = {}) {
    if (value === null || value === undefined) {
        return "";
    }
    // eslint-disable-next-line no-control-regex
    return String(value).trim().slice(0, maxLen).replace(/[\u0000-\u001F\u007F]/g, "");
}

function sanitizePath(value) {
    const str = sanitizeString(value);
    if (!str) {
        return "";
    }
    const safe = str.replace(/[<>:"|?*]/g, "_");
    const normalized = path.posix.normalize(safe).replace(/^(\.\.(\/|\\|$))+/, "");
    return normalized === "." ? "" : normalized;
}

function toList(str) {
    return str ? str.split(",").map(s => s.trim()).filter(Boolean) : [];
}

/* -------------------------------------------------------------------------- */
/*                               Pure helpers                                 */
/* -------------------------------------------------------------------------- */

function filterChangedFiles(changedFiles, { includeExtensions, excludeExtensions, includePaths, excludePaths }) {
    const incExt = toList(includeExtensions);
    const excExt = toList(excludeExtensions);
    const incPath = toList(includePaths).map(sanitizePath).filter(Boolean);
    const excPath = toList(excludePaths).map(sanitizePath).filter(Boolean);

    return changedFiles.filter(file => {
        const filePath = file.filename.replace(/\\/g, "/");
        const ext = path.posix.extname(filePath);

        const extAllowed = !incExt.length || incExt.includes(ext);
        const extExcluded = excExt.includes(ext);
        const inAllowedPath = !incPath.length || incPath.some(p => filePath.startsWith(p));
        const inExcludedPath = excPath.some(p => filePath.startsWith(p));

        return extAllowed && !extExcluded && inAllowedPath && !inExcludedPath;
    });
}

/**
 * Returns the commit recorded by the newest summary comment posted by `botLogin`, or null.
 * Only the action's own comments count, so nobody else can mark commits as reviewed.
 */
function findLastReviewedCommit(comments, botLogin) {
    const pattern = new RegExp(`^${REVIEW_COMMENT_PREFIX.trim()}\\s*([0-9a-f]{7,40})\\b`);
    for (const comment of [...comments].reverse()) {
        if (!comment.body || comment.user?.login !== botLogin) {
            continue;
        }
        const match = comment.body.match(pattern);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/* -------------------------------------------------------------------------- */
/*                               GitHub helpers                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the merge base between the current tip of the base branch and the given head.
 * pull_request.base.sha is the base tip as of PR creation and never advances, so it is not
 * the merge base once the base branch has been merged into the PR branch.
 */
async function getMergeBase(github, core, { owner, repo, baseRef, headSha }) {
    try {
        const { data } = await github.rest.repos.compareCommits({ owner, repo, base: baseRef, head: headSha, per_page: 1 });
        return data.merge_base_commit?.sha ?? null;
    } catch (error) {
        core.warning(`Merge base lookup failed: ${error.message}`);
        return null;
    }
}

async function getBotLogin(github) {
    try {
        const { data } = await github.rest.users.getAuthenticated();
        return data.login;
    } catch {
        // Installation tokens (the default GITHUB_TOKEN) cannot call /user; they comment as github-actions[bot].
        return DEFAULT_BOT_LOGIN;
    }
}

async function loadReviewRules(github, core, { owner, repo, ref, filePath }) {
    if (!filePath) {
        core.info("No custom review rules file specified.");
        return null;
    }
    try {
        const { data } = await github.rest.repos.getContent({ owner, repo, path: filePath, ref });
        if (Array.isArray(data) || data.type !== "file") {
            core.warning(`Review rules path ${filePath} is not a file`);
            return null;
        }
        if (data.size > MAX_RULES_BYTES) {
            core.warning(`Review rules file ${filePath} is too large (${data.size} bytes), ignoring it`);
            return null;
        }
        core.info(`Loaded review rules from ${filePath}@${ref}`);
        return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    } catch (error) {
        core.warning(`Could not load review rules from ${filePath}: ${error.message}`);
        return null;
    }
}

/**
 * Picks the files to review: the whole PR diff on the first run, otherwise only the PR files
 * touched since the last reviewed commit.
 */
async function selectChangedFiles(github, core, { owner, repo, pullNumber, headSha, botLogin }) {
    // The authoritative PR diff ("Files changed" tab). Files that only reached the PR branch
    // through a merge of the base branch are identical on both sides of the merge base.
    const prFiles = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 });
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 });
    const lastReviewedCommit = findLastReviewedCommit(comments, botLogin);

    if (!lastReviewedCommit) {
        core.info("No previous review comment found, reviewing all files in PR");
        return { prFiles, changedFiles: prFiles, incrementalSince: null };
    }
    if (lastReviewedCommit === headSha) {
        core.info("Head commit was already reviewed, nothing new to review");
        return { prFiles, changedFiles: [], incrementalSince: lastReviewedCommit };
    }

    core.info(`Incremental review since ${lastReviewedCommit}`);
    try {
        const { data } = await github.rest.repos.compareCommits({ owner, repo, base: lastReviewedCommit, head: headSha });
        const touched = new Set((data.files || []).map(file => file.filename));
        // Intersect: a file must be part of the PR diff AND touched since the previous review.
        // Anything the compare picked up from a base-branch merge is missing from prFiles.
        return { prFiles, changedFiles: prFiles.filter(file => touched.has(file.filename)), incrementalSince: lastReviewedCommit };
    } catch (error) {
        core.warning(`Incremental diff failed (${error.message}), falling back to the full PR diff`);
        return { prFiles, changedFiles: prFiles, incrementalSince: null };
    }
}

/* -------------------------------------------------------------------------- */
/*                                   Entry                                    */
/* -------------------------------------------------------------------------- */

async function run({ github, context, core }) {
    const env = process.env;
    const { owner, repo } = context.repo;
    const pullNumber = context.payload.pull_request?.number;

    const skip = reason => {
        core.info(reason);
        core.setOutput("skip", "true");
    };

    if (!pullNumber) {
        throw new Error(`Claude Auto Code Review must run on a pull_request event (got "${context.eventName}")`);
    }

    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const headSha = pr.head.sha;
    const baseSha = (await getMergeBase(github, core, { owner, repo, baseRef: pr.base.ref, headSha })) || pr.base.sha;
    core.setOutput("head_sha", headSha);
    core.setOutput("base_sha", baseSha);

    if (pr.state !== "open") {
        return skip(`PR #${pullNumber} is ${pr.state}, skipping review`);
    }

    const botLogin = await getBotLogin(github);
    const { prFiles, changedFiles, incrementalSince } = await selectChangedFiles(github, core, { owner, repo, pullNumber, headSha, botLogin });

    const files = filterChangedFiles(changedFiles, {
        includeExtensions: sanitizeString(env.INCLUDE_EXTENSIONS),
        excludeExtensions: sanitizeString(env.EXCLUDE_EXTENSIONS),
        includePaths: sanitizeString(env.INCLUDE_PATHS),
        excludePaths: sanitizeString(env.EXCLUDE_PATHS)
    });
    core.info(`Found ${files.length} files to review (PR diff: ${prFiles.length})`);
    core.setOutput("file_count", String(files.length));

    if (files.length === 0) {
        return skip("No files to review");
    }

    // Rules come from the base branch so a PR cannot rewrite the instructions it is reviewed with.
    const reviewRules = await loadReviewRules(github, core, {
        owner,
        repo,
        ref: pr.base.ref,
        filePath: sanitizePath(env.REVIEW_RULES_FILE)
    });

    core.setOutput("prompt", buildPrompt({ owner, repo, pullNumber, headSha, baseSha, incrementalSince, files, reviewRules }));
    core.setOutput("skip", "false");
    return undefined;
}

async function main({ github, context, core }) {
    try {
        return await run({ github, context, core });
    } catch (error) {
        if (/^(true|1)$/i.test((process.env.FAIL_ACTION_IF_REVIEW_FAILED || "").trim())) {
            throw error;
        }
        core.warning(`Claude review preparation failed: ${error.message}`);
        core.setOutput("skip", "true");
        return undefined;
    }
}

module.exports = main;
module.exports.run = run;
module.exports.sanitizeString = sanitizeString;
module.exports.sanitizePath = sanitizePath;
module.exports.filterChangedFiles = filterChangedFiles;
module.exports.findLastReviewedCommit = findLastReviewedCommit;
module.exports.selectChangedFiles = selectChangedFiles;
module.exports.loadReviewRules = loadReviewRules;
