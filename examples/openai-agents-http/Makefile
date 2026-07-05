.PHONY: smoke

smoke:
	python3 -m py_compile agent.py
	npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http --help >/dev/null
	@printf '%s\n' "OpenAI Agents Streamable HTTP example smoke passed."
