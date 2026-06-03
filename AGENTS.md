# OpenClaw Plugin — Agent Rules

General workspace rules (repo boundaries, plugin version bump, `dist` rebuild, doc lifecycle) live in the **workspace-root `AGENTS.md`**. This file adds the one rule specific to this repo: **how to write a skill step doc.**

Context: the `schejo` skill (`skills/schejo/SKILL.md`) is only a **router** — it matches an intent and hands off to one step doc under `skills/schejo/steps/`. A step doc is **not** the router and **not** a full SOP. It is one step's **execution contract + boundaries + judgement frame**.

## One-line standard

A step doc should only lock down interfaces, safety rules, authoritative sources, and non-negotiable boundaries; for design decisions that require runtime contextual judgment, provide principles, priorities, and closed sets—not exhaustive mappings.

## Four layers

- **Scope (1 line)** — `Use this doc only to …`. What this step does / does not. Guards against misroute scope-creep. No trigger backstory, no project / MVP history.
- **Contract (exact — pin it)** — input shape, output schema, closed enums, required fields, field semantics, tool names, direction. The model can't guess these; zero ambiguity, no "thinking room" here.
- **Rails (hard limits — may be a table)** — safety / grounding / authority / permission / no-overreach. These are constraints, not designs, so they may be hard rules or even decision tables.
- **Runtime Judgement (delegate)** — the design work: principles + priority + closed sets, explicitly "use your judgement." No exhaustive case mapping.

## Must pin (never delegate)

output schema / field semantics / required fields · closed enum values (no inventing) · tool names + allowed scope · authority & non-recomputable fields · safety red-lines (no injury loading; no diagnosis / medication / medical prescription) · overreach limits · fact sources (data only from what was read — no fabrication).

## Must delegate (never script)

modality choice · composition (how many blocks, order) · movement / exercise pairing · where intensity lands under the band ceiling · weighing goal × readiness × equipment × injury × trigger.
→ give principles + priority + closed set, not a "state → plan" table.

## Examples

A few — to anchor output **shape**, field **semantics**, or a **tie-break**. One JSON example = good. A long "activity → modality" mapping table = bad: it replaces runtime judgement.

## Decision tables

- **OK for**: safety, interface, permission, fact source, non-recomputable fields — constraints that are meant to be fixed and enumerable.
- **Not OK for**: modality choice, composition, intensity — scripting these pins runtime judgement to a write-time guess (strictly worse than the model deciding with full context).
- **Test**: is the table drawing a **boundary** or making a **design**? Boundary → table OK. Design → no table.

## Language

Write instructions in **English**; put **Chinese only inside example output** (the user-facing language) — matching the sibling steps (`daily-report`, `workout-readiness`). Keep one language across a doc and across all step docs, so the router + steps read uniformly.

## Self-check

- [ ] One Scope line (`only to …`) at the top?
- [ ] Contract schema / enums / field-semantics / tool-names unambiguous and un-guessable?
- [ ] Every Rail a real safety / interface / authority / overreach limit — not a design preference dressed as a rule?
- [ ] No design judgement written as an exhaustive map / decision tree? (→ principle + priority + closed set)
- [ ] No ADR / MVP / history / trigger backstory the executor doesn't need?
- [ ] Examples anchor shape / semantics / tie-break — not make decisions?
- [ ] Closed sets fully listed (no inventing); open reasoning explicitly handed over?
- [ ] One language throughout — English instructions, Chinese only in example output?
- [ ] Trimmed to the bone: every line is contract, boundary, or judgement frame.

## Skeleton

```
Scope: Use this doc only to <do X> from <intent>. Nothing else.

## Contract
- Input: <shape + field semantics>
- Output: <schema + 1 example>; <field> ∈ { closed enum } — never invent.
- Tool: <name> only.

## Rails (hard limits)
| limit       | rule                                  |
| <authority> | <e.g. band 端侧已算，不重算>            |
| <safety>    | <e.g. acute injury 不加载>             |
| <fact src>  | <e.g. equipment 必来自真实环境>         |

## Runtime Judgement (design within the Rails)
<design task>: weigh <inputs>; priority <a > b > c>; closed set <…>;
don't table-lookup — use your judgement.
```
