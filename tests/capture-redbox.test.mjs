import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { captureRedbox } from '../scripts/capture-redbox.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const html = `<style>body{font:16px Arial;margin:40px}.metric{margin:44px 0;padding:20px;width:300px;border:1px solid #ddd}strong{display:block;font-size:28px;margin-top:12px}</style><h1>独立合成页面</h1><div class="metric" id="top">Pool<strong>6</strong></div><div class="metric" id="rows">表格合计<strong>6</strong></div>`;
async function fixture(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 650 } });
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.test/review?token=secret#/dashboard?session=secret');
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redbox-review-test-'));
  t.after(async () => { await context.close(); await fs.rm(outputDir, { recursive: true, force: true }); });
  const options = { outputDir, name: 'one-issue', issue: '01', title: 'Pool 对账',
    targets: [page.locator('#top'), page.locator('#rows')], source: '合成数据', revision: 'test' };
  return { page, options };
}
const overlays = page => page.locator('[id^="redbox-review-"]').count();

test('生成原图、标注图及可分享证据，保留业务内容并清理标记', async t => {
  const { page, options } = await fixture(t);
  const text = await page.locator('body').innerText();
  const files = await captureRedbox(page, options);
  assert.equal(await page.locator('body').innerText(), text);
  assert.equal(await overlays(page), 0);
  for (const key of ['raw', 'marked']) {
    const data = await fs.readFile(files[key]);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  const evidence = JSON.parse(await fs.readFile(files.evidence, 'utf8'));
  assert.equal(evidence.boxes.length, 2);
  assert.equal(evidence.issue, '01');
  assert.equal(evidence.url, 'https://example.test/review#/dashboard');
  assert.ok(!JSON.stringify(evidence).includes('secret'));
  assert.ok(Object.values(evidence.files).every(file => !path.isAbsolute(file)));
});

test('保留旧截图，不覆盖同名证据', async t => {
  const { page, options } = await fixture(t);
  await captureRedbox(page, options);
  await assert.rejects(captureRedbox(page, options), /已存在/);
  assert.equal(await overlays(page), 0);
});

test('拒绝歧义和不可见目标', async t => {
  const { page, options } = await fixture(t);
  await assert.rejects(captureRedbox(page, { ...options, targets: [page.locator('.metric')] }), /只匹配一个/);
  await page.locator('#top').evaluate(el => { el.style.marginLeft = '2000px'; });
  await assert.rejects(captureRedbox(page, { ...options, targets: [page.locator('#top')] }), /完整位于视口/);
  assert.equal(await overlays(page), 0);
});

test('标注图保存失败时仍清理自己的 DOM', async t => {
  const { page, options } = await fixture(t);
  const screenshot = page.screenshot.bind(page);
  let calls = 0;
  page.screenshot = async (...args) => {
    if (++calls === 2) throw new Error('模拟截图失败');
    return screenshot(...args);
  };
  await assert.rejects(captureRedbox(page, options), /模拟截图失败/);
  assert.equal(await overlays(page), 0);
});

test('目标在原图与标注图之间移动时拒绝近似坐标', async t => {
  const { page, options } = await fixture(t);
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (...args) => {
    const result = await screenshot(...args);
    await page.locator('#top').evaluate(el => { el.style.marginLeft = '30px'; });
    return result;
  };
  await assert.rejects(captureRedbox(page, options), /发生移动/);
  assert.equal(await overlays(page), 0);
});

test('靠右的长标签在视口内折行', async t => {
  const { page, options } = await fixture(t);
  await page.locator('#top').evaluate(el => {
    Object.assign(el.style, { position: 'fixed', left: '760px', top: '80px', width: '130px', margin: '0' });
  });
  const screenshot = page.screenshot.bind(page);
  let bounds;
  page.screenshot = async (...args) => {
    bounds = await page.evaluate(() => {
      const host = document.querySelector('[id^="redbox-review-"]');
      const label = host?.shadowRoot?.querySelector('span');
      return label ? { left: label.getBoundingClientRect().left, right: label.getBoundingClientRect().right } : null;
    });
    return screenshot(...args);
  };
  await captureRedbox(page, { ...options, title: '一段足够长的标题用于确认靠右标签自动折行而不会超出页面边界', targets: [page.locator('#top')] });
  assert.ok(bounds.left >= 0 && bounds.right <= 1000);
});
