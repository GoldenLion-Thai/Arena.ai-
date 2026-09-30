terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 5.0"
    }
  }
}

# Authentication: use `oci setup config` (API key + ~/.oci/config) or the
# instance-principal/resource-principal flow. Never commit credentials; the
# provider reads OCI_CONFIG_FILE / OCI_PROFILE by default.
provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  region           = var.region
  config_file_profile = var.oci_profile
}
