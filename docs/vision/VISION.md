# Guanxi — vision

**Status:** accepted direction · **Updated:** 2026-10-19
**Owner decisions:** [2026-10-19](../decisions/2026-10-19-owner-decisions.md)

## One sentence

Guanxi (关系, "connections") is an open-source, local-first **agent harness** that links every
model you can reach — subscriptions, API keys and local models on any of your machines — with
every machine you own. Strong models plan, cheap or free models do the long work, and the
harness keeps getting better from its own sessions.

## Why it should exist

Current harnesses (Claude Code, Codex, OpenCode, Goose, DeepSeek Harness) are good at one
session, with one provider family, on one machine. People who own several machines and pay
for several subscriptions still juggle them by hand:

- a paid subscription, a gifted API key and a local model live in three separate tools;
- a long task either burns expensive tokens or overwhelms a small local model;
- parallel agents collide on ports, Docker containers and CPU, and nobody knows which machine
  is free;
- a phone shows nothing useful about the session left running on the laptop;
- the same friction (a wrong workaround, a misheard product name) repeats every week because
  nothing learns from past sessions.

## Product promise

1. **One place for every model source.** Subscriptions (through the vendor's official agent),
   API keys with visible balances, local runtimes for text, image, video, speech and
   classification on any machine. The harness never hides a model's capabilities.
2. **Smart work with cheap executors.** A strong lead writes a precise plan and goes to sleep.
   A local model runs for hours on whichever machine is free, handing off to a fresh context
   before its window degrades. A judge watches; the lead wakes up only when it matters.
3. **Your machines as one fleet.** Every machine runs the same Guanxi. Each one knows its own
   load and grants leases on its own hardware, ports and containers. Work goes where there is
   room, including an optional pay-per-minute cloud machine within an approved budget.
4. **Light by default.** The harness orients the model (where it is, what it may use) and then
   gets out of the way. Every extra piece of scaffolding has to win on the benchmark.
5. **Everything is a plugin.** Providers, tools, the agent loop, compaction, UI panels,
   themes, languages: all are replaceable plugins on one kernel. Agents can write plugins too,
   inside a sandbox, following the shared design system.
6. **It learns from itself.** Periodic audits find friction in real sessions and turn it into
   better instructions, skills, glossary entries, plugins or upstream pull requests. Every
   automatic change passes a gate sized to its risk (an eval set for a glossary entry, the
   benchmark A/B for prompts and plugins), and core code changes only through a pull request
   the owner approves.
7. **Total visibility.** Every session is an append-only event log: prompts, visible
   reasoning, tool calls, sub-agents, handoffs, costs. People and agents read the same trace;
   reasoning stays on the owner's machines and is shown only to local models.

## Who it is for

- **Primary:** a technically confident owner of several machines (today's owner: a MacBook,
  a dual-boot Fedora/Windows GPU PC that stays on, a Fedora laptop and a small VPS, D-185; others may run
  anything from one laptop to geo-distributed servers) who pays for one or more
  subscriptions, holds a few API keys and runs local models.
- **Secondary:** the owner's family or friends on the same installation, each with private
  sessions, their own connections and optional sharing.
- **Tertiary:** someone with one Windows or Linux computer who just wants to download a good
  local image model and use it with a pleasant UI.

## Principles

1. **Truth over confidence.** Capability, fit, balance and status always carry a source, an
   observation time and a confidence level. `unknown` beats a wrong guess.
2. **Work belongs to a durable run, not to a window.** Closing a tab, sleeping a laptop or
   losing Wi-Fi never silently kills or duplicates work.
3. **One writer per thing.** Every session, run and machine resource has exactly one owner
   that may change it. This is what makes multi-master safe.
4. **Reuse before writing.** Take maintained open-source code under compatible licenses, with
   attribution, before writing our own. Cite a paper or an industry standard for non-obvious
   design choices.
5. **No artificial ceilings.** Context, output, media size and device counts come from the
   runtime, adapter or policy and are explained; a safe default never becomes a hidden cap.
6. **Secrets stay references.** Agents see `secret://` references and derived facts (health,
   balance), never values.
7. **Measured change.** Harness changes, including self-generated ones, pass a benchmark gate
   and can be rolled back.
8. **Simple first screen.** The empty session shows the logo, the project, the prompt box, the
   access mode, the model picker, the microphone and the paperclip. Depth is one click away.

## What Guanxi is not

- Not a way to share or resell subscriptions.
- Not a hosted SaaS; there is no central Guanxi server.
- Not a replacement for the vendors' own agents: Claude Code or Codex can be sub-agents inside
  Guanxi.
- Not a cluster manager for data centres; the fleet model targets up to about ten personal
  machines.

## Positioning against the closest projects

| Project                  | What it does best                                  | What Guanxi adds                                                                    |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| DeepSeek Harness (MIT)   | Cordis plugin model, typed UI slots, lossless trace | Fleet, multi-user, relay executor, benchmark-gated self-evolution; own governance   |
| OpenCode (MIT)           | Provider breadth, client/server, ACP               | Hardware-aware fleet, hibernating delegation, multimodal model workbench            |
| Claude Code / Codex      | Frontier model quality, polished UX                | Runs them as sub-agents next to API and local models; owner-controlled routing      |
| Open WebUI / LM Studio   | Local model chat and management                    | Agentic coding, durable runs across machines, fleet scheduling                      |
| GPUStack / Xinference    | Model serving on clusters                          | Apple Silicon + Windows + Linux personal fleet, agent-centric scheduling            |

## Success signals (to be measured, not assumed)

- A delegated run of six hours or more on a local 30B-class model completes its plan items
  with all gates green, without the lead model spending tokens in between, and the quality per
  cycle does not trend down (MS1 gate in the [roadmap](../plans/ROADMAP.md); relay benchmark
  in [ADR-0020](../decisions/0020-relay-executor-handoff-and-judge.md)).
- The private benchmark detects a 10-point regression before a harness change is promoted
  (stage B1 gate).
- Friction per 100 sessions falls release over release in the audit report (REQ-K6).
- A new user downloads a local image model and generates a picture within ten minutes
  (REQ-G7).
- The fleet design holds for about ten machines (REQ-B6).
