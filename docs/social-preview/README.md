# Edit the social preview

`card.html`, `card.css`, and `avatar.png` are the editable artwork. The portrait comes from the bundled CC0 avatar. The fonts are the existing packaged Space Grotesk files. The public site serves only the finished `public/social-preview-v1.png`.

Start `npm run dev`. Install the pinned browser tools as described in [development.md](../development.md#run-browser-checks), then render the card:

```sh
PLAYWRIGHT_MODULE="$PWD/tmp/browser-tools/node_modules/playwright/index.mjs" node docs/social-preview/render.mjs
```

The renderer writes `card.png`, a thumbnail, and verification data under `tmp/social-preview/render/`. It checks local asset loading, 1200 by 630 dimensions, opacity, and safe text margins. Inspect both images. Browser versions and platforms can change the rendered pixels.

When publishing new artwork, use a new filename such as `social-preview-v2.png`. Update the static image URLs and alternative text in `index.html`, then update the preview contract at the top of `scripts/verify-social-preview.mjs`. Social platforms can retain cached images and page metadata. A new image URL avoids reusing old image bytes, but cannot force a platform to re-scrape its cached page.

## Check the actual card

For a local Pages-style build, run:

```sh
npm run build -- --base=/talkinghead/
npm run serve:pages
```

In another terminal, run:

```sh
APP_URL=http://127.0.0.1:4173/talkinghead/ node scripts/verify-social-preview.mjs
```

The checker reads raw HTTP HTML without JavaScript. It validates the production metadata and fetches the equivalent image path from the local fixture. It also checks the PNG's headers, chunk boundaries, and checksums. It does not decode compressed pixels or emulate a social network's authenticated preview interface.

To check the public site, run `node scripts/verify-social-preview.mjs`. The Pages workflow runs both checks automatically. It stores the JSON evidence with the existing browser artifacts. No social SDK, account token, or Facebook app ID is required.
