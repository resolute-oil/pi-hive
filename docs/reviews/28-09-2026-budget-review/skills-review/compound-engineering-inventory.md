# Compound-Engineering Skills Inventory & Recommendations

**Context.** The user is running a "massive refactor review" of budget enforcement strategies in `pi-hive` (a TypeScript Pi extension). They asked which skills under `.pi/npm/node_modules/compound-engineering-pi/skills/` would be most useful for that review.

This file inventories all 47 skills shipped with `compound-engineering-pi` and recommends a ranked short-list tuned to this review.

The review priorities the user called out:

- Architectural pattern compliance and design integrity
- Code simplification / YAGNI analysis
- Spec / requirement completeness analysis (does the design match what was asked for?)
- TypeScript code quality
- Repository onboarding / understanding conventions
- Pattern recognition / consistency checking
- Performance / cost analysis (token budgets are a perf-adjacent concern)
- Security / trust boundary analysis

---

## Inventory

Grouped by theme. One-line summary of what each skill does and the work product it produces.

### Code & architecture reviewers (apply to diffs and produce written feedback)

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 1 | `architecture-strategist` | Reads code + docs, then produces an **architecture overview, change assessment, compliance check, risk analysis, and recommendations**. Flags coupling, leaky abstractions, dependency violations, SOLID compliance. |
| 2 | `code-simplicity-reviewer` | Scans code line-by-line, produces a **simplification analysis** with unnecessary complexity found, code to remove, YAGNI violations, LOC-reduction estimate. Output is a prioritized tear-down of over-engineering. |
| 3 | `dhh-rails-reviewer` | Brutally-honest Rails review in DHH's voice. Produces a **Rails-convention compliance verdict** and tears out JS-framework contamination, service objects, DI containers. (N/A for TypeScript work.) |
| 4 | `julik-frontend-races-reviewer` | Reviews JS/Stimulus code for **race conditions, timing issues, and DOM lifecycle problems**. Produces a list of concrete race scenarios with mitigations. |
| 5 | `kieran-python-reviewer` | Strict Python quality review. Produces findings on **type hints, naming, testability, and Pythonic patterns**. (Wrong language for pi-hive.) |
| 6 | `kieran-rails-reviewer` | Strict Rails quality review. Produces findings on **Rails conventions, naming, testability, namespacing, Turbo Streams**. (Wrong language for pi-hive.) |
| 7 | `kieran-typescript-reviewer` | Strict TypeScript quality review. Produces findings on **`any` usage, type safety, naming, module extraction, modern TS patterns**, and regressions. **Direct fit for pi-hive.** |
| 8 | `pattern-recognition-specialist` | Scans codebase for **design patterns, anti-patterns, naming consistency, duplication, and boundary violations**. Produces a structured report. |
| 9 | `performance-oracle` | Audits code for **algorithmic complexity, N+1 queries, memory, caching, network, and frontend bundle**. Produces a performance summary, critical issues, scalability assessment. |
| 10 | `security-sentinel` | Performs a **security audit** covering input validation, SQLi, XSS, authn/authz, sensitive data exposure, and OWASP Top 10. Produces a risk matrix with remediation roadmap. |
| 11 | `agent-native-reviewer` | Reviews code for **agent-native parity**: every UI/user action has an equivalent tool; primitives not workflows; shared workspace; context parity. Produces a capability map and findings. |

### Architecture, spec, and design (before/around implementation)

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 12 | `agent-native-architecture` | Reference document for designing **agent-first systems** (parity, granularity, composability, completion signals). Used as background knowledge, not a reviewer. |
| 13 | `brainstorming` | Pre-implementation interview that **surfaces intent, explores 2-3 approaches with trade-offs, and writes a structured design doc** (WHAT not HOW). Skipped when requirements are already clear. |
| 14 | `spec-flow-analyzer` | Takes a spec/plan and produces a **flow overview, permutation matrix, gap inventory, and prioritized clarifying questions** (critical / important / nice-to-have). Exactly the "does the design match what was asked for?" axis. |
| 15 | `design-implementation-reviewer` | Uses agent-browser + Figma MCP to **compare implementation screenshots against Figma designs**, producing a structured fidelity report. (N/A unless pi-hive dashboard work is in scope.) |
| 16 | `design-iterator` | Runs **N screenshot-analyze-improve cycles** on a UI element. Each iteration picks ONE most-impactful change and re-screenshots. Stops when no clear improvement remains. |
| 17 | `figma-design-sync` | Visual comparison + targeted CSS/Tailwind fixes to bring implementation into **pixel-level Figma alignment**. (N/A without Figma source.) |
| 18 | `frontend-design` | Reference doc for producing **distinctive, non-AI-slop frontend design** with bold aesthetic direction, custom typography, motion, and atmosphere. |

### Research agents (gather external/internal context)

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 19 | `best-practices-researcher` | Synthesizes **current industry best practices** for a technology or framework. Mandatory deprecation check for any external API. Produces categorized guidance with source attribution. |
| 20 | `framework-docs-researcher` | Gathers **official documentation** for a specific framework/library, with version-specific constraints and migration notes. Mandatory deprecation/sunset check for external APIs. |
| 21 | `git-history-analyzer` | Performs **archaeological analysis** of git history: file evolution, code origin tracing, pattern recognition in commits, contributor mapping. Produces a timeline + turning points. |
| 22 | `learnings-researcher` | Searches `docs/solutions/` for **past institutional knowledge** by frontmatter metadata. Uses grep pre-filtering, then reads frontmatter of candidates only. Returns distilled summaries + key insights. |
| 23 | `repo-research-analyst` | **Onboards to a repo**: architecture & structure, GitHub issue patterns, contribution guidelines, templates, code patterns. Produces a structured repo research summary. |

### Documentation & editing

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 24 | `compound-docs` | Auto-captures solved problems as **structured markdown docs** in `docs/solutions/<category>/` with validated YAML frontmatter. Skipped for trivial fixes. |
| 25 | `document-review` | Reviews and refines **brainstorm or plan documents** for clarity, completeness, specificity, YAGNI, and user-intent fidelity. Auto-fixes minor issues, asks approval for substantive ones. |
| 26 | `every-style-editor` | Line-by-line **editorial review** of copy against Every's style guide: grammar, punctuation, mechanics, capitalization. Produces corrected text with rule citations. |
| 27 | `every-style-editor-2` | Second variant of the Every style guide review. **Numbered list of suggested edits** with rule citations and reasoning. |
| 28 | `ankane-readme-writer` | Writes Ruby-gem READMEs in **Ankane template form** (imperative voice, ≤15-word sentences, fixed section order). Single-purpose, narrow scope. |

### Workflow & project management

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 29 | `bug-reproduction-validator` | **Reproduces and validates reported bugs**: extracts repro steps, classifies (Confirmed / Cannot Reproduce / Not a Bug / Environmental / Data / User Error), produces a structured report with severity. |
| 30 | `file-todos` | Manages a **file-based todo system** in `todos/`: naming convention, YAML frontmatter, triage, dependency tracking, work logs. |
| 31 | `orchestrating-swarms` | Teammate/Task orchestration guide: **spawnTeam, inboxes, task lists, dependencies, backends (tmux / iterm2 / in-process)**. Useful only when actually running swarms. |
| 32 | `pr-comment-resolver` | **Implements a single PR comment** end-to-end with a resolution report (what changed, why it addresses the comment, status). |
| 33 | `resolve-pr-parallel` | Orchestrates **parallel resolution of all unresolved PR review threads** by spawning one `pr-comment-resolver` per thread. |

### Data, DB, deployment (mostly Rails-specific)

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 34 | `data-integrity-guardian` | Reviews **migrations, models, transactions, referential integrity, and PII compliance**. Produces concrete data-corruption scenarios and safe alternatives. |
| 35 | `data-migration-expert` | Validates **data migrations, backfills, ID mappings, and enum conversions** against production reality. Refuses approval without verification + rollback plan. |
| 36 | `deployment-verification-agent` | Produces a **Go/No-Go deployment checklist** with invariants, pre-deploy SQL audits, migration steps, post-deploy verification, and 24-hour monitoring plan. |
| 37 | `schema-drift-detector` | Cross-references **schema.rb changes against migrations in the PR** to catch unrelated drift from local DB state. (Rails only.) |

### Domain-specific (Ruby / DSPy / image gen)

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 38 | `andrew-kane-gem-writer` | Authoring guide for **Ruby gems in Andrew Kane's style**: entry-point structure, class-macro DSL, Railtie on_load, configuration pattern, Minitest testing. (N/A — pi-hive is TypeScript.) |
| 39 | `dhh-rails-style` | **37signals / DHH Rails style guide**: rich domain models, CRUD controllers, state records, Current attributes, database-backed everything. Routing reference for Rails code. |
| 40 | `dspy-ruby` | Reference doc for **DSPy.rb** (signatures, modules, tools, type system, optimization, observability). Useful only if using DSPy. |
| 41 | `gemini-imagegen` | Generates and edits images via **Google Gemini API (Nano Banana Pro)**. Quick reference for resolution, aspect ratio, and editing patterns. |
| 42 | `lint` | Runs **standardrb / erblint / brakeman** on Ruby + ERB files. Produces an analysis with prioritized fixes. (N/A for TS.) |

### Infrastructure / utilities

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 43 | `agent-browser` | Wrapper for **Vercel agent-browser CLI**: navigate, snapshot with refs, click/fill, screenshot, parallel sessions. Used by browser-driven reviewers. |
| 44 | `git-worktree` | Manages **Git worktrees** for parallel development via a single script: create, list, switch, cleanup. Also handles `.env` copying and `.gitignore`. |
| 45 | `rclone` | **Cloud storage upload/sync** (S3, R2, B2, Google Drive, Dropbox, etc.) with setup, flags, and large-file chunking. |

### Skill / extension meta

| # | Skill | What it does / produces |
|---|-------|-------------------------|
| 46 | `create-agent-skills` | Guide for **authoring new Claude Code skills and slash commands**. Covers frontmatter, invocation control, dynamic context, progressive disclosure. |
| 47 | `skill-creator` | Companion guide for **skill creation** (anatomy, bundled resources, progressive disclosure, packaging, validation). |

---

## Recommendations

Ranked by relevance to a comprehensive refactor review of budget enforcement strategies in pi-hive. **Each entry cites the SKILL.md path and gives a 2-3 sentence rationale tied to this specific review.**

### 1. `architecture-strategist` — _HIGHEST_

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/architecture-strategist/SKILL.md`

**Why for this review.** Budget enforcement is the kind of cross-cutting concern that lives or dies on architecture: where the budget is set, where it is checked, who owns the counter, and how it composes with the existing extension-factory contract in `index.ts`. This skill produces an architecture overview, change assessment, compliance check, and risk analysis — exactly the four lenses a refactor review needs. It also surfaces SOLID violations and inappropriate intimacy between components, which is the failure mode when a budget layer is bolted on after the fact.

### 2. `spec-flow-analyzer` — _HIGHEST_

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/spec-flow-analyzer/SKILL.md`

**Why for this review.** The user explicitly asked whether the design matches what was requested. This skill is purpose-built for that: it maps every user flow and permutation (first-time vs. returning, edge cases, partial completion, error recovery), then produces a flow overview, permutation matrix, gap inventory, and prioritized clarifying questions. For a budget refactor the gaps will be in error handling (what happens at zero budget, mid-run overruns, concurrent sub-agents racing), state transitions (decrement / reset / top-up), and timeout/rate-limit behavior. Run it against the original spec/issue this branch implements.

### 3. `code-simplicity-reviewer` — _HIGHEST_

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/code-simplicity-reviewer/SKILL.md`

**Why for this review.** A budget layer invites over-engineering — strategies, counters, decorators, hooks, registries, fallbacks for every edge case. This reviewer tears that apart: it produces a list of unnecessary complexity, code to remove with LOC-reduction estimates, and YAGNI violations with concrete fixes. Its principle ("Every line of code is a liability") is exactly the right frame for a refactor whose whole purpose is to simplify. Especially valuable because budget code tends to accumulate defensive checks that look like robustness but are actually YAGNI.

### 4. `kieran-typescript-reviewer`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/kieran-typescript-reviewer/SKILL.md`

**Why for this review.** pi-hive is TypeScript, and budget enforcement code will live alongside typed interfaces (`BudgetStrategy`, counters, signals). This reviewer enforces the project's relevant subset of Kieran's bar: no unjustified `any`, strict null checks around budget exhaustion, testability, the 5-second naming rule, and "duplication > complexity." It is also strict about regressions — perfect for catching whether the refactor silently broke an existing budget path.

### 5. `repo-research-analyst`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/repo-research-analyst/SKILL.md`

**Why for this review.** The user wants the review grounded in this repo's conventions, not generic best practices. This skill maps AGENTS.md, the extension-factory contract, the existing command/hook registration patterns in `index.ts`, and any prior docs in `docs/solutions/` or `docs/plans/` so the reviewer judges the budget code against the project's actual rules (e.g., "do not register tools/hooks unless `.pi/hive/hive-config.yaml` exists"). It produces the baseline that every other reviewer needs.

### 6. `pattern-recognition-specialist`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/pattern-recognition-specialist/SKILL.md`

**Why for this review.** pi-hive already has patterns for subagent orchestration, telemetry, and dashboard integration. A budget refactor that introduces a new pattern (e.g., its own counter class, its own event bus, its own config shape) instead of fitting the existing ones is a code-smell that's easy to miss in a single-pass review. This skill systematically detects established patterns, anti-patterns (TODO/FIXME/god-object), naming consistency, duplication, and layer violations — and produces a structured report that can be diffed against the new code.

### 7. `performance-oracle`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/performance-oracle/SKILL.md`

**Why for this review.** Budget enforcement is a perf-adjacent concern: the budget counter is on the hot path of every subagent call, every LLM call, every tool invocation. A naive implementation that reads/writes state synchronously inside the loop can become the new bottleneck. This reviewer audits algorithmic complexity, memory allocation, and I/O patterns, and projects behavior at 10×/100×/1000× volume — exactly the frame you want for token-budget code where costs compound.

### 8. `security-sentinel`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/security-sentinel/SKILL.md`

**Why for this review.** Budget enforcement is a trust boundary — any user (or subagent) that can edit the budget, bypass the counter, or reset state mid-session undermines the whole feature. This skill audits input validation (config files, runtime overrides), authz (who is allowed to change a budget?), sensitive data exposure (budget telemetry in logs), and OWASP Top 10. It also covers the failure mode where budget state is stored unsafely and could be tampered with by another tool or session. Highly relevant given pi-hive's stated "do not start long-lived processes / guard with trust boundary" rules.

### 9. `agent-native-architecture`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/agent-native-architecture/SKILL.md`

**Why for this review.** pi-hive is a multi-agent orchestration extension. A budget feature is inherently an agent concern — it shapes what the agent is allowed to do. This skill is a reference doc, not a reviewer, but its parity/granularity/composability lens is useful when judging whether the budget is exposed at the right level (a primitive the orchestrator calls) or buried inside another tool's workflow (an anti-pattern). Especially relevant if the refactor moves budget logic from a tool-internal hook to a primitive called by the Agent/SubagentWorkflow primitives.

### 10. `best-practices-researcher`

**Path:** `.pi/npm/node_modules/compound-engineering-pi/skills/best-practices-researcher/SKILL.md`

**Why for this review.** The user wants to know whether the chosen budget strategy is the right shape — token-bucket vs. fixed allocation vs. dynamic refill, hard vs. soft caps, etc. This researcher synthesizes current industry practice for budget patterns in agent / LLM systems, with mandatory deprecation checks for any external API involved. It also explicitly steers to existing skills first (the agent-native-architecture / kieran-typescript-reviewer / repo-research-analyst trio above), so it acts as a forcing function to make sure the internal-knowledge review happened before going external.

### Honorable mention

- `git-history-analyzer` — if the budget code already exists in some form, understanding its evolution (who wrote it, when it changed, why the patterns exist) frames the refactor's surface area.
- `learnings-researcher` — if pi-hive's `docs/solutions/` has prior budget-related write-ups, this is the cheap path to institutional knowledge before starting.
- `dhh-rails-style` / `dhh-rails-reviewer` / `kieran-rails-reviewer` / `kieran-python-reviewer` — explicitly N/A. Wrong language; ignore for this review.

---

## If you only run two or three skills

If time is the constraint, run these three first. They cover the three independent axes the user named:

1. **`architecture-strategist`** — answers "is the design structurally sound for a refactor?". Without this, the refactor is shape-blind.
2. **`spec-flow-analyzer`** — answers "does the design match what was asked for, and where are the gaps?". Without this, you can refactor cleanly into the wrong thing.
3. **`code-simplicity-reviewer`** — answers "can we cut more?". Without this, the refactor will preserve complexity instead of reducing it.

If the user can only pick **one**, pick `spec-flow-analyzer` — it surfaces the gaps that would otherwise consume the architecture and simplicity passes too.