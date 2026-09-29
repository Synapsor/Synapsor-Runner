# Reviewed Business Inputs

The fixed `app.request_change` contract accepts an activated outcome, opaque
observed subjects, and an optional `inputs` object. Business inputs are not a
database patch. Every accepted name, type, unit, bound, and enum is part of the
reviewed Action Rule. Unknown names, missing values, coercions, and out-of-range
values are refused before consuming a reference or loading source facts.

The rule compiler can use an `input` scalar expression when deriving the
permitted effect or evaluating eligibility and approval. Existing private facts,
tenant/principal context, target identity, effect-envelope constraints, approval
limits, and transaction re-verification remain mandatory. Inputs cannot replace
subject references, trusted bindings, arbitrary identifiers, SQL, or operator
permission. Relationship identities must be derived from reviewed subjects and
facts rather than accepted as business input.

For example, a refund outcome can declare integer `requested_amount_cents`
between 1 and 2500. A client calls the same tool with:

```json
{
  "outcome": "support.request_refund",
  "subject_refs": { "charge": "obj_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  "inputs": { "requested_amount_cents": 1200 }
}
```

The operator reviews both that outer bound and the eligibility/approval rules.
An input within the bound is not automatically eligible or approved. Exact
conditions still come from the activated rule and authoritative current facts.

A string input can explicitly declare a minimum alongside its maximum:

```json
{
  "name": "operator_note",
  "description": "The note supplied by the caller",
  "type": { "kind": "string", "min_length": 1, "max_length": 64, "comparison": "exact" }
}
```

Both lengths count UTF-16 code units, preserving the existing maximum's metric:
an ordinary emoji usually occupies two units. Required presence alone does not
mean nonempty. Omitting `min_length` preserves legacy behavior; explicit zero
also permits an empty string when the other constraints allow it. Whitespace is
not trimmed or forbidden, and enums and semantic conditions still apply. These
lengths are not interchangeable with JSON Schema's Unicode-code-point length.

For a source-backed program, the local operator can record the source's explicit
input ranges against the current intended Actions. This is attributed policy
interpretation, not independent proof of meaning. Runner checks compiled bounds
and supported finite equivalents, and sends known representation mismatches to
the existing bounded authoring correction flow. Missing interpretation remains
pending. A structural draft or a matching input range is not whole-policy review
or publication.

The canonical input values participate in request identity and are bound into
the immutable eligibility proof. Worker verification validates the same inputs
against the exact active rule before reloading facts and deriving the effect
again. Removing, changing, or adding an input therefore cannot reuse a previous
approval for a different change. Existing rules without inputs retain their
canonical representation and accept their original request shape.

Runtime changes never grant authoring tools to application agents. The operator
authoring interface may propose changes to these definitions, but only the
operator can activate the exact reviewed revision.
