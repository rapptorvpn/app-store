#! /bin/env bash

set -e

php /usr/src/nextcloud/occ \
  maintenance:install \
  --database='sqlite' \
  --admin-user='admin' \
  --admin-pass="$(openssl rand -base64 40)"

php /usr/src/nextcloud/occ \
  config:system:set \
  trusted_domains 0 --value="app-93million-nextcloud.${RAPPTOR_BASE_DOMAIN}"
