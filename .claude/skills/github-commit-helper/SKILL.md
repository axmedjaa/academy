---
name: github-commit-helper
description: Stages, reviews, and commits changes to a git repository with a commit message that matches the repo's own established convention, then optionally pushes and opens a GitHub PR via `gh`. Use this whenever the user asks to "commit this," "commit my changes," "make a commit," "write a commit message," or wants help finishing off a piece of work with a proper git commit — even if they don't explicitly ask for the "commit helper" skill.
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git add:*), Bash(git commit:*), Bash(gh auth status:*)
context: fork
agent: /"github-committer"
---
# GitHub Commit Helper

Turn a working tree full of changes into a well-formed commit — and,
if the user wants, a pushed branch or an open PR. The core idea: don't
impose a commit convention, **discover the one this repo already
uses** and match it. A repo full of `feat(x): ...` commits should keep
getting `feat(x): ...` commits; a repo full of short imperative
one-liners should keep getting those.

## Before touching anything

Confirm you're in a git repo and get oriented:

```bash
git rev-parse --is-inside-work-tree
git status
git branch --show-current
```

If this isn't a git repo, stop and tell the user — don't `git init`
on their behalf without asking.

## Step 1: Detect the commit convention

Read the last 20-30 commits on the current branch (fall back to
`main`/`master` if the branch is new and has none of its own):

```bash
git log -30 --pretty=format:'%s'
```

Look for a pattern:
- **Conventional Commits** — `type(scope): summary`, e.g. `feat(auth): add token refresh`, `fix: null check on login`. Note which `type`s actually appear (repos vary — some use `feat`/`fix`/`chore`/`docs`/`refactor`, others add `test`, `perf`, `build`, `ci`).
- **Plain imperative** — `Add token refresh endpoint`, no prefix, capitalized, no trailing period.
- **Ticket-prefixed** — `PROJ-123: fix login bug` or `[PROJ-123] fix login bug`.
- **Something else** — match whatever's actually there rather than forcing it into one of the above.

Also check whether body text is common (`git log -5 --pretty=format:'%B---'`)
— some repos are one-liner-only, others regularly include a body
explaining *why*. Match that habit too, don't add a body where the
repo's history never has one.

If history is empty (brand-new repo, first commit), default to
Conventional Commits — it's the most common sane default — but say
so, don't just silently pick it.

## Step 2: Review and test the changes

Look at what's actually changing before writing anything:

```bash
git status
git diff
```

Read the diff for real — this is where you catch the change that
doesn't match its own description, debug output left behind, a file
that shouldn't be there (`.env`, credentials, build artifacts, `node_modules`).
Flag anything that looks like it doesn't belong in the commit and ask
before including it.

If the project has an obvious test/lint/build command (check
`package.json` scripts, `Makefile`, `CLAUDE.md`, or ask if it's not
obvious), run it before committing. A commit that breaks the build is
worse than no commit. If tests fail, show the failure and ask the
user how they want to proceed — don't commit broken code silently and
don't silently skip testing either.

## Step 3: Stage and commit

Stage everything and commit:

```bash
git add -A
git status   # confirm what's about to be committed
```

Write the message to match the convention from Step 1. For the
summary line: imperative mood ("add", not "added" or "adds"), no
trailing period, under ~72 chars where the repo's own history respects
that limit. Only add a body if the repo's history commonly has one, or
if the change genuinely needs the extra explanation (a non-obvious
"why").

Commit with a heredoc so multi-line messages and special characters
survive intact:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary>

<optional body — the why, not a restatement of the diff>
EOF
)"
```

Adapt the message shape to whatever convention you detected — the
heredoc above is the Conventional Commits case; for plain-imperative
repos just drop the `type(scope):` prefix.

After committing, run `git log -1 --stat` and show the user what
landed.

## Step 4: Push and PR — always ask first

Never push or open a PR without asking. Once the commit is made:

1. Ask whether they want to push. If yes:
   ```bash
   git push -u origin "$(git branch --show-current)"
   ```
   (Use plain `git push` if the branch already has an upstream.)

2. If they want a PR too (and `gh` is available — check with
   `gh auth status`), ask for or confirm the target branch, then:
   ```bash
   gh pr create --fill
   ```
   `--fill` seeds the title/body from the commit(s), which is usually
   right when there's just one commit; offer to write a fuller PR
   description if there are several commits going into the PR.

If they only wanted a local commit, stop after Step 3 — don't assume
push is implied.

## Notes

- If there's nothing staged/changed (`git status` shows a clean tree),
  say so instead of inventing a commit.
- If changes span clearly unrelated concerns (e.g. a dependency bump
  *and* an unrelated bug fix), point this out and offer to split into
  separate commits rather than automatically squashing them together
  — but don't block on it if the user just wants one commit.
- Never force-push, rewrite history, or skip hooks (`--no-verify`)
  unless the user explicitly asks for it.
