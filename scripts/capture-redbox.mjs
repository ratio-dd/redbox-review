/**
 * 为调用方已有的 Playwright page 生成原图、红框图与定位证据。
 * 不启动浏览器、服务或登录；调用示例见 README.md。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function captureRedbox(page, options) {
  const { outputDir, name, issue, title, targets, source, revision = '' } = options;
  if (!path.isAbsolute(outputDir || '') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name || '')) {
    throw new Error('outputDir 必须为绝对路径，name 只能包含字母、数字、下划线及连字符。');
  }
  if (!issue || !title || !source || !Array.isArray(targets) || !targets.length) {
    throw new Error('请提供单个问题编号、简短标题、数据来源，以及至少一个 Locator。');
  }
  const viewport = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollX, scrollY,
    dpr: devicePixelRatio,
  }));
  const boxes = [];
  for (const locator of targets) {
    if (await locator.count() !== 1) throw new Error('每个 Locator 必须只匹配一个元素。');
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0 || box.x < 4 || box.y < 4 ||
        box.x + box.width > viewport.width - 4 || box.y + box.height > viewport.height - 4) {
      throw new Error('目标必须完整位于视口内并留有 4px 边距，请滚动或调整视口后重试。');
    }
    boxes.push(box);
  }
  await fs.mkdir(outputDir, { recursive: true });
  const prefix = path.join(outputDir, name);
  const files = { raw: `${prefix}-raw.png`, marked: `${prefix}-marked.png`, evidence: `${prefix}-evidence.json` };
  // 保留已有证据，调用方应为每次截图使用新名称。
  for (const file of Object.values(files)) {
    try { await fs.access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`输出文件已存在： ${file}`);
  }
  await page.screenshot({ path: files.raw, fullPage: false, animations: 'disabled' });
  const overlayId = `redbox-review-${randomUUID()}`;
  try {
    await page.evaluate(({ boxes, overlayId, issue, title, source, revision }) => {
      const host = document.createElement('div');
      host.id = overlayId;
      Object.assign(host.style, {
        position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none',
      });
      // Shadow DOM 隔离业务页面的样式。
      const root = host.attachShadow({ mode: 'open' });
      for (const [index, box] of boxes.entries()) {
        const border = document.createElement('div');
        Object.assign(border.style, {
          position: 'absolute', left: `${box.x - 3}px`, top: `${box.y - 3}px`,
          width: `${box.width + 6}px`, height: `${box.height + 6}px`,
          border: '3px solid #e32636', boxSizing: 'border-box', borderRadius: '3px',
        });
        const label = document.createElement('span');
        label.textContent = `${issue}${boxes.length > 1 ? `.${index + 1}` : ''} · ${title}`;
        Object.assign(label.style, {
          position: 'absolute', left: '0', bottom: '100%', background: '#fff',
          color: '#be123c', border: '1px solid #e32636', padding: '2px 5px',
          font: '13px/18px sans-serif', whiteSpace: 'normal',
          width: 'max-content', maxWidth: `${Math.max(1, innerWidth - box.x - 12)}px`,
          boxSizing: 'border-box', overflowWrap: 'anywhere',
        });
        // 目标靠近顶部时，将标签移到边框下方。
        if (box.y < 32) { label.style.bottom = 'auto'; label.style.top = '100%'; }
        border.appendChild(label);
        root.appendChild(border);
      }
      const stamp = document.createElement('div');
      stamp.textContent = [source, revision].filter(Boolean).join(' · ');
      Object.assign(stamp.style, {
        position: 'absolute', bottom: '8px', left: '8px', padding: '4px 8px',
        background: '#fff8e1', border: '1px solid #a16207', color: '#713f12',
        font: '12px/18px sans-serif', maxWidth: 'calc(100% - 32px)',
      });
      root.appendChild(stamp);
      document.documentElement.appendChild(host);
    }, { boxes, overlayId, issue, title, source, revision });
    // 页面移动后原坐标失效，重新等待稳定后再截图。
    for (const [index, locator] of targets.entries()) {
      const current = await locator.boundingBox();
      if (!current || ['x', 'y', 'width', 'height'].some(key => Math.abs(current[key] - boxes[index][key]) > 1)) {
        throw new Error('截图期间目标发生移动，请等待页面稳定并使用新名称重试。');
      }
    }
    await page.screenshot({ path: files.marked, fullPage: false, animations: 'disabled' });
    const safeUrl = new URL(page.url());
    safeUrl.username = '';
    safeUrl.password = '';
    safeUrl.search = '';
    safeUrl.hash = safeUrl.hash.split('?')[0];
    // 非网络页面可能在 URL 路径中包含整份内容，不将其复制进证据。
    const evidenceUrl = ['http:', 'https:'].includes(safeUrl.protocol)
      ? safeUrl.href : safeUrl.protocol;
    await fs.writeFile(files.evidence, JSON.stringify({
      issue, title, source, revision, url: evidenceUrl, capturedAt: new Date().toISOString(),
      viewport, boxes, files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.basename(file)])),
    }, null, 2));
    return files;
  } finally {
    if (!page.isClosed()) await page.evaluate(id => document.getElementById(id)?.remove(), overlayId);
  }
}
