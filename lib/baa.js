// Which AI services may receive health information at all: only ones covered by a business associate agreement, and
// whose address the request format here is known to fit. Used by the AI scribe (visit notes) and Sunny (members'
// questions). Adding a host is a decision, not a default.
//   - api.openai.com: OpenAI directly, ONLY when the practice has signed OpenAI's BAA for the key in use.
//   - bedrock-runtime.<region>.amazonaws.com and bedrock-mantle.<region>.api.aws: Amazon Bedrock's two
//     OpenAI-compatible endpoints, covered by the AWS Business Associate Addendum accepted in AWS Artifact.
//   - localhost: a model on the practice's own machine never leaves the building.
// OpenRouter and Moonshot's own service do not sign one and are refused, as is anything else.
"use strict";
const BAA_HOSTS = [/^api\.openai\.com$/, /^bedrock-runtime\.[a-z]{2}(-[a-z]+)+-\d\.amazonaws\.com$/, /^bedrock-mantle\.[a-z]{2}(-[a-z]+)+-\d\.api\.aws$/, /^(localhost|127\.0\.0\.1)(:\d+)?$/];
const hostAllowed = (host) => BAA_HOSTS.some((re) => re.test(String(host || "").toLowerCase()));
module.exports = { BAA_HOSTS, hostAllowed };
