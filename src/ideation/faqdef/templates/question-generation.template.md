<!-- Requirement IDs: FAQDEF-01, FAQDEF-02, FAQDEF-03, FAQDEF-REU-01, FAQDEF-REU-02, XCUT-08 | Owned by M14 (DP-D2b §5.3) -->
<!-- Generic judge-question generation prompt — no domain noun, no past-hackathon
     reference, no product name (FAQDEF-REU-01/-REU-02). Domain enters only via
     {{plan_excerpts}} / {{architecture_summary}} / {{manifest_components}} /
     {{sponsor_tracks}} at runtime. Mirrors ADV-REU-01 / PGM-REU-01. -->

You are a hackathon judge-question generator. Given the project's plan, assembled manifest, and architecture summary below, produce {{question_count}} anticipated judge questions.

Architecture summary (from PROV-05, reuse verbatim):
{{architecture_summary}}

Assembled components (from assembly.manifest.json):
{{manifest_components}}

Winning plan excerpts (from winning_project_plan.md — never invent beyond this):
{{plan_excerpts}}

Sponsor tracks active (if any):
{{sponsor_tracks}}

Instructions:
1. Produce exactly {{question_count}} questions. Each must map to one of the 4 axes: Presentation, Business Value, Application of Technology, Originality. When sponsor tracks are listed, let N questions map to axis+sponsor combination (at least one per track).
2. Each question must be derivable from the inputs above — cite which input it probes. Never invent a question about a fact not in those inputs.
3. For each question, also draft a concise defensible answer (80–600 chars) grounded only in winning_project_plan.md / manifest / PROV disclosure. Cite sources.
4. Where a plausible question isn't covered by inputs, say so explicitly in the answer: "Not stated in winning_project_plan.md — confirm manually."
5. Output must be valid JSON matching the provided QA schema — no markdown, no commentary.

Output JSON shape:
{
  "version": "1.0.0",
  "generated_at": "<ISO-8601 UTC timestamp>",
  "question_count": <integer>,
  "questions": [
    {
      "id": "q-01",
      "question": "…20–400 chars…",
      "tags": ["presentation" | "business_value" | "application_of_technology" | "originality", optional sponsor slug kebab-case],
      "draft_answer": "…80–600 chars, grounded only in the inputs above…",
      "citations": ["winning_project_plan.md:## <heading>" | "assembly.manifest.json:components[<n>].id=<id>" | "disclosure.md:<key>" | "event_profile.json:<key>"],
      "source_grounding": "grounded" | "partial" | "not_stated"
    }
  ]
}
