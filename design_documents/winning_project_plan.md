---
title: "StayQuiet — Background Agent for Independent Short-Stay Hosts"
persona: "Independent short-stay rental host"
sponsor_tracks: ["Professional Agents"]
grounded: true
---

## Executive Pitch

Solo short-stay hosts lose hours each week rewriting house rules, cancellation replies, and cleaning-dispute responses as platform policies shift, while a single missed update risks a refund or a 1-star review. StayQuiet, built with Strands Agents SDK (Python) via tool-calling agent loop with Amazon Bedrock models on AWS with optional Amazon Bedrock AgentCore Runtime deployment, runs quietly in the background watching bookings and policy text, drafting guest-ready replies and turnover checklists, and pings the host only when a refund, exception, or review-risk decision is real — entered in exactly one track: Professional Agents.

Wins Technical Implementation via non-trivial Strands Agents SDK (Python) tool use plus live demo and optional AgentCore deploy; wins Design via one coherent host-inbox-to-resolution flow; wins Potential Impact via a specific solo-host pain resolved end-to-end; wins Creativity & Originality via background policy-change detection plus dispute-ready audit trail; wins Presentation via a ≤5:00 public YouTube demo that shows the working project and covers problem, who, and why. Every capability is powered explicitly by Strands Agents SDK (Python) with Amazon Bedrock models on AWS, so Stage One viability (fits theme + reasonably applies Strands Agents) and Stage Two scoring both trace directly to Hackathon-page requirements.

Background operation is the core promise: no dashboard to babysit, no chat to prompt. The agent, powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS, acts with an audit trail and surfaces only price, refund, or safety-adjacent calls, built new during 2026-08-10 → 2026-09-14 with Strands Agents SDK named explicitly in code, description, and video. This maximizes Grand Prize EV by evidencing all five equally-weighted axes in one end-to-end job rather than a scattered platform.

## Problem Framing

A solo Airbnb host wakes to three overlapping threads: a guest asking to split payment across installments that the platform now handles differently, a cleaner disputing a checkout task, and a cancellation request citing a rule that changed last month. She copies old templates, searches help-center pages, rewrites the same policy in friendlier tone, and still worries she promised the wrong refund. Each booking costs 45–90 minutes of rewriting and double-checking; workaround cost is late-night message debt, inconsistent enforcement, and review anxiety that discounts the next stay.

Severity is high because errors are money and reputation: wrong refund wording means lost payout, wrong cleaning call means turnover failure. Existing workarounds — saved snippets, spreadsheets, help-center bookmarks — go stale the moment policy text shifts. This pain is the ideal vehicle for Professional Agents — "an agent that makes someone dramatically better at the work they already do" — because hosting is skilled, judgment-heavy small-business work buried in repetitive, judgment-heavy tasks that eat their day. Framing the build this way, with background monitoring and drafting powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS, directly evidences Potential Impact and Creativity & Originality: a credible, specific case for solving a real problem for a real audience that static templates cannot solve.

## AI Solution

StayQuiet provides three background capabilities powered explicitly by the mandated stack. Policy Watcher uses Strands Agents SDK (Python) with a policy-fetch and diff tool on AWS to ingest public help-center and booking snapshots, summarize what changed, and flag only bookings affected. Message Drafter uses Strands Agents SDK (Python) tool-calling with Amazon Bedrock models to draft case-specific guest replies grounded in the current policy excerpt and booking facts, never sending refunds without human approval. Turnover Checklist uses Strands Agents SDK (Python) tools with Amazon Bedrock models on AWS to build a per-stay checklist from booking details and prior dispute notes, logging every agent action to an audit trail for dispute defense.

The host experience is quiet-by-default, powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS: connect synthetic booking feed, let the agent monitor, receive a ping only for refund, exception, or review-risk with a one-tap approve/edit, then review the audit log. No fixed node/graph topology is prescribed — capabilities orchestrate via the Strands agent loop with isolated tools and human-in-loop gates for money actions.

Why this stack wins the chosen track: Strands Agents SDK (Python) satisfies the "Build a new AI agent with Strands Agents" mandate and evidences Technical Implementation; AWS plus Amazon Bedrock model access supplies managed inference and deployment depth for background operation; optional Amazon Bedrock AgentCore Runtime strengthens Technical Implementation without risking eligibility. Design is won via one coherent inbox-to-resolution flow, Presentation via a live demo that shows the Strands loop acting end-to-end, not just chatting.

## Why Now

Could this have been built two years ago with forms and a database and no AI model? No — continuous policy diffing plus grounded, case-specific reply drafting needs tool-calling agents with long context, not static templates. Only Strands Agents SDK (Python) with Amazon Bedrock models on AWS provides the model-agnostic agent loop plus tool calling to turn another dashboard into autonomous background work that runs quietly and surfaces only real decisions.

This timing maximizes win probability: the brief explicitly asks for agents that handle work end to end, not just chat about it, and that run autonomously in the background. Building Policy Watcher, Message Drafter, and Turnover Checklist now, all powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS, evidences Technical Implementation (thorough, skillful Strands use) and Creativity & Originality (non-obvious background policy-change detection) exactly as the judging language rewards.

## Target Persona

Primary: independent short-stay rental host managing 1–3 listings solo, handling guest messaging, turnover, and refunds without staff. She works from her phone between turnovers, dreads refund disputes, and cannot afford staff or a property manager. Secondary: part-time co-hosts and cleaners coordinating via shared checklists.

Every persona need is served by Strands Agents SDK (Python) with Amazon Bedrock models on AWS running in the background: the solo host never prompts a chat, she only approves pings for price, refund, or review-risk; co-hosts and cleaners see only the per-stay checklist and audit trail. This specificity wins Potential Impact (credible case for a real audience, demo resolves that exact pain) and Design (complete, coherent product experience for one user, not a generic proof of concept) while anchoring the Professional Agents track choice to the primary user doing skilled work.

## Business Value

- specific_user: solo short-stay hosts losing nightly margin to message debt and review risk, served by background drafting and triage powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS
- tam_figure: estimate — solo-host segment implied by the brief; validate via gallery scan before quoting externally
- revenue_model: monthly per-host subscription plus per-listing add-on for audit-trail dispute packs (illustrative), with inference metered on AWS to protect margin
- why_ai: background policy-aware drafting and exception triage powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS — not reachable by snippet libraries or form macros
- Track ROI: Professional Agents focus maximizes win probability with deep alignment to skilled-work augmentation; single-track entry avoids dilution.

Track ROI: Focus on Professional Agents alone maximizes prize EV versus diluting across 3+ tracks. Per the brief Tracks/Prizes section, one project may enter exactly one track and a project can win one prize, with Grand Prize open to all plus per-track Gold/Silver/Bronze; under the 1–2 tracks only discipline, concentrating all Technical Implementation depth (Strands Agents SDK tool-calling, Bedrock inference, optional AgentCore deploy), Design coherence (one inbox-to-resolution flow), and Presentation time (≤5:00 on one end-to-end job) on the skilled small-business owner rubric beats splitting effort across Everyday and Good Neighbor narratives that would weaken Impact and Originality evidence for judges exercising sole discretion.

## Architecture

Engine-layer spec, powered by Strands Agents SDK (Python) with Amazon Bedrock models on AWS: synthetic booking feed and help-center snapshots enter a Strands agent loop on AWS; tools include policy-fetch and diff, booking-context lookup, draft composer, checklist builder, and audit logger; Amazon Bedrock models power synthesis; optional AgentCore Runtime hosts the loop with observability; UI states are quiet monitor, decision ping with approve/edit, and audit-trail view. Video plan: short public clip opening on the live product, covering problem, user, and importance, plus architecture walkthrough showing user input/interface to Strands agent loop to tools/integrations to AWS services to output. Repo carries MIT license, README, diagram, and setup steps. This layered spec directly evidences Technical Implementation (non-trivial Strands use, live demo, AgentCore), Design (coherent product, not notebook), and Presentation (diagram labels every Strands/AWS piece).

### Hackathon Requirements & Compliance Matrix

| Requirement | Brief Verbatim | How This Plan Satisfies It | Judging Axis Evidenced |
|---|---|---|---|
| Mandatory Technologies | "Build a new AI agent with Strands Agents" | Python Strands agent loop with tool-calling on AWS, Bedrock models, optional AgentCore Runtime; Strands named in code, description, video | Technical Implementation |
| Prize Tracks | "your Project may only fall into one track" | Enter exactly one track: Professional Agents for solo-host skilled work | Potential Impact |
| Judging Axes+Weights | "equally weighted criteria" plus Stage One pass/fail | One end-to-end job evidences all five axes; Stage One via theme fit + real Strands use | Presentation, Design, Potential Impact, Creativity & Originality, Technical Implementation |
| Submission Gate: public repo URL | "PUBLIC URL to your code repository" | Public GitHub repo with all source, assets, setup instructions | Technical Implementation |
| Submission Gate: license + README + spin-up | "include MIT/Apache open source license" | MIT LICENSE visible in About, README, one-command setup, free testing access until judging ends | Technical Implementation, Design |
| Submission Gate: architecture diagram | "Architecture Diagram required" | Diagram: interface to Strands loop to tools to AWS to output, labels required | Technical Implementation, Presentation |
| Submission Gate: demo video | "maximum 5 minutes" | Public YouTube ≤5:00 with working demo plus pitch covering problem, who, why | Presentation |
| Submission Gate: description + track + Builder ID + live demo | "Name Strands Agents explicitly" | Text leads with problem, names Strands explicitly, selects Professional Agents, provides Builder ID email, optional live link | Presentation, Technical Implementation |
| Rules: originality / disclosure / platform | "New Projects Only" | Built 2026-08-10 to 2026-09-14, solely owned, disclose AI assistants and chassis reuse, English materials, no IP violation | Technical Implementation, Potential Impact |

### Sponsored Track Strategy (1–2 tracks)

Focus: 1 track — per the brief Tracks/Prizes section a project may enter exactly one track, so under the 1–2 tracks only discipline concentrating on a single skilled-work track maximizes Grand Prize + track EV versus hedging across three. Selected track: Professional Agents. Sponsor: AWS. Rubric fit: solo hosts doing judgment-heavy small-business work buried in repetitive messaging and turnover tasks are exactly professionals the track describes as makers and small-business owners eaten by judgment-heavy tasks; background policy-aware drafting makes them dramatically better at work they already do. Exact SDK that will be imported and actually called: strands Agent and tool decorator for policy_fetch, policy_diff, booking_lookup, compose_draft, build_checklist, audit_log, Bedrock model via Strands model provider on AWS, and bedrock-agentcore-starter-toolkit for optional AgentCore Runtime deploy with observability. Demo/video co-star: the live demo opens on the quiet monitor, shows the Strands agent loop invoking policy-fetch/diff and Bedrock-grounded drafting step-by-step in the UI stream, triggers one human approval for a refund exception, then walks the architecture diagram labeling every Strands/AWS/Bedrock/AgentCore piece while the narration names Strands Agents SDK explicitly, making the sponsor stack the visible hero of Technical Implementation and Presentation.

Bonus/Submission Gate: ship public GitHub repo with MIT license, README and setup, labeled architecture diagram, public YouTube video ≤5:00 showing working Strands project plus problem/who/why, text description naming Strands Agents explicitly, single-track selection Professional Agents, AWS Builder ID email, optional live demo link to strengthen Technical Implementation, and optional builder.aws.com post with Agents for Humans in title published before 2026-09-14 17:00 PDT for up to +0.6 bonus; all work new from the submission period with AI-assistant reuse disclosed, free judge testing until judging ends, internal freeze 2026-09-13 EOD EEST.

## Suggested Module Emphasis

Context buffer, powered alongside Strands Agents SDK (Python) with Amazon Bedrock models on AWS, matters for multi-thread guest histories so long background runs never hit a context wall mid-demo. Resilience wrapper applies to every Strands/AWS outbound call with golden cache as degraded-live fallback. Cost metering guards Bedrock usage under the $50 credit limit with budget warnings. Synthetic booking and policy snapshots avoid PII in the public repo. One-command deploy with typed streaming bus supports the scoring-relevant live demo link, while disclosure generator plus submission formatter and deck/script/demodrive/faqdef packaging enforce the problem-to-demo-to-why arc and Q&A defense. These are advisory suggestions only — the Assembly Advisory module decides the implementation — but each directly traces to Hackathon-page judging language to maximize Grand Prize and Professional Agents win probability.
