.PHONY: smoke

smoke:
	python3 -m py_compile agent.py
	npx -y -p @synapsor/runner synapsor-runner mcp serve --help >/dev/null
	@printf '%s\n' "OpenAI Agents stdio example smoke passed."
