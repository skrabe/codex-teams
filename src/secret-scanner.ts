type SecretRule = {
  id: string;
  source: string;
  flags?: string;
};

export type SecretMatch = {
  ruleId: string;
  label: string;
};

const ANT_KEY_PFX = ["sk", "ant", "api"].join("-");

const SECRET_RULES: SecretRule[] = [
  { id: "aws-access-token", source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b" },
  { id: "gcp-api-key", source: "\\b(AIza[\\w-]{35})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "anthropic-api-key", source: `\\b(${ANT_KEY_PFX}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)` },
  { id: "anthropic-admin-api-key", source: "\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "openai-api-key", source: "\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "huggingface-access-token", source: "\\b(hf_[a-zA-Z]{34})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "github-pat", source: "ghp_[0-9a-zA-Z]{36}" },
  { id: "github-fine-grained-pat", source: "github_pat_\\w{82}" },
  { id: "github-app-token", source: "(?:ghu|ghs)_[0-9a-zA-Z]{36}" },
  { id: "github-oauth", source: "gho_[0-9a-zA-Z]{36}" },
  { id: "github-refresh-token", source: "ghr_[0-9a-zA-Z]{36}" },
  { id: "gitlab-pat", source: "glpat-[\\w-]{20}" },
  { id: "gitlab-deploy-token", source: "gldt-[0-9a-zA-Z_\\-]{20}" },
  { id: "slack-bot-token", source: "xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*" },
  { id: "slack-user-token", source: "xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}" },
  { id: "slack-app-token", source: "xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+", flags: "i" },
  { id: "sendgrid-api-token", source: "\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "npm-access-token", source: "\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "stripe-access-token", source: "\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "digitalocean-pat", source: "\\b(dop_v1_[a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" },
  { id: "private-key", source: "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----", flags: "i" },
];

let compiledRules: Array<{ id: string; re: RegExp }> | null = null;

function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  if (compiledRules === null) {
    compiledRules = SECRET_RULES.map((r) => ({
      id: r.id,
      re: new RegExp(r.source, r.flags),
    }));
  }
  return compiledRules;
}

const SPECIAL_CASE: Record<string, string> = {
  aws: "AWS",
  gcp: "GCP",
  api: "API",
  pat: "PAT",
  ad: "AD",
  oauth: "OAuth",
  npm: "NPM",
  pypi: "PyPI",
  github: "GitHub",
  gitlab: "GitLab",
  openai: "OpenAI",
  digitalocean: "DigitalOcean",
  huggingface: "HuggingFace",
  sendgrid: "SendGrid",
  anthropic: "Anthropic",
};

function ruleIdToLabel(ruleId: string): string {
  return ruleId
    .split("-")
    .map((part) => SPECIAL_CASE[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const rule of getCompiledRules()) {
    if (seen.has(rule.id)) continue;
    if (rule.re.test(content)) {
      seen.add(rule.id);
      matches.push({ ruleId: rule.id, label: ruleIdToLabel(rule.id) });
    }
  }

  return matches;
}
