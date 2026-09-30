output "public_ip" {
  description = "Instance IP — point your DNS A record here"
  value       = oci_core_instance.host.public_ip
}

output "url" {
  description = "Where the workspace is served"
  value       = var.domain != "" && var.tls != "off" ? "https://${var.domain}" : "http://${oci_core_instance.host.public_ip}"
}

output "ssh" {
  value = "ssh ubuntu@${oci_core_instance.host.public_ip}"
}

output "watch_bootstrap" {
  description = "First boot takes 8–15 minutes (mostly the model download)"
  value       = "ssh ubuntu@${oci_core_instance.host.public_ip} 'sudo tail -f /var/log/grid-os-sovereign-install.log /var/log/grid-bootstrap.log'"
}

output "verify" {
  description = "Run this after bootstrap completes"
  value       = "bash deploy/verify.sh --url ${var.domain != "" && var.tls != "off" ? "https://${var.domain}" : "http://${oci_core_instance.host.public_ip}"} --public-host ${oci_core_instance.host.public_ip} --expect-models${local.auth != "" ? " --auth ${var.auth_user}:<password>" : ""}"
}

output "image_used" {
  value = local.image_id
}

output "shape_used" {
  value = var.shape
}

output "security_notes" {
  value = [
    length(var.admin_cidrs) == 0 ? "SSH is open to 0.0.0.0/0 — set admin_cidrs to your egress IP(s)." : "SSH restricted to: ${join(", ", var.admin_cidrs)}",
    local.auth == "" ? "No basic auth at the edge — put your IdP in front or set auth_pass (TF_VAR_auth_pass)." : "Basic auth enabled for user '${var.auth_user}'.",
    length(var.allow_cidrs) == 0 ? "HTTPS is open to the internet." : "HTTPS restricted to: ${join(", ", var.allow_cidrs)}",
    "Ports 11434 (ollama) and 8080 (app tier) have no ingress rule and are bound to loopback.",
    "GPU shapes are billed hourly. terraform destroy when you are done.",
  ]
}
