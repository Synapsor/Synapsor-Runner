.PHONY: demo

demo:
	@printf '%s\n' "Unsafe shortcut:"
	@printf '%s\n' '  agent -> execute_sql("UPDATE invoices SET late_fee_cents = 0 ...")'
	@printf '%s\n' ""
	@printf '%s\n' "Synapsor guarded-action proof:"
	npx -y @synapsor/runner try --prove --yes --no-open
	@printf '%s\n' ""
	@printf '%s\n' "Risk audit example:"
	npx -y @synapsor/runner audit --example dangerous-db-mcp --format markdown
