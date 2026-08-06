.PHONY: check test

check:
	bun run typecheck
	cd worker && cargo fmt -- --check
	cd worker && cargo clippy --all-targets -- -D warnings

test:
	bun test orchestrator/tests
	cd worker && cargo test
