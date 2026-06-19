SHELL := /bin/bash
.DEFAULT_GOAL := dev

PNPM ?= pnpm
PORT ?= 4317
TICKETBOARD_URL ?= http://127.0.0.1:$(PORT)
BRIEF_WATCH_ARGS ?=

.PHONY: dev
dev:
	@set -euo pipefail; \
	export PORT="$(PORT)"; \
	export TICKETBOARD_URL="$(TICKETBOARD_URL)"; \
	dev_pid=""; \
	watch_pid=""; \
	cleanup() { \
		status=$$?; \
		trap - INT TERM EXIT; \
		if [ -n "$$watch_pid" ]; then kill "$$watch_pid" 2>/dev/null || true; fi; \
		if [ -n "$$dev_pid" ]; then kill "$$dev_pid" 2>/dev/null || true; fi; \
		if [ -n "$$watch_pid" ]; then wait "$$watch_pid" 2>/dev/null || true; fi; \
		if [ -n "$$dev_pid" ]; then wait "$$dev_pid" 2>/dev/null || true; fi; \
		exit "$$status"; \
	}; \
	trap cleanup INT TERM EXIT; \
	$(PNPM) dev & \
	dev_pid=$$!; \
	echo "Waiting for Ticketboard at $$TICKETBOARD_URL ..."; \
	until curl -fsS "$$TICKETBOARD_URL/" >/dev/null 2>&1; do \
		if ! kill -0 "$$dev_pid" 2>/dev/null; then \
			echo "pnpm dev exited before Ticketboard became ready"; \
			wait "$$dev_pid"; \
		fi; \
		sleep 1; \
	done; \
	echo "Starting Codex brief watcher ..."; \
	$(PNPM) brief:watch $(if $(strip $(BRIEF_WATCH_ARGS)),-- $(BRIEF_WATCH_ARGS)) & \
	watch_pid=$$!; \
	while kill -0 "$$dev_pid" 2>/dev/null && kill -0 "$$watch_pid" 2>/dev/null; do \
		sleep 1; \
	done; \
	if ! kill -0 "$$dev_pid" 2>/dev/null; then \
		wait "$$dev_pid"; \
	fi; \
	wait "$$watch_pid"
