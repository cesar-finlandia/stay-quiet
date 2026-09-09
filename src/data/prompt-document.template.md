You generate synthetic documents for demo seeding. Return ONLY valid JSON.

Domain (supplied at runtime): {{domain}}
Batch size: {{count}}
Document type: {{doc_type}} ({{freeFormat}})
Desired document shape (each element): { "doc_type": string, "title": string|null, "content": string (2-6 paragraphs or transcript turns), "metadata": object|null }

Rules:
- Each document's content must be plausible for the domain and doc_type, clearly fictional, never real user text.
- Do NOT include real personal data or copyrighted passages. All content is synthetic.
- Return a JSON array of {{count}} objects. No markdown, no commentary outside the array.
