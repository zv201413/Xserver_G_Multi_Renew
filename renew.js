const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACC = process.env.ACC || process.env.EML;
const ACC_PWD = process.env.ACC_PWD || process.env.PWD;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;

// T 延迟控制（单位：分钟）
//   不设置       → 无延迟，进窗口立刻执行
//   单个数字     → 固定延迟 N 分钟
//   A-B         → 随机延迟 A~B 分钟
//   手动触发时永不延迟
const T = process.env.T;
const IS_MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || !process.env.GITHUB_ACTIONS;
let DELAY_MS = 0;
if (T && !IS_MANUAL) {
  const range = T.match(/^(\d+)\s*-\s*(\d+)$/);
  const fixed = T.match(/^(\d+)$/);
  if (range) {
    const lo = parseInt(range[1]), hi = parseInt(range[2]);
    DELAY_MS = (Math.floor(Math.random() * (hi - lo + 1)) + lo) * 60000;
    console.log('🎲 随机延迟 ' + (DELAY_MS / 60000) + ' 分钟（范围 ' + lo + '-' + hi + '）');
  } else if (fixed) {
    DELAY_MS = parseInt(fixed[1]) * 60000;
    console.log('⏳ 固定延迟 ' + (DELAY_MS / 60000) + ' 分钟');
  }
}
if (IS_MANUAL) console.log('🖱️ 手动触发模式，跳过延迟');

const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xmgame';
const STATUS_FILE = 'status.json';

// 时区：续期页面时间为日本时间 (JST, UTC+9)
const TZ_OFFSET = 9;

// ── 状态持久化 ──

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

function getAccountStatus() {
  return loadStatus()[ACC] || {};
}

function gitCommitPush(commitMsg) {
  try {
    execSync('git config --global user.email "bot@xserver.renew" && git config --global user.name "XServer Bot"', { stdio: 'pipe' });
    execSync('git pull --rebase origin main', { stdio: 'pipe' });
    execSync('git add status.json', { stdio: 'pipe' });
    execSync('git commit -m "' + commitMsg + '"', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('📤 status.json 已推送');
    return true;
  } catch (e) {
    console.log('⚠️ status.json 推送失败（将被 workflow 兜底）');
    return false;
  }
}

// ── 日期工具 ──

function getNowJST() {
  return new Date(Date.now() + TZ_OFFSET * 3600000);
}

function getTodayStr() {
  return getNowJST().toISOString().slice(0, 10);
}

// 当前 JST 分钟数（从 00:00 起），用于比较页面给的具体时间
function getNowJSTMinutes() {
  var d = getNowJST();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Telegram 通知（带每日去重）──

async function sendTGOnce(statusIcon, statusText, extra, imagePath) {
  if (!TG_TOKEN || !TG_ID) return;
  var today = getTodayStr();
  var s = getAccountStatus();
  if (s.notifiedDate === today) {
    console.log('🔇 今日已通知过，跳过');
    return;
  }
  extra = extra || '';
  imagePath = imagePath || null;
  try {
    var time = getNowJST().toISOString().replace('T', ' ').slice(0, 19);
    var cnTime = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(11, 16);
    var text = 'XServer 延期提醒\n' + statusIcon + ' ' + statusText + '\n' + extra + '\n账号: ' + ACC + '\n时间: ' + time + ' (JST) / ' + cnTime + ' (CST)';
    if (imagePath && fs.existsSync(imagePath)) {
      var fileData = fs.readFileSync(imagePath);
      var fd = new FormData();
      fd.append('chat_id', TG_ID);
      fd.append('caption', text);
      fd.append('photo', new Blob([fileData], { type: 'image/png' }), path.basename(imagePath));
      var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
      if (res.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res.status, await res.text());
    } else {
      var res2 = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_ID, text: text })
      });
      if (res2.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res2.status, await res2.text());
    }
    // 标记今日已通知
    var status = loadStatus();
    if (!status[ACC]) status[ACC] = {};
    status[ACC].notifiedDate = today;
    saveStatus(status);
  } catch (e) { console.log('⚠️ TG 发送失败:', e.message); }
}

async function sendTG(statusIcon, statusText, extra, imagePath) {
  // 续签成功通知不受去重限制
  if (!TG_TOKEN || !TG_ID) return;
  extra = extra || '';
  imagePath = imagePath || null;
  try {
    var time = getNowJST().toISOString().replace('T', ' ').slice(0, 19);
    var cnTime = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(11, 16);
    var text = 'XServer 延期提醒\n' + statusIcon + ' ' + statusText + '\n' + extra + '\n账号: ' + ACC + '\n时间: ' + time + ' (JST) / ' + cnTime + ' (CST)';
    if (imagePath && fs.existsSync(imagePath)) {
      var fileData = fs.readFileSync(imagePath);
      var fd = new FormData();
      fd.append('chat_id', TG_ID);
      fd.append('caption', text);
      fd.append('photo', new Blob([fileData], { type: 'image/png' }), path.basename(imagePath));
      var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
      if (res.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res.status, await res.text());
    } else {
      var res2 = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_ID, text: text })
      });
      if (res2.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res2.status, await res2.text());
    }
  } catch (e) { console.log('⚠️ TG 发送失败:', e.message); }
}

// ── 调度 ──

function checkScheduling() {
  const today = getTodayStr();
  const s = getAccountStatus();
  if (!s.nextCheckDate) { console.log('🆕 首次运行'); return; }
  if (process.env.GITHUB_EVENT_NAME !== 'schedule') { console.log('💻 手动触发'); return; }
  if (today < s.nextCheckDate) {
    var days = Math.ceil((new Date(s.nextCheckDate) - new Date(today)) / 86400000);
    console.log('⏳ 预约 ' + s.nextCheckDate + '，还剩 ' + days + ' 天，秒退');
    process.exit(0);
  }
  console.log('📅 到达预约日期 ' + today);
}

function updateNextCheckDate(daysLater, reason) {
  var next = addDaysStr(getTodayStr(), daysLater);
  var status = loadStatus();
  if (!status[ACC]) status[ACC] = {};
  status[ACC].nextCheckDate = next;
  delete status[ACC].notifiedDate;  // 日期变了，清空通知标记
  saveStatus(status);
  console.log('📅 下次预约: ' + next + '（' + reason + '）');
  gitCommitPush('[Bot] ' + ACC + ' 下次检查 ' + next);
}

function updateNextCheckDateByDate(dateStr, reason) {
  var status = loadStatus();
  if (!status[ACC]) status[ACC] = {};
  status[ACC].nextCheckDate = dateStr;
  saveStatus(status);
  console.log('📅 下次预约: ' + dateStr + '（' + reason + '）');
  gitCommitPush('[Bot] ' + ACC + ' 下次检查 ' + dateStr);
}

async function setTodayAndExit(msg) {
  console.log('🔄 ' + msg + '，设今天为预约日继续轮询');
  var status = loadStatus();
  if (!status[ACC]) status[ACC] = {};
  status[ACC].nextCheckDate = getTodayStr();
  saveStatus(status);
  // 当天第一次跑才发 TG（内部写 notifiedDate 到 status.json）
  await sendTGOnce('🧊', '等待可续期', msg);
  // 推送 status.json（含 nextCheckDate + notifiedDate）回仓库
  gitCommitPush('[Bot] ' + ACC + ' 轮询日 ' + getTodayStr());
  process.exit(0);
}

// ── 页面解析 ──

async function parseRemainingMinutes(page) {
  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    var text = await page.evaluate(function() {
      var el = document.querySelector('[class*="remain"], [class*="time"], [class*="period"]');
      if (el) return el.innerText;
      return document.body.innerText;
    });
    var m = text.match(/残り(\d+)時間(\d+)分/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时' + m[2] + '分钟'); return parseInt(m[1]) * 60 + parseInt(m[2]); }
    m = text.match(/残り(\d+)時間/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时'); return parseInt(m[1]) * 60; }
    m = text.match(/(\d+)時間(\d+)分/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时' + m[2] + '分钟'); return parseInt(m[1]) * 60 + parseInt(m[2]); }
    console.log('⚠️ 未找到剩余时间');
    return null;
  } catch (e) { console.log('⚠️ 解析失败:', e.message); return null; }
}

/**
 * 读取续期页面，检测是否有限制提示
 *
 * 受限时页面包含如：
 *   残り契約時間が16時間を切るまで、期限の延長は行えません。
 *   更新をご希望の場合は、2026-06-10 20:40以降にお試しください。
 *
 * @returns {{ restricted: boolean|null, thresholdHours: number|null, nextDate: string|null, nextTime: string|null, nextMinutes: number|null }}
 */
async function parseExtendPage(page) {
  try {
    await page.waitForTimeout(2000);
    var text = await page.textContent('body');
  } catch (e) {
    console.log('⚠️ 未能读取续期页面');
    return { restricted: null, thresholdHours: null, nextDate: null, nextTime: null, nextMinutes: null };
  }

  var thresholdMatch = text.match(/残り契約時間が(\d+)時間を切るまで/);
  var nextMatch = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})以降/);

  if (thresholdMatch) {
    var thresholdHours = parseInt(thresholdMatch[1]);
    var nextDate = nextMatch ? nextMatch[1] : null;
    var nextTime = nextMatch ? nextMatch[2] : null;
    var nextMinutes = nextMatch ? parseInt(nextMatch[2].split(':')[0]) * 60 + parseInt(nextMatch[2].split(':')[1]) : null;
    console.log('🧊 受限: 阈值=' + thresholdHours + 'h, 可续期=' + (nextTime ? nextDate + ' ' + nextTime : '未知'));
    return { restricted: true, thresholdHours: thresholdHours, nextDate: nextDate, nextTime: nextTime, nextMinutes: nextMinutes };
  }

  console.log('✅ 可执行续期');
  return { restricted: false, thresholdHours: null, nextDate: null, nextTime: null, nextMinutes: null };
}

// ── 续期操作 ──

async function tryRenew(page, beforeMins, thresholdHours) {
  try {
    console.log('🔄 滚动到页面底部...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    await page.getByRole('link', { name: '期限を延長する' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('link', { name: '期限を延長する' }).click();
    await page.waitForLoadState('load');

    await page.getByRole('button', { name: '確認画面に進む' }).click();
    await page.waitForLoadState('load');

    console.log('🖱️ 执行延期...');
    await page.getByRole('button', { name: '期限を延長する' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: '5_before_back.png' });

    console.log('✅ 延期成功，获取新剩余时间...');
    await page.getByRole('link', { name: '戻る' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: 'success.png' });

    var afterMins = await parseRemainingMinutes(page);
    var beforeH = beforeMins ? (beforeMins / 60).toFixed(1) : '?';
    var afterH = afterMins ? (afterMins / 60).toFixed(1) : '?';
    var timeInfo = '续签前 ' + beforeH + 'h → 续签后 ' + afterH + 'h';
    console.log('⏱️ ' + timeInfo);

    // 动态计算下次检查：用续期后剩余时间 - 阈值，算出几天后再查
    var nextDays = 3;
    if (afterMins !== null && thresholdHours !== null) {
      var newH = afterMins / 60;
      var calcDays = Math.ceil((newH - thresholdHours) / 24);
      nextDays = Math.max(1, calcDays);
      console.log('📐 续期后剩余 ' + newH.toFixed(1) + 'h，阈值 ' + thresholdHours + 'h，约 ' + nextDays + ' 天后复查');
    }

    var status = loadStatus();
    if (!status[ACC]) status[ACC] = {};
    status[ACC].lastSuccess = Date.now();
    saveStatus(status);
    updateNextCheckDate(nextDays, '续签成功');
    await sendTG('✅', '续签成功', timeInfo + '\n下次检查' + nextDays + '天后', 'success.png');
  } catch (e) {
    console.log('⚠️ 未找到延期按钮');
    await page.screenshot({ path: 'skip.png' });
    var s = getAccountStatus();
    if (!s.lastSuccess) await sendTG('🕐', '等待中', '按钮未出现', 'skip.png');
    else await sendTG('⚠️', '跳过', '未到时间', 'skip.png');
  }
}

// ── 主流程 ──

(async function main() {
  console.log('==================================================');
  console.log('XServer 自动延期 (自适应版)');
  console.log('==================================================');

  if (!ACC || !ACC_PWD) { console.log('❌ 未找到账号或密码'); process.exit(1); }
  checkScheduling();

  var launchOpts = { headless: true, channel: 'chrome' };
  if (PROXY_URL) launchOpts.proxy = { server: 'http://127.0.0.1:8080' };
  var browser = await chromium.launch(launchOpts);
  var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await context.newPage();

  var thresholdHours = null;  // 从续期页面捕获，传给 tryRenew

  try {
    if (PROXY_URL) {
      console.log('🌐 检查代理 IP...');
      try {
        await page.goto('https://api.ipify.org/?format=json', { timeout: 15000 });
        console.log('✅ IP: ' + JSON.parse(await page.textContent('body')).ip);
      } catch (e) { console.log('⚠️ IP 检查失败'); }
    }

    console.log('🌐 打开登录页面');
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: '1_navigation.png' });

    console.log('📧 填写账号密码');
    await page.locator('#memberid').fill(ACC);
    await page.locator('#user_password').fill(ACC_PWD);
    await page.screenshot({ path: '1.5_filled.png' });

    console.log('🖱️ 提交登录');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      page.locator('input[name="action_user_login"]').click()
    ]);
    await page.screenshot({ path: '2_after_login.png' });

    console.log('🚀 点击游戏管理');
    await page.getByRole('link', { name: 'ゲーム管理' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: '3_game_manage.png' });

    // 从游戏管理页面获取剩余时间
    var totalMins = await parseRemainingMinutes(page);

    console.log('🚀 进入续期页面');
    await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();
    await page.screenshot({ path: '4_renew_page.png' });

    // 读取续期页面：受限时包含阈值和可续期时间
    var extendInfo = await parseExtendPage(page);

    if (extendInfo.restricted) {
      thresholdHours = extendInfo.thresholdHours;

      // 1. 有精确的未来日期 → 预约到那天，退出
      if (extendInfo.nextDate && extendInfo.nextDate > getTodayStr()) {
        console.log('📅 预约 ' + extendInfo.nextDate + ' 再检查');
        await sendTGOnce('🧊', '冷却等待', '可续期: ' + extendInfo.nextDate + ' ' + (extendInfo.nextTime || ''));
        updateNextCheckDateByDate(extendInfo.nextDate, '冷却中');
        process.exit(0);
      }

      // 2. 日期=今天但时间未到 → 设今天为预约日，靠 cron 轮询
      if (extendInfo.nextDate === getTodayStr() && extendInfo.nextMinutes !== null) {
        var nowMin = getNowJSTMinutes();
        var waitMin = extendInfo.nextMinutes - nowMin;
        if (waitMin > 0) {
          await setTodayAndExit('还需 ' + waitMin + ' 分钟到可续期时间');
        }
      }

      // 3. 剩余 > 阈值 → 预约几天后再查
      if (totalMins !== null && thresholdHours !== null) {
        var h = totalMins / 60;
        if (h > thresholdHours) {
          var hoursToGo = h - thresholdHours;
          var days = Math.max(1, Math.ceil(hoursToGo / 24));
          console.log('🔭 剩余 ' + h.toFixed(1) + 'h > 阈值 ' + thresholdHours + 'h，预约 ' + days + ' 天后');
          await sendTGOnce('🔭', '探测跳过', '剩余 ' + h.toFixed(1) + 'h，预约 ' + days + ' 天后');
          updateNextCheckDate(days, '等待进入可续期窗口');
          process.exit(0);
        }
        // 剩余 ≤ 阈值但页面仍受限 → 可能按钮尚未出现，尝试执行
        console.log('⚠️ 剩余时间已达标但页面受限，尝试续期');
      } else {
        console.log('⚠️ 无法分析，尝试直接续期');
      }
    }

    // ── 可续期窗口 ──
    if (DELAY_MS > 0) {
      console.log('⏳ T 延迟 ' + (DELAY_MS / 60000).toFixed(1) + ' 分钟...');
      await new Promise(function(r) { setTimeout(r, DELAY_MS); });
    }

    console.log('🚀 执行续期');
    await tryRenew(page, totalMins, thresholdHours);

  } catch (error) {
    console.log('❌ 流程失败: ' + error.message);
    await page.screenshot({ path: 'failure.png' });
    await sendTG('❌', '续签失败', error.message, 'failure.png');
  } finally {
    await context.close();
    await browser.close();
  }
})();
