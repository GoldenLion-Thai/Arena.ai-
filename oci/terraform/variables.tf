# ---------------------------------------------------------------- identity
variable "tenancy_ocid" {
  description = "Tenancy OCID (from the OCI console → tenancy details)"
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment to create everything in. Defaults to the tenancy."
  type        = string
  default     = ""
}

variable "oci_profile" {
  description = "Profile name in ~/.oci/config"
  type        = string
  default     = "DEFAULT"
}

variable "region" {
  description = "OCI region — pick one that actually has your GPU shape in stock"
  type        = string
  default     = "eu-frankfurt-1"
}

variable "availability_domain" {
  description = "AD name. Leave empty to use the first AD in the region."
  type        = string
  default     = ""
}

# ------------------------------------------------------------------ compute
variable "shape" {
  description = <<-EOT
    Instance shape. Honest guidance:
      VM.GPU.A10.1   1x A10 (24GB)   — 14B q4 comfortably, ~40-60 tok/s
      BM.GPU.A10.4   4x A10 (96GB)   — 70B q4 / several models at once
      VM.GPU2.2      2x A10 (48GB)   — older but usually in stock
      VM.Standard.A1.Flex (ARM, no GPU) — free tier: CPU inference only,
                                          fine for 3B-7B q4 at 5-10 tok/s
    GPU shapes are NOT in the free tier; they are billed per hour.
  EOT
  type        = string
  default     = "VM.GPU.A10.1"
}

variable "flex_ocpus" {
  description = "OCPU count when using a *.Flex shape (ignored otherwise)"
  type        = number
  default     = 4
}

variable "flex_memory_gb" {
  description = "Memory in GB when using a *.Flex shape"
  type        = number
  default     = 32
}

variable "image_is_gpu" {
  description = "Look for the GPU-enabled Ubuntu platform image first (CUDA drivers preinstalled)"
  type        = bool
  default     = true
}

variable "boot_volume_size_gb" {
  description = "Boot volume — the OS plus the app tier"
  type        = number
  default     = 100
}

variable "model_volume_gb" {
  description = "Separate block volume mounted at /var/lib/ollama/models so weights survive instance replacement. 0 disables it."
  type        = number
  default     = 200
}

variable "instance_name" {
  type    = string
  default = "grid-os-sovereign"
}

# ------------------------------------------------------------------ network
variable "vcn_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.0.1.0/24"
}

variable "admin_cidrs" {
  description = "CIDRs allowed to SSH. Your office/VPN egress — not 0.0.0.0/0."
  type        = list(string)
  default     = []
}

variable "allow_cidrs" {
  description = "CIDRs allowed to reach the HTTPS UI. Empty means any (add basic auth in that case)."
  type        = list(string)
  default     = []
}

variable "ssh_public_key_path" {
  description = "Path to the SSH public key for the ubuntu user"
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

# ---------------------------------------------------------------- the product
variable "domain" {
  description = "Public hostname for TLS. Empty = serve on the IP without a certificate."
  type        = string
  default     = ""
}

variable "acme_email" {
  description = "Let's Encrypt contact address (expiry notices)"
  type        = string
  default     = ""
}

variable "models" {
  description = "Models to pull on first boot"
  type        = list(string)
  default     = ["qwen2.5:14b-instruct-q4_K_M"]
}

variable "auth_user" {
  description = "Basic-auth user for the edge (nginx). The app ships no auth of its own."
  type        = string
  default     = "admin"
}

variable "auth_pass" {
  description = "Basic-auth password. Pass as TF_VAR_auth_pass so it never lands in a tfvars file."
  type        = string
  sensitive   = true
  default     = ""
}

variable "tls" {
  description = "auto | certbot | self | off"
  type        = string
  default     = "auto"
}

variable "keep_alive" {
  description = "OLLAMA_KEEP_ALIVE — how long a model stays loaded between requests"
  type        = string
  default     = "30m"
}

variable "repo" {
  description = "GitHub owner/name the bootstrap fetches install.sh from"
  type        = string
  default     = "GoldenLion-Thai/Arena.ai-"
}

variable "ref" {
  description = "Branch, tag or commit to install"
  type        = string
  default     = "main"
}

variable "defined_tags" {
  type    = map(string)
  default = {}
}

variable "freeform_tags" {
  type    = map(string)
  default = { product = "GRiD-OS-SOVEREIGN", tier = "private-llm-host" }
}
