.PHONY: smoke

smoke:
	python3 -m py_compile agent.py
	npx -y @synapsor/runner mcp serve --help >/dev/null
	@printf '%s\n' "OpenAI Agents stdio example smoke passed."
