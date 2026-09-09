# Pitch Candidates — 10 candidates (grounded 9/10)

## pitch-01 — First-time homeowner facing wiring quotes (persona: persona-01, r/Rivian, 2026-06) — grounded ✓ — score 8.2
- **Problem:** New homeowner needs a panel upgrade and EV charger but cannot tell if a $4k+ quote with trenching and extras is fair, and has no time to chase multiple electricians while closing on a house.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for quote intake, scope checklist, and local price-range lookup, running on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime deployment; it works in background, flags overpriced line items, drafts comparison questions, and surfaces only price or safety decisions, with public MIT repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because parsing messy PDF quotes and explaining trade-specific line items needs current tool-calling agents. (IDEA-02 filter)
- **Evidence (paraphrased):** r/Rivian, 2026-06 — Homeowner was quoted over $4k through an arranged installer for a home charger setup, then found a local electrician willing to do similar work for under $2k, sparking confusion about fair pricing.
- **Illustrative quote:** "arranged installer priced far above a local electrician" — r/Rivian (≤25 words, subreddit only)
- **Predictability:** Quote-checkers are common gallery fare; differentiation is trade-specific electrical scope reasoning plus photo-aware checklist. Best fits Everyday Agents for home/money busywork. (does not replace IDEA-03 manual gallery scan)

## pitch-02 — Hobby maker and visual creator (persona: persona-02, r/lego, 2026-08) — grounded ✓ — score 7.6
- **Problem:** Maker spends months sourcing rare parts, tracking substitutes, and re-shooting a complex build, losing creative time to repetitive parts lists, inventory checks, and photo setup notes.
- **AI solution:** Built with Strands Agents SDK (TypeScript) with tools for parts-list builder, substitute finder, and shoot checklist, using Bedrock models on AWS with optional Amazon Bedrock AgentCore Runtime; it monitors the parts hunt quietly and pings only for cost or design swaps, with public Apache repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because matching visual references to parts and lighting notes needs current vision-plus-agent reasoning. (IDEA-02 filter)
- **Evidence (paraphrased):** r/lego, 2026-08 — Creator spent months designing, sourcing parts, and staging lighting to recreate a detailed picture-riddle scene with bricks, finding photography and part hunting especially tedious.
- **Illustrative quote:** "months spent sourcing pieces and matching lighting" — r/lego (≤25 words, subreddit only)
- **Predictability:** Creator assistants are predictable; edge is physical-craft sourcing plus visual checklist grounding. Best fits Professional Agents for makers and creators. (does not replace IDEA-03 manual gallery scan)

## pitch-03 — Young earner under family money pressure (persona: persona-03, r/povertyfinance, 2026-06) — grounded ✓ — score 8.0
- **Problem:** New full-time earner living at home is asked for $3k/month toward family mortgage and to support many relatives, with no plan for savings, payback terms, or saying no safely.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for budget modeling, contribution planner, and message drafter, running on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it tracks income, bills, and goals in background and surfaces only real money decisions, with public MIT repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because negotiating sensitive family money talk with tailored drafts needs current language-model agents. (IDEA-02 filter)
- **Evidence (paraphrased):** r/povertyfinance, 2026-06 — A young worker in a large low-income household recently landed higher pay and faces demands to split the check widely, feeling overwhelmed about boundaries and obligations.
- **Illustrative quote:** "new job income stretched across a large household" — r/povertyfinance (≤25 words, subreddit only)
- **Predictability:** Budget apps crowd the gallery; differentiation is boundary-setting plus culturally sensitive negotiation help. Best fits Everyday Agents for home and money. (does not replace IDEA-03 manual gallery scan)

## pitch-04 — Independent short-stay rental host (persona: persona-04, r/InterstellarKinetics, 2026-04) — grounded ✓ — score 8.5
- **Problem:** Solo Airbnb host juggles shifting cancellation rules, installment-payment confusion, cleaning disputes, and review risk, losing hours rewriting policies and responses for every booking.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for policy watcher, message drafter, and turnover checklist, hosted on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it monitors bookings quietly and pings only for refunds or exceptions, with public MIT repo, architecture diagram, and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because tracking shifting policy text and drafting case-specific guest replies needs current agent tool use. (IDEA-02 filter)
- **Evidence (paraphrased):** r/InterstellarKinetics, 2026-04 — Hosts describe major platform policy shifts around cancellations and risk, feeling that refund and dispute burdens moved onto them with little warning.
- **Illustrative quote:** "policy shifts pushing refund risk onto hosts" — r/InterstellarKinetics (≤25 words, subreddit only)
- **Predictability:** Hosting helpers are common; moat is background policy-change detection plus dispute-ready audit trail. Best fits Professional Agents for small-business owners. (does not replace IDEA-03 manual gallery scan)

## pitch-05 — Household bracing for fuel price shocks (persona: persona-05, r/oil, 2026-05) — grounded ✓ — score 7.8
- **Problem:** Family faces sudden diesel and grocery spikes from a supply crisis, with no clear view of what to stock, cut, or delay week to week without doomscrolling news threads.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for price watcher, pantry planner, and trip saver, on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it scans public price updates in background and pings only for buy-now or save-now choices, with public Apache repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because turning scattered crisis posts into personal savings actions needs current summarization agents. (IDEA-02 filter)
- **Evidence (paraphrased):** r/oil, 2026-05 — Analysis of a prolonged strait closure describes soaring diesel prices and government caps across Southeast Asia, with households worried about transport and food costs.
- **Illustrative quote:** "diesel spike squeezing daily transport budgets" — r/oil (≤25 words, subreddit only)
- **Predictability:** News summarizers are predictable; differentiation is household-level action planning under volatility. Best fits Everyday Agents for home and money. (does not replace IDEA-03 manual gallery scan)

## pitch-06 — Resident caught in drought HOA fights (persona: persona-06, r/fuckHOA, 2026-06) — grounded ✓ — score 8.3
- **Problem:** Neighborhood is split between brown-lawns-versus-green during water limits, with violation letters, snitching, and confusing HOA versus city rules escalating tension.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for restriction tracker, violation-letter helper, and neighbor notice drafter, on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it watches city and HOA updates quietly and pings only for real compliance choices, with public MIT repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because reconciling conflicting city and HOA texts into plain steps needs current document-aware agents. (IDEA-02 filter)
- **Evidence (paraphrased):** r/fuckHOA, 2026-06 — During a historic drought, residents report violations for brown lawns even as water limits apply, pitting appearance rules against conservation needs.
- **Illustrative quote:** "penalties for brown grass during water limits" — r/fuckHOA (≤25 words, subreddit only)
- **Predictability:** Neighborhood apps are familiar; edge is drought-rule mediation plus de-escalation drafts. Best fits Good Neighbor Agents for neighborhoods. (does not replace IDEA-03 manual gallery scan)

## pitch-07 — Career switcher chasing admin work (persona: persona-07, r/Sacramento, 2026-08) — grounded ✓ — score 7.9
- **Problem:** Former preschool teacher wants an office admin job but lacks software keywords like scheduling and records systems, and burns out tailoring resumes without feedback.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for posting matcher, resume tailoring, and application tracker, on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it scans postings in background and pings only for strong fits or apply decisions, with public MIT repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because translating classroom skills into admin keywords per posting needs current language-model reasoning. (IDEA-02 filter)
- **Evidence (paraphrased):** r/Sacramento, 2026-08 — A job seeker who moved recently describes endless hunting for entry-level admin roles, willing to take anything nearby and asking for local leads.
- **Illustrative quote:** "long search for any entry-level admin opening" — r/Sacramento (≤25 words, subreddit only)
- **Predictability:** Job copilots are crowded; differentiation is software-gap coaching plus honest fit scoring. Best fits Professional Agents for work skills. (does not replace IDEA-03 manual gallery scan)

## pitch-08 — Family caregiver for aging parents (persona: persona-08, r/AskWomenOver60, 2026-09) — grounded ✓ — score 8.4
- **Problem:** Working caregiver coordinates meds, hospice visits, meals, and visiting help for an elderly parent while burning out and missing coverage gaps across family members.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for schedule builder, task splitter, and resource finder, on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it organizes care tasks quietly and pings only for coverage gaps or health decisions, with public Apache repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because turning scattered family messages into safe care plans needs current conversational agents. (IDEA-02 filter)
- **Evidence (paraphrased):** r/AskWomenOver60, 2026-09 — A retiree who moved to care for an elderly father seeks resources and notes that a large share of peers now provide parent care alongside work and health strains.
- **Illustrative quote:** "retired early to provide full-time parent care" — r/AskWomenOver60 (≤25 words, subreddit only)
- **Predictability:** Care apps are common; edge is low-burden coordination plus respite-finding for solo caregivers. Best fits Good Neighbor Agents for families and community. (does not replace IDEA-03 manual gallery scan)

## pitch-09 — Renter unsettled by home intrusion (persona: persona-09, r/BestofRedditorUpdates, 2026-05) — grounded ✓ — score 7.7
- **Problem:** Renter suspects someone entered the home, finding odd signs but unsure how to log evidence, secure the unit, or escalate to landlord and police without overreacting.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for incident logger, safety checklist, and letter drafter, on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it guides documentation quietly and pings only for urgent safety actions, with public MIT repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because turning messy notes and photos into a clear timeline needs current multimodal agents. (IDEA-02 filter)
- **Evidence (paraphrased):** r/BestofRedditorUpdates, 2026-05 — Resident kept finding strange traces at home, then spotted a neighbor leaving the house, raising fears about unauthorized entry and what to document next.
- **Illustrative quote:** "strange traces then a neighbor seen leaving" — r/BestofRedditorUpdates (≤25 words, subreddit only)
- **Predictability:** Safety apps exist; differentiation is calm evidence logging plus landlord-ready escalation. Best fits Everyday Agents for home and family. (does not replace IDEA-03 manual gallery scan)

## pitch-10 — Busy renter drowning in small errands (persona: persona-10, —, —) — ungrounded ⚠️ — no external evidence, market validation required — score 6.5
- **Problem:** Solo renter loses evenings to bills, scheduling, and refill paperwork that repeats monthly, wanting quiet handling with a ping only when approval or payment is truly needed.
- **AI solution:** Built with Strands Agents SDK (Python) with tools for bill tracker, appointment booker, and reminder sender, on AWS with Bedrock models and optional Amazon Bedrock AgentCore Runtime; it clears routine errands in background and surfaces only real decisions, with public MIT repo and 5-min YouTube demo.
- **Why now:** No — could this have been built two years ago with a form and a database and no AI model? No, because acting across bills and calendars with judgment needs current tool-calling agents. (IDEA-02 filter)
- **Evidence (paraphrased):** —, — — No external grounding — market validation required manually (IDEA-01/03) *(never full verbatim)*
- **Illustrative quote:** none
- **Predictability:** Errand agents are the most predictable gallery entry; must differentiate via strict human-in-loop payments. Best fits Everyday Agents for daily busywork. (does not replace IDEA-03 manual gallery scan)

<!-- traceability: input_mined_hash=b64458c31448f2b52502f97d8e9a1dcf9f793dab9bd27529070d16413f5e57e4 | requirement IDs: PGM-07 PGM-08 IDEA-02 -->
