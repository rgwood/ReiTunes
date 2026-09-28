# ReiTunes web app

The React frontend has two layers of tests:

- Vitest covers state and data transformations without opening a browser.
- Playwright covers the important user flows in Chromium, plus mobile playback and shared-session flows in WebKit, with the backend API mocked locally.

Install the dependencies and Playwright's browser once:

```sh
npm install
npx playwright install --with-deps chromium webkit
```

Then run either test layer on its own, or both together:

```sh
npm test
npm run test:e2e
npm run test:all
```

The Playwright command starts and stops its own Vite server. It does not need the Rust backend, a local database, or production credentials.

Use `npm run test:e2e -- --project=chromium` for desktop and responsive regression checks, or `--project=mobile-webkit` for the iPhone-sized WebKit checks. The audio test uses a real WAV stream to verify playback and automatic track changes. WebKit emulation does not verify physical iPhone lock-screen playback, Bluetooth routing or iOS background suspension.
