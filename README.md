# blog

Personal site of **Iceberg-Deep** — Hack The Box write-ups and a learning-in-public blog.

🔗 **Live:** https://iceberg-deep.github.io/blog/

Built with [Jekyll](https://jekyllrb.com/) and served by GitHub Pages. Dark, terminal-flavored theme; no build tooling beyond Jekyll itself.

## Contents

- **Write-ups** — HTB box walkthroughs (`bankrobber.md`, `json.md`, `forest.md`), written to teach the thought process rather than read like a client report.
- **Blog** — short "today I learned" notes in `_posts/`, listed at the [blog index](https://iceberg-deep.github.io/blog/blog/).

## Structure

```
_config.yml        Jekyll config (baseurl: /blog)
index.html         home page (hero, bio, write-up cards)
blog.html          blog post index
*.md               HTB write-ups (use layout: writeup)
_posts/            dated blog posts (use layout: post)
_layouts/          default / post / writeup templates
img/               avatars, logos, screenshots
```

## Adding content

- **Blog post** — copy `_drafts/TEMPLATE.md` to `_posts/YYYY-MM-DD-slug.md`. Every post keeps the same cadence:
  ```yaml
  ---
  layout: post
  title: "Large Heading."
  subtitle: "Smaller heading that lands the hook."
  date: YYYY-MM-DD
  description: "Per-post link-preview promise, ~160-200 chars, in voice."
  image: /assets/og/slug.png
  tags: [tag-one, tag-two]
  ---
  ```
  - **Voice cadence:** cold-open hook, a thematic ASCII art code block right after the first paragraph, short `##` section turns, visceral/confident tone, edge aimed at the work not the reader, one-line takeaway to close.
  - **Link preview is required.** A real `description:` + a 1200×630 `image:` are what make the post look like it has substance everywhere (Discord/iMessage/LinkedIn all read the same `og:` tags). Generate the card in-style:
    ```bash
    scripts/og-card.sh slug "cat slug.md" "Title 1" "Title 2" "Subtitle." "tag · tag · tag"
    ```
  - OG/Twitter tags are emitted from front matter by `_includes/meta.html` (wired into `<head>`); site-level fallbacks live in `_config.yml` (`description`, `default_image`).
- **Write-up** — add a `*.md` at the repo root with `layout: writeup`, then link it from a card in `index.html`.

## Local preview

```bash
bundle exec jekyll serve   # http://localhost:4000/blog/
```
