# Requirement IDs: RES-04, XCUT-08
"""Structured-output validation + exactly-one self-repair round-trip — DP-A §4.4, §6.

Python mirror of validate.ts. Single source: master_blueprint.md §4 #4. Error
shape frozen at contracts/validation-error.schema.json. Synchronous, side-effect-
free validation; wraps jsonschema internally but exposes only the plain JSON
Schema surface (draft 2020-12). Domain-free (GOV-REU-02); standard library +
jsonschema only (RES-REU-01).
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Dict, List, Optional, TypedDict, Union

from jsonschema import Draft202012Validator


class ValidationError(TypedDict):
    """Frozen shape: contracts/validation-error.schema.json."""

    path: str  # JSON Pointer-style location ("/" = document root)
    message: str  # rendered verbatim into the repair re-prompt
    code: str  # stable machine-readable error code (type, required, format, enum...)


class ValidationResult(TypedDict):
    valid: bool
    errors: List[ValidationError]


class ValidationRepairFailed(Exception):
    """Internal signal for the wrapper (step 5): routes to the RES-03 fallback chain."""

    def __init__(self, message: str, errors: List[ValidationError]) -> None:
        super().__init__(message)
        self.reason = "validation_repair_failed"
        self.errors = errors


LlmCallable = Union[Callable[[str], str], Callable[[str], Awaitable[str]]]

_KEYWORD_TO_CODE = {
    "type": "type",
    "required": "required",
    "enum": "enum",
    "const": "const",
    "format": "format",
    "additionalProperties": "additional_properties",
}


def _pointer(segment: Any) -> str:
    return "/" + str(segment).replace("~", "~0").replace("/", "~1")


def _validate(schema: Dict[str, Any], data: Any) -> ValidationResult:
    validator = Draft202012Validator(schema)
    raw_errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    if not raw_errors:
        return {"valid": True, "errors": []}
    errors: List[ValidationError] = []
    for e in raw_errors:
        pointer = "/" + "/".join(_pointer(s)[1:] for s in e.absolute_path) if e.absolute_path else "/"
        errors.append(
            {
                "path": pointer,
                "message": e.message,
                "code": _KEYWORD_TO_CODE.get(e.validator, str(e.validator)),
            }
        )
    return {"valid": False, "errors": errors}


def validate(schema: Dict[str, Any], data: Any) -> ValidationResult:
    """validate(schema, data) -> {valid, errors} — synchronous and side-effect-free,

    never calls an LLM (DP-A §6.1). Errors match
    contracts/validation-error.schema.json.
    """
    return _validate(schema, data)


REPAIR_OUTPUT_TRUNCATE_CHARS = 4000

# Verbatim mirror of src/resilience/repair-prompt.template.md (DP-A §6.3).
_REPAIR_PROMPT_TEMPLATE = """The previous response failed schema validation. Fix ONLY the validation errors listed below and return the corrected output as valid JSON conforming to the provided schema. Do not add commentary, do not invent fields absent from the schema, do not change fields that already passed validation.

Validation errors:
{{#each errors}}
{{error_lines}}
{{/each}}

Original output (for reference):
{{original_output_truncated_4k}}

Return ONLY the corrected JSON object."""


def render_repair_prompt(errors: List[ValidationError], original_output: str) -> str:
    """Renders the generic re-prompt template (DP-A §6.3) with errors plus the

    original output truncated at 4k chars. Consumers never author prompts.
    """
    return _render_repair_prompt(errors, original_output)


def _render_repair_prompt(errors: List[ValidationError], original_output: str) -> str:
    lines = [f"- path: {e['path']} | code: {e['code']} | message: {e['message']}" for e in errors]
    truncated = original_output[:REPAIR_OUTPUT_TRUNCATE_CHARS]
    return _REPAIR_PROMPT_TEMPLATE.replace("{{error_lines}}", "\n".join(lines)).replace(
        "{{original_output_truncated_4k}}", truncated
    )


def _complete_repair(
    schema: Dict[str, Any], raw: Any, first_errors: List[ValidationError]
) -> Dict[str, Any]:
    """Shared tail of the repair round-trip (string check -> JSON parse ->

    re-validate). Raises ValidationRepairFailed on any second-stage failure so
    both async repair() and the wrapper's sync-position hook share identical
    semantics (DP-A §6.2/§6.4).
    """
    if not isinstance(raw, str):
        raise ValidationRepairFailed("repair output was not a string", first_errors)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationRepairFailed("repair output was not valid JSON", first_errors) from exc

    second = _validate(schema, parsed)
    if not second["valid"]:
        raise ValidationRepairFailed("repaired output still fails validation", second["errors"])
    return {"valid": True, "data": parsed, "errors": []}


async def repair(
    schema: Dict[str, Any],
    data: Any,
    re_prompt: Callable[[List[ValidationError]], str],
    call_llm: LlmCallable,
) -> Dict[str, Any]:
    """Exactly-one self-repair round-trip (DP-A §6.2): one call_llm invocation with

    re_prompt(errors), parse as JSON, re-validate, return. On second failure raises
    ValidationRepairFailed — the wrapper catches it and routes to the RES-03 fallback
    chain with reason "validation_repair_failed". No retry loop of its own; no global
    state (counter hygiene). Accepts sync or async call_llm.
    """
    first = _validate(schema, data)
    if first["valid"]:
        return {"valid": True, "data": data, "errors": []}

    prompt = re_prompt(first["errors"])
    try:
        raw = call_llm(prompt)
        if isinstance(raw, Awaitable):
            raw = await raw  # type: ignore[union-attr]
    except Exception as exc:  # noqa: BLE001 - wrapped into the internal signal
        raise ValidationRepairFailed(f"repair call_llm failed: {exc}", first["errors"]) from exc

    return _complete_repair(schema, raw, first["errors"])
