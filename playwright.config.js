// Screen check for the Surya Audit page. scripts/verify.sh starts the API offline and sets BASE_URL.
const { defineConfig, devices } = require('@playwright/test');

if (!process.env.BASE_URL) {
  throw new Error('Set BASE_URL to a running Surya Audit server, e.g. BASE_URL=http://127.0.0.1:8000');
}

module.exports = defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  reporter: 'line',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.BASE_URL, trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
