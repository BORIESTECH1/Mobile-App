Playwright test setup and run (Windows PowerShell)

1. Install dev dependencies (Node.js required):

    npm install

2. Install Playwright browsers (required for @playwright/test):

    npx playwright install

3. Run the Esusu E2E tests (Chromium):

    npx playwright test --project=chromium

Notes:
- Tests run against file:// URLs. If your environment blocks file navigation, start a simple static server in the project root (recommended):

    # PowerShell
    python -m http.server 8000

  Then update the test helper `localFileUrl` in `tests/esusu.spec.js` to use http://localhost:8000/groups.html

- Playwright will create a results folder on first run. If tests fail, rerun with `npx playwright test -g "Esusu flows" -o` for verbose output.
