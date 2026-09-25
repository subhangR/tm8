---
name: harness-trim-task
description: Trimming unselected skills from Claude Code harness to reduce token load (H2+H3+I10a)
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:10:21.385Z
---

# Harness Lane Trimming Task

## Current Status
- Task ID: 01a0d98a-8df1-727d-ab29-3b6f1075c672
- Priority: medium
- Phase: Setup & Clarification
- Started: 2026-09-25

## Goals
Reduce harness lane token load by trimming unselected skills:
1. User skills not in effective set → off
2. Plugin skills not selected → off  
3. Equipped native skills → name-only (to remove double-listing)
4. Chrome block → off

**Target**: Remove ~6k tokens from remaining budget

## Key Implementation Files
- `packages/execution/src/spawn/harness-surface.ts`
- `manifest.ts` buildAgentCommand
- SpawnService (two loadSpawnContext call sites: spawn AND resume)

## Linked Tasks
- H2 (01a0d3b2-5292): Set skillOverrides 'off' for unselected plugin skills
- H3 (01a0d3b2-5886): Set skillOverrides 'name-only' for equipped native skills (double-listing fix)
- I10a (01a0d3b2-4106): Measurement findings showing ~33.4k tokens on +lean, with 20k from skill_listing, 4.1k from Chrome block

## Recording Specification
Every trim must be recorded in `launch.harness.skillOverrides` with source metadata:
- 'user-unselected' — user skill not in effective set
- 'plugin-unselected' — plugin skill not selected by launch
- 'native-name-only' — equipped native skill (duplicate removal)
- 'chrome' — Claude in Chrome block

## Environment Notes
- Current working directory: fixture repo (ledger-lite)
- No git remotes configured in worktree
- Awaiting clarification on:
  1. Access to Claude Code source repository
  2. How to set up separate dev node for probing (:46xx pattern)
  3. Fixture repo usage for probing vs implementation
