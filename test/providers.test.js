// The AI scribe takes the same provider names and key variables as the owner's other products.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../server");
const { settingsFrom } = require("../lib/scribe");

const KEYS = ["AI_PROVIDER", "AI_MODEL", "AI_API_URL", "AI_API_KEY", "MOONSHOT_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "MOONSHOT_MODEL", "OPENROUTER_MODEL", "OPENAI_MODEL", "SCRIBE_API_URL", "SCRIBE_API_KEY", "SCRIBE_MODEL"];
function withEnv(vars, fn) {
  const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const k of KEYS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } }
}

test("AI provider names: moonshot, openrouter and openai each use their own address and key variable", () => {
  const or = withEnv({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "made-up-or-key", AI_MODEL: "moonshotai/kimi-k2:free", MOONSHOT_API_KEY: "made-up-ms-key" }, () => settingsFrom(loadConfig()));
  assert.equal(or.host, "openrouter.ai"); assert.equal(or.url, "https://openrouter.ai/api/v1"); assert.equal(or.key, "made-up-or-key", "the provider's own key, not another provider's");
  assert.equal(or.model, "moonshotai/kimi-k2:free"); assert.equal(or.enabled, true);

  const ms = withEnv({ AI_PROVIDER: "Moonshot", MOONSHOT_API_KEY: "made-up-ms-key", AI_MODEL: "kimi-k2.6" }, () => settingsFrom(loadConfig()));
  assert.equal(ms.host, "api.moonshot.ai"); assert.equal(ms.key, "made-up-ms-key");

  const oa = withEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: "made-up-oa-key", AI_MODEL: "some-model" }, () => settingsFrom(loadConfig()));
  assert.equal(oa.host, "api.openai.com"); assert.equal(oa.key, "made-up-oa-key");

  // the three SCRIBE_* variables still win over a provider name, and a provider with no key stays off
  const own = withEnv({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "x", AI_MODEL: "a", SCRIBE_API_URL: "https://ai.example.com/v1", SCRIBE_API_KEY: "y", SCRIBE_MODEL: "b" }, () => settingsFrom(loadConfig()));
  assert.equal(own.host, "ai.example.com"); assert.equal(own.key, "y"); assert.equal(own.model, "b");
  const off = withEnv({ AI_PROVIDER: "openrouter", AI_MODEL: "moonshotai/kimi-k2:free" }, () => settingsFrom(loadConfig()));
  assert.equal(off.enabled, false);

  // a backup is any other provider with its key and a model to use: its own variable, or the provider's default
  const chain = withEnv({ AI_PROVIDER: "moonshot", MOONSHOT_API_KEY: "ms", AI_MODEL: "kimi-k2.6", OPENROUTER_API_KEY: "or", OPENROUTER_MODEL: "some/model:free", OPENAI_API_KEY: "oa" }, () => settingsFrom(loadConfig()));
  assert.equal(chain.host, "api.moonshot.ai");
  assert.deepEqual(chain.fallbacks.map((f) => [f.host, f.model, f.key]), [["openrouter.ai", "some/model:free", "or"], ["api.openai.com", "gpt-4o-mini", "oa"]]);
  // keys alone: each backup uses its provider's default. The free one is tried before the paid one.
  const keys = withEnv({ AI_PROVIDER: "moonshot", MOONSHOT_API_KEY: "ms", AI_MODEL: "kimi-k2.6", OPENROUTER_API_KEY: "or", OPENAI_API_KEY: "oa" }, () => settingsFrom(loadConfig()));
  assert.deepEqual(keys.fallbacks.map((f) => [f.host, f.model]), [["openrouter.ai", "openrouter/free"], ["api.openai.com", "gpt-4o-mini"]]);
  // a provider with no key is never a backup
  const none = withEnv({ AI_PROVIDER: "moonshot", MOONSHOT_API_KEY: "ms", AI_MODEL: "kimi-k2.6" }, () => settingsFrom(loadConfig()));
  assert.deepEqual(none.fallbacks, []);
  const named = withEnv({ AI_PROVIDER: "moonshot", MOONSHOT_API_KEY: "ms", AI_MODEL: "kimi-k2.6", OPENAI_API_KEY: "oa", OPENAI_MODEL: "another-model" }, () => settingsFrom(loadConfig()));
  assert.equal(named.fallbacks[0].model, "another-model");
});
