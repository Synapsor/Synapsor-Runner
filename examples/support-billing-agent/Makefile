.PHONY: demo unsafe evaluate clean

demo:
	cd ../.. && examples/support-billing-agent/scripts/run-demo.sh
	cd ../.. && examples/support-billing-agent/scripts/run-evaluation.sh

evaluate:
	cd ../.. && examples/support-billing-agent/scripts/run-evaluation.sh

unsafe:
	@printf '%s\n' "Unsafe raw-SQL shortcut this demo avoids:"
	@printf '%s\n' ""
	@printf '%s\n' '  agent -> execute_sql("UPDATE invoices SET late_fee_cents = 0 WHERE status = '\''overdue'\''")'
	@printf '%s\n' ""
	@printf '%s\n' "Why it is risky:"
	@printf '%s\n' "  - the model controls SQL shape and scope"
	@printf '%s\n' "  - tenant filters can be omitted or hallucinated"
	@printf '%s\n' "  - there is no proposal, approval boundary, conflict receipt, or replay"
	@printf '%s\n' ""
	@printf '%s\n' "Run 'make demo' to see the Synapsor path: semantic tool -> proposal -> approval -> guarded writeback -> replay."

clean:
	docker compose down -v --remove-orphans
