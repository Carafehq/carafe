# carafe.sh

The project website: one static page (`public/index.html`) and its GIFs (copies of `docs/media`).
No build step. Deployed to Cloudflare (static assets on Workers):

```sh
cd site && npx wrangler deploy
```
