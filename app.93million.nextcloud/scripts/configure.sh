#! /bin/env bash

set -e

if ! php /var/www/html/occ files_external:list | grep "/Rapptor files" > /dev/null; then
  php /var/www/html/occ app:enable files_external
  php /var/www/html/occ \
    files_external:create \
    -c datadir="/files/" \
    -- "/Rapptor files" local "null::null"
fi
