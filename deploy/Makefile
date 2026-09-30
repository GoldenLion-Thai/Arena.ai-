# =============================================================================
# GRiD-OS-SOVEREIGN — deployment automation
#
#   make help                      what this file does
#   make local                     fastest: run it here (mock host, no download)
#   make local MODEL=qwen2.5:14b   fastest: run it here against real Ollama
#   make package                   build the upload-ready artifact into dist/
#   make plan DOMAIN=llm.example.com EMAIL=you@example.com
#   make vps   DOMAIN=… EMAIL=… AUTH=admin:pw MODELS="qwen2.5:14b-instruct-q4_K_M"
#   make verify URL=https://llm.example.com AUTH=admin:pw PUBLIC_HOST=1.2.3.4
#   make deploy TARGET=ubuntu@1.2.3.4 DOMAIN=… EMAIL=…     (scp + remote install)
#   make terraform-plan / terraform-apply                   (oci/, automated infra)
#   make test                      163+ assertions incl. this deployment layer
# =============================================================================

DOMAIN       ?=
EMAIL        ?=
MODEL        ?= qwen2.5:7b-instruct-q4_K_M
MODELS       ?= $(MODEL)
AUTH         ?=
ALLOW        ?=
TLS          ?= auto
PORT         ?= 8080
HOST         ?= 127.0.0.1
APP_DIR      ?= /opt/grid-os-sovereign
OLLAMA_HOST  ?= 127.0.0.1:11434
KEEP_ALIVE   ?= 30m
TARGET       ?=
URL          ?= http://$(HOST):$(PORT)
PUBLIC_HOST  ?=
ARTIFACT_DIR ?= dist
TF_DIR       ?= ../oci/terraform
SSH_OPTS     ?= -o BatchMode=yes -o ConnectTimeout=10

SHELL := /bin/bash
MODEL_ARGS := $(foreach m,$(MODELS),--model $(m))
ALLOW_ARGS := $(foreach c,$(ALLOW),--allow $(c))
AUTH_ARG   := $(if $(AUTH),--auth $(AUTH),)

.DEFAULT_GOAL := help
.PHONY: help local real mock package plan vps verify deploy ssh-verify lint test smoke gateway deploytest terraform-plan terraform-apply terraform-destroy clean

help:
	@sed -n '2,20p' Makefile | sed 's/^# \{0,1\}//'
	@printf '\nVariables: DOMAIN EMAIL MODEL(S) AUTH ALLOW TLS PORT HOST APP_DIR OLLAMA_URL TARGET URL PUBLIC_HOST\n\n'

## local — fastest path on this machine -------------------------------------
local:
	@bash local.sh --model $(MODEL) --port $(PORT) --host $(HOST) --keep-alive $(KEEP_ALIVE)

mock:
	@bash local.sh --mock --port $(PORT) --host $(HOST)

## package — build dist/ artifact ready to upload ---------------------------
package:
	@bash package.sh --out ../$(ARTIFACT_DIR)

## plan / vps — automated install on a host you are on ----------------------
plan:
	@bash install.sh --dry-run --yes $(if $(DOMAIN),--domain $(DOMAIN),) $(if $(EMAIL),--email $(EMAIL),) \
	  $(MODEL_ARGS) $(AUTH_ARG) $(ALLOW_ARGS) --tls $(TLS) --port $(PORT) --app-dir $(APP_DIR)

vps:
	@sudo bash install.sh --yes $(if $(DOMAIN),--domain $(DOMAIN),) $(if $(EMAIL),--email $(EMAIL),) \
	  $(MODEL_ARGS) $(AUTH_ARG) $(ALLOW_ARGS) --tls $(TLS) --port $(PORT) --app-dir $(APP_DIR) \
	  --ollama-host $(OLLAMA_HOST) --keep-alive $(KEEP_ALIVE)

## verify — prove the deployment --------------------------------------------
verify:
	@bash verify.sh --url $(URL) $(if $(AUTH),--auth $(AUTH),) $(if $(PUBLIC_HOST),--public-host $(PUBLIC_HOST),) --expect-models

## deploy — upload the artifact and install remotely over ssh ---------------
deploy: package
	@test -n "$(TARGET)" || { echo "deploy needs TARGET=user@host"; exit 2; }
	@ART=$$(ls -t ../$(ARTIFACT_DIR)/grid-os-sovereign-*.tar.gz | head -1); \
	 SHA=$$(ls -t ../$(ARTIFACT_DIR)/*.sha256 | head -1); \
	 echo "→ uploading $$ART to $(TARGET)"; \
	 scp $(SSH_OPTS) "$$ART" "$$SHA" "$(TARGET):/tmp/"; \
	 echo "→ installing"; \
	 ssh $(SSH_OPTS) "$(TARGET)" "set -e; cd /tmp && sha256sum -c $$(basename $$SHA) && \
	   rm -rf grid-os-sovereign-* && tar -xzf $$(basename $$ART) && cd grid-os-sovereign-* && \
	   sudo bash deploy/install.sh --source . --yes \
	     $(if $(DOMAIN),--domain $(DOMAIN),) $(if $(EMAIL),--email $(EMAIL),) \
	     $(MODEL_ARGS) $(AUTH_ARG) $(ALLOW_ARGS) --tls $(TLS)"

ssh-verify:
	@test -n "$(TARGET)" || { echo "ssh-verify needs TARGET=user@host"; exit 2; }
	@bash verify.sh --ssh $(TARGET) --url $(URL) $(if $(AUTH),--auth $(AUTH),) \
	  $(if $(PUBLIC_HOST),--public-host $(PUBLIC_HOST),) --expect-models

## terraform — fully automated infrastructure (oci/) -------------------------
terraform-plan:
	@cd $(TF_DIR) && terraform init -input=false && terraform plan \
	  $(if $(DOMAIN),-var domain=$(DOMAIN),) $(if $(EMAIL),-var acme_email=$(EMAIL),)

terraform-apply:
	@cd $(TF_DIR) && terraform init -input=false && terraform apply -auto-approve \
	  $(if $(DOMAIN),-var domain=$(DOMAIN),) $(if $(EMAIL),-var acme_email=$(EMAIL),)

terraform-destroy:
	@cd $(TF_DIR) && terraform destroy -auto-approve

## quality gates -------------------------------------------------------------
lint:
	@for f in *.sh; do printf '  bash -n %-14s' "$$f"; bash -n "$$f" && echo OK; done
	@command -v shellcheck >/dev/null && shellcheck -S warning *.sh || echo "  (shellcheck not installed — syntax checked only)"

test:
	@cd .. && npm test

smoke:
	@cd .. && npm run test:smoke

gateway:
	@cd .. && npm run test:gateway

deploytest:
	@cd .. && npm run test:deploy

clean:
	@rm -rf ../$(ARTIFACT_DIR) && echo "removed ../$(ARTIFACT_DIR)"
