Review the given code or `git diff`. Categorise every finding:

- `[CRITICAL]` — bug, security hole, data loss risk. Must fix before merge.
- `[WARNING]` — bad practice, performance issue, unclear logic. Should fix.
- `[SUGGESTION]` — readability, naming, minor improvement. Optional.

### Check for
- Unhandled errors and edge cases
- SQL injection, XSS, unvalidated user input
- N+1 queries, missing indexes
- Race conditions, missing locks
- Hardcoded secrets or credentials
- Dead code or unreachable branches 

### Format each finding
```
[LEVEL] file.ts:42 — description of the problem
→ suggested fix (one line)
```

No praise, no summary. Only findings. If nothing found, say "LGTM".
