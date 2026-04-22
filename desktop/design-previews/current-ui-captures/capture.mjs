const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
await page.goto('http://127.0.0.1:1420/', { waitUntil: 'networkidle' });
await page.screenshot({ path: 'design-previews/current-ui-captures/00-manuscripts.png', fullPage: true });
const navTexts = ['知识库', 'RedClaw'];
for (const [index, label] of navTexts.entries()) {
  const target = page.getByRole('button', { name: label }).first();
  await target.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `design-previews/current-ui-captures/0${index + 1}-${label}.png`, fullPage: true });
}
await browser.close();
