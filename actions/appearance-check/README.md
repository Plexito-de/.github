# appearance-check

Run after a production deploy. It reads the live site, not the repo, because these defects exist only in
what is served: a globe instead of the favicon in Google, a second host answering 200, a share card with
no image, a soft 404.

```yaml
- uses: Plexito-de/.github/actions/appearance-check@<sha> # main
  with:
    url: https://example.com/
```

Warn-only by default: each FAIL becomes a workflow warning and the step summary holds the full report.
Pass `fail-on-error: "true"` to make it blocking.

The script is a copy of `web-quality-gates/scripts/appearance-check.py` in the private
`dotfiles-and-globals` repo, which is the source. That repo's `check-globals.sh` fails when the two differ.
