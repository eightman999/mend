# mend — one patch tool for every AI edit format

[![make.fun hidden-spec-cli-01](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/eightman999/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/eightman999/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

An entry for [make.fun's hidden-spec-cli-01](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

AI harnesses apply the edits models write, and models write them in four
formats. `mend` is a single command-line tool (`main.ts`, Node 22, standard
library only) that applies all of them to a tree of files:

- unified diffs — including ones whose line numbers are wrong, relocated by
  three-tier matching (exact, whitespace-tolerant, fuzzy)
- SEARCH/REPLACE blocks
- V4A patches
- text-editor tool calls as JSON

Writes are all-or-nothing: a patch that does not apply cleanly changes
nothing. `SPEC.md` is the full specification the tool is built to;
`check.ts` runs the public practice set (100 of 100 passed).

The checks are written the way models get edits wrong: wrong line numbers,
drifted whitespace and indentation, blank context lines without their
leading space, prose and code fences around the patch, CRLF files, files
without a final line break, blocks that occur twice.
