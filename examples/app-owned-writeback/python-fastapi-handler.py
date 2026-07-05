import os
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel


class HandlerRequest(BaseModel):
    schema_version: str
    writeback_job_id: str
    proposal_id: str
    idempotency_key: str
    change_set: dict
    executor: str | None = None
    dry_run: bool = False


app = FastAPI()
EXPECTED_TOKEN = os.environ.get("SYNAPSOR_APP_WRITEBACK_TOKEN", "dev-handler-token")


@app.post("/synapsor/writeback")
def writeback(request: HandlerRequest, authorization: str | None = Header(default=None)):
    if authorization != f"Bearer {EXPECTED_TOKEN}":
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    scope = request.change_set.get("scope", {})
    if not scope.get("tenant_id"):
        raise HTTPException(status_code=400, detail="BAD_WRITEBACK_REQUEST")

    if request.dry_run:
        return {
            "status": "applied",
            "rows_affected": 0,
            "source_database_mutated": False,
            "details": {"dry_run": True},
        }

    # IMPORTANT: your app handler owns the final business write.
    # Runner creates the proposal and calls your handler only after approval,
    # but your handler must still enforce tenant/scope, expected-version or
    # conflict guard, idempotency key, allowed business action,
    # transaction/rollback, and safe error receipt.
    #
    # If you skip those checks, you can reintroduce cross-tenant writes,
    # lost updates, or duplicate writes. Keep handler credentials out of MCP.
    #
    # Put your app-owned transaction here.
    #
    # Examples:
    # - insert a refund_review row;
    # - insert an account_credit row;
    # - open a support_ticket row;
    # - update invoice + ledger rows together.
    #
    # Re-check tenant/principal authorization, idempotency, row/version guards,
    # and business policy before mutating application state.

    expected = request.change_set.get("guards", {}).get("expected_version", {})
    return {
        "status": "applied",
        "rows_affected": 1,
        "previous_version": str(expected.get("value", "")),
        "new_version": datetime.now(timezone.utc).isoformat(),
        "source_database_mutated": True,
    }
