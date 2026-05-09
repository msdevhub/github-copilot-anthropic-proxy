// Generated install script served at /install/openclaw
// Usage: curl -fsSL https://api.eagle.openclaws.co.uk/install/openclaw?key=sk-xxx | node
export function buildOpenclawInstallScript({ baseAnthropic, baseOpenai, apiKey }) {
  const claude = ['claude-opus-4.7-1m-internal','claude-opus-4.7','claude-opus-4.6','claude-opus-4.5','claude-sonnet-4.6','claude-sonnet-4.5','claude-haiku-4.5'];
  const oai = ['gpt-5-mini','gemini-3.1-pro-preview','gemini-3-flash-preview'];
  const resp = ['gpt-5.5','gpt-5.2-codex'];
  const DEFAULT_PRIMARY = 'cp-anthropic/claude-opus-4.6';

  return `#!/usr/bin/env node
// 🦅 copilot-proxy → openclaw 交互式安装向导
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const KEY = ${JSON.stringify(apiKey)};
const BASE_A = ${JSON.stringify(baseAnthropic)};
const BASE_O = ${JSON.stringify(baseOpenai)};
const CLAUDE = ${JSON.stringify(claude)};
const OAI = ${JSON.stringify(oai)};
const RESP = ${JSON.stringify(resp)};
const DEFAULT_PRIMARY = ${JSON.stringify(DEFAULT_PRIMARY)};
const ALL_NEW = [
  ...CLAUDE.map(i=>'cp-anthropic/'+i),
  ...OAI.map(i=>'cp-openai/'+i),
  ...RESP.map(i=>'cp-responses/'+i),
];

const CFG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const c = (() => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { console.error('❌ 无法读取 ' + CFG + ': ' + e.message); process.exit(1); } })();

const C = { reset:'\\x1b[0m', bold:'\\x1b[1m', dim:'\\x1b[2m', cyan:'\\x1b[36m', green:'\\x1b[32m', yellow:'\\x1b[33m', red:'\\x1b[31m', blue:'\\x1b[34m' };
const isTTY = process.stdin.isTTY;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });
const ask = q => new Promise(r => rl.question(q, ans => r(ans.trim())));

function modelBelongsToCopilotProxy(modelKey) {
  return modelKey && (modelKey.startsWith('cp-') || modelKey.startsWith('copilot-proxy-'));
}

async function main() {
  const provs = (c.models && c.models.providers) || {};
  const provNames = Object.keys(provs);
  const agents = c.agents || {};
  const defaults = agents.defaults || {};
  const defaultPrimary = (defaults.model && defaults.model.primary) || '(unset)';

  // -------- 1. 现状汇总 --------
  console.log('');
  console.log(C.bold + C.cyan + '🦅 copilot-proxy → openclaw 安装向导' + C.reset);
  console.log(C.dim + '   配置文件: ' + CFG + C.reset);
  console.log('');
  console.log(C.bold + '📦 当前 Providers (' + provNames.length + ')' + C.reset);
  if (provNames.length === 0) {
    console.log('   ' + C.dim + '(空 — 这是首次接入)' + C.reset);
  } else {
    for (const n of provNames) {
      const p = provs[n];
      const isOurs = n.startsWith('cp-');
      const isLegacy = n.startsWith('copilot-proxy-');
      const tag = isOurs ? C.green + ' [本服务·新版]' : isLegacy ? C.yellow + ' [本服务·旧版,将清理]' : C.dim + ' [第三方]';
      console.log('   • ' + n + tag + C.reset + C.dim + '  api=' + (p.api||'?') + ', models=' + ((p.models||[]).length) + C.reset);
    }
  }
  console.log('');

  // -------- 2. agents 列表 + 当前默认模型 --------
  console.log(C.bold + '🤖 当前 Agent 默认模型 (defaults.model.primary)' + C.reset);
  console.log('   ' + (defaultPrimary === DEFAULT_PRIMARY ? C.green + '✓ ' : '  ') + defaultPrimary + C.reset);
  console.log('');

  // 列出 agents.list[] 里配置的 agent
  const agentList = Array.isArray(agents.list) ? agents.list : [];
  const agentsWithModel = agentList.filter(a => a && a.model);
  if (agentList.length) {
    console.log(C.bold + '👥 已配置 ' + agentList.length + ' 个 Agent (其中 ' + agentsWithModel.length + ' 个有独立 model 设置)' + C.reset);
    const show = agentList.slice(0, 12);
    for (const a of show) {
      const m = a.model || C.dim + '(继承默认)' + C.reset;
      const def = a.default ? C.green + ' [default]' + C.reset : '';
      const isOurModel = a.model && (a.model.startsWith('cp-') || a.model.startsWith('copilot-proxy-'));
      const tag = a.model ? (isOurModel ? '' : C.yellow + ' [非本服务模型]' + C.reset) : '';
      console.log('   • ' + a.id + def + '  ' + C.dim + '→' + C.reset + ' ' + m + tag);
    }
    if (agentList.length > 12) console.log('   ' + C.dim + '... 还有 ' + (agentList.length - 12) + ' 个' + C.reset);
    console.log('');
  }

  // -------- 3. 改动计划 --------
  console.log(C.bold + '🔧 本次将执行' + C.reset);
  console.log('   ' + C.green + '✚ 新增/覆盖 3 个 provider' + C.reset + ': cp-anthropic (' + CLAUDE.length + ' claude), cp-openai (' + OAI.length + ' gpt/gemini), cp-responses (' + RESP.length + ' gpt-5系列)');
  const willDelete = provNames.filter(n => n.startsWith('copilot-proxy-'));
  if (willDelete.length) console.log('   ' + C.yellow + '🗑  清理旧版 provider' + C.reset + ': ' + willDelete.join(', '));
  console.log('   ' + C.blue + '📌 默认模型' + C.reset + ': ' + (ALL_NEW.includes(defaultPrimary) ? '保留 ' + defaultPrimary : '设为 ' + DEFAULT_PRIMARY));
  console.log('   ' + C.dim + '💾 备份: ' + CFG + '.bak.cp.<timestamp>' + C.reset);
  console.log('');

  if (!isTTY) {
    console.log(C.yellow + '⚠️  非交互模式 (管道运行)，30 秒后自动确认...' + C.reset);
    console.log(C.dim + '   要交互请加 < /dev/tty: curl ... | node /dev/stdin < /dev/tty' + C.reset);
    await new Promise(r => setTimeout(r, 1500));
  } else {
    const yn = await ask(C.bold + '继续? [Y/n] ' + C.reset);
    if (yn && /^n/i.test(yn)) { console.log('已取消'); process.exit(0); }
  }

  // -------- 4. 询问是否改默认模型 --------
  let chosenPrimary = ALL_NEW.includes(defaultPrimary) ? defaultPrimary : DEFAULT_PRIMARY;
  if (isTTY) {
    console.log('');
    console.log(C.bold + '可用模型:' + C.reset);
    ALL_NEW.forEach((m, i) => console.log('   ' + String(i+1).padStart(2) + ') ' + (m === chosenPrimary ? C.green + m + ' ←默认' + C.reset : m)));
    const sel = await ask(C.bold + '选择默认模型 [回车=' + chosenPrimary + ']: ' + C.reset);
    if (sel) {
      const n = parseInt(sel, 10);
      if (!isNaN(n) && n >= 1 && n <= ALL_NEW.length) chosenPrimary = ALL_NEW[n-1];
      else if (ALL_NEW.includes(sel)) chosenPrimary = sel;
      else console.log(C.yellow + '   未识别，沿用 ' + chosenPrimary + C.reset);
    }
  }

  // -------- 5. 询问是否批量改 agent.list[].model --------
  const agentsToUpdate = [];
  if (agentList.length && isTTY) {
    console.log('');
    console.log(C.bold + '🤖 Agent 模型迁移' + C.reset);
    console.log('   ' + C.dim + '说明: agent 没设 model 时会用上面的全局默认。设了的话以自己的为准。' + C.reset);
    const choice = (await ask(C.bold + '如何处理 ' + agentList.length + ' 个 agent 的 model? [s]跳过 / [a]全部改成 ' + chosenPrimary + ' / [l]只迁移旧版 cp-/copilot-proxy- / [p]逐个询问 [回车=s]: ' + C.reset)).toLowerCase();
    if (choice === 'a') {
      for (const a of agentList) if (a.model !== chosenPrimary) agentsToUpdate.push([a, chosenPrimary]);
    } else if (choice === 'l') {
      for (const a of agentList) {
        if (a.model && (a.model.startsWith('copilot-proxy-') || (a.model.startsWith('cp-') && !ALL_NEW.includes(a.model)))) {
          agentsToUpdate.push([a, chosenPrimary]);
        }
      }
    } else if (choice === 'p') {
      for (const a of agentList) {
        const cur = a.model || '(继承默认)';
        const ans = (await ask('   • ' + a.id + ' [当前: ' + cur + '] → 改为 ' + chosenPrimary + '? [y/N/数字选其他]: ')).trim();
        if (/^y/i.test(ans)) agentsToUpdate.push([a, chosenPrimary]);
        else {
          const n = parseInt(ans, 10);
          if (!isNaN(n) && n >= 1 && n <= ALL_NEW.length) agentsToUpdate.push([a, ALL_NEW[n-1]]);
        }
      }
    }
    if (agentsToUpdate.length) console.log(C.green + '   ✓ 将更新 ' + agentsToUpdate.length + ' 个 agent' + C.reset);
  }
  for (const [a, m] of agentsToUpdate) a.model = m;

  // -------- 6. 写入 --------
  fs.writeFileSync(CFG + '.bak.cp.' + Date.now(), JSON.stringify(c, null, 2));
  c.models = c.models || {};
  c.models.providers = c.models.providers || {};
  // 清理旧 provider
  ['copilot-proxy-anthropic','copilot-proxy-openai','copilot-proxy-responses'].forEach(k => delete c.models.providers[k]);
  // 写入新 provider
  c.models.providers['cp-anthropic'] = { baseUrl: BASE_A, apiKey: KEY, api: 'anthropic-messages', authHeader: true,
    models: CLAUDE.map(id => ({ id, name: id, contextWindow: id.includes('1m') ? 1000000 : 200000, maxTokens: id.includes('haiku') ? 8192 : 32000 })) };
  c.models.providers['cp-openai'] = { baseUrl: BASE_O, apiKey: KEY, api: 'openai-completions',
    models: OAI.map(id => ({ id, name: id, contextWindow: id.startsWith('gemini') ? 1000000 : 400000, maxTokens: 16384 })) };
  c.models.providers['cp-responses'] = { baseUrl: BASE_O, apiKey: KEY, api: 'openai-responses',
    models: RESP.map(id => ({ id, name: id, contextWindow: 400000, maxTokens: 16384 })) };
  // defaults
  c.agents = c.agents || {};
  c.agents.defaults = c.agents.defaults || {};
  c.agents.defaults.model = { primary: chosenPrimary, fallbacks: ALL_NEW.filter(m => m !== chosenPrimary) };
  // 清理 defaults.models 里的旧条目并加入新模型
  const cleaned = Object.fromEntries(Object.entries(c.agents.defaults.models || {})
    .filter(([k]) => !k.startsWith('copilot-proxy-') && !k.startsWith('cp-') && !k.startsWith('eagle/')));
  c.agents.defaults.models = Object.assign(cleaned, Object.fromEntries(ALL_NEW.map(m => [m, {}])));

  fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
  console.log('');
  console.log(C.green + C.bold + '✅ 安装完成' + C.reset);
  console.log('   默认模型: ' + C.cyan + chosenPrimary + C.reset);
  console.log('   验证: ' + C.dim + 'openclaw config validate' + C.reset);
  rl.close();
}

main().catch(e => { console.error(C.red + '❌ ' + e.message + C.reset); process.exit(1); });
`;
}
