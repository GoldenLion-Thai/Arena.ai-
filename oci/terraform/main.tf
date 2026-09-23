# =============================================================================
# GRiD-OS-SOVEREIGN on Oracle Cloud Infrastructure — fully automated
#
#   terraform init && terraform apply
#
# Creates: VCN + internet gateway + route table + NSG + public subnet, a GPU
# (or A1 Flex) instance, an optional block volume for model weights, and
# cloud-init that runs deploy/install.sh on first boot: node, ollama, models,
# systemd services, nginx, TLS, host firewall, then deploy/verify.sh.
#
# What this deliberately does NOT create: an ingress rule for 11434 or 8080.
# The model host stays on loopback; the edge serves the workspace.
# =============================================================================

locals {
  compartment = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  ad          = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.ads.availability_domains[0].name
  is_flex     = length(regexall("Flex", var.shape)) > 0

  # No SSH source given would lock you out, so fall back to any — and shout.
  ssh_cidrs = length(var.admin_cidrs) > 0 ? var.admin_cidrs : ["0.0.0.0/0"]
  web_cidrs = length(var.allow_cidrs) > 0 ? var.allow_cidrs : ["0.0.0.0/0"]

  image_id = var.image_is_gpu && length(data.oci_core_images.gpu.images) > 0 ? (
    data.oci_core_images.gpu.images[0].id
    ) : (
    data.oci_core_images.std.images[0].id
  )

  auth = var.auth_pass != "" ? "${var.auth_user}:${var.auth_pass}" : ""

  user_data = base64encode(templatefile("${path.module}/cloud-init.tftpl", {
    domain     = var.domain
    email      = var.acme_email
    models     = join(" ", var.models)
    auth       = local.auth
    allow      = length(var.allow_cidrs) > 0 ? join(" ", var.allow_cidrs) : ""
    tls        = var.tls
    keep_alive = var.keep_alive
    repo       = var.repo
    ref        = var.ref
    model_volume = var.model_volume_gb > 0
  }))
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = local.compartment
}

# GPU platform images ship CUDA drivers; standard images do not.
data "oci_core_images" "gpu" {
  compartment_id           = local.compartment
  operating_system         = "Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"

  filter {
    name   = "display_name"
    values = [".*GPU.*"]
    regex  = true
  }
}

data "oci_core_images" "std" {
  compartment_id           = local.compartment
  operating_system         = "Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
}

# -------------------------------------------------------------------- network
resource "oci_core_vcn" "this" {
  compartment_id = local.compartment
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.instance_name}-vcn"
  dns_label      = "grid"
  defined_tags   = var.defined_tags
  freeform_tags  = var.freeform_tags
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = local.compartment
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.instance_name}-igw"
  enabled        = true
}

resource "oci_core_default_route_table" "this" {
  route_table_id = oci_core_vcn.this.default_route_table_id
  display_name   = "${var.instance_name}-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

# One NSG, three ingress rules, and a very deliberate omission.
resource "oci_core_network_security_group" "this" {
  compartment_id = local.compartment
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.instance_name}-nsg"
}

resource "oci_core_network_security_group_security_rule" "ssh" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "INGRESS"
  protocol                  = "6" # TCP
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  tcp_options {
    destination_port_range { min = 22, max = 22 }
  }
  for_each = toset(local.ssh_cidrs)
}

resource "oci_core_network_security_group_security_rule" "https" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  tcp_options {
    destination_port_range { min = 443, max = 443 }
  }
  for_each = toset(local.web_cidrs)
}

resource "oci_core_network_security_group_security_rule" "http_acme" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  tcp_options {
    destination_port_range { min = 80, max = 80 }
  }
  # port 80 exists for the redirect and the Let's Encrypt challenge only
  for_each = var.tls == "off" ? toset([]) : toset(local.web_cidrs)
}

resource "oci_core_network_security_group_security_rule" "egress" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment
  vcn_id                     = oci_core_vcn.this.id
  cidr_block                 = var.subnet_cidr
  display_name               = "${var.instance_name}-subnet"
  dns_label                  = "edge"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_vcn.this.default_route_table_id
  security_list_ids          = [oci_core_vcn.this.default_security_list_id]
}

resource "oci_core_default_security_list" "lockdown" {
  manage_default_resource_id = oci_core_vcn.this.default_security_list_id

  # The NSG above is the real policy; the default list stays empty so that
  # anything added to another VNIC in this VCN is closed by default.
}

# ------------------------------------------------------------------- compute
resource "oci_core_instance" "host" {
  availability_domain = local.ad
  compartment_id      = local.compartment
  display_name        = var.instance_name
  shape               = var.shape

  dynamic "shape_config" {
    for_each = local.is_flex ? [1] : []
    content {
      ocpus         = var.flex_ocpus
      memory_in_gbs = var.flex_memory_gb
    }
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    nsg_ids          = [oci_core_network_security_group.this.id]
    assign_public_ip = true
    hostname_label   = "llm"
  }

  metadata = {
    ssh_authorized_keys = file(pathexpand(var.ssh_public_key_path))
    user_data           = local.user_data
  }

  agent_config {
    is_monitoring_disabled = false
    is_management_disabled = false
  }

  defined_tags  = var.defined_tags
  freeform_tags = var.freeform_tags

  lifecycle {
    ignore_changes = [metadata["user_data"]] # don't reboot on a password change
  }
}

# ------------------------------------------------- model weights on their own
resource "oci_core_volume" "models" {
  count            = var.model_volume_gb > 0 ? 1 : 0
  availability_domain = local.ad
  compartment_id   = local.compartment
  display_name     = "${var.instance_name}-models"
  size_in_gbs      = var.model_volume_gb
  vpus_per_gb      = "10" # balanced; raise to 20 for faster cold loads
  defined_tags     = var.defined_tags
  freeform_tags    = var.freeform_tags
}

resource "oci_core_volume_attachment" "models" {
  count           = var.model_volume_gb > 0 ? 1 : 0
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.host.id
  volume_id       = oci_core_volume.models[0].id
  is_read_only    = false
  # no explicit device: OCI assigns it and cloud-init finds the unmounted disk
}
