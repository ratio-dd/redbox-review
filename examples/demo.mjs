import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { captureRedbox } from '../scripts/capture-redbox.mjs';

const outputDir = path.resolve('output/demo', new Date().toISOString().replaceAll(':', '-'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.route('**/*', route => route.abort());
  await page.setContent(`<style>body{font:16px Arial;margin:40px;background:#f6f8fa}h1{font-size:23px}.metric{background:white;border:1px solid #ddd;border-radius:8px;padding:22px;width:350px;margin-top:45px}strong{display:block;font-size:28px;margin-top:12px}</style><h1>One issue per image · Pool total</h1><div class="metric" id="top">Pool waiting<strong>6</strong></div><div class="metric" id="rows">Table column total<strong>6</strong></div>`);
  const files = await captureRedbox(page, {
    outputDir, name: '01-pool-total', issue: '01', title: 'Pool total matches table',
    targets: [page.locator('#top'), page.locator('#rows')],
    source: 'LOCAL FIXTURE', revision: 'synthetic example',
  });
  // 可选：显式指定示例导出路径；默认只写入被忽略的 output/。
  if (process.env.REDBOX_EXAMPLE_EXPORT) {
    await fs.copyFile(files.marked, path.resolve(process.env.REDBOX_EXAMPLE_EXPORT));
  }
  console.log(JSON.stringify(files, null, 2));
} finally {
  await browser.close();
}
