# Micro-Trial Handoff Log

**Trial date:** 2026-09-30
**Repo:** /home/z/my-project/baton-cli/ (Baton CLI v1.2.0)
**Worker model:** Claude (same model — known limitation: not a fresh model)
**Verifier:** Same Claude (acting as human owner)

## Baseline
- Minutes to brief a fresh model on this repo: ~8 min
- Corrections usually needed: 2-3 (wrong import path, missing type, not following existing command structure)

| # | Task | Worker | Min to brief | Clarifying Qs | Corrections needed | False claims caught | Min on Baton upkeep | Notes |
|---|------|--------|-------------|---------------|--------------------|--------------------|--------------------|-------|
| 1 | T-0010 | claude | | | | | | |
| 2 | T-0011 | claude | | | | | | |
| 3 | T-0012 | claude | | | | | | |

## Frustrations (write down, fix after trial)
- (will fill in during trial)

## Frustration 1 (T-0010 setup)
- baton init created project-memory/ inside baton-cli/ but the git repo root is /home/z/my-project (parent).
- baton task ready can't find the task file on main because it looks for `project-memory/tasks/T-0010.md`
  relative to the git root, but the file is at `baton-cli/project-memory/tasks/T-0010.md`.
- Workaround: initialize baton in the git root (/home/z/my-project) instead, OR make baton-cli its own git repo.
- This is a real usability bug for nested project directories.
