# Photo Geolocator — make.fun bounty entry

An agent that answers where a street-level photo was taken, as a latitude and longitude.

## What it does

For each of the 25 photos in a trial it asks the vision model `claude-sonnet-5-5`
(through make.fun's metered gateway, on the entrant's own Anthropic key) where the
photo was taken, reads the latitude and longitude out of the answer, and posts every
answer to the trial env. When a model call is refused (no key pushed, budget spent)
or an answer holds no coordinates, it falls back to a single fixed point — the
spherical geometric median of the kit's practice photos — so no photo is left
unanswered.

## Run

```sh
node main.ts
```

Run as the grader runs it: Node 22, standard library only, with `MAKEFUN_ENV_URL`,
`ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` set.

## Bounty

[Find where a photo was taken](https://make.fun/bounty/photo-geolocator-01) on make.fun.
