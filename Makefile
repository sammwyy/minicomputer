.PHONY: check test

check:
	bun run typecheck
	cargo fmt --manifest-path worker/Cargo.toml -- --check
	cargo clippy --manifest-path worker/Cargo.toml --all-targets -- -D warnings

test:
	bun test orchestrator/tests
	cargo test --manifest-path worker/Cargo.toml
