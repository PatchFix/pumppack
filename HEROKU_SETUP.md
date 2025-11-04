# Heroku Setup for Puppeteer

## Overview
This project uses Puppeteer for headless browser scraping. Heroku requires special configuration to run Puppeteer.

## Buildpack Setup

Add the Puppeteer buildpack to your Heroku app:

```bash
heroku buildpacks:add --index 1 jontewks/puppeteer
heroku buildpacks:add --index 2 heroku/nodejs
```

Or use the Heroku dashboard:
1. Go to your app → Settings → Buildpacks
2. Add: `https://github.com/jontewks/puppeteer-heroku-buildpack`
3. Add: `heroku/nodejs` (if not already present)

## Environment Variables (Optional)

You can set these if needed:

```bash
heroku config:set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
```

## Memory Considerations

Puppeteer/Chromium can be memory-intensive. Consider:
- Using a dyno with at least 512MB RAM (Standard-1X or higher)
- Implementing proper browser cleanup (already done in `comScrape`)
- Limiting concurrent browser instances

## Testing Locally

```bash
npm install
node -e "import('./clank.js').then(m => m.comScrape('https://pump.fun/'))"
```

## Testing on Heroku

```bash
# Test the endpoint
curl "https://your-app.herokuapp.com/test-com-scrape?url=https://pump.fun/"
```

## Notes

- The `comScrape` function is configured with Heroku-friendly browser args
- Browser instances are properly closed to prevent memory leaks
- Timeout is set to 30 seconds for page loads

