# ReiTunes web app

The React frontend has two layers of tests:

- Vitest covers state and data transformations without opening a browser.
- Playwright covers the important user flows in Chromium with the backend API mocked locally.

Install the dependencies and Playwright's browser once:

```sh
npm install
npx playwright install chromium
```

Then run either test layer on its own, or both together:

```sh
npm test
npm run test:e2e
npm run test:all
```

The Playwright command starts and stops its own Vite server. It does not need the Rust backend, a local database, or production credentials.
