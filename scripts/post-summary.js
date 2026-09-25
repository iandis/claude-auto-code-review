const { REVIEW_COMMENT_PREFIX, SUMMARY_SEPARATOR } = require("./constants");

function parseSummary(structuredOutput) {
    if (!structuredOutput) {
        return "";
    }
    try {
        const parsed = JSON.parse(structuredOutput);
        return typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
    } catch {
        return "";
    }
}

async function run({ github, context, core }) {
    const env = process.env;
    const failAction = /^(true|1)$/i.test((env.FAIL_ACTION_IF_REVIEW_FAILED || "").trim());
    const fail = message => (failAction ? core.setFailed(message) : core.warning(message));

    // The review step runs with continue-on-error, so its outcome carries the real result.
    if (env.REVIEW_OUTCOME !== "success" || env.REVIEW_CONCLUSION !== "success") {
        return fail(`Claude review did not complete (outcome: ${env.REVIEW_OUTCOME || "unknown"}, conclusion: ${env.REVIEW_CONCLUSION || "unknown"})`);
    }

    const summary = parseSummary(env.STRUCTURED_OUTPUT);
    if (!summary) {
        return fail("Claude review finished without a summary; not recording the reviewed commit");
    }

    const { owner, repo } = context.repo;
    await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: Number(env.PULL_NUMBER),
        body: `${REVIEW_COMMENT_PREFIX}${env.HEAD_SHA}${SUMMARY_SEPARATOR}${summary}`
    });

    core.setOutput("summary", summary);
    core.setOutput("reviewed_commit", env.HEAD_SHA);
    return undefined;
}

module.exports = run;
module.exports.parseSummary = parseSummary;
