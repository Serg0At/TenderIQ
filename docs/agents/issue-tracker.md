# Issue tracker

Issues for this repo live as **local markdown files** under `.scratch/<feature>/`.

One file per issue: `.scratch/<feature>/issues/NNN-slug.md`. The feature's spec sits beside
them at `.scratch/<feature>/spec.md`.

Each issue file carries, at the top:

- `status:` — `ready-for-agent` | `in-progress` | `done`
- `blocked-by:` — a list of issue numbers in this feature, or `none`

Work blockers-first: an issue may be started when every number in its `blocked-by` is `done`.

Chosen because this is a solo project. Both a GitHub remote (`origin`) and a GitLab remote
exist; if issues ever move to either, replace this file — the skills read it, not the remotes.

## Triage labels

The `triage` skill is not in use here. Specs produced by `to-spec` and tickets produced by
`to-tickets` are already agent-ready and are not triaged.
