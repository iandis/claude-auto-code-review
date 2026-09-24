const prepare = require("../scripts/prepare");
const postSummary = require("../scripts/post-summary");
const { buildPrompt, simplifyFiles, TRUNCATED_NOTE } = require("../scripts/prompt");
const { REVIEW_COMMENT_PREFIX, SUMMARY_SEPARATOR } = require("../scripts/constants");

const HEAD = "a".repeat(40);
const LAST = "b".repeat(40);
const BOT = "github-actions[bot]";

const file = (filename, patch = "@@ -1 +1 @@\n-a\n+b") => ({ filename, status: "modified", additions: 1, deletions: 1, changes: 2, patch });
const marker = (sha, login = BOT) => ({ user: { login }, body: `${REVIEW_COMMENT_PREFIX}${sha}${SUMMARY_SEPARATOR}ok` });

function makeCore() {
    const outputs = {};
    return {
        outputs,
        info: jest.fn(),
        warning: jest.fn(),
        setFailed: jest.fn(),
        setOutput: jest.fn((k, v) => { outputs[k] = v; })
    };
}

function makeGithub({ prFiles = [], comments = [], compareFiles = null, compareFails = false, state = "open", rules = null } = {}) {
    const listFiles = jest.fn();
    const listComments = jest.fn();
    return {
        paginate: jest.fn(fn => Promise.resolve(fn === listFiles ? prFiles : comments)),
        rest: {
            pulls: {
                get: jest.fn().mockResolvedValue({ data: { state, head: { sha: HEAD }, base: { ref: "main", sha: "c".repeat(40) } } }),
                listFiles
            },
            issues: { listComments, createComment: jest.fn().mockResolvedValue({}) },
            users: { getAuthenticated: jest.fn().mockRejectedValue(new Error("Resource not accessible by integration")) },
            repos: {
                compareCommits: jest.fn(({ base }) => {
                    if (base === "main") {
                        return Promise.resolve({ data: { merge_base_commit: { sha: "d".repeat(40) } } });
                    }
                    if (compareFails) {
                        return Promise.reject(new Error("No common ancestor"));
                    }
                    return Promise.resolve({ data: { files: compareFiles || [] } });
                }),
                getContent: jest.fn(() => rules === null
                    ? Promise.reject(new Error("Not Found"))
                    : Promise.resolve({ data: { type: "file", size: rules.length, encoding: "base64", content: Buffer.from(rules).toString("base64") } }))
            }
        }
    };
}

const context = { eventName: "pull_request", repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 7 } } };

afterEach(() => {
    for (const key of ["INCLUDE_EXTENSIONS", "EXCLUDE_EXTENSIONS", "INCLUDE_PATHS", "EXCLUDE_PATHS", "REVIEW_RULES_FILE", "FAIL_ACTION_IF_REVIEW_FAILED",
        "REVIEW_OUTCOME", "REVIEW_CONCLUSION", "STRUCTURED_OUTPUT", "HEAD_SHA"]) {
        delete process.env[key];
    }
});

describe("filterChangedFiles", () => {
    const files = [file("src/a.js"), file("src/a.test.js"), file("docs/x.md"), file("lib/b.py")];

    test("keeps everything without filters", () => {
        expect(prepare.filterChangedFiles(files, {})).toHaveLength(4);
    });

    test("applies extension and path filters", () => {
        const result = prepare.filterChangedFiles(files, { includeExtensions: ".js,.py", excludePaths: "lib/" });
        expect(result.map(f => f.filename)).toEqual(["src/a.js", "src/a.test.js"]);
    });

    test("include paths are sanitized against traversal", () => {
        const result = prepare.filterChangedFiles(files, { includePaths: "../docs/" });
        expect(result.map(f => f.filename)).toEqual(["docs/x.md"]);
    });
});

describe("findLastReviewedCommit", () => {
    test("returns newest marker from the bot", () => {
        expect(prepare.findLastReviewedCommit([marker(LAST), marker(HEAD)], BOT)).toBe(HEAD);
    });

    test("ignores markers posted by other users", () => {
        expect(prepare.findLastReviewedCommit([marker(LAST), marker(HEAD, "mallory")], BOT)).toBe(LAST);
    });

    test("returns null without markers", () => {
        expect(prepare.findLastReviewedCommit([{ user: { login: BOT }, body: "hello" }], BOT)).toBeNull();
    });
});

describe("prepare run", () => {
    test("first review covers the whole PR diff", async () => {
        const core = makeCore();
        await prepare({ github: makeGithub({ prFiles: [file("a.js"), file("b.js")] }), context, core });
        expect(core.outputs.skip).toBe("false");
        expect(core.outputs.file_count).toBe("2");
        expect(core.outputs.base_sha).toBe("d".repeat(40));
        expect(core.outputs.prompt).toContain("first review");
    });

    test("incremental review intersects PR files with files touched since last review", async () => {
        const core = makeCore();
        const github = makeGithub({
            prFiles: [file("a.js"), file("b.js")],
            comments: [marker(LAST)],
            compareFiles: [{ filename: "b.js" }, { filename: "from-main-merge.js" }]
        });
        await prepare({ github, context, core });
        expect(core.outputs.file_count).toBe("1");
        expect(core.outputs.prompt).toContain(`INCREMENTAL review`);
        expect(core.outputs.prompt).toContain('"filename": "b.js"');
        expect(core.outputs.prompt).not.toContain("from-main-merge.js");
    });

    test("skips when head was already reviewed", async () => {
        const core = makeCore();
        await prepare({ github: makeGithub({ prFiles: [file("a.js")], comments: [marker(HEAD)] }), context, core });
        expect(core.outputs.skip).toBe("true");
        expect(core.outputs.prompt).toBeUndefined();
    });

    test("falls back to full diff when incremental compare fails", async () => {
        const core = makeCore();
        await prepare({ github: makeGithub({ prFiles: [file("a.js"), file("b.js")], comments: [marker(LAST)], compareFails: true }), context, core });
        expect(core.outputs.file_count).toBe("2");
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("falling back"));
    });

    test("skips when filters remove every file", async () => {
        process.env.INCLUDE_EXTENSIONS = ".py";
        const core = makeCore();
        await prepare({ github: makeGithub({ prFiles: [file("a.js")] }), context, core });
        expect(core.outputs.skip).toBe("true");
    });

    test("appends review rules loaded from the base branch", async () => {
        process.env.REVIEW_RULES_FILE = ".github/review-rules.md";
        const core = makeCore();
        const github = makeGithub({ prFiles: [file("a.js")], rules: "Never use var." });
        await prepare({ github, context, core });
        expect(github.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: "main", path: ".github/review-rules.md" }));
        expect(core.outputs.prompt).toContain("Never use var.");
    });

    test("non-PR event warns and skips unless failing is requested", async () => {
        const core = makeCore();
        await prepare({ github: makeGithub(), context: { ...context, eventName: "push", payload: {} }, core });
        expect(core.outputs.skip).toBe("true");
        expect(core.warning).toHaveBeenCalled();

        process.env.FAIL_ACTION_IF_REVIEW_FAILED = "true";
        await expect(prepare({ github: makeGithub(), context: { ...context, eventName: "push", payload: {} }, core: makeCore() }))
            .rejects.toThrow("pull_request event");
    });
});

describe("prompt", () => {
    test("truncates oversized patches and respects total budget", () => {
        const big = "x".repeat(50);
        const result = simplifyFiles([file("a.js", big), file("b.js", big), file("c.js", big)], { maxPatchChars: 30, maxTotalChars: 60 });
        expect(result[0].patch).toBe(`${"x".repeat(30)}\n${TRUNCATED_NOTE}`);
        expect(result[1].patch).toBe(`${"x".repeat(30)}\n${TRUNCATED_NOTE}`);
        expect(result[2].patch).toBe(TRUNCATED_NOTE);
    });

    test("includes PR metadata", () => {
        const prompt = buildPrompt({ owner: "o", repo: "r", pullNumber: 7, headSha: HEAD, baseSha: LAST, incrementalSince: null, files: [file("a.js")] });
        expect(prompt).toContain("Repository: o/r");
        expect(prompt).toContain(`Head commit (checked out in the working directory): ${HEAD}`);
        expect(prompt).toContain("confirmed: true");
    });
});

describe("post-summary", () => {
    test("posts marker comment with summary", async () => {
        Object.assign(process.env, { REVIEW_OUTCOME: "success", REVIEW_CONCLUSION: "success", STRUCTURED_OUTPUT: '{"summary":" Looks good. "}', HEAD_SHA: HEAD });
        const core = makeCore();
        const github = makeGithub();
        await postSummary({ github, context, core });
        expect(github.rest.issues.createComment).toHaveBeenCalledWith({
            owner: "o", repo: "r", issue_number: 7, body: `${REVIEW_COMMENT_PREFIX}${HEAD}${SUMMARY_SEPARATOR}Looks good.`
        });
        expect(core.outputs.reviewed_commit).toBe(HEAD);
        expect(prepare.findLastReviewedCommit([{ user: { login: BOT }, body: github.rest.issues.createComment.mock.calls[0][0].body }], BOT)).toBe(HEAD);
    });

    test("does not record a commit when the review failed", async () => {
        Object.assign(process.env, { REVIEW_OUTCOME: "failure", REVIEW_CONCLUSION: "failure", HEAD_SHA: HEAD });
        const core = makeCore();
        const github = makeGithub();
        await postSummary({ github, context, core });
        expect(github.rest.issues.createComment).not.toHaveBeenCalled();
        expect(core.warning).toHaveBeenCalled();
        expect(core.setFailed).not.toHaveBeenCalled();
    });

    test("fails the action on missing summary when requested", async () => {
        Object.assign(process.env, { REVIEW_OUTCOME: "success", REVIEW_CONCLUSION: "success", STRUCTURED_OUTPUT: "not json", HEAD_SHA: HEAD, FAIL_ACTION_IF_REVIEW_FAILED: "true" });
        const core = makeCore();
        await postSummary({ github: makeGithub(), context, core });
        expect(core.setFailed).toHaveBeenCalled();
    });
});

describe("prompt size guard", () => {
    const params = files => ({ owner: "o", repo: "r", pullNumber: 7, headSha: HEAD, baseSha: LAST, incrementalSince: null, files });

    test("drops patches when the prompt would be too large", () => {
        const prompt = buildPrompt(params([file("a.js", "y".repeat(8000))]), { maxPromptBytes: 7000 });
        expect(prompt).not.toContain("yyyy");
        expect(prompt).toContain(TRUNCATED_NOTE);
    });

    test("throws when even the file list does not fit", () => {
        expect(() => buildPrompt(params([file("a.js")]), { maxPromptBytes: 100 })).toThrow("too large");
    });
});
