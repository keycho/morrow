# @fletch/receipts

```
>>--->  fletch
```

weekly accuracy receipts. generates a markdown summary and a rendered png
card (dark terminal aesthetic, monospace, arrow mark) showing, per token,
last week's mean absolute error between the pre-open fair value and the
actual open, the best call of the week, and the week's on-chain commits with
a link to the latest commit tx.

generation only. nothing is auto-posted anywhere; the operator posts the
cards manually.

## png rendering

the card is built as an svg string and rasterized with
`@resvg/resvg-js`, an optional native dependency that renders svg to png
without a headless browser. it is lazily imported: if it is not installed the
receipt still generates with the svg source and the png is omitted. this
keeps the base install light and generation robust.

## run

```
DATABASE_URL=... pnpm receipts          # generate last week's receipt
DATABASE_URL=... pnpm receipts --force  # regenerate if it already exists
```

the indexer worker also generates the weekly receipt automatically on the
configured weekday after the open anchors land (see config.receipts).

## storage and serving

receipts are stored in the `receipts` table and served by the api:

- `GET /v1/receipts` list of weekly receipts
- `GET /v1/receipts/:weekStart` one receipt with markdown and summary
- `GET /v1/receipts/:weekStart/card.png` the rendered png (when available)

the dashboard lists the cards at `/receipts`.
