The previous response failed schema validation. Fix ONLY the validation errors listed below and return the corrected output as valid JSON conforming to the provided schema. Do not add commentary, do not invent fields absent from the schema, do not change fields that already passed validation.

Validation errors:
{{#each errors}}
- path: {{path}} | code: {{code}} | message: {{message}}
{{/each}}

Original output (for reference):
{{original_output_truncated_4k}}

Return ONLY the corrected JSON object.
