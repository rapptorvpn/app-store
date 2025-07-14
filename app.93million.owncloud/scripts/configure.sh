#! /bin/env bash

set -e

if ! occ files_external:list | grep "/Rapptor files" > /dev/null; then
  occ app:enable files_external
  occ files_external:import /scripts/files_external_volumes.json
  occ config:app:set --value yes core enable_external_storage
fi
