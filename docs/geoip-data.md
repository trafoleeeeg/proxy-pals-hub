# Offline IP-to-country data

Umbra uses the `@iplookup/country` dataset to show a country flag for a verified proxy exit IP. The dataset is generated from the [user-country database](https://github.com/sapics/ip-location-db) and distributed under the [Open Data Commons PDDL](https://opendatacommons.org/licenses/pddl/1-0/). The package code is MIT licensed.

The build packs the dependency's country ranges into static files hosted by Umbra. Browser lookups download only those same-origin files; no proxy IP is sent to a geolocation provider. The displayed country is approximate and reflects the packaged dataset's publication date.

