/**
 * 把 incident/agent-profile/identity.json 同步进 agent_profiles 表。
 *
 * 为什么要同步：Agent 运行时读的是库里的 profile 行，不是这个 JSON。
 * 改了 JSON 不入库，等于没改——上一轮就会踩这个坑。
 *
 * 幂等：内容一致就不动，profile 的 version 不会因为重复执行而涨。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const distUrl = (name) =>
  pathToFileURL(new URL(`../../dist/${name}`, import.meta.url).pathname).href;

const PROFILE_ID = 'bbc54f27-afd9-454a-be99-842531057c43';
const OWNER_ID = '68fcc7c5-f8ca-4265-acd5-f215f5aa24a4';

const identity = JSON.parse(
  readFileSync(new URL('../agent-profile/identity.json', import.meta.url), 'utf8'),
);

const db = await import(distUrl('db.js'));
db.initDatabase();

const before = db.getAgentProfile(PROFILE_ID);
if (!before) throw new Error(`profile ${PROFILE_ID} not found`);

const same =
  before.identity_prompt === identity.identity_prompt &&
  before.soul_prompt === identity.soul_prompt &&
  before.agents_prompt === identity.agents_prompt &&
  before.tools_prompt === identity.tools_prompt &&
  JSON.stringify(before.runtime_policy ?? {}) ===
    JSON.stringify(identity.runtime_policy ?? {});

if (same) {
  console.log(
    `profile 已是最新形态（version=${before.version}），跳过。agents_prompt=${before.agents_prompt.length} 字`,
  );
} else {
  const after = db.updateAgentProfile(PROFILE_ID, OWNER_ID, {
    name: identity.name,
    identityPrompt: identity.identity_prompt,
    soulPrompt: identity.soul_prompt,
    agentsPrompt: identity.agents_prompt,
    toolsPrompt: identity.tools_prompt,
    runtimePolicy: identity.runtime_policy,
    changeSource: 'update',
  });
  console.log(
    `profile 已更新：version ${before.version} -> ${after.version}，` +
      `agents_prompt ${before.agents_prompt.length} -> ${after.agents_prompt.length} 字`,
  );
}
