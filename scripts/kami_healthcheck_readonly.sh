#!/usr/bin/env bash
# KAMi-VPS-1 read-only health check.
#
# This is a thin wrapper. The real audit now lives in vps-healthcheck-readonly.sh,
# which is provider-agnostic, so the same sections run against the Hostinger and
# OCI machines and their reports are directly comparable.
#
# Keeping this file means "bash kami_healthcheck_readonly.sh" still works.

export AUDIT_LABEL="${AUDIT_LABEL:-kami-VPS-1}"
export AUDIT_PROVIDER="${AUDIT_PROVIDER:-Oracle Cloud Infrastructure - VM.Standard.A1.Flex, 4 OCPU / 24 GB}"
export AUDIT_DIRS="${AUDIT_DIRS:-/opt/kami-vps-1 /opt/aire-os /srv/kami /opt /srv}"
export AUDIT_URLS="${AUDIT_URLS:-http://127.0.0.1:8000/api/v1/version http://127.0.0.1:3000/health http://127.0.0.1:3001/health http://127.0.0.1:8080/health}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/vps-healthcheck-readonly.sh" "$@"
