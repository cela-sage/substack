# archive

This repository renders the archive of a weekly newsletter: every issue, newest first, five to a page, plus a feed
of the latest three issues for the home page. It is a small ES module package with no runtime dependencies.

## Commands

- Install: `pnpm install`
- Run every test: `pnpm test`
- Run one test file: `node --test test/page.test.js`
- Run tests matching a name: `node --test --test-name-pattern="page 2"`
- Watch mode while editing: `node --test --watch`

Always run the full suite before you say a change is done. A green single file is not enough, because the feed and
the pages share helpers.

## Package manager

- Use pnpm, never npm or yarn. The version is pinned in `package.json` under `packageManager`.
- Commit `pnpm-lock.yaml` whenever dependencies change.
- Do not add runtime dependencies without asking first. Dev dependencies need a reason in the pull request.

## Layout

- `src/issues.js` holds the list of issues, oldest first, each with a number, a title and a date.
- `src/newest-first.js` returns a sorted copy of the issues, newest first. It never mutates its input.
- `src/offset.js` turns a page number and a page size into the index of the first item on that page.
- `src/page.js` returns the issues for one page of the archive.
- `src/feed.js` returns the latest issues for the home page feed.
- `src/format-date.js` formats an issue date for display.
- `test/` holds one test file per public function, named after the module it covers.

## How the archive works

- Pages are numbered from 1. Page 1 is the first page a reader sees.
- A page holds five issues. The last page may hold fewer.
- The archive is always newest first, so page 1 starts with the most recent issue.
- The feed shows the three most recent issues and ignores paging entirely.
- A page past the end returns an empty list rather than throwing.

## Code style

- ES modules only. Use `import` and `export`, never `require`.
- Named exports, one main function per module. No default exports.
- Prefer small pure functions. Anything that touches the outside world belongs at the edge, not in `src/`.
- Use `const` by default and `let` only when a value really changes. Never `var`.
- Arrow functions for small helpers, `function` declarations only when hoisting matters.
- Two-space indentation, double quotes, semicolons, trailing commas in multi-line literals.
- Keep lines under 100 characters.
- Name booleans as questions: `isEmpty`, `hasNext`, `canPublish`.
- Name functions after what they return, not how they compute it.
- No abbreviations in names except `i` for a loop index and well-known ones like `url` and `id`.

## Comments

- Comment why, never what. Most functions need no comment at all.
- A comment earns its place when the code does something a reader wouldn't expect.
- No commented-out code. Delete it; git remembers.
- No TODO without an issue number.

## Errors

- Validate arguments at the public boundary and throw a `TypeError` with a message that names the argument.
- Never swallow an error. If you catch it, either handle it fully or rethrow it with context.
- Return empty lists for "nothing found", not `null` or `undefined`.

## Dates

- Dates are stored as ISO strings, `YYYY-MM-DD`, in `src/issues.js`.
- Format dates only in `src/format-date.js`. Nothing else should build a display string from a date.
- Treat every date as UTC. Never rely on the machine's time zone.

## Testing

- Tests use the built-in `node:test` runner and `node:assert/strict`. No test framework is installed.
- One `describe` per module, one `it` per behaviour. The test name says the behaviour in plain words.
- Test the public function, not its internals.
- Every bug fix comes with a test that fails before the fix and passes after it.
- Keep fixtures inline and small. Build issues with a helper rather than copying the real list.
- Don't mock the modules in `src/`. They are pure, so call them for real.
- A failing test is information. Read the assertion message before changing any code.

## Making changes

- Read the failing test and the module it covers before editing anything.
- Make the smallest change that fixes the problem, then run the whole suite.
- Don't reformat code you didn't change. Unrelated formatting hides the real diff.
- Don't rename or move files as part of a fix.
- If a fix needs more than one module to change, explain why in the summary.
- Keep public function signatures stable. The home page imports `page` and `feed` directly.

## Performance

- The archive has a few hundred issues at most, so clarity beats cleverness.
- Don't cache results. Every call recomputes from `src/issues.js`, which is cheap and always correct.
- Avoid sorting more than once per call.

## Git

- Work on a branch named after the change, like `fix/page-offset` or `feat/feed-size`.
- One logical change per commit.
- Commit messages follow Conventional Commits: `fix(page): ...`, `feat(feed): ...`, `test(offset): ...`.
- Write the subject in the imperative mood and keep it under 72 characters.
- Never commit generated files or `node_modules`.
- Rebase on `main` before opening a pull request. Don't merge `main` into your branch.

## Pull requests

- The description says what changed and why, and how you tested it.
- Link the issue it closes.
- Keep pull requests small enough to review in ten minutes.
- A reviewer's question is a request for a clearer name or a comment, not only an answer in the thread.

## Releases

- The package is private and never published to a registry.
- The home page pins this repository by commit, so every merge to `main` must leave the tests green.

## Accessibility and content

- Issue titles are shown as they are written. Don't change their case or punctuation.
- Dates are shown in the reader's language by the page, not by this package.
- The feed and the pages must list the same issues in the same order for the same data.

## When you are unsure

- Prefer asking over guessing when a change would alter what readers see.
- If the tests and this file disagree, the tests win, and this file needs a fix.
- If you find a bug unrelated to your task, mention it in your summary instead of fixing it in the same change.

## Things to avoid

- Don't touch `src/issues.js` except to add a new issue at the end.
- Don't add a build step. The modules run as they are.
- Don't introduce TypeScript, a bundler or a linter config without a discussion first.
- Don't write to the file system or the network from anything in `src/`.
- Don't change the page size. Five per page is a product decision, not a technical one.

## Glossary

- Issue: one edition of the newsletter, with a number, a title and a date.
- Archive: the full list of issues, newest first, split into pages.
- Page: one screen of the archive, five issues long.
- Feed: the three most recent issues shown on the home page.
