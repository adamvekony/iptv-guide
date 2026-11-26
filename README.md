# TV guide (managed by IPTV Control Room)

This repository is created and updated automatically by IPTV Control Room. Don't edit it by hand: changes are
overwritten on the next publish.

- `channels.json` lists the channels in your playlist (tvg-id, name, logo) and the XMLTV sources. It contains no
  provider credentials.
- `logos/` holds locally verified channel logos.
- `build-guide.mjs` downloads the XMLTV sources, keeps only your channels and writes `guide.xml.gz`.
- `.github/workflows/build-guide.yml` runs the build twice a day and on every change, then publishes the result to
  GitHub Pages.

The playlist itself is not stored here. It contains provider credentials, so it lives in a secret gist.
