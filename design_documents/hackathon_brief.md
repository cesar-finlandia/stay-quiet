# hackathon_brief.md — 2026-09 Agents for Humans Hackathon (Devpost + AWS)

> **Provenance:** transcribed on 2026-09-09 — the DEFINITIVE kickoff-day version.
> Source: https://agentsforhumans.devpost.com/ and every tab read the same day:
> Overview, Rules (`/rules`), Resources (`/resources`), Schedule (`/details/dates`),
> FAQs (`/details/faqs`), Updates (`/updates`). Discussions (`/forum_topics`) and
> Discord were not publicly readable without login and were NOT verified.
> Items marked `[unconfirmed]` were not published on the pages above at transcription
> time — re-check the event page / Updates tab / Discord before acting on them.
>
> Purpose: single paste-input for `src/profile` (Event Profile Extractor) and `src/pgm`
> (Problem Grounding Engine), per TU16 (`docs/tutorials/TU16-mock-hackathon-walkthrough.md`).
> Classification today: **DEFINED** — the binding challenge has been published since
> 2026-08-10 and is unchanged; there is no pending reveal (see §4 for verbatim).

---

# Agents for Humans Hackathon — Official Brief

**Build an AI agent with Strands Agents SDK that handles repetitive tasks**

🌎 Online Hackathon · 💻 ~5-week build: 2026-08-10 → 2026-09-14 · 🏆 $40,000 cash across Grand Prize + 3 tracks
Sponsor: AWS · Administrator: Devpost · ~8,858 participants at transcription time.

Every day, people lose hours to small, repetitive tasks like paying bills, scheduling meetings, or filling out the same paperwork again. AWS asks builders to change that with a background AI agent built on the Strands Agents SDK: instead of another app people open and manage, the agent runs autonomously and only surfaces when there is a real decision to make. Open to any part of life — home, work, health, money, errands, family, community.

## The challenge (summary — see §4 for verbatim)

Build a NEW AI agent with the Strands Agents SDK that does real work for real people end to end — not just chat about it — and enter it in exactly ONE of three tracks: Everyday Agents, Professional Agents, or Good Neighbor Agents (see §4 for verbatim track definitions). Deploying with Amazon Bedrock AgentCore is encouraged and strengthens the Technical Implementation score but is not required.

## Mandated technology + credits (summary — see §4 for verbatim)

Mandate: the project MUST be built with the Strands Agents SDK (Python or TypeScript). Free AWS account required; $50 in AWS Promotional Credits available to registered participants while supplies last — request via the Google Form linked on the Resources tab no later than **2026-09-11 12:00 PDT** (see §4 for verbatim procedure and the three conflicting form URLs found across tabs — open question Q1).

## Official resources

- Strands Agents Quickstart (Python & TypeScript): https://strandsagents.com/docs/user-guide/quickstart/overview/
- Strands Agents examples: https://strandsagents.com/docs/examples/
- Getting Started with Strands Agents (beginner, builder.aws.com): https://builder.aws.com/content/2xCUnoqntk2PnWDwyb9JJvMjxKA/getting-started-with-strands-agents-a-step-by-step-guide
- Strands Agents SDK technical deep dive (AWS ML blog): https://aws.amazon.com/blogs/machine-learning/strands-agents-sdk-a-technical-deep-dive-into-agent-architectures-and-observability/
- Introducing Strands Agents (AWS open-source blog): https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/
- Strands Agents video playlist (14 videos): linked on Resources tab (YouTube)
- Amazon Bedrock AgentCore docs: https://docs.aws.amazon.com/bedrock-agentcore/
- AgentCore CLI quickstart: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-get-started-cli.html
- Deploy a Strands agent to AgentCore Runtime: https://aws.github.io/bedrock-agentcore-starter-toolkit/user-guide/runtime/quickstart.html
- Live build session (TODAY 2026-09-09, 10:00 PDT / 17:00 UTC): "Agent Speedrun: Ideate → Build → Validate → Deploy" + recording of the 2026-09-08 session: https://youtu.be/vYQpWQgVKs8?si=3PClymHAaAlIphcM (see Updates tab)

## Prizes

$40,000 cash total: Grand Prize $10,000 (all eligible submissions) + per-track Gold $5,000 / Silver $3,000 / Bronze $2,000 × 3 tracks (Everyday, Professional, Good Neighbor). Winners also get an AWS social-post feature; Grand Prize adds a virtual roundtable with AWS experts. One prize per project. See §2 schedule / §4 rules for judging and delivery terms.

## Event schedule

| When (PDT, as published) | UTC | EEST (Finland) | What |
|---|---|---|---|
| Mon 2026-08-10, 09:00 PDT | 2026-08-10 16:00 UTC | 2026-08-10 19:00 EEST | Submissions open |
| Fri 2026-09-11, 12:00 PDT | 2026-09-11 19:00 UTC | 2026-09-11 22:00 EEST | AWS $50 credit request cutoff (form) |
| Mon 2026-09-14, 17:00 PDT | 2026-09-15 00:00 UTC | 2026-09-15 03:00 EEST | **Submissions close (hard deadline)** |
| Tue 2026-09-15, 09:00 PDT → Thu 2026-10-08, 17:00 PDT | 2026-09-15 16:00 UTC → 2026-10-09 00:00 UTC | — | Judging period |
| Wed 2026-10-14, 14:00 PDT (on/around) | 2026-10-14 21:00 UTC | 2026-10-15 00:00 EEST | Winners announced |

Kickoff-day note (2026-09-09): no single kickoff stream — the event has run since 2026-08-10. Today's only timed item is the Agent Speedrun live build session at 10:00 PDT (see Updates tab).

## Teams & participation

- Solo, teams (no size limit stated — "no limit on team size" per FAQ), and organizations may enter; an individual may join multiple teams AND enter solo.
- Fully online, worldwide, but a 22-item exclusion list applies (see §4): includes Australia, Brazil, Italy, Singapore, UAE, Quebec, Russia, and others — Finland is NOT excluded.
- Must be age of majority in country of residence (18 in Finland).
- Register via "Join Hackathon" on the event page (free Devpost account); each team/org appoints one Representative to submit.
- Multiple submissions allowed, but each must be unique and substantially different; each project may be entered in ONE track only.

## What to submit (exact field checklist — via the Devpost "Enter a Submission" page)

1. Project built with Strands Agents SDK meeting the Project Requirements (§4).
2. Text description — features and functionality (lead with problem; name Strands Agents explicitly per organizer pro-tip).
3. PUBLIC code repository URL (GitHub, GitLab, or Bitbucket) with all source, assets, and setup instructions; must be public and carry an MIT or Apache license file detectable/visible in the repo's About section.
4. README in the repo.
5. Architecture diagram (user input/interface → Strands agent loop → tools/integrations → AWS services → output; beauty optional, labels required).
6. Demo video, max 5 minutes, public on YouTube or Vimeo, containing (a) demonstration of the working project and (b) pitch covering (1) problem, (2) who it is for, (3) why it matters. Slides/screen recordings/voiceover OK; no need to appear on camera.
7. Track selection (exactly one of the three).
8. AWS Builder ID (the email address used to create it at profile.aws.amazon.com).
9. (Optional but scoring-relevant) Live demo link — strengthens Technical Implementation.
10. (Optional, bonus points) builder.aws.com blog post(s) with "Agents for Humans" in the title, publicly published before the deadline (0.2 pts each, max +0.6 — see §4).

## Judging criteria

Stage One: pass/fail viability gate (fits theme + reasonably applies Strands Agents). Stage Two: five EQUALLY weighted axes (judges' sole discretion). Bonus blog post adds up to +0.6 on a 1–5.6 scale.

| Axis | What judges look for |
|---|---|
| **Technical Implementation** | How thoroughly/skillfully Strands Agents is used; genuine effort, working non-trivial implementation; live demo and/or AgentCore deployment strengthen this score |
| **Design** | Complete, coherent product experience — not just a technical proof of concept |
| **Potential Impact** | Credible, specific case for solving a real problem for a real audience — and the demo actually addresses it |
| **Creativity & Originality** | Creative, non-obvious use of Strands Agents + genuine understanding of the problem space |
| **Presentation** | Video clearly demonstrates the project end-to-end; pitch communicates problem / who / why; easy to follow |

## Rules highlights (summary — see §4 for verbatim)

- New projects only: work must be built during 2026-08-10 → 2026-09-14; standard tools (frameworks, libraries, starter templates, AI coding assistants) allowed, but any OTHER pre-existing code/work must be disclosed.
- Original work, solely owned, MIT/Apache licensed; no IP violations; no financial/preferential support from Sponsor/Administrator.
- Free testing access for judges until judging ends (login credentials if private; hardware on request for exotic devices).
- All submission materials in English (or with English translation); video on YouTube/Vimeo public.
- One prize per project; prizes paid within 60 days of completed winner affidavits (10 business days to return forms); winners handle taxes/fees.
- Full Official Rules + Devpost ToS (incorporated by reference; Rules prevail on conflict) govern; arbitration in New York.

---

## My annotations (NOT part of the official brief)

### Kickoff-day status (2026-09-09): DEFINED, 5 days to deadline

- No prep-phase brief existed for this event, so this file is created fresh — there is no prep guess to retire and no "right/wrong" verdict to give.
- The challenge is fully published and unchanged since 2026-08-10: three tracks, Strands Agents mandate, submission fields, criteria, and deadlines are all binding. The "kickoff stream reveal" scenario does not apply here.
- Kickoff-day-only finding: the Updates tab's only live item is today's (2026-09-09, 10:00 PDT) Agent Speedrun build session + yesterday's recording — useful as a build reference, not a rule change.
- Urgent: the $50 AWS credit request cutoff is 2026-09-11 12:00 PDT (~2 days away) — claim immediately if not already done; note open question Q1 (three different form URLs across tabs).

### The official project broken down for my use

- **Specific user persona `[GUESS — to validate via PGM at Hour 0]`:** a solo trades/small-business owner (e.g. a Finnish contractor/electrician) buried in quote follow-ups, scheduling, and compliance paperwork — judgment-heavy skilled work surrounded by repetitive admin. Fits the Professional Agents track ("makes someone dramatically better at the work they already do").
- **What it does `[GUESS]`:** a background Strands agent that watches the inbox/job queue, drafts quotes and follow-ups, checks compliance checklists, and pings the owner only when a real decision (price, slot, exception) is needed — otherwise acts quietly with an audit trail.
- **Why AI / why now:** Strands' model-agnostic agent loop + tool calling turns "another dashboard to babysit" into autonomous background work; AgentCore (optional) gives the managed runtime/memory/observability story judges reward. Repetitive admin is exactly the "drain of real time and attention" the brief names.
- **Business value `[GUESS]`:** named user (solo contractors / micro-firms); revenue model = monthly SaaS per seat; TAM anchor to pin down during PGM (EU/US micro-contractor admin-software spend). Track pick: Professional Agents (single-track rule — no hedging).
- **Demo story:** 5-minute video (hard cap): 0:00–0:30 problem + who + why; 0:30–3:30 live working demo of one end-to-end job (inbox item → agent acts → human decision ping → resolved); 3:30–5:00 architecture diagram walk + Builder ID + repo. Fallback ladder: live → degraded-live (cached) → DEMODRIVE-recorded video → localhost mock replay (offline golden path).
- **Judging-axis strategy (how each axis gets evidenced via DECKGEN/SCRIPT/FAQDEF/SUBMIT):**
  - Technical Implementation → real Strands tools + non-trivial loop in public repo; live demo link and/or AgentCore deploy; architecture diagram labels every Strands/AWS piece.
  - Design → one coherent product flow (not a notebook demo); SCRIPT enforces the problem→demo→why arc.
  - Potential Impact → PGM-grounded persona + specific pain quote in text description and deck; demo resolves that exact pain.
  - Creativity & Originality → PAS scan of the project gallery before committing; FAQDEF pre-answers "how is this different from X".
  - Presentation → video checklist enforced at record time (demo + problem/who/why all present, ≤5:00, public YouTube link); text description names Strands Agents explicitly.

### Chassis module mapping (grounded in `contracts/component-catalog.json`)

- Mandated tech Strands Agents SDK (Python/TS, model-agnostic) has no 1:1 chassis component — it lives in the working copy's engine; chassis wraps around it:
- `resilience` (always): wrap every Strands/AWS outbound call; golden cache = degraded-live demo rung. `context`: agent-loop buffer so long background runs never hit a context-length wall mid-demo. `cost`: meter Bedrock/model calls per run so testing cannot burn the $50 credit.
- `platform` (deploy/transport/ui): needed — live demo link scores Technical Implementation points; typed streaming bus for agent step-by-step UI; one-command deploy + smoke verify. Requires `DEPLOY_PROVIDER` config (+ `VERCEL_TOKEN`/`VERCEL_PROJECT_ID` on default provider).
- `data` (synthetic): use synthetic/anonymized stand-in records instead of real client data (FAQ explicitly recommends this; avoids PII exposure in a public repo).
- `media` (stt/tts/vision/pdf): include ONLY if the build adds voice/image/PDF handling — not implied by the brief.
- `provenance` + `ideation` (provo/submit, deckgen/script/demodrive/faqdef): required for packaging — disclosure of AI-assistant + chassis reuse, `submission.md`, pitch artifacts, Q&A sheet, golden-demo capture.
- Env/provider keys required: AWS account credentials for the build (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / region), the model provider key behind Strands (e.g. Bedrock via AWS or `OPENAI_API_KEY`), `AWS Builder ID` email for the submission form; optional AgentCore deploy credentials.

### Constraints I care about this event (my notes)

- Solo entry. Online participation from Finland (EEST = PDT+10). No travel.
- Goal per playbook §6: complete, working, well-pitched submission — not prizes; with 5 days left, scope to ONE end-to-end job, not a platform.
- Demo must survive bad Wi-Fi: offline golden path (mock envelopes + DEMODRIVE capture recorded EARLY) + public YouTube video as the guaranteed-visible artifact.
- Sponsor-credit claiming: $50 AWS credits via Resources-tab form ASAP — hard cutoff 2026-09-11 12:00 PDT / 19:00 UTC; credits expire 2026-10-31; monitor usage to avoid extra charges.
- Hard deadline: **2026-09-14 17:00 PDT = 2026-09-15 00:00 UTC = 2026-09-15 03:00 EEST**. Target internal freeze 2026-09-13 EOD EEST (video upload + repo public + form fields pasted, only README polish after).
- Open questions to resolve via Updates/Discussions/Discord (see §4 Q1–Q4).

## Hackathon Rules - Requirements - Tracks

*Sole source-of-truth for the binding challenge, tracks, requirements and rules as published on the event page and its binding linked pages (Official Rules, Resources, FAQs). Verbatim excerpts are quoted; everything else is summary. Do not invent anything. Checklist/descriptive items already covered in full in §2 (prizes, schedule table, teams, submission-fields checklist, judging table, official resources) are referenced, not repeated.*

### 1. Binding challenge + tracks (verbatim)

Overview page (2026-09-09):

> "Build an AI agent with the Strands Agents SDK that handles routine and repetitive tasks in the background. Instead of another app people open and manage, the agent runs autonomously and only surfaces when there's a real decision to make."

> "1. **Everyday Agents** - an agent that takes the busywork out of daily life, home, money, health, errands, family. The best ones run quietly in the background and only ping you when there's a real decision to make."
> "2. **Professional Agents** - an agent that makes someone dramatically better at the work they already do, professionals, makers, creators, small-business owners. Target the repetitive, judgment-heavy tasks that eat their day."
> "3. **Good Neighbor Agents** - an agent that helps groups of people, not just one, neighborhoods, nonprofits, food banks, schools, libraries, small local orgs."

Official Rules §4, Project Requirements (verbatim core):

> "**Build a new AI agent with Strands Agents that does real work for real people. Your agent should take on something people actually deal with — and handle it end to end, not just chat about it. Enter it in one of the three tracks below.**"
> "*Deploying with Amazon Bedrock AgentCore is a smart architectural choice and will strengthen your Technical Implementation score, but it's not required.*"

Summary: one project → exactly one track (FAQ: "your Project may only fall into one track"); track choice should follow the PRIMARY USER (own life → Everyday; skilled professional → Professional; group/community → Good Neighbor). Multiple submissions allowed only if unique and substantially different. Prizes/schedule/teams/submission fields/judging table: see §2.

### 2. Mandated technology + credits/keys procedure (verbatim + summary)

Official Rules §4 (verbatim):

> "Sign up for an [AWS Account.](https://signin.aws.amazon.com/signup?request_type=register)"
> "[Install the Strands Agents SDK](https://strandsagents.com/docs/user-guide/quickstart/overview/)"
> "Entrants may request $50 in AWS Promotional Credits for the purpose of completing your Project for the hackathon while supplies last. AWS Promotional Credits can only be requested by individuals registered for the Hackathon. In order to request AWS Promotional Credits, you must complete the form at: [https://forms.gle/6sjzKiX6bKUMA5NEA](https://forms.gle/6sjzKiX6bKUMA5NEA) by **September 11th at 12pm PT**. AWS Promotional Credits are subject to the AWS Promotional Credits terms and conditions found at: [https://aws.amazon.com/awscredits/](https://aws.amazon.com/awscredits/). AWS Promotional Credits are not redeemable for cash and expire October 31st."
> "*NOTE: Additional charges incurred by the Entrant for the use of AWS products are the responsibility of the Entrant. Entrants are encouraged to monitor their usage of services so as to not incur additional charges.*"

Resources tab (verbatim): "Registered participants can request $50 in AWS Promotional Credits to cover build costs, while supplies last. Requests must be submitted by **September 11, 2026 at 12pm PT**." — via form at https://forms.gle/Ssr8zLw4afKg114M7. FAQ gives a THIRD URL: https://forms.gle/ZKQUctt5oLQMhahHA. → Open question Q1: which form URL is canonical; safest action is to submit via the Resources-tab link first and confirm receipt.

### 3. Rules highlights (verbatim excerpts + summary)

- New work only (Rules §4, verbatim): "**New Projects Only: Projects must be newly created during the Submission Period.** Participants may use standard development tools, including frameworks, libraries, starter templates, and AI coding assistants, but **must disclose any other pre-existing code or work incorporated into the Project.** The work described and submitted must have been built during the Submission Period." FAQ confirms: open-source libraries/frameworks/starter templates/AI assistants are fair game; everything else pre-existing must be disclosed; "when in doubt, disclose it."
- License + repo (Rules §4, verbatim core): 'Provide a PUBLIC URL to your code repository (on github, gitlab or bitbucket) … The repository must be public and **include MIT/Apache open source license** by including an open source license file. This license should be detectable and visible at the top of the repository page (in the About section).' Plus README and Architecture Diagram required.
- Video (Rules §4, verbatim core): "Include a video (**maximum 5 minutes**) … Demonstration of your working project … Pitch … must cover: (1) the problem you're solving (2) who it's for (3) why it matters … Slides, screen recordings, and voiceover are all acceptable — you do not need to appear on camera. … Videos must be uploaded to YouTube or Vimeo and made public."
- Originality/IP (Rules §4, verbatim core): "Be the **original work of the Entrant**, be solely owned by the Entrant, and not violate the Intellectual Property rights of any other person or entity." No prior financial/preferential support from Sponsor/Administrator (disqualification at Sponsor's discretion).
- Testing access (Rules §4, verbatim core): "The Entrant must make the Project available **free of charge and without any restriction, for testing, evaluation and use** by the Sponsor, Administrator and Judges **until the Judging Period ends**." Judges may judge on description/images/video alone; exotic hardware may be requested physically.
- Eligibility exclusions (Rules §3, verbatim list): NOT open to residents of / organizations domiciled in "Argentina, Australia, Brazil, Hong Kong, Indonesia, Italy, Malaysia, Philippines, Thailand, Vietnam, Singapore, Belarus, the so-called Donetsk People's Republic region (DNR), the so-called Luhansk People's Republic region (LNR), and the United Arab Emirates, (Province of) Quebec, Russia, Crimea, Cuba, Iran, North Korea, Syria and any other country designated by [OFAC]" — plus Promotion Entities' employees/agents/families, Judges and their employers, and conflict-of-interest cases.
- Judging method (Rules §6, verbatim core): "Stage One) The first stage will determine via pass/fail whether the ideas meet a baseline level of viability … Stage Two) All Submissions that pass Stage One will be evaluated in Stage Two based on the following **equally weighted criteria**" (five axes — see §2 table). "**Bonus builder.aws Blog Post (optional):** Submissions that advance to Stage Two may earn **up to 0.6 additional points** … (0.2 each) … **Final scores range from 1 to 5.6.**" Tie-break: highest score on the first listed criterion, then down the list, then judges' vote. Quote on method: "This process may utilize expert panels, peer review, automated AI-driven analysis, or any combination thereof."
- Bonus post terms (Rules §4/§6 + FAQ, verbatim core): 'Publish a post on builder.aws.com covering your build journey and use of AWS for this hackathon. Use Agents for Humans in your title. You can submit more than one post. Posts must be publicly published before the submission deadline.' Per Rules §6: "Use hashtag Agents for Humans in the title." (Note: Rules were "Updated 8/12/26 to remove requirement of #AgentsforHumans in Blog Post Bonus Submission items" — the `#` requirement is dropped; plain title text suffices.)
- Prize terms (Rules §8, verbatim core): "A Project can win one (1) Prize." "Prizes will be delivered **within 60 days** of the Sponsor or Devpost's receipt of the completed Required Forms" (10 business days to return them). Winners bear fees/taxes (W-9/W-8BEN as applicable). Grand Prize = $10,000 + social feature + expert roundtable; per-track Gold/Silver/Bronze = $5,000/$3,000/$2,000 + social feature (see §2).
- Submission modification (Rules §5, verbatim core): "Once the Submission Period has ended, you may not make any changes or alterations to your Submission" (except Sponsor/Devpost-permitted IP/PII/inappropriateness fixes); drafts may live in the Devpost portfolio beforehand.
- Disputes/governing law (Rules §13, verbatim core): binding arbitration under AAA rules; "governed by … the substantive laws of the State of New York, USA"; no class actions; no consequential/punitive damages. Devpost ToS incorporated by reference (Rules §14); Official Rules prevail on conflict.
- Pro-tip guidance from organizers (Updates tab, non-binding but scoring-relevant): text description must explain what/whom/how in plain language and "Name Strands Agents explicitly"; repo must contain all source/assets/setup instructions; video must show the working project, not just slides.

### 4. Open questions for kickoff Q&A / Discussions / Discord

- **Q1 `[unconfirmed]`:** Which AWS-credit form URL is canonical? Rules §4 gives `forms.gle/6sjzKiX6bKUMA5NEA`, Resources gives `forms.gle/Ssr8zLw4afKg114M7`, FAQ gives `forms.gle/ZKQUctt5oLQMhahHA`. Action: submit via Resources link, confirm receipt, ask in Discussions.
- **Q2 `[unconfirmed]`:** Is there a team-size cap in the Official Rules? FAQ says "no limit on team size" but Rules §3 defines Teams without a number — confirm only if joining a large team (solo: moot).
- **Q3 `[unconfirmed]`:** Any stream/judging-round details beyond the published dates (e.g. finalist demo calls)? Nothing published; assume async judging unless an Update says otherwise.
- **Q4 `[unconfirmed]`:** Discord/forum location for this event (Devpost Discussions vs AWS community Discord)? Not linked from the tabs read — find before asking technical questions.
- Could NOT verify (no public access): Discussions content, Discord posts, any kickoff-stream announcements beyond the Updates tab. No contradictions found between tabs except Q1.
